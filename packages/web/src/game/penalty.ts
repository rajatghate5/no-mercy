/**
 * How many cards a tick actually dealt to each player.
 *
 * Separate from the render path because the mapping from events to cards is
 * genuinely counterintuitive and got it wrong once already:
 *
 *   - Eating a stack emits `drew` AND `stackTaken` carrying the SAME number,
 *     so anything that reads both deals every card twice.
 *   - A Colour Roulette does the opposite: it draws one card at a time in a
 *     loop and emits a separate `drew { count: 1 }` for each, so anything
 *     that reads events individually shows nothing for the cruellest card in
 *     the deck.
 *
 * Summing `drew` is correct for both, and for the two-card UNO forfeit, and
 * for a draw-until-playable that ran long.
 */

import type { GameEvent } from '@mercy/engine';

/** Below this it is somebody taking their turn, not somebody being punished. */
export const PENALTY_FLOOR = 2;

export function cardsDealt(events: readonly GameEvent[]): Map<string, number> {
  const dealt = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'drew') continue;
    dealt.set(e.player, (dealt.get(e.player) ?? 0) + e.count);
  }
  return dealt;
}

/** Just the ones worth announcing. */
export function penalties(events: readonly GameEvent[]): [string, number][] {
  return [...cardsDealt(events)].filter(([, n]) => n >= PENALTY_FLOOR);
}
