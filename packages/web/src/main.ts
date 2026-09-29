/**
 * Entry point.
 *
 * Owns the render loop, the current screen, and the bridge between a game
 * controller (LocalGame or NetworkGame) and the 3D table.
 *
 * The controllers are the same ones the terminal build used: they were always
 * UI-agnostic, so swapping a terminal renderer for a WebGL one did not touch
 * a line of game logic.
 */

import {
  COLORS,
  playableFor,
  type Color,
  type GameOverReason,
  type RedactedState,
} from '@mercy/engine';
import type { Difficulty } from '@mercy/bots';
import { LocalGame } from './game/local.js';
import { NetworkGame } from './game/network.js';
import { Sound } from './game/sound.js';
import { DEFAULT_ROOM_SETTINGS } from '@mercy/protocol';
import { resolveServer } from './game/serverUrl.js';
import { Store } from './game/store.js';
import { penalties } from './game/penalty.js';
import { decidePrompt } from './game/prompt.js';
import type { PlayableGame } from './game/types.js';
import { warmCardArt } from './scene/cardArt.js';
import { AttractScene } from './scene/attract.js';
import { createStage, webglAvailable } from './scene/table.js';
import { TableView } from './scene/tableView.js';
import { handDepth, visibleWidthAtHand } from './scene/layout.js';
import { VoiceChat } from './game/voice.js';
import { Hud, Screens, type MenuChoice, type VoiceView } from './ui/screens.js';

// Where the multiplayer server lives, and whether one is reachable at all.
const { url: SERVER_URL, multiplayer: MULTIPLAYER_AVAILABLE } = resolveServer({
  configured: import.meta.env.VITE_UNO_SERVER as string | undefined,
  sameOrigin: import.meta.env.VITE_UNO_SAME_ORIGIN as string | undefined,
  protocol: location.protocol,
  hostname: location.hostname,
  port: location.port,
});

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hudLayer = document.getElementById('hud-layer') as HTMLElement;
const screenLayer = document.getElementById('screen-layer') as HTMLElement;

/**
 * Fail out loud.
 *
 * createStage() used to run bare at module scope, so anything that stopped
 * WebGL working - a privacy-hardened browser, an older iPhone, a blocklisted
 * GPU - threw here and the page simply stayed black with nothing on it and
 * nothing in the log for a player to report. A 3D card table genuinely cannot
 * run without WebGL; what it can do is say so.
 */
function fatal(title: string, detail: string): never {
  screenLayer.innerHTML = '';
  const screen = document.createElement('div');
  screen.className = 'screen';
  const box = document.createElement('div');
  box.className = 'card-panel';
  // Built by hand rather than through Screens: this has to work even if the
  // failure happened before the rest of the app was ready.
  const h = document.createElement('h2');
  h.textContent = title;
  const p1 = document.createElement('p');
  p1.className = 'sub';
  p1.textContent = detail;
  const p2 = document.createElement('p');
  p2.className = 'sub';
  p2.textContent =
    'If this is a privacy or content blocker, allowing WebGL for this page is usually enough.';
  box.append(h, p1, p2);
  screen.append(box);
  screenLayer.append(screen);
  throw new Error(`${title}: ${detail}`);
}

if (!webglAvailable()) {
  fatal(
    'This browser cannot draw the table',
    'The game needs WebGL, and this browser has it turned off or unavailable.',
  );
}

let stage: ReturnType<typeof createStage>;
try {
  stage = createStage(canvas);
} catch (e) {
  fatal('The table failed to start', `WebGL reported: ${String(e)}`);
}
const view = new TableView(stage.scene);
const attract = new AttractScene(stage.scene);
const screens = new Screens(screenLayer);
const store = new Store();
const sound = new Sound(localStorage.getItem('uno:muted') !== '1');

let game: PlayableGame | null = null;
let hud: Hud | null = null;
let unsubscribe: (() => void) | null = null;
let botTimer: number | null = null;
let unoTimer: number | null = null;
let gameMeta: { difficulty: string; startedAt: number; bots: number } | null = null;
let voice: VoiceChat | null = null;
let unbindKeys: (() => void) | null = null;
let recorded = false;

const defaultName = localStorage.getItem('uno:name') || 'player';

