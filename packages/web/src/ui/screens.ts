/**
 * The HTML layer: menus, lobby, stats, and the in-game HUD.
 *
 * Three draws the table; everything that is text lives here as DOM, because
 * text rendered into WebGL is worse at every one of the things text needs to
 * be good at - selection, accessibility, reflow and crispness.
 */

import { COLORS, type Color, type GameOverReason, type RedactedState } from '@mercy/engine';
import type { Difficulty } from '@mercy/bots';
import {
  HOUSE_RULE_LIMITS,
  TURN_SECONDS,
  type BotSpeed,
  type ChatMessage,
  type HouseRules,
  type LobbyPlayer,
  type RoomSettings,
  type TurnSeconds,
} from '@mercy/protocol';
import { CARD_COLORS } from '../scene/cardArt.js';
import type { LogEntry } from '../game/narrate.js';
import type { Stats } from '../game/store.js';
import { clear, el } from './dom.js';

/** How long a chat line stays at full strength before it fades out. */
const TICKER_LIFE_MS = 12000;
/** Lines kept on screen at once. Older ones drop off the top. */
const TICKER_LINES = 4;
/** How long "+16" stays against a name after a penalty lands. */
const PENALTY_HOLD_MS = 2600;

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const BLURB: Record<Difficulty, string> = {
  easy: 'Plays a random legal card. Good for learning the rules.',
  medium: 'Holds its draw cards for defence and steers toward its best colour.',
  hard: 'Counts the deck, tracks what you are void in, and targets whoever is closest to going out.',
};

/**
 * Per-player microphone state, as the rail draws it.
 *
 *   none  - not in voice at all (a bot, or somebody who never joined)
 *   on    - connected and quiet
 *   muted - connected, microphone closed
 *   live  - talking right now
 */
export type VoiceState = 'none' | 'on' | 'muted' | 'live';
export type VoiceView = Record<string, VoiceState>;

export type MenuChoice =
  | { kind: 'solo'; bots: number; difficulty: Difficulty }
  | { kind: 'host'; bots: number; difficulty: Difficulty; name: string; seats: number }
  | { kind: 'join'; code: string; name: string }
  | { kind: 'spectate'; code: string; name: string };

export class Screens {
  /**
   * Whether the house-rules disclosure is open.
   *
   * Held on the instance because the lobby is rebuilt from scratch every time
   * the server broadcasts settings - which is on every toggle. Without this,
   * changing a rule collapses the panel you are working in.
   */
  private advancedOpen = false;

  constructor(private readonly root: HTMLElement) {}

  private panel(...children: (Node | string)[]): HTMLElement {
    const screen = el('div', { class: 'screen' }, [el('div', { class: 'card-panel' }, children)]);
    clear(this.root);
    this.root.append(screen);
    return screen;
  }

  /**
   * Two panes: who you are on the left, what you are deciding on the right.
   *
   * Every screen used to be one centred column, and on anything wider than a
   * phone that column used about a third of the width - so the page read as a
   * dialog box floating in a void rather than as a place. Worse, a single
   * stacked width forces everything to the same visual weight: the four ways
   * to play, the bot-count stepper and the Deal button each got one full-width
   * row, as though choosing to host and nudging a number were decisions of the
   * same size.
   *
   * The left pane is stable - identity, context, the way out. The right pane
   * is what changes as you make choices. Two fixed zones instead of one
   * growing stack, and the eye learns where each kind of thing lives.
   *
   * On a phone it collapses to exactly the old single column, because at that
   * width the old answer was the right one.
   *
   * Deliberately NOT applied to the short screens - Connecting, Could not
   * join, Game over. Those are moments rather than pages, with three elements
   * between them; splitting three things across two panes leaves one pane
   * empty and looks like a mistake. They keep panel().
   */
  private split(left: (Node | string)[], right: (Node | string)[]): HTMLElement {
    const screen = el('div', { class: 'screen' }, [
      el('div', { class: 'card-panel split' }, [
        el('div', { class: 'pane-left' }, left),
        el('div', { class: 'pane-right' }, right),
      ]),
    ]);
    clear(this.root);
    this.root.append(screen);
    return screen;
  }

  close(): void {
    clear(this.root);
  }

  loading(message: string): void {
    clear(this.root);
    this.root.append(el('div', { class: 'loading', text: message }));
  }

  // --- main menu -----------------------------------------------------------

