/**
 * The reconciler: turns RedactedState into what is on the table.
 *
 * This is the only place that knows both about game state and about Three
 * objects. Everything it does is a diff: given the state the server (or the
 * local game) says is true, move what exists, spawn what is new, retire what
 * is gone - and animate the difference rather than snapping to it.
 *
 * Meshes are keyed so they survive across updates. That is what lets a card
 * the player is holding become the card on the discard pile, instead of one
 * vanishing and an unrelated one appearing.
 */

import { Group, Raycaster, Vector2, Vector3, type Scene } from 'three';
import { playableFor, type Card, type GameEvent, type RedactedState } from '@mercy/engine';
import { Animator, ease } from './anim.js';
import { makeCard, releaseCardMaterial, revealCard, setCardLit, type CardObject } from './card3d.js';
import {
  discardTransform,
  fanMetrics,
  drawTransform,
  opponentHandLayout,
  seatSqueeze,
  ownHandLayout,
  seatAngle,
  seatSpawn,
  type Transform,
} from './layout.js';

/*
 * Animation timings.
 *
 * Deliberately unhurried. The previous set was about a third faster and the
 * table read as cards teleporting: a +10 landing on someone is the loudest
 * thing that happens in this game and it was over before you had registered
 * it. Everything here is roughly 1.5x its old value.
 */
const DEAL_MS = 560;
const MOVE_MS = 450;
/*
 * A card thrown across the table.
 *
 * The duration was never the problem - the CURVE was. This ran on outQuint,
 * which has covered 83% of the distance at 30% of the time: the card snapped
 * to the pile and then crept the last few pixels, which reads as fast however
 * long you make it. A thrown card accelerates first, so the throw is eased in
 * AND out, and given enough time that the acceleration is legible.
 */
const PLAY_MS = 1100;
/** A card already on the table shuffling along to make room. */
const SETTLE_MS = 290;

/*
 * A penalty landing on somebody.
 *
 * Staggered rather than simultaneous: ten cards arriving at once is one
 * event, ten cards arriving in sequence is a count you can feel.
 */
const BURST_MS = 620;
const BURST_STAGGER = 85;
const BURST_MAX = 12;

/*
 * The hover is a SPRING, not a tween, and that is the whole point.
 *
 * A tween has a start. Sweeping a pointer along the fan changes every card's
 * destination several times a second, and because a keyed tween replaces the
 * one before it, each change restarted the motion from zero - throwing away
 * the progress of the last and dropping the card back onto the slow part of
 * the easing curve. Eased in and out, as the neighbours were, that is worst of
 * all: a tween restarted every 80ms never leaves its own slow start, so the
 * row appeared to lag the pointer and then lurch to catch up.
 *
 * Exponential approach has no start to restart. Every frame the card moves a
 * fixed FRACTION of the remaining distance, so re-aiming it is free: the
 * target simply changes and the motion carries on from the speed it already
 * had. Sweep the pointer as fast as you like and nothing stutters, because
 * nothing is ever interrupted.
 *
 * These are time constants in milliseconds - the time to close 63% of the gap.
 * The raised card is quickest because it is the one you asked for; the row
 * settles behind it a touch slower so the fan reads as following the lift
 * rather than racing it.
 */
const FOLLOW_LIFT_MS = 70;
const FOLLOW_ROW_MS = 115;
/** Close enough to stop stepping and snap, so an idle hand costs nothing. */
const FOLLOW_DONE = 0.0015;
/**
 * The largest frame step the spring will honour.
 *
 * A backgrounded tab hands back a dt of several seconds on its first frame,
 * and 1 - exp(-3000/70) is indistinguishable from 1: every card would teleport
 * to its slot the moment you came back to the window.
 */
const FOLLOW_MAX_DT = 50;