/**
 * Touch devices have no hover, so the lift-to-preview never fires and the
 * first tap would commit a card immediately. On touch we require two taps:
 * one to raise the card, a second on the SAME card to play it. Mis-taps then
 * cost a correction instead of a turn.
 */
const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;

// --- render loop -----------------------------------------------------------

let last = performance.now();
function frame(now: number) {
  const dt = now - last;
  last = now;
  view.animator.update(dt);
  // The hand's springs, which is how a hover stays re-aimable mid-motion.
  view.stepHand(dt);
  // Scenery runs whenever the table is empty, which is every menu, the lobby
  // and the stats screen - no explicit start/stop at each transition to get
  // out of step with.
  const wantScenery = !view.hasCards;
  if (wantScenery !== attract.active) {
    if (wantScenery) attract.start();
    else attract.stop();
  }
  attract.update(dt, window.innerWidth / window.innerHeight);
  stage.renderer.render(stage.scene, stage.camera);
  requestAnimationFrame(frame);
}


/**
 * Measure how much world-width the hand may occupy, from the LIVE camera.
 *
 * Recomputed per update rather than cached, because the camera moves between
 * portrait and landscape and a stale budget overflows the viewport.
 */
function handWidthBudget(): number {
  const aspect = window.innerWidth / window.innerHeight;
  /*
   * Ask the layout where the row is rather than assuming.
   *
   * This used the fixed HAND_Z constants, which stopped being true once the
   * layout began sliding the row to fit a big hand. The budget was then being
   * measured on a plane the cards were no longer on - and since portrait
   * moves them TOWARD the camera, where less world-width is visible, the fan
   * was handed more room than existed and ran off both edges.
   */
  const count = game?.view()?.players.find((p) => p.id === game?.youId)?.hand?.length ?? 7;
  const cam = stage.camera.position;
  const distance = Math.hypot(cam.y - 0.46, cam.z - handDepth(count, aspect));
  return visibleWidthAtHand(aspect, stage.camera.fov, distance);
}

/**
 * How long a bot "thinks" before acting in a solo game.
 *
 * Has to outlast PLAY_MS (1100ms) or the next bot throws while the last card
 * is still in the air, and the table reads as a blur however slow each
 * individual throw is.
 */
const BOT_DELAY_MS = 1250;

/**
 * How long the bots hold off before pouncing on a missed UNO.
 *
 * Deliberately generous when it is YOU on one card. The printed rule gives you
 * until "the next player begins their turn", which at a digital table is no
 * time at all - the window would close before a human could move a mouse, and
 * the rule would just be a tax on reaction time. Two seconds is long enough to
 * be a real race and short enough to still feel like one.
 */
const UNO_GRACE_MS = 2000;
/** Bots remembering their own UNO. Quick, but visible as a beat. */
const UNO_SELF_MS = 550;

function stopBotLoop() {
  if (botTimer !== null) {
    clearTimeout(botTimer);
    botTimer = null;
  }
  if (unoTimer !== null) {
    clearTimeout(unoTimer);
    unoTimer = null;
  }
}

/**
 * Let the bots react to a hanging UNO.
 *
 * A separate timer from the turn loop on purpose: calling UNO happens off-turn,
 * so it must not wait for, or hold up, whoever is on the clock.
 */
function scheduleUnoReaction() {
  if (unoTimer !== null) {
    clearTimeout(unoTimer);
    unoTimer = null;
  }
  const g = game;
  if (!(g instanceof LocalGame)) return;
  const at = g.unoRisk;
  if (g.isOver || at === null) return;
  unoTimer = window.setTimeout(
    () => {
      unoTimer = null;
      g.stepUno();
    },
    at === g.youId ? UNO_GRACE_MS : UNO_SELF_MS,
  );
}

/**
 * Drive bot turns in a SOLO game.
 *
 * Only local games need this. In a networked game the server owns the state
 * and steps its own bots; a client that also stepped them would race the
 * server and submit duplicate moves.
 *
 * Each step triggers onStateChange, which calls back in here - so this is a
 * self-sustaining loop that stops on its own the moment it is the human's
 * turn or the game ends.
 */
function scheduleBotTurn() {
  if (botTimer !== null) {
    clearTimeout(botTimer);
    botTimer = null;
  }
  const g = game;
  if (!(g instanceof LocalGame)) return;
  if (g.isOver || g.waitingOnHuman()) return;
  botTimer = window.setTimeout(() => {
    botTimer = null;
    g.stepBot();
  }, BOT_DELAY_MS);
}