  menu(opts: {
    defaultName: string;
    onChoose: (c: MenuChoice) => void;
    onStats: () => void;
    serverUrl: string;
    /** False on a static host with no reachable game server. */
    multiplayer: boolean;
  }): void {
    let bots = 3;
    // Hosting starts with NO bots. You are opening a table for people; bots
    // are something you add afterwards if seats go unfilled.
    let hostSeats = 4;
    let difficulty: Difficulty = 'medium';
    let name = opts.defaultName;
    let code = '';
    let mode: 'solo' | 'host' | 'join' | 'spectate' = 'solo';

    const render = () => {
      const needsName = mode !== 'solo';
      const needsCode = mode === 'join' || mode === 'spectate';
      // Bot count and difficulty only make sense when you ARE the opposition
      // setup - i.e. a solo game. Hosting configures those in the lobby, once
      // you can see who actually turned up.
      const needsBots = mode === 'solo';
      const needsSeats = mode === 'host';

      const online = (m: typeof mode) => m !== 'solo';

      /**
       * Each mode is a card that says what it does.
       *
       * The previous row of four bare words made the reader guess at the
       * difference between "Host" and "Join", and gave a disabled button no
       * way to explain itself.
       */
      const modeCard = (m: typeof mode, label: string, blurb: string) => {
        // Online modes stay VISIBLE but disabled when no server is reachable.
        // Hiding them just raises the question "where did they go?".
        const blocked = online(m) && !opts.multiplayer;
        return el(
          'button',
          {
            class: 'mode-card',
            'aria-pressed': mode === m,
            disabled: blocked,
            title: blocked ? 'Needs a game server — see the note below' : undefined,
            onClick: () => {
              if (blocked) return;
              mode = m;
              render();
            },
          },
          [
            el('span', { class: 'mode-name', text: label }),
            el('span', { class: 'mode-blurb', text: blurb }),
          ],
        );
      };

      const body: Node[] = [
        el('div', { class: 'mode-grid' }, [
          modeCard('solo', 'Play vs bots', 'Offline. Start immediately.'),
          modeCard('host', 'Host a game', 'Open a table, share a code.'),
          modeCard('join', 'Join a game', "Enter a friend's code."),
          modeCard('spectate', 'Spectate', 'Watch without playing.'),
        ]),
      ];

      if (!opts.multiplayer) {
        body.push(
          el('div', { class: 'notice' }, [
            el('strong', { text: 'Online play is off on this build' }),
            el('span', {
              text: 'This page is hosted on GitHub Pages, which serves files but cannot run a game server — so there is nothing for Host, Join or Spectate to connect to. Playing against bots works fully.',
            }),
            el('span', {
              class: 'how',
              text: 'To play with friends: clone the repo and run "bun run serve", or deploy the included render.yaml for a single URL that does both.',
            }),
          ]),
        );
      }

      if (needsBots) {
        body.push(
          el('div', { class: 'section' }, [
            el('h3', { class: 'section-title', text: 'Game setup' }),
            el('div', { class: 'row' }, [
              el('label', { text: 'Opponents' }),
              el('div', { class: 'stepper' }, [
                el('button', {
                  text: '−',
                  'aria-label': 'Fewer opponents',
                  onClick: () => {
                    bots = Math.max(mode === 'host' ? 0 : 1, bots - 1);
                    render();
                  },
                }),
                el('span', { class: 'value', text: `${bots} bot${bots === 1 ? '' : 's'}` }),
                el('button', {
                  text: '+',
                  'aria-label': 'More opponents',
                  onClick: () => {
                    bots = Math.min(9, bots + 1);
                    render();
                  },
                }),
              ]),
            ]),
            el('div', { class: 'row' }, [
              el('label', { text: 'Difficulty' }),
              el(
                'div',
                { class: 'seg' },
                DIFFICULTIES.map((d) =>
                  el('button', {
                    'aria-pressed': difficulty === d,
                    text: d,
                    onClick: () => {
                      difficulty = d;
                      render();
                    },
                  }),
                ),
              ),
            ]),
            el('p', { class: 'hint', text: BLURB[difficulty] }),
          ]),
        );
      }

      if (needsSeats) {
        body.push(
          el('div', { class: 'section' }, [
            el('h3', { class: 'section-title', text: 'Your table' }),
            el('div', { class: 'row' }, [
              el('label', { text: 'Table size' }),
              el('div', { class: 'stepper' }, [
                el('button', {
                  text: '−',
                  'aria-label': 'Smaller table',
                  onClick: () => {
                    hostSeats = Math.max(2, hostSeats - 1);
                    render();
                  },
                }),
                el('span', { class: 'value', text: `${hostSeats} seats` }),
                el('button', {
                  text: '+',
                  'aria-label': 'Bigger table',
                  onClick: () => {
                    hostSeats = Math.min(10, hostSeats + 1);
                    render();
                  },
                }),
              ]),
            ]),
            el('p', {
              class: 'hint',
              text: 'You get a room code to share. Add bots later if seats go unfilled.',
            }),
          ]),
        );
      }

      if (needsCode) {
        const input = el('input', {
          type: 'text',
          class: 'code-input',
          placeholder: 'K7QM',
          maxlength: 4,
          autocomplete: 'off',
          autocapitalize: 'characters',
          spellcheck: 'false',
          value: code,
          onInput: (e) => {
            code = (e.target as HTMLInputElement).value.toUpperCase();
            (e.target as HTMLInputElement).value = code;
          },
        });
        body.push(
          el('div', { class: 'section' }, [
            el('h3', { class: 'section-title', text: 'Room code' }),
            input,
          ]),
        );
      }

      if (needsName) {
        body.push(
          el('div', { class: 'section' }, [
            el('h3', { class: 'section-title', text: 'You' }),
            el('input', {
              type: 'text',
              placeholder: 'Your name',
              maxlength: 16,
              value: name,
              onInput: (e) => {
                name = (e.target as HTMLInputElement).value;
              },
            }),
            serverChip(opts.serverUrl),
          ]),
        );
      }

      const go = () => {
        if (mode === 'solo') return opts.onChoose({ kind: 'solo', bots, difficulty });
        const trimmed = name.trim() || opts.defaultName;
        if (mode === 'host') {
          // Zero bots: the host opens a table for people, then tops it up.
          return opts.onChoose({
            kind: 'host',
            bots: 0,
            difficulty,
            name: trimmed,
            seats: hostSeats,
          });
        }
        if (code.length !== 4) return;
        opts.onChoose(
          mode === 'join'
            ? { kind: 'join', code, name: trimmed }
            : { kind: 'spectate', code, name: trimmed },
        );
      };

      body.push(
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'primary',
            text: mode === 'solo' ? 'Deal' : mode === 'host' ? 'Create room' : 'Connect',
            onClick: go,
          }),
        ]),
      );

      this.split(
        [
          el('header', { class: 'masthead' }, [
            // Two spans, because the two words are set at different sizes: a
            // small spaced "No" over MERCY. See .masthead h1 in styles.css.
            el('h1', {
              html: "<span class='no'>No</span><span class='mercy'>Mercy</span>",
            }),
            el('p', {
              class: 'sub',
              text: '168 cards. Draw cards stack, 7s swap hands, 0s pass them along, and 25 cards knocks you out.',
            }),
          ]),
          // The left pane's foot. "Your record" is a way out of this screen,
          // not one of the things you came here to decide, so it belongs with
          // the identity rather than beside Deal - which is what made the two
          // of them read as an equal pair of buttons.
          el('div', { class: 'pane-foot' }, [
            el('button', { text: 'Your record', onClick: opts.onStats }),
          ]),
        ],
        body,
      );
    };

    render();
  }

  // --- lobby ---------------------------------------------------------------

  lobby(opts: {
    code: string;
    players: LobbyPlayer[];
    settings: RoomSettings | null;
    isHost: boolean;
    youId: string;
    error: string | null;
    connecting: boolean;
    onStart: () => void;
    onLeave: () => void;
    onSettings: (s: Partial<RoomSettings>) => void;
  }): void {
    if (opts.connecting) {
      this.panel(
        el('h2', { text: 'Connecting…' }),
        el('p', { class: 'sub', text: 'Reaching the game server.' }),
        el('div', { class: 'actions' }, [el('button', { text: 'Cancel', onClick: opts.onLeave })]),
      );
      return;
    }

    if (opts.error) {
      this.panel(
        el('h2', { text: 'Could not join' }),
        el('p', { class: 'err', text: opts.error }),
        el('div', { class: 'actions' }, [
          el('button', { class: 'primary', text: 'Back to menu', onClick: opts.onLeave }),
        ]),
      );
      return;
    }

    const humans = opts.players.filter((p) => !p.isBot);
    const seats = opts.settings?.maxPlayers ?? 6;
    const rows = opts.players.map((p) =>
      el('div', {}, [
        el('span', { text: p.name + (p.id === opts.youId ? '  (you)' : '') }),
        el('span', {
          class: 'tag',
          text: [p.isBot ? 'bot' : null, p.isHost ? 'host' : null, p.connected ? null : 'away']
            .filter(Boolean)
            .join(' · '),
        }),
      ]),
    );
    // Show the empty seats too, so "who else is coming" is visible at a glance.
    for (let i = humans.length; i < seats; i++) {
      rows.push(
        el('div', { class: 'empty-seat' }, [
          el('span', { text: 'empty seat' }),
          el('span', { class: 'tag', text: 'waiting' }),
        ]),
      );
    }

    const controls: Node[] = [];
    if (opts.isHost && opts.settings) {
      const s = opts.settings;
      controls.push(
        el('div', { class: 'row' }, [
          el('label', { text: 'Fill seats with bots' }),
          el('div', { class: 'stepper' }, [
            el('button', {
              text: '−',
              onClick: () => opts.onSettings({ botCount: Math.max(0, s.botCount - 1) }),
            }),
            el('span', {
              class: 'value',
              text: s.botCount === 0 ? 'none' : `${s.botCount} bot${s.botCount === 1 ? '' : 's'}`,
            }),
            el('button', {
              text: '+',
              onClick: () => opts.onSettings({ botCount: Math.min(9, s.botCount + 1) }),
            }),
          ]),
        ]),
      );
      // Difficulty is meaningless with no bots on the table.
      if (s.botCount > 0) {
        controls.push(
          el('div', { class: 'row' }, [
            el('label', { text: 'Bot difficulty' }),
            el(
              'div',
              { class: 'seg' },
              DIFFICULTIES.map((d) =>
                el('button', {
                  'aria-pressed': s.difficulty === d,
                  text: d,
                  onClick: () => opts.onSettings({ difficulty: d }),
                }),
              ),
            ),
          ]),
        );
      }
    }

    const rules = opts.settings?.rules;
    if (rules) {
      if (opts.isHost) {
        controls.push(
          houseRuleControls(
            opts.settings!,
            this.advancedOpen,
            (open) => {
              this.advancedOpen = open;
            },
            (patch) => opts.onSettings({ rules: { ...rules, ...patch } }),
            (patch) => opts.onSettings(patch),
          ),
        );
      } else {
        // Joiners cannot change the rules but must be able to see them.
        controls.push(el('p', { class: 'hint', text: `House rules: ${houseRuleSummary(rules)}` }));
      }
    }

    this.split(
      [
        el('h2', { text: 'Waiting room' }),
        // The code is the one thing on this screen somebody has to read out
        // across a room, so it gets a pane to itself.
        el('div', { class: 'code-display', text: opts.code }),
        el('p', {
          class: 'sub',
          text: opts.isHost
            ? 'Read that code out. Everyone else picks "Join a game" and types it.'
            : 'Waiting for the host to deal.',
        }),
      ],
      [
        el('p', {
          class: 'hint',
          text: `${humans.length} of ${seats} seat${seats === 1 ? '' : 's'} taken`,
        }),
        el('div', { class: 'players' }, rows),
        ...controls,
        el('div', { class: 'actions' }, [
          opts.isHost
            ? el('button', {
                class: 'primary',
                // One human and no bots is not a game; say so on the button.
                text:
                  humans.length + (opts.settings?.botCount ?? 0) < 2
                    ? 'Waiting for players…'
                    : 'Deal',
                disabled: humans.length + (opts.settings?.botCount ?? 0) < 2,
                onClick: opts.onStart,
              })
            : el('button', { text: 'Waiting…', disabled: true }),
          el('button', { text: 'Leave', onClick: opts.onLeave }),
        ]),
      ],
    );
  }

  // --- stats ---------------------------------------------------------------

  stats(s: Stats, recent: { won: boolean; difficulty: string; players: number; turns: number; worstHit: number }[], onBack: () => void, onClear: () => void): void {
    const body: Node[] = [];

    if (s.games === 0) {
      body.push(el('p', { class: 'sub', text: 'No games yet. Go and get eliminated a few times.' }));
    } else {
      body.push(
        el('div', { class: 'stat-grid' }, [
          stat('Played', String(s.games)),
          stat('Won', String(s.wins)),
          stat('Win rate', `${Math.round(s.winRate * 100)}%`),
          stat('Avg turns', s.avgTurns.toFixed(0)),
          stat('Worst hit', `+${s.worstHit}`),
        ]),
        el('h2', { text: 'By difficulty' }),
        el(
          'div',
          { class: 'table-list' },
          s.byDifficulty.map((d) =>
            el('div', {}, [
              el('span', { text: d.difficulty }),
              el('span', {
                class: 'muted',
                text: `${d.wins} / ${d.games}  (${d.games ? Math.round((d.wins / d.games) * 100) : 0}%)`,
              }),
            ]),
          ),
        ),
        el('h2', { text: 'Recent' }),
        el(
          'div',
          { class: 'table-list' },
          recent.map((m) =>
            el('div', {}, [
              el('span', { text: `${m.won ? 'Won' : 'Lost'} · ${m.difficulty} · ${m.players}p` }),
              el('span', {
                class: 'muted',
                text: `${m.turns} turns${m.worstHit ? ` · worst +${m.worstHit}` : ''}`,
              }),
            ]),
          ),
        ),
      );
    }

    this.panel(
      el('h2', { text: 'Your record' }),
      ...body,
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', text: 'Back', onClick: onBack }),
        s.games > 0 ? el('button', { class: 'danger', text: 'Clear history', onClick: onClear }) : null,
      ].filter(Boolean) as Node[]),
    );
  }

  // --- game over -----------------------------------------------------------

  gameOver(
    won: boolean,
    winnerName: string,
    reason: GameOverReason,
    onAgain: () => void,
    onMenu: () => void,
  ): void {
    /*
     * Say what actually happened.
     *
     * A game can end three ways here and they do not feel remotely alike:
     * going out is a win you engineered, outlasting everyone is a win you
     * survived, and smallest-hand is a win by a nose when the cards ran out.
     * Collapsing all three into "wins" threw that away - and when the winner
     * could not be resolved at all this screen used to read "Nobody wins".
     */
    const headline = won
      ? {
          wentOut: 'You <span class="mercy">win</span>',
          lastStanding: 'Last one <span class="mercy">standing</span>',
          fewestCards: 'You <span class="mercy">win</span> on cards',
        }[reason]
      : `${escapeHtml(winnerName)} wins`;

    const blurb = won
      ? {
          wentOut: 'Hand empty, table beaten.',
          lastStanding: 'Everyone else hit twenty-five and went out the hard way.',
          fewestCards: 'The deck ran dry and you were holding the fewest cards.',
        }[reason]
      : {
          wentOut: `${winnerName} went out first. Better luck next hand.`,
          lastStanding: `${winnerName} outlasted everyone. Better luck next hand.`,
          fewestCards: `The deck ran dry and ${winnerName} held the fewest cards.`,
        }[reason];

    this.panel(
      el('h1', { html: headline }),
      el('p', { class: 'sub', text: blurb }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', text: 'Play again', onClick: onAgain }),
        el('button', { text: 'Menu', onClick: onMenu }),
      ]),
    );
  }
}