/**
 * How close two transforms must be to count as the same destination.
 *
 * Loose on purpose: the point is not floating-point equality, it is "close
 * enough that re-aiming at it would only restart the tween". A tween restarted
 * every frame never gets past the fast part of its curve, which is what turns a
 * fan of cards into a fan of cards that never quite arrives.
 */
const SAME_TARGET_EPS = 0.002;

/** How many face-down cards to actually render for a pile. */
const MAX_PILE_MESHES = 14;
const MAX_DISCARD_MESHES = 8;

interface Held {
  mesh: CardObject;
  /** Where it is meant to be, so we do not re-tween to the same place. */
  target?: Transform;
}

export class TableView {
  readonly root = new Group();
  readonly animator = new Animator();

  private held = new Map<string, Held>();
  /**
   * Hand cards currently chasing their slot, keyed to their time constant.
   *
   * Membership is ownership: a card in here is driven by stepHand() and must
   * not also have a tween, which is why moveTo() evicts its key.
   */
  private follow = new Map<string, number>();
  private raycaster = new Raycaster();
  private pointer = new Vector2();

  /** Index into the viewer's hand that is currently raised. */
  selected = -1;
  /** How far the hand row is panned, in world units. */
  private handScroll = 0;
  private handOverflow = 0;
  private lastHandIds: string[] = [];
  private seatCount = 0;
  private viewerIndex = 0;
  private dealt = false;

  constructor(private readonly scene: Scene) {
    scene.add(this.root);
  }

  /** Is anything actually on the table? Drives whether the menus need scenery. */
  get hasCards(): boolean {
    return this.held.size > 0;
  }

  dispose(): void {
    for (const { mesh } of this.held.values()) this.root.remove(mesh);
    this.held.clear();
    this.scene.remove(this.root);
  }

  /** Reset between games so the next deal starts from an empty table. */
  reset(): void {
    this.animator.clear();
    this.follow.clear();
    this.bursts.clear();
    for (const { mesh } of this.held.values()) this.root.remove(mesh);
    this.held.clear();
    this.lastHandIds = [];
    this.selected = -1;
    this.dealt = false;
  }

  // --- helpers -------------------------------------------------------------

  private place(mesh: CardObject, t: Transform): void {
    mesh.position.set(t.pos[0], t.pos[1], t.pos[2]);
    mesh.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
    mesh.scale.setScalar(t.scale ?? 1);
  }

  private moveTo(
    key: string,
    mesh: CardObject,
    to: Transform,
    opts: {
      duration?: number;
      delay?: number;
      arc?: number;
      easing?: typeof ease.outCubic;
      onDone?: () => void;
    } = {},
  ): void {
    const from = {
      pos: [mesh.position.x, mesh.position.y, mesh.position.z] as [number, number, number],
      rot: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z] as [number, number, number],
      scale: mesh.scale.x,
    };
    const toScale = to.scale ?? 1;
    const arc = opts.arc ?? 0;
    // A tween and the spring must never write the same mesh in one frame.
    this.follow.delete(key);