// --- game wiring -----------------------------------------------------------

function detach() {
  unsubscribe?.();
  unsubscribe = null;
  unbindKeys?.();
  unbindKeys = null;
  voice?.leave();
  voice = null;
  hud?.destroy();
  hud = null;
  game = null;
  view.reset();
  stopBotLoop();
  recorded = false;
}

function startSolo(bots: number, difficulty: Difficulty) {
  const g = new LocalGame({
    seed: (Math.random() * 0xffffffff) >>> 0,
    humanName: defaultName,
    botCount: bots,
    difficulty,
  });
  gameMeta = { difficulty, startedAt: Date.now(), bots };
  attach(g);
}

function attach(g: PlayableGame) {
  detach();
  game = g;
  // Close the panel BEFORE building the HUD. They live in separate layers now,
  // but ordering still matters for what the player sees first.
  screens.close();
  hud = new Hud(hudLayer);
  hud.corner([
    {
      label: sound.enabled ? 'Sound on' : 'Sound off',
      onClick: () => {
        const on = sound.toggle();
        localStorage.setItem('uno:muted', on ? '0' : '1');
        refreshHud();
      },
    },
    { label: 'Leave', onClick: toMenu },
  ]);
  /*
   * Chat is a networked-only feature: a solo game has nobody to talk to, and
   * a ticker with only your own voice in it is furniture.
   */
  if (g.say) {
    const net = g instanceof NetworkGame ? g : null;

    if (net && VoiceChat.supported) {
      voice = new VoiceChat({
        youId: g.youId,
        signal: (sig) => net.sendVoiceSignal(sig),
        announce: (joined, muted) => net.announceVoice(joined, muted),
        onChange: () => refreshVoice(),
      });
      net.onVoiceSignal = (from, sig) => void voice?.onSignal(from, sig);
      net.onVoiceRoster = (players) => voice?.setRoster(players);
    }

    hud.enableChat(
      (text) => g.say?.(text),
      (typing) => g.setTyping?.(typing),
      voice
        ? {
            available: true,
            /*
             * The microphone is not opened until the first press.
             *
             * Asking for permission the moment a game starts gets refused by
             * habit; asking the first time somebody actually holds V is a
             * request with a reason attached.
             */
            onTalk: (on) => {
              if (!voice) return;
              if (on && !voice.joined) {
                void voice.join().then((ok) => ok && voice?.setTalking(true));
                return;
              }
              voice.setTalking(on);
            },
            onToggleMute: () => {
              if (!voice?.joined) return;
              voice.setMuted(!voice.muted);
            },
          }
        : undefined,
    );
    unbindKeys = hud.bindKeys();
  }
  unsubscribe = g.subscribe(onStateChange);
  onStateChange();
}

function onStateChange() {
  const g = game;
  if (!g) return;
  const state = g.view();
  if (!state) return;

  // Feed the 3D table the same events that drive the log, so a card flies
  // from the seat that actually played it.
  const aspect = window.innerWidth / window.innerHeight;
  view.update(state, g.lastEvents, aspect, handWidthBudget());
  cueSounds(g);
  refreshHud();
  // After refreshHud, so the rail rows the badge attaches to already exist.
  showPenalties(g, state);

  if (g.isOver) {
    stopBotLoop();
    finishGame(g);
    return;
  }

  // Keep the table moving: if it is a bot's turn, queue their move.
  scheduleBotTurn();
  scheduleUnoReaction();
}

/** Microphone state per seat, or an empty map when voice is not running. */
function voiceView(): VoiceView | undefined {
  if (!voice) return undefined;
  return voice.states() as VoiceView;
}

/**
 * Redraw only what voice touches.
 *
 * Levels are sampled about nine times a second, and running the whole HUD
 * refresh at that rate would rebuild the log, the chips and every prompt
 * button nine times a second along with them.
 */
function refreshVoice() {
  const state = game?.view();
  if (!state || !hud) return;
  hud.rail(state, voiceView(), game instanceof NetworkGame ? game.spectators : 0);
  hud.micState(voice?.selfState() ?? 'none');
  // The mesh only calls seats that are actually at the table.
  voice?.setSeats(state.players.filter((p) => !p.isBot).map((p) => p.id));
}