/**
 * House-rule controls for the host.
 *
 * Collapsed by default: most tables play the standard rules, and a wall of
 * toggles between "create room" and "deal" is noise for them.
 */
function houseRuleControls(
  settings: RoomSettings,
  open: boolean,
  onToggleOpen: (open: boolean) => void,
  onRules: (patch: Partial<HouseRules>) => void,
  onSettings: (patch: Partial<RoomSettings>) => void,
): HTMLElement {
  const rules = settings.rules;

  const stepper = (
    label: string,
    value: number,
    suffix: string,
    lo: number,
    hi: number,
    key: 'startingHand' | 'handLimit',
  ) =>
    el('div', { class: 'row' }, [
      el('label', { text: label }),
      el('div', { class: 'stepper' }, [
        el('button', {
          text: '−',
          'aria-label': `Decrease ${label}`,
          disabled: value <= lo,
          onClick: () => onRules({ [key]: value - 1 } as Partial<HouseRules>),
        }),
        el('span', { class: 'value', text: `${value} ${suffix}` }),
        el('button', {
          text: '+',
          'aria-label': `Increase ${label}`,
          disabled: value >= hi,
          onClick: () => onRules({ [key]: value + 1 } as Partial<HouseRules>),
        }),
      ]),
    ]);

  const toggle = (label: string, hint: string, value: boolean, onFlip: () => void) =>
    el('div', { class: 'row toggle-row' }, [
      el('div', { class: 'toggle-label' }, [
        el('label', { text: label }),
        el('span', { class: 'hint', text: hint }),
      ]),
      el('button', {
        class: value ? 'toggle on' : 'toggle',
        'aria-pressed': value,
        text: value ? 'On' : 'Off',
        onClick: onFlip,
      }),
    ]);

  const choice = <T extends string | number>(
    label: string,
    hint: string,
    options: { value: T; label: string }[],
    current: T,
    onPick: (v: T) => void,
  ) =>
    el('div', { class: 'row toggle-row' }, [
      el('div', { class: 'toggle-label' }, [
        el('label', { text: label }),
        el('span', { class: 'hint', text: hint }),
      ]),
      el(
        'div',
        { class: 'seg' },
        options.map((o) =>
          el('button', {
            'aria-pressed': current === o.value,
            text: o.label,
            onClick: () => onPick(o.value),
          }),
        ),
      ),
    ]);

  const group = (title: string, children: Node[]) =>
    el('div', { class: 'rule-group' }, [el('h3', { text: title }), ...children]);

  const body = el('div', { class: 'advanced-body' }, [
    group('The deal', [
      stepper(
        'Starting hand',
        rules.startingHand,
        'cards',
        HOUSE_RULE_LIMITS.startingHand.min,
        HOUSE_RULE_LIMITS.startingHand.max,
        'startingHand',
      ),
      stepper(
        'Mercy Rule at',
        rules.handLimit,
        'cards',
        Math.max(HOUSE_RULE_LIMITS.handLimit.min, rules.startingHand + 3),
        HOUSE_RULE_LIMITS.handLimit.max,
        'handLimit',
      ),
    ]),

    group('Mechanics', [
      toggle('Stacking', 'Answer a draw card instead of eating it', rules.stacking, () =>
        onRules({ stacking: !rules.stacking }),
      ),
      ...(rules.stacking
        ? [
            choice(
              'Stack rule',
              rules.stackMode === 'escalating'
                ? 'Beat the LAST card played — what the instruction sheet says'
                : rules.stackMode === 'sum'
                  ? 'Beat the whole running total — stacks die out after two cards'
                  : 'Any draw card answers any other — far more survivable',
              [
                { value: 'escalating' as const, label: 'Last card' },
                { value: 'sum' as const, label: 'Running total' },
                { value: 'any' as const, label: 'Any' },
              ],
              rules.stackMode,
              (v) => onRules({ stackMode: v }),
            ),
          ]
        : []),
      toggle('7s swap hands', "Play a 7, take someone else's hand", rules.sevenSwap, () =>
        onRules({ sevenSwap: !rules.sevenSwap }),
      ),
      ...(rules.sevenSwap
        ? [
            toggle(
              'May keep your hand',
              'House rule — the printed game obliges you to swap with somebody',
              rules.sevenDecline,
              () => onRules({ sevenDecline: !rules.sevenDecline }),
            ),
          ]
        : []),
      toggle('0s pass hands', 'Play a 0, everyone shifts their hand along', rules.zeroPass, () =>
        onRules({ zeroPass: !rules.zeroPass }),
      ),
      toggle(
        'Call last card',
        'One card left? Say it, or an opponent can catch you for 2',
        rules.unoCalls,
        () => onRules({ unoCalls: !rules.unoCalls }),
      ),
      toggle(
        'Draw until playable',
        'Keep drawing until you get something you can play',
        rules.drawUntilPlayable,
        () => onRules({ drawUntilPlayable: !rules.drawUntilPlayable }),
      ),
      toggle(
        'Force play',
        'A card you draw is played for you if it is playable',
        rules.forcePlay,
        () => onRules({ forcePlay: !rules.forcePlay }),
      ),
    ]),

    group('Table', [
      choice(
        'Bot speed',
        'How long bots pause before playing',
        [
          { value: 'fast' as const, label: 'Fast' },
          { value: 'normal' as const, label: 'Normal' },
          { value: 'slow' as const, label: 'Slow' },
        ],
        settings.botSpeed,
        (v: BotSpeed) => onSettings({ botSpeed: v }),
      ),
      choice(
        'Turn timer',
        settings.turnSeconds === 0
          ? 'No limit — one player walking away freezes the table'
          : `Auto-plays for anyone who takes over ${settings.turnSeconds}s`,
        TURN_SECONDS.map((t) => ({ value: t, label: t === 0 ? 'Off' : `${t}s` })),
        settings.turnSeconds,
        (v: TurnSeconds) => onSettings({ turnSeconds: v }),
      ),
      toggle(
        'Allow spectators',
        'Anyone with the code can watch without playing',
        settings.allowSpectators,
        () => onSettings({ allowSpectators: !settings.allowSpectators }),
      ),
    ]),
  ]);

  const panel = el('details', { class: 'advanced' }, [
    el('summary', {}, [
      el('span', { class: 'adv-title', text: 'Advanced setup' }),
      // Showing the current values makes this read as a settings row you can
      // act on, rather than a collapsed heading that might be anything.
      el('span', { class: 'adv-summary', text: houseRuleSummary(rules) }),
    ]),
    body,
  ]) as HTMLDetailsElement;
  panel.open = open;
  panel.addEventListener('toggle', () => onToggleOpen(panel.open));
  return panel;
}