    this.animator.tween({
      key,
      duration: opts.duration ?? MOVE_MS,
      delay: opts.delay ?? 0,
      easing: opts.easing ?? ease.outCubic,
      onUpdate: (t) => {
        mesh.position.set(
          from.pos[0] + (to.pos[0] - from.pos[0]) * t,
          // A card thrown across the table rises and falls; a straight lerp
          // reads as sliding, which is what a physical card never does.
          from.pos[1] + (to.pos[1] - from.pos[1]) * t + Math.sin(t * Math.PI) * arc,
          from.pos[2] + (to.pos[2] - from.pos[2]) * t,
        );
        mesh.rotation.set(
          from.rot[0] + shortestAngle(from.rot[0], to.rot[0]) * t,
          from.rot[1] + shortestAngle(from.rot[1], to.rot[1]) * t,
          from.rot[2] + shortestAngle(from.rot[2], to.rot[2]) * t,
        );
        mesh.scale.setScalar(from.scale + (toScale - from.scale) * t);
      },
      ...(opts.onDone ? { onComplete: opts.onDone } : {}),
    });
  }

  private ensure(key: string, card: Card | null): Held {
    const hit = this.held.get(key);
    if (hit) {
      // A card we were showing face-down is now known: swap its face rather
      // than replacing the mesh, so it can keep animating uninterrupted.
      if (card && !hit.mesh.userData.card) revealCard(hit.mesh, card);
      return hit;
    }
    const mesh = makeCard(card, key);
    this.root.add(mesh);
    const held: Held = { mesh };
    this.held.set(key, held);
    return held;
  }

  /**
   * Cards flying to whoever just ate a penalty.
   *
   * Needed because the opponent fan LIES about size. It renders
   * min(handCount, 12) meshes keyed by index, so a player already holding
   * twelve cards who eats a +16 gets no new meshes at all and NOTHING moves -
   * and a player on seven who eats a +10 sees five cards arrive, not ten. The
   * penalty is applied correctly at every layer; it was simply invisible, so
   * it read as though the cards had never been dealt.
   *
   * These meshes are transient and belong to no hand: they fly from the draw
   * pile to the seat and retire themselves. Tracked here so update() does not
   * cull them mid-flight.
   */
  private bursts = new Set<string>();
  private burstSeq = 0;

  penalty(state: RedactedState, playerId: string, count: number, aspect: number): void {
    const idx = state.players.findIndex((p) => p.id === playerId);
    if (idx < 0 || count < 1) return;

    const angle = seatAngle(idx, this.viewerIndex, this.seatCount);
    const to = seatSpawn(angle, playerId === state.viewer, seatSqueeze(aspect));
    // Past a dozen the point is made; the number in the rail carries the rest.
    const shown = Math.min(count, BURST_MAX);

    for (let i = 0; i < shown; i++) {
      const key = `burst-${this.burstSeq++}`;
      this.bursts.add(key);
      const held = this.ensure(key, null);
      this.place(held.mesh, drawTransform(6));
      this.moveTo(key, held.mesh, to, {
        duration: BURST_MS,
        delay: i * BURST_STAGGER,
        arc: 1.15,
        easing: ease.inOutCubic,
        onDone: () => {
          this.bursts.delete(key);
          this.retire(key);
        },
      });
    }
  }

  private retire(key: string): void {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.animator.cancel(key);
    const mesh = held.mesh;
    releaseCardMaterial(mesh);
    // Fade out by sinking into the felt, then remove.
    this.animator.tween({
      duration: 320,
      onUpdate: (t) => {
        mesh.position.y -= t * 0.02;
        mesh.scale.setScalar(1 - t * 0.35);
      },
      onComplete: () => this.root.remove(mesh),
    });
  }

  // --- the update ----------------------------------------------------------

  update(state: RedactedState, events: GameEvent[], aspect: number, widthBudget: number): void {
    this.seatCount = state.players.length;
    this.viewerIndex = state.players.findIndex((p) => p.id === state.viewer);
    if (this.viewerIndex < 0) this.viewerIndex = 0;

    const live = new Set<string>();

    // A card played this tick should fly from its owner's seat, so spawn it
    // there BEFORE the discard layout puts it in the middle.
    for (const e of events) {
      if (e.type !== 'cardPlayed') continue;
      const idx = state.players.findIndex((p) => p.id === e.player);
      if (idx < 0) continue;
      const key = `discard-${e.card.id}`;
      if (this.held.has(key)) continue;
      const held = this.ensure(key, e.card);
      const angle = seatAngle(idx, this.viewerIndex, this.seatCount);
      this.place(held.mesh, seatSpawn(angle, e.player === state.viewer, seatSqueeze(aspect)));
    }

    this.layoutOwnHand(state, aspect, widthBudget, live);
    this.layoutOpponents(state, aspect, live);
    this.layoutDiscard(state, live);
    this.layoutDrawPile(state, live);

    // A burst belongs to no hand, so the ordinary cull would delete it the
    // instant the next state arrived - which is always, because the state
    // that triggered it has already landed.
    for (const key of this.bursts) live.add(key);

    for (const key of [...this.held.keys()]) {
      if (!live.has(key)) this.retire(key);
    }

    this.dealt = true;
  }

  private layoutOwnHand(state: RedactedState, aspect: number, widthBudget: number, live: Set<string>): void {
    const me = state.players.find((p) => p.id === state.viewer);
    const hand = me?.hand ?? [];

    // A spectator has no hand; nothing to lay out.
    if (hand.length === 0) {
      this.lastHandIds = [];
      return;
    }

    if (this.selected >= hand.length) this.selected = hand.length - 1;

    // Re-clamp every layout: the hand changes size constantly, and a scroll
    // left over from a twenty-card hand would push a five-card one off screen.
    this.handOverflow = fanMetrics(hand.length, aspect, widthBudget).overflow;
    this.handScroll = Math.max(-this.handOverflow, Math.min(this.handOverflow, this.handScroll));

    const targets = ownHandLayout(hand.length, this.selected, aspect, widthBudget, this.handScroll);
    const isFirstDeal = !this.dealt;

    /*
     * Which cards catch the light.
     *
     * playableFor() returns nothing when it is not your turn, and shadowing
     * the entire hand at that point would read as a fault rather than as
     * information. So the rule only applies while you actually have a choice
     * to make; the rest of the time every card is lit.
     */
    const mine = state.players[state.turn]?.id === state.viewer;
    const playable = mine ? new Set(playableFor(state).map((c) => c.id)) : null;

    hand.forEach((card, i) => {
      const key = `hand-${card.id}`;
      live.add(key);
      const isNew = !this.held.has(key);
      const held = this.ensure(key, card);
      const target = targets[i]!;
      setCardLit(held.mesh, !playable || playable.has(card.id));

      if (isNew) {
        // New cards arrive from the draw pile, face-down, and flip as they come.
        const from = drawTransform(6);
        this.place(held.mesh, { pos: [from.pos[0], from.pos[1] + 0.2, from.pos[2]], rot: from.rot });
        this.moveTo(key, held.mesh, target, {
          duration: isFirstDeal ? DEAL_MS : MOVE_MS + 120,
          // Stagger only the opening deal; a mid-game draw should feel instant.
          delay: isFirstDeal ? i * 115 : 0,
          arc: 0.75,
          easing: ease.outQuint,
        });
      } else if (!sameTransform(held.target, target)) {
        /*
         * Only cards that are actually going somewhere new are re-aimed.
         *
         * Without this guard a hover re-tweened all twenty-five cards, most of
         * them to the pixel they already occupied - and because a keyed tween
         * REPLACES the one before it, each of those restarts threw away the
         * progress of the last. The card you were pointing at rose in a series
         * of little jerks instead of one motion, and the card you had just left
         * took as long to come down as you took to move the mouse. Comparing
         * against the recorded target rather than the mesh's live position is
         * the point: a card mid-flight to the right place must be left alone.
         */
        // Hand it to the spring rather than tweening it. Re-aiming is free,
        // so a pointer sweeping the row costs nothing and interrupts nothing.
        this.animator.cancel(key);
        this.follow.set(key, i === this.selected ? FOLLOW_LIFT_MS : FOLLOW_ROW_MS);
      }
      held.target = target;
    });

    this.lastHandIds = hand.map((c) => c.id);
  }

  /**
   * Advance the hand's springs. Called once per frame, before the render.
   *
   * Nothing here has a schedule: each card simply moves a fraction of the way
   * to wherever `held.target` says it belongs right now. That is what makes a
   * hover re-aimable mid-flight - see FOLLOW_LIFT_MS. A card that arrives is
   * dropped from the map, so an idle hand does no work at all.
   */
  stepHand(dtMs: number): void {
    if (this.follow.size === 0) return;
    const dt = Math.min(dtMs, FOLLOW_MAX_DT);

    for (const [key, tau] of this.follow) {
      const held = this.held.get(key);
      const to = held?.target;
      if (!held || !to) {
        this.follow.delete(key);
        continue;
      }

      const m = held.mesh;
      // Frame-rate independent: the same fraction of the gap per millisecond,
      // whether the display runs at 60Hz or 120.
      const k = 1 - Math.exp(-dt / tau);
      const scale = to.scale ?? 1;

      m.position.x += (to.pos[0] - m.position.x) * k;
      m.position.y += (to.pos[1] - m.position.y) * k;
      m.position.z += (to.pos[2] - m.position.z) * k;
      m.rotation.x += shortestAngle(m.rotation.x, to.rot[0]) * k;
      m.rotation.y += shortestAngle(m.rotation.y, to.rot[1]) * k;
      m.rotation.z += shortestAngle(m.rotation.z, to.rot[2]) * k;
      m.scale.setScalar(m.scale.x + (scale - m.scale.x) * k);

      const gap =
        Math.abs(to.pos[0] - m.position.x) +
        Math.abs(to.pos[1] - m.position.y) +
        Math.abs(to.pos[2] - m.position.z) +
        Math.abs(scale - m.scale.x);
      if (gap < FOLLOW_DONE) {
        // Snap, so a card at rest is exactly where the layout says and not an
        // exponential's worth of epsilon away from it.
        this.place(m, to);
        this.follow.delete(key);
      }
    }
  }

  /**
   * Re-lay the viewer's hand and nothing else.
   *
   * A hover, a drag or a pan moves no other card on the table, but the only way
   * in used to be the full update() - so pointing at a card also re-walked every
   * opponent's fan, the discard stack and the draw pile, dozens of times a
   * second while the pointer swept the row. The live set is deliberately thrown
   * away here: retiring keys is update()'s job, and a set this pass never filled
   * would look like every card on the table had just left the game.
   */
  reflowHand(state: RedactedState, aspect: number, widthBudget: number): void {
    this.layoutOwnHand(state, aspect, widthBudget, new Set());
  }

  private layoutOpponents(state: RedactedState, aspect: number, live: Set<string>): void {
    state.players.forEach((p, idx) => {
      if (p.id === state.viewer) return;
      const angle = seatAngle(idx, this.viewerIndex, this.seatCount);
      // Cap the rendered fan: nobody can read 25 overlapping cards anyway,
      // and the count is shown numerically in the HUD.
      const shown = Math.min(p.handCount, 12);
      const targets = opponentHandLayout(shown, angle, seatSqueeze(aspect));

      for (let i = 0; i < shown; i++) {
        const key = `opp-${p.id}-${i}`;
        live.add(key);
        const isNew = !this.held.has(key);
        const held = this.ensure(key, null);
        const target = targets[i]!;
        if (isNew) {
          const from = drawTransform(6);
          this.place(held.mesh, from);
          this.moveTo(key, held.mesh, target, { duration: DEAL_MS, delay: i * 55, arc: 0.6 });
        } else {
          this.moveTo(key, held.mesh, target, { duration: SETTLE_MS });
        }
      }
    });
  }

  private layoutDiscard(state: RedactedState, live: Set<string>): void {
    const top = state.discardTop;
    if (!top) return;
    const key = `discard-${top.id}`;
    live.add(key);
    const held = this.ensure(key, top);
    const depth = Math.min(state.discardCount, MAX_DISCARD_MESHES);
    this.moveTo(key, held.mesh, discardTransform(depth, hashId(top.id)), {
      duration: PLAY_MS,
      arc: 0.9,
      easing: ease.inOutCubic,
    });

    // Keep a few older cards underneath so the pile has visible depth.
    for (let i = 1; i < Math.min(MAX_DISCARD_MESHES, state.discardCount); i++) {
      const stackKey = `pile-${i}`;
      live.add(stackKey);
      const stack = this.ensure(stackKey, null);
      this.place(stack.mesh, discardTransform(depth - i, i * 7.3));
    }
  }

  private layoutDrawPile(state: RedactedState, live: Set<string>): void {
    const n = Math.min(state.drawPileCount, MAX_PILE_MESHES);
    for (let i = 0; i < n; i++) {
      const key = `draw-${i}`;
      live.add(key);
      const held = this.ensure(key, null);
      this.place(held.mesh, drawTransform(i));
    }
  }

  // --- interaction ---------------------------------------------------------

  /** True when the hand is wider than the screen and can be panned. */
  get handScrollable(): boolean {
    return this.handOverflow > 0.01;
  }

  /** Where the pan sits, as -1..1. Drives the edge affordances. */
  get handScrollAt(): number {
    return this.handOverflow > 0.01 ? this.handScroll / this.handOverflow : 0;
  }

  /**
   * Pan the hand by `dx` world units. Returns true if anything moved, so the
   * caller can skip a relayout when the row is already against its stop.
   */
  panHand(dx: number): boolean {
    if (this.handOverflow <= 0.01) return false;
    const next = Math.max(-this.handOverflow, Math.min(this.handOverflow, this.handScroll + dx));
    if (Math.abs(next - this.handScroll) < 1e-4) return false;
    this.handScroll = next;
    return true;
  }

  /** Reset the pan, for a new deal. */
  resetHandScroll(): void {
    this.handScroll = 0;
  }

  /**
   * Which hand index is under the pointer, or -1.
   *
   * The raised card wins over any card that is merely nearer. Raising a card
   * moves it most of a card up the screen, which slides it under the edges of
   * its neighbours - so across a band of pixels several cards wide the nearest
   * hit is the NEIGHBOUR while the card you are pointing at is the one in the
   * air. Taking the nearest hit there hands the selection back and forth across
   * that band as the pointer creeps along it. Preferring the card already raised
   * turns the band into plain hysteresis: it keeps its place until the pointer
   * leaves it altogether, and a sweep along the row then steps one card at a
   * time in one direction.
   */
  pick(clientX: number, clientY: number, camera: THREE_Camera): number {
    this.pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, camera);

    const meshes = this.lastHandIds
      .map((id) => this.held.get(`hand-${id}`)?.mesh)
      .filter((m): m is CardObject => !!m);

    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return -1;

    const indexOf = (hit: (typeof hits)[number]) =>
      this.lastHandIds.indexOf((hit.object as CardObject).userData.cardId.replace(/^hand-/, ''));

    if (this.selected >= 0 && hits.some((h) => indexOf(h) === this.selected)) return this.selected;
    return indexOf(hits[0]!);
  }

  /** World position of a hand card, for anchoring HTML labels to it. */
  handCardPosition(index: number): Vector3 | null {
    const id = this.lastHandIds[index];
    if (!id) return null;
    const mesh = this.held.get(`hand-${id}`)?.mesh;
    return mesh ? mesh.position.clone() : null;
  }
}

/** Three's Camera type, imported structurally to avoid a value import here. */
type THREE_Camera = Parameters<Raycaster['setFromCamera']>[1];

/** Deterministic 0..1 from a card id, so a pile's jitter never re-rolls. */
function hashId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Are these the same destination, to within a distance nobody can see? */
function sameTransform(a: Transform | undefined, b: Transform): boolean {
  if (!a) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.pos[i]! - b.pos[i]!) > SAME_TARGET_EPS) return false;
    if (Math.abs(a.rot[i]! - b.rot[i]!) > SAME_TARGET_EPS) return false;
  }
  return Math.abs((a.scale ?? 1) - (b.scale ?? 1)) <= SAME_TARGET_EPS;
}

/** Rotate the short way round, so a card never spins 350 degrees to reach -10. */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