function cueSounds(g: PlayableGame) {
  for (const e of g.lastEvents) {
    if (e.type === 'cardPlayed') sound.play('play');
    else if (e.type === 'drew') sound.play('draw');
    else if (e.type === 'stackTaken' && e.count >= 6) sound.play('bigHit');
    else if (e.type === 'eliminated') sound.play('eliminate');
    else if (e.type === 'gameOver') sound.play(e.winner === g.youId ? 'win' : 'lose');
  }
}

/**
 * Make a penalty visible.
 *
 * The cards were always dealt - engine, server and wire all audited - but the
 * table showed almost none of it, because the opponent fan renders at most
 * twelve meshes keyed by index. Somebody already holding twelve who ate a +16
 * got no new cards on screen at all, so a correctly applied penalty looked
 * like nothing happening at all.
 *
 * Handled here rather than inside the fan because a penalty is an EVENT, not
 * a hand size: it must be shown even when the hand it lands in is already
 * bigger than the table can draw.
 */
function showPenalties(g: PlayableGame, state: RedactedState) {
  const aspect = window.innerWidth / window.innerHeight;
  for (const [player, count] of penalties(g.lastEvents)) {
    view.penalty(state, player, count, aspect);
    hud?.flashPenalty(player, count);
  }
}

function refreshHud() {
  const g = game;
  const state = g?.view();
  if (!g || !state || !hud) return;

  hud.chips(state);
  hud.rail(state, voiceView(), g instanceof NetworkGame ? g.spectators : 0);
  hud.log(g.log);
  if (g.chat) {
    hud.chat(g.chat);
    hud.typing(g.typingNames?.() ?? []);
  }

  hud.handScroll(
    view.handScrollable
      ? {
          at: view.handScrollAt,
          onPan: (dir) => {
            // A click moves about a third of a screen, which is far enough to
            // feel like progress and short enough to keep your place.
            if (view.panHand(dir * handWidthBudget() * 0.34)) {
              relayout();
              refreshHud();
            }
          },
        }
      : null,
  );
  hud.corner([
    {
      label: sound.enabled ? 'Sound on' : 'Sound off',
      onClick: () => {
        const on = sound.toggle();
        localStorage.setItem('uno:muted', on ? '0' : '1');
        refreshHud();
      },
    },
    { label: 'Leave', onClick: toMenu },
  ]);

  renderUnoShout(g, state);

  const spec = decidePrompt(state, {
    youId: g.youId,
    isOver: g.isOver,
    spectator: !!g.spectator,
    waiting: g.waitingOnHuman(),
    aggressor: lastAggressor(g, state),
  });

  switch (spec.kind) {
    case 'none':
      return hud.clearPrompt();

    case 'waiting':
      return hud.prompt({
        label: spec.spectating ? `Spectating — ${spec.who} to play` : `${spec.who}…`,
      });

    case 'color':
      return hud.prompt({
        kind: 'decision',
        label: spec.label,
        colors: [...COLORS],
        onPick: (c: Color) =>
          g.apply(
            spec.action === 'chooseColor'
              ? { type: 'chooseColor', player: g.youId, color: c }
              : { type: 'chooseRouletteColor', player: g.youId, color: c },
          ),
      });

    case 'swap':
      return hud.prompt({
        kind: 'decision',
        label: 'You played a 7 — take someone else\'s hand',
        buttons: [
          ...spec.targets.map((t) => ({
            label: t.name,
            // The count is the whole decision, so it gets its own line rather
            // than being tucked in brackets after the name.
            sub: `${t.handCount} ${t.handCount === 1 ? 'card' : 'cards'}`,
            onClick: () => g.apply({ type: 'chooseSwapTarget', player: g.youId, target: t.id }),
          })),
          // House rule. Off in the printed game, where a 7 obliges you to swap.
          ...(spec.mayDecline
            ? [
                {
                  label: 'Keep mine',
                  sub: `${spec.ownHand} ${spec.ownHand === 1 ? 'card' : 'cards'}`,
                  onClick: () => g.apply({ type: 'declineSwap', player: g.youId }),
                },
              ]
            : []),
        ],
      });

    /*
     * A live draw stack is a DECISION, not a turn.
     *
     * It used to render as an ordinary turn: the prompt said "click a card to
     * play it" while the stack rules made almost every card in your hand
     * illegal, the penalty was a chip in the top strip fourth in a row of
     * chips, and clicking a card did nothing at all. The rule was enforced
     * perfectly and the interface never said so, which reads as a broken game
     * rather than a punishment.
     *
     * There is deliberately no "Draw a card" button on this plate: while a
     * stack is live the engine rejects a plain draw, so the button could only
     * ever do nothing.
     */
    case 'stack':
      return hud.prompt({
        kind: 'decision',
        tone: 'danger',
        label: `${spec.by ?? 'You have been'} hit ${spec.by ? 'you ' : ''}with +${spec.total}`,
        sub: spec.canStack
          ? `Play a +${spec.need} or bigger to pass it on — or take all ${spec.total}.`
          : `Nothing in your hand is a +${spec.need} or bigger. You have to take all ${spec.total}.`,
        buttons: [
          {
            label: `Take ${spec.total} cards`,
            onClick: () => g.apply({ type: 'takeStack', player: g.youId }),
          },
        ],
      });

    case 'turn': {
      const narrow = window.innerWidth < 560;
      return hud.prompt({
        label: narrow
          ? isTouch
            ? 'Your turn — tap a card, tap again to play'
            : 'Your turn'
          : 'Your turn — click a card to play it',
        buttons: [
          {
            label: 'Draw a card',
            onClick: () => g.apply({ type: 'draw', player: g.youId }),
          },
        ],
      });
    }
  }
}