/**
 * Which server this client will talk to, said the way a player would say it.
 *
 * This used to print the raw `wss://host` address as a hint under the name
 * field - correct, and exactly the kind of thing that makes a game look like
 * somebody's dev build. The scheme is noise; the host is the only part anyone
 * would ever read, and a green dot says the rest.
 */
function serverChip(url: string): HTMLElement {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not a parseable URL: show it as given rather than swallowing it.
  }
  return el('div', { class: 'server-chip' }, [
    el('span', { class: 'dot' }),
    el('span', { text: 'Playing on ' }),
    el('span', { class: 'host', text: host }),
  ]);
}

/** One-line summary of any non-standard rules, for players who cannot edit. */
export function houseRuleSummary(rules: HouseRules): string {
  const parts: string[] = [`${rules.startingHand} cards`, `out at ${rules.handLimit}`];
  if (!rules.stacking) parts.push('no stacking');
  else if (rules.stackMode === 'any') parts.push('any-card stacking');
  else if (rules.stackMode === 'sum') parts.push('beat-the-total stacking');
  if (!rules.sevenSwap) parts.push('no 7-swaps');
  else if (rules.sevenDecline) parts.push('7s may decline');
  if (!rules.zeroPass) parts.push('no 0-passes');
  // These two are printed rules and default on, so it is turning them OFF
  // that is worth reporting.
  if (!rules.drawUntilPlayable) parts.push('draw one only');
  if (!rules.forcePlay) parts.push('no force play');
  if (!rules.unoCalls) parts.push('no UNO calls');
  return parts.join(' · ');
}

