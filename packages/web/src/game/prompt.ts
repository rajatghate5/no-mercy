/**
 * What the table should be asking you, as data.
 *
 * This lived inside refreshHud() as a ladder of early returns against the
 * live DOM, which made it the one piece of genuinely branchy logic in the
 * client that could not be tested without a browser. It has had two bugs
 * reported against it, so it is a pure function now: state in, a description
 * of the prompt out, and rules.test-style coverage over every phase.
 *
 * Deliberately returns a DESCRIPTION rather than touching the HUD, so the
 * decision and the rendering can be wrong independently and only one of them
 * needs a browser to check.
 */

import { playableFor, type Color, type RedactedState } from '@mercy/engine';

export type PromptSpec =
  /** Nothing to ask: the game is over. */
  | { kind: 'none' }
  /** Not your decision. A quiet line naming whoever the table is waiting on. */
  | { kind: 'waiting'; who: string; spectating: boolean }
  /** Name a colour - for a wild you played, or a roulette aimed at you. */
  | { kind: 'color'; label: string; action: 'chooseColor' | 'chooseRouletteColor' }
  /** You played a 7. */
  | {
      kind: 'swap';
      targets: { id: string; name: string; handCount: number }[];
      mayDecline: boolean;
      ownHand: number;
    }
  /**
   * A draw stack is live and pointed at you.
   *
   * `total` is the accumulated penalty - the whole stack, not the last card.
   * `need` is what a card must equal or beat to pass it on, which under the
   * printed rule is the LAST card played, not the total.
   */
  | { kind: 'stack'; total: number; need: number; by: string | null; canStack: boolean }
  /** An ordinary turn. The only state in which drawing is offered. */
  | { kind: 'turn' };

export interface PromptContext {
  youId: string;
  isOver: boolean;
  spectator: boolean;
  /** Is the pending decision yours? Comes from the controller. */
  waiting: boolean;
  /** Who played the card now on top, if it can be determined. */
  aggressor?: string | null;
}

export function decidePrompt(state: RedactedState, ctx: PromptContext): PromptSpec {
  if (ctx.isOver) return { kind: 'none' };

  const upName = state.players[state.turn]?.name ?? 'someone';
  if (ctx.spectator) return { kind: 'waiting', who: upName, spectating: true };
  if (!ctx.waiting) return { kind: 'waiting', who: upName, spectating: false };

  const phase = state.phase;

  if (phase.type === 'chooseColor') {
    return { kind: 'color', label: 'Pick a colour', action: 'chooseColor' };
  }
  if (phase.type === 'chooseRouletteColor') {
    return {
      kind: 'color',
      label: 'Roulette — name the colour you must draw to',
      action: 'chooseRouletteColor',
    };
  }

  if (phase.type === 'chooseSwapTarget') {
    return {
      kind: 'swap',
      targets: state.players
        .filter((p) => p.id !== ctx.youId && !p.eliminated && !p.finished)
        .map((p) => ({ id: p.id, name: p.name, handCount: p.handCount })),
      mayDecline: state.rules.sevenMayDecline,
      ownHand: state.players.find((p) => p.id === ctx.youId)?.hand?.length ?? 0,
    };
  }

  /*
   * A live stack outranks the ordinary turn, and must be checked before it.
   *
   * While pendingDraw > 0 the engine rejects a plain `draw` outright, so
   * offering "Draw a card" here is offering a button that cannot do anything.
   * The only moves are a bigger draw card or eating the whole pile.
   */
  if (state.pendingDraw > 0) {
    const by = ctx.aggressor && ctx.aggressor !== ctx.youId ? ctx.aggressor : null;
    return {
      kind: 'stack',
      total: state.pendingDraw,
      need: state.stackValue,
      by: by ? (state.players.find((p) => p.id === by)?.name ?? null) : null,
      canStack: playableFor(state).length > 0,
    };
  }

  return { kind: 'turn' };
}

/** The colours a picker should offer. Kept here so the caller stays dumb. */
export const PICKABLE: readonly Color[] = ['red', 'yellow', 'green', 'blue'];