/**
 * Who played the card that is currently sitting on top of the stack.
 *
 * Read from the event stream rather than inferred from seat order: with a
 * Skip Everyone or a reversal in the mix, "the player before you" is not
 * reliably the player who hit you.
 */
function lastAggressor(g: PlayableGame, state: RedactedState): string | null {
  for (let i = g.lastEvents.length - 1; i >= 0; i--) {
    const e = g.lastEvents[i]!;
    if (e.type === 'cardPlayed' && e.card.id === state.discardTop?.id) return e.player;
  }
  return null;
}

/**
 * Show the UNO button when there is something to shout about.
 *
 * Rendered outside the prompt flow because it must survive every early return
 * below - you can be caught out while a colour picker is on screen, and it is
 * not your turn when you are catching someone else.
 */
function renderUnoShout(g: PlayableGame, state: RedactedState): void {
  if (!hud) return;
  const at = state.unoRisk;
  if (g.isOver || !at || g.spectator) return hud.uno(null);

  if (at === g.youId) {
    return hud.uno({
      label: 'LAST CARD!',
      sub: 'say it before they do',
      kind: 'call',
      onClick: () => g.apply({ type: 'callUno', player: g.youId }),
    });
  }

  const name = state.players.find((p) => p.id === at)?.name ?? 'they';
  hud.uno({
    label: 'LAST CARD!',
    sub: `catch ${name} — they forgot`,
    kind: 'catch',
    onClick: () => g.apply({ type: 'catchUno', player: g.youId }),
  });
}