function stat(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v }),
  ]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The persistent in-game overlay: seats, chips, log, prompt, chat. */
export class Hud {
  readonly root: HTMLElement;
  private topbar: HTMLElement;
  private logBox: HTMLElement;
  private promptBox: HTMLElement;
  private cornerBox: HTMLElement;
  private unoBox: HTMLElement;
  private railBox: HTMLElement | null = null;
  private railRows = new Map<string, HTMLElement>();
  private chatBox: HTMLElement | null = null;
  private talking = false;
  private pushToTalk: ((on: boolean) => void) | null = null;
  private toggleMute: (() => void) | null = null;
  private scrollBox: HTMLElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  /** How many messages have already been drawn, so lines append once. */
  private chatSeen = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', {});
    this.topbar = el('div', { class: 'topbar' });
    this.logBox = el('div', { class: 'log' });
    this.promptBox = el('div', { class: 'prompt' });
    this.cornerBox = el('div', { class: 'corner' });
    // Its own layer, not part of the prompt: the UNO shout has to be able to
    // sit on screen at the same time as a colour picker or a stack warning.
    this.unoBox = el('div', { class: 'unobar' });
    this.root.append(this.topbar, this.logBox, this.promptBox, this.unoBox, this.cornerBox);
    parent.append(this.root);
  }

  destroy(): void {
    this.root.remove();
  }

  corner(buttons: { label: string; onClick: () => void }[]): void {
    clear(this.cornerBox);
    for (const b of buttons) {
      this.cornerBox.append(el('button', { text: b.label, onClick: b.onClick }));
    }
  }

  /**
   * Bottom edge of the top HUD furniture, in CSS pixels.
   *
   * Measured, not guessed. A fixed floor works until the prompt wraps to two
   * lines on a phone and its button row lands exactly where the top seat's
   * label sits - which is how "Draw a card" ended up underneath a name chip.
   */
  topReserved(): number {
    // A decision prompt sits in the middle of the screen, not the top strip,
    // so it must not push the seat labels down with it.
    const promptBottom = this.promptBox.classList.contains('decision')
      ? 0
      : this.promptBox.getBoundingClientRect().bottom;
    return Math.max(this.topbar.getBoundingClientRect().bottom, promptBottom) + 10;
  }

  /**
   * The turn order rail.
   *
   * Replaces four names floating on the felt at their 3D seats. Those had no
   * reading order, drifted with the camera and collided with the fans - and
   * the ONE state worth showing, whose turn it is, was invisible: the
   * highlight painted the name `var(--accent)`, which after the palette pass
   * is bone, and the idle colour `var(--ink)` is ALSO bone. Every seat
   * computed to the same rgb(233,227,213).
   *
   * So the marker is rebuilt out of channels that cannot collide with a suit
   * colour: idle rows drop to 42%, the active row goes to full white-bone,
   * gains a caret and a rule down its edge. Brightness and position, no hue.
   *
   * Listed in turn order from the viewer, so reading down the rail is reading
   * the order play will actually arrive in.
   */
  rail(state: RedactedState, voice?: VoiceView, spectators = 0): void {
    if (!this.railBox) {
      this.railBox = el('div', { class: 'rail' }, [
        el('div', { class: 'rail-head', text: 'Turn order' }),
      ]);
      this.root.append(this.railBox);
    }

    const me = Math.max(0, state.players.findIndex((p) => p.id === state.viewer));
    const n = state.players.length;
    // Rotate so the viewer leads, then follow the direction of play.
    const order = Array.from({ length: n }, (_, k) => {
      const step = state.direction === 1 ? k : n - k;
      return (me + step) % n;
    });

    const seen = new Set<string>();
    order.forEach((idx, slot) => {
      const p = state.players[idx]!;
      seen.add(p.id);
      let row = this.railRows.get(p.id);
      if (!row) {
        row = el('div', { class: 'row' }, [
          el('span', { class: 'caret', text: '\u25b8' }),
          el('span', { class: 'nm' }),
          el('span', { class: 'mic' }, [el('i'), el('i'), el('i')]),
          el('span', { class: 'ct' }),
        ]);
        this.railRows.set(p.id, row);
      }
      // Re-append in order rather than rebuilding: a row that survives can
      // animate its opacity instead of flashing.
      this.railBox!.append(row);
      row.style.order = String(slot);

      const out = p.eliminated || p.finished;
      row.dataset.turn = String(state.players[state.turn]?.id === p.id && !out);
      row.dataset.out = String(out);
      row.dataset.you = String(p.id === state.viewer);
      row.dataset.danger = String(!out && p.handCount / state.rules.handLimit > 0.8);

      row.querySelector('.nm')!.textContent =
        (p.eliminated ? '\u2620 ' : p.finished ? '\u2605 ' : '') +
        (p.id === state.viewer ? 'You' : p.name);
      row.querySelector('.ct')!.textContent = out ? (p.eliminated ? 'out' : 'done') : String(p.handCount);

      const mic = row.querySelector('.mic') as HTMLElement;
      const st = voice?.[p.id];
      mic.dataset.v = st ?? 'none';
      row.classList.toggle('talking', st === 'live');
    });

    for (const [id, row] of this.railRows) {
      if (!seen.has(id)) {
        row.remove();
        this.railRows.delete(id);
      }
    }

    // Watchers, as a count. Naming them would be telling the table who is in
    // the room, which a nickname on a join screen is not consent for.
    let watchers = this.railBox.querySelector('.watchers') as HTMLElement | null;
    if (spectators <= 0) {
      watchers?.remove();
      return;
    }
    if (!watchers) {
      watchers = el('div', { class: 'watchers' });
      this.railBox.append(watchers);
    }
    clear(watchers);
    watchers.append(
      el('b', { text: String(spectators) }),
      document.createTextNode(spectators === 1 ? ' watching' : ' watching'),
    );
  }

  chips(state: RedactedState): void {
    clear(this.topbar);

    const colorChip = el('div', { class: 'chip' });
    if (state.activeColor) {
      colorChip.append(
        el('span', {
          class: 'swatch',
          style: `background:${CARD_COLORS[state.activeColor]}`,
        }),
        document.createTextNode(state.activeColor),
      );
    } else {
      colorChip.textContent = 'no colour yet';
    }
    this.topbar.append(colorChip);

    this.topbar.append(
      el('div', {
        class: 'chip',
        text: state.direction === 1 ? '↻ clockwise' : '↺ anticlockwise',
      }),
      // Least essential of the three; hidden on phones so the row fits.
      el('div', { class: 'chip secondary', text: `${state.drawPileCount} in deck` }),
    );

    if (state.pendingDraw > 0) {
      this.topbar.append(
        el('div', {
          class: 'chip stack',
          text: `STACK +${state.pendingDraw} · need +${state.stackValue} or higher`,
        }),
      );
    }
  }

  log(entries: LogEntry[]): void {
    clear(this.logBox);
    // Column-reverse in CSS, so the newest entry is appended first.
    for (const e of entries.slice(-8).reverse()) {
      this.logBox.append(el('div', { class: e.tone, text: e.text }));
    }
  }

  /**
   * The prompt strip.
   *
   * Two quite different jobs wear the same element. Passive prompts ("Ada's
   * turn") are a quiet chip under the status row. DECISIONS - pick a colour,
   * pick who to swap with - move to the middle of the screen and become a
   * plate, because a choice that stops the game has to be impossible to miss.
   *
   * It used to be one treatment for both, in the top strip, where on a phone
   * it overlapped the status chips and the question was genuinely unreadable.
   */
  prompt(content: {
    label: string;
    /** A quieter second line under the headline. */
    sub?: string;
    kind?: 'passive' | 'decision';
    /** 'danger' for something being done TO you, like a draw stack. */
    tone?: 'danger';
    colors?: Color[];
    onPick?: (c: Color) => void;
    buttons?: { label: string; sub?: string; onClick: () => void }[];
  }): void {
    clear(this.promptBox);
    this.promptBox.classList.toggle('decision', content.kind === 'decision');
    this.promptBox.classList.toggle('danger', content.tone === 'danger');
    this.promptBox.append(el('div', { class: 'label', text: content.label }));
    if (content.sub) this.promptBox.append(el('p', { class: 'sub-line', text: content.sub }));

    if (content.colors) {
      this.promptBox.append(
        el(
          'div',
          { class: 'colorpick' },
          content.colors.map((c) =>
            el('button', {
              style: `background:${CARD_COLORS[c]}`,
              'aria-label': c,
              title: c,
              onClick: () => content.onPick?.(c),
            }),
          ),
        ),
      );
    }
    if (content.buttons?.length) {
      this.promptBox.append(
        el(
          'div',
          { class: 'choices' },
          content.buttons.map((b) =>
            el('button', { class: 'primary choice', onClick: b.onClick }, [
              el('span', { class: 'choice-label', text: b.label }),
              b.sub ? el('span', { class: 'choice-sub', text: b.sub }) : null,
            ].filter(Boolean) as Node[]),
          ),
        ),
      );
    }
  }

  clearPrompt(): void {
    clear(this.promptBox);
    this.promptBox.classList.remove('decision', 'danger');
  }

  /**
   * The last-card shout - yours to claim, or theirs to lose.
   *
   * One button either way, because at the table it is one word either way:
   * whoever says it first wins the exchange.
   */
  uno(content: { label: string; sub: string; kind: 'call' | 'catch'; onClick: () => void } | null): void {
    clear(this.unoBox);
    if (!content) return;
    this.unoBox.append(
      el('button', { class: `uno-shout ${content.kind}`, onClick: content.onClick }, [
        el('span', { class: 'word', text: content.label }),
        el('span', { class: 'sub', text: content.sub }),
      ]),
    );
  }

  /**
   * The chat ticker.
   *
   * Not a drawer. The old one was a panel that slid in from the right edge
   * with a vertical tab and an unread badge - furniture to open, close and
   * keep count for, sitting over an opponent's hand whenever it was open.
   *
   * This is how a game overlay does it: lines fade in at the bottom right,
   * sit for TICKER_LIFE_MS, and fade out. Nothing to open, so nothing can be
   * unread; the transcript is always the last few things said. The rule
   * underneath IS the input - press T and it lights up.
   *
   * Voice shares the same rule: push-to-talk on V, with the level meter for
   * everyone else living on the turn-order rail beside their name. One
   * cluster in one corner carries both channels.
   */
  enableChat(
    onSend: (text: string) => void,
    onTyping?: (typing: boolean) => void,
    voice?: {
      onTalk: (talking: boolean) => void;
      onToggleMute: () => void;
      available: boolean;
    },
  ): void {
    if (this.chatBox) return;

    const lines = el('div', { class: 'lines' });

    /*
     * Tell the table you are typing, and stop telling them when you stop.
     *
     * Throttled on the way out and expired on a timer at the other end, so a
     * dropped "stopped" message leaves an indicator that clears itself rather
     * than one that sticks forever.
     */
    let typingSent = 0;
    let typingIdle: number | undefined;
    const signal = (on: boolean) => {
      window.clearTimeout(typingIdle);
      if (!on) {
        typingSent = 0;
        onTyping?.(false);
        return;
      }
      const now = Date.now();
      if (now - typingSent > 2000) {
        typingSent = now;
        onTyping?.(true);
      }
      typingIdle = window.setTimeout(() => signal(false), 2500);
    };

    const input = el('input', {
      type: 'text',
      class: 'say',
      placeholder: 'Say something\u2026',
      maxlength: 200,
      onInput: (e) => signal(!!(e.target as HTMLInputElement).value),
      onKeydown: (e) => {
        const ev = e as KeyboardEvent;
        // Keys typed into the field are for the field, never for the table.
        ev.stopPropagation();
        if (ev.key === 'Escape') {
          signal(false);
          (ev.target as HTMLInputElement).blur();
          return;
        }
        if (ev.key !== 'Enter') return;
        const field = ev.target as HTMLInputElement;
        const value = field.value.trim();
        if (value) onSend(value);
        field.value = '';
        signal(false);
        field.blur();
      },
      onBlur: () => this.chatBox?.classList.remove('typing'),
      onFocus: () => this.chatBox?.classList.add('typing'),
    }) as HTMLInputElement;

    const ptt = el('button', { class: 'ptt', 'aria-label': 'Hold to talk' }, [
      el('span', { class: 'mic' }, [el('i'), el('i'), el('i')]),
      el('span', { class: 'ptt-label', text: 'Hold V' }),
    ]);

    const bar = el('div', { class: 'bar' }, [
      voice?.available ? ptt : null,
      input,
    ].filter(Boolean) as Node[]);

    this.chatBox = el('div', { class: 'ticker' }, [lines, bar]);
    this.root.append(this.chatBox);
    this.chatInput = input;

    if (!voice?.available) return;

    /*
     * Push to talk, mouse or key.
     *
     * Held rather than toggled by default: an open microphone at a card table
     * is four people's kitchens. A tap of M still toggles mute for anyone who
     * would rather leave it open.
     */
    const talk = (on: boolean) => {
      if (on === this.talking) return;
      this.talking = on;
      ptt.dataset.live = String(on);
      (ptt.querySelector('.mic') as HTMLElement).dataset.v = on ? 'live' : 'on';
      voice.onTalk(on);
    };
    ptt.addEventListener('pointerdown', () => talk(true));
    ptt.addEventListener('pointerup', () => talk(false));
    ptt.addEventListener('pointerleave', () => talk(false));
    this.pushToTalk = talk;
    this.toggleMute = voice.onToggleMute;
  }

  /**
   * Table keys, live only while the HUD is up.
   *
   * T opens the line, V holds the microphone, M toggles mute. Everything is
   * ignored while the text field has focus, so typing "victory" does not
   * broadcast three seconds of you typing it.
   */
  bindKeys(): () => void {
    const typing = () => document.activeElement === this.chatInput;

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      const k = e.key.toLowerCase();
      if (k === 't') {
        e.preventDefault();
        this.chatInput?.focus();
      } else if (k === 'v' && !e.repeat) {
        this.pushToTalk?.(true);
      } else if (k === 'm') {
        this.toggleMute?.();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v') this.pushToTalk?.(false);
    };
    // Releasing V outside the window would otherwise leave the mic open.
    const blur = () => this.pushToTalk?.(false);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }

  /**
   * Flash what a penalty cost somebody, against their name.
   *
   * The cards flying to their seat say that something happened; this says how
   * much. Sixteen cards arriving is hard to count and easy to disbelieve, and
   * the running hand total moving from 12 to 28 is not a number anybody reads
   * mid-animation.
   */
  flashPenalty(playerId: string, count: number): void {
    const row = this.railRows.get(playerId);
    if (!row || count < 1) return;
    row.querySelector('.hit')?.remove();
    const badge = el('span', { class: 'hit', text: `+${count}` });
    row.append(badge);
    window.setTimeout(() => badge.classList.add('going'), PENALTY_HOLD_MS);
    window.setTimeout(() => badge.remove(), PENALTY_HOLD_MS + 600);
  }

  /** Reflect the local microphone: muted, open, or off. */
  micState(state: VoiceState): void {
    const mic = this.chatBox?.querySelector('.ptt .mic') as HTMLElement | null;
    if (mic) mic.dataset.v = state;
    const label = this.chatBox?.querySelector('.ptt-label');
    if (label) label.textContent = state === 'muted' ? 'Muted' : 'Hold V';
    (this.chatBox?.querySelector('.ptt') as HTMLElement | null)?.setAttribute(
      'data-muted',
      String(state === 'muted'),
    );
  }

  chat(messages: ChatMessage[]): void {
    const box = this.chatBox?.querySelector('.lines') as HTMLElement | null;
    if (!box) return;

    /*
     * Append only what is new.
     *
     * Rebuilding the list every state change - which is every card played -
     * restarted each line's fade-in, so an old message flashed back to full
     * brightness every time anybody did anything.
     */
    for (const m of messages.slice(this.chatSeen)) {
      const row = el('div', { class: 'msg' }, [
        el('span', { class: 'who', text: m.name }),
        document.createTextNode(m.text),
      ]);
      box.append(row);
      window.setTimeout(() => row.classList.add('leaving'), TICKER_LIFE_MS);
      window.setTimeout(() => row.remove(), TICKER_LIFE_MS + 1200);
      while (box.children.length > TICKER_LINES) box.firstElementChild?.remove();
    }
    this.chatSeen = messages.length;
  }

  /**
   * Arrows for a hand too wide to fit.
   *
   * Drag and wheel both already work, but neither announces itself. These say
   * "there is more of your hand over there" and give a mouse a way to get at
   * it without learning that the felt is draggable.
   */
  handScroll(state: { at: number; onPan: (dir: -1 | 1) => void } | null): void {
    if (!state) {
      this.scrollBox?.remove();
      this.scrollBox = null;
      return;
    }
    if (!this.scrollBox) {
      this.scrollBox = el('div', { class: 'hand-scroll' }, [
        el('button', { 'aria-label': 'Earlier cards', text: '‹' }),
        el('button', { 'aria-label': 'Later cards', text: '›' }),
      ]);
      this.root.append(this.scrollBox);
    }
    const [left, right] = [...this.scrollBox.children] as HTMLButtonElement[];
    if (left) {
      left.onclick = () => state.onPan(-1);
      left.disabled = state.at <= -0.99;
    }
    if (right) {
      right.onclick = () => state.onPan(1);
      right.disabled = state.at >= 0.99;
    }
  }

  /** Who is mid-sentence, by name. Empty clears the line. */
  typing(names: string[]): void {
    if (!this.chatBox) return;
    let line = this.chatBox.querySelector('.typing') as HTMLElement | null;
    if (!line) {
      line = el('div', { class: 'typing' });
      this.chatBox.insertBefore(line, this.chatBox.querySelector('.bar'));
    }
    clear(line);
    if (names.length === 0) return;
    const who =
      names.length === 1
        ? `${names[0]} is typing`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing`
          : `${names.length} people are typing`;
    line.append(
      el('span', { text: who }),
      el('span', { class: 'dots' }, [el('i'), el('i'), el('i')]),
    );
  }
}

export { COLORS };