function finishGame(g: PlayableGame) {
  if (recorded) return;
  recorded = true;

  const won = g.winner === g.youId;

  // Only solo games have a meaningful local record; a networked game's stats
  // would need the server to attest them.
  if (g instanceof LocalGame && gameMeta) {
    const raw = g.raw;
    const you = raw.players.find((p) => p.id === g.youId);
    const worstHit = g.log.reduce((max, l) => {
      const m = /ate the stack - (\d+) cards/.exec(l.text);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    store.record({
      playedAt: gameMeta.startedAt,
      seed: raw.rng >>> 0,
      players: raw.players.length,
      bots: gameMeta.bots,
      difficulty: gameMeta.difficulty,
      won,
      eliminated: !!you?.eliminated,
      turns: g.log.length,
      eliminations: raw.players.filter((p) => p.eliminated).length,
      worstHit,
      durationMs: Date.now() - gameMeta.startedAt,
    });
  }

  const final = g.view();
  /*
   * Fall back to the last player standing, never to "Nobody".
   *
   * The engine cannot produce a null winner - every ending resolves to a
   * player, including the one where a stack eliminates the last two at once.
   * So if the id does not resolve here, the fault is on this side of the
   * wire, and the right answer is still whoever is left at the table rather
   * than a screen telling four people that nobody won.
   */
  const standing = final?.players.filter((p) => !p.eliminated) ?? [];
  const winnerName =
    final?.players.find((p) => p.id === g.winner)?.name ??
    (standing.length === 1 ? standing[0]!.name : null) ??
    final?.players.find((p) => p.finished)?.name ??
    'Nobody';

  /*
   * Read the reason off the final table rather than threading it through the
   * network protocol: the redacted state already says everything needed, and
   * a LAN game and a bot game then explain themselves identically.
   */
  const reason: GameOverReason = final?.players.some((p) => p.finished)
    ? 'wentOut'
    : (final?.players.filter((p) => !p.eliminated && !p.finished).length ?? 0) === 1
      ? 'lastStanding'
      : 'fewestCards';

  // Let the final animation land before the panel covers the table.
  window.setTimeout(() => {
    screens.gameOver(
      won,
      winnerName,
      reason,
      () => {
        if (gameMeta && game instanceof LocalGame) {
          startSolo(gameMeta.bots, gameMeta.difficulty as Difficulty);
        } else {
          toMenu();
        }
      },
      toMenu,
    );
  }, 900);
}

// --- pointer interaction ---------------------------------------------------

/**
 * Re-run the layout without a state change - a hover, a pan, an arrow click.
 *
 * The width budget MUST come from handWidthBudget(). It was passing
 * `stage.camera.fov` here, a field that happens to be a number and is
 * therefore a legal argument, but it is fifty-odd DEGREES being read as
 * fifty-odd WORLD UNITS. The fan was handed roughly five times the room that
 * exists, so it kept its cards a comfortable 1.12 widths apart and ran a
 * twenty-card hand some twenty units wide across a nine-unit viewport. The
 * overflow came out as zero at the same time, which took the scroll away too:
 * the hand blew off both edges on the first hover and could not be panned
 * back. The initial deal looked right because that path (onStateChange) was
 * always measuring properly - only hovering broke it.
 */
function relayout() {
  const g = game;
  const state = g?.view();
  if (state) {
    /*
     * Hand only. A hover or a pan moves no opponent's card, no pile and no
     * discard, but this went through the full update() - so sweeping a pointer
     * along the fan re-walked the entire table dozens of times a second.
     */
    view.reflowHand(state, window.innerWidth / window.innerHeight, handWidthBudget());
  }
}

function playable(): { hand: readonly { id: string }[] } | null {
  const g = game;
  if (!g || g.isOver || g.spectator || !g.waitingOnHuman()) return null;
  const state = g.view();
  if (!state || state.phase.type !== 'play') return null;
  return { hand: state.players.find((p) => p.id === g.youId)?.hand ?? [] };
}

/**
 * Panning the hand.
 *
 * Past about twenty cards on a narrow screen the fan stops compressing and
 * starts running off both edges - legible cards you can scroll to beat
 * illegible ones that all fit. Drag, swipe or wheel moves the row.
 *
 * A drag must never also count as playing a card, so the pointerup handler
 * checks how far the pointer travelled before committing. The threshold is in
 * CSS pixels because that is what a finger's wobble is measured in.
 */
const DRAG_SLOP = 7;
let dragFrom: { x: number; y: number } | null = null;
let dragged = false;

/** Screen pixels to world units at the hand's depth. */
function worldPerPixel(): number {
  return handWidthBudget() / Math.max(1, window.innerWidth);
}

canvas.addEventListener('pointermove', (e) => {
  if (dragFrom) {
    const dx = e.clientX - dragFrom.x;
    if (!dragged && Math.abs(dx) > DRAG_SLOP && Math.abs(dx) > Math.abs(e.clientY - dragFrom.y)) {
      dragged = true;
    }
    if (dragged) {
      // Drag right, the row follows right - so the scroll offset goes down.
      if (view.panHand(-dx * worldPerPixel())) relayout();
      dragFrom = { x: e.clientX, y: e.clientY };
      return;
    }
  }
  if (isTouch) return; // a finger "moving" is a drag, not a hover
  if (!playable()) return;
  const hit = view.pick(e.clientX, e.clientY, stage.camera);
  if (hit !== view.selected) {
    view.selected = hit;
    relayout();
  }
});

canvas.addEventListener('wheel', (e) => {
  if (!view.handScrollable) return;
  // Trackpads report horizontal intent in deltaX; a wheel only has deltaY.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (view.panHand(delta * worldPerPixel())) {
    e.preventDefault();
    relayout();
    refreshHud();
  }
}, { passive: false });

canvas.addEventListener('pointercancel', () => {
  dragFrom = null;
  dragged = false;
});

canvas.addEventListener('pointerdown', (e) => {
  sound.resume();
  dragFrom = { x: e.clientX, y: e.clientY };
  dragged = false;
});

/*
 * Committing happens on pointerUP, not down.
 *
 * It has to: the difference between playing a card and scrolling the hand is
 * whether the pointer moved afterwards, and on pointerdown that is not known
 * yet. Acting on the press meant every attempt to swipe the row past a card
 * played that card instead.
 */
canvas.addEventListener('pointerup', (e) => {
  const wasDrag = dragged;
  dragFrom = null;
  dragged = false;
  if (wasDrag) return;

  const ctx = playable();
  if (!ctx) return;

  const hit = view.pick(e.clientX, e.clientY, stage.camera);

  if (isTouch) {
    // Tapping away from the hand just clears the selection.
    if (hit < 0) {
      if (view.selected !== -1) {
        view.selected = -1;
        relayout();
      }
      return;
    }
    // First tap on a card raises it; second tap on the same card commits.
    if (hit !== view.selected) {
      view.selected = hit;
      relayout();
      sound.play('draw');
      return;
    }
  }

  if (hit < 0) return;
  const card = ctx.hand[hit];
  if (!card) return;
  // The engine rejects illegal moves; applying is how we find out.
  game?.apply({ type: 'play', player: game.youId, cardId: card.id });
  view.selected = -1;
});

// --- screens ---------------------------------------------------------------

function toMenu() {
  detach();
  screens.menu({
    defaultName,
    serverUrl: SERVER_URL,
    multiplayer: MULTIPLAYER_AVAILABLE,
    onStats: () =>
      screens.stats(
        store.stats(),
        store.recent(8),
        toMenu,
        () => {
          store.clear();
          toMenu();
        },
      ),
    onChoose: (choice) => {
      sound.resume();
      if (choice.kind === 'solo') return startSolo(choice.bots, choice.difficulty);

      localStorage.setItem('uno:name', choice.name);
      const net = new NetworkGame({
        url: SERVER_URL,
        name: choice.name,
        mode:
          choice.kind === 'host'
            ? {
                kind: 'create',
                settings: {
                  ...DEFAULT_ROOM_SETTINGS,
                  botCount: choice.bots,
                  difficulty: choice.difficulty,
                  maxPlayers: choice.seats,
                },
              }
            : choice.kind === 'join'
              ? { kind: 'join', code: choice.code }
              : { kind: 'spectate', code: choice.code },
      });
      watchLobby(net);
    },
  });
}

/** Sit in the lobby until the server actually deals. */
function watchLobby(net: NetworkGame) {
  let attached = false;
  const render = () => {
    if (attached) return;
    if (net.view()) {
      attached = true;
      off();
      attach(net);
      return;
    }
    screens.lobby({
      code: net.code,
      players: net.lobby,
      settings: net.settings,
      isHost: net.isHost,
      youId: net.youId,
      error: net.status === 'error' || net.status === 'closed' ? net.error : null,
      connecting: net.status === 'connecting',
      onStart: () => net.start(),
      onSettings: (s) => net.updateSettings(s),
      onLeave: () => {
        off();
        net.leave();
        toMenu();
      },
    });
  };
  const off = net.subscribe(render);
  render();
}

// --- dev handle ------------------------------------------------------------

/*
 * A handle for the browser-driven checks, in dev builds only.
 *
 * The layout bugs in this file - a fan wider than the viewport, a budget
 * measured on the wrong plane - are all things you can only catch by measuring
 * where the cards actually ARE, and doing that through clicks alone is slower
 * than the bugs deserve. `import.meta.env.DEV` is statically false in a
 * production build, so the bundler drops this whole branch: there is nothing to
 * remember to strip and nothing to leak.
 */
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__table = {
    get game() {
      return game;
    },
    view,
    stage,
    handWidthBudget,
  };
}

// --- boot ------------------------------------------------------------------

screens.loading('Drawing the deck…');
// Give the browser a frame to paint the loading text before we block it
// rasterising seventy card faces.
requestAnimationFrame(() => {
  warmCardArt();
  toMenu();
  requestAnimationFrame(frame);
});
