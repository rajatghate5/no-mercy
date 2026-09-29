/**
 * Counting cards dealt, from events.
 *
 * These exist because the first cut read `drew` and `stackTaken` as separate
 * penalties and flew every stacked card twice.
 */
import { describe, expect, test } from 'bun:test';
import { createGame, reduce, type GameEvent } from '@mercy/engine';
import { cardsDealt, penalties } from '../src/game/penalty.js';
import { card, num, player, state, pile } from '../../engine/test/helpers.js';

describe('cardsDealt', () => {
  test('a stack counts once, not twice', () => {
    const s = state({
      players: [player('you', [num('green', 3)]), player('them', [])],
      drawPile: pile(40, 'blue'),
      pendingDraw: 16,
      stackValue: 10,
      activeColor: 'red',
      turn: 0,
    });
    const { events } = reduce(s, { type: 'takeStack', player: 'you' });

    // The reducer really does emit both, which is the trap.
    expect(events.filter((e) => e.type === 'drew')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'stackTaken')).toHaveLength(1);

    expect([...cardsDealt(events)]).toEqual([['you', 16]]);
  });

  test('a roulette drawn one card at a time counts as one penalty', () => {
    const rl = card('wildColorRoulette');
    let s = state({
      players: [
        player('a', [rl, num('red', 1)]),
        player('b', [num('blue', 9)]),
        player('c', [num('green', 2)]),
      ],
      // No green in the pile, so b digs through all of it.
      drawPile: pile(9, 'blue'),
      activeColor: 'red',
      turn: 0,
    });
    s = reduce(s, { type: 'play', player: 'a', cardId: rl.id }).state;
    const { events } = reduce(s, { type: 'chooseRouletteColor', player: 'b', color: 'green' });

    // Emitted one at a time - individually all below the floor.
    const drews = events.filter((e): e is GameEvent & { type: 'drew' } => e.type === 'drew');
    expect(drews.length).toBeGreaterThan(1);
    expect(drews.every((e) => e.count === 1)).toBe(true);

    // But they add up to one real penalty.
    const [hit] = penalties(events);
    expect(hit?.[0]).toBe('b');
    expect(hit?.[1]).toBe(drews.length);
  });

  test('drawing a single card on your turn is not a penalty', () => {
    const s = state({
      players: [player('you', [num('green', 3)]), player('them', [])],
      drawPile: [num('red', 4), num('red', 5)],
      activeColor: 'red',
      turn: 0,
      rules: { drawUntilPlayable: false, forcePlay: false },
    });
    const { events } = reduce(s, { type: 'draw', player: 'you' });
    expect([...cardsDealt(events)]).toEqual([['you', 1]]);
    expect(penalties(events)).toEqual([]);
  });

  test('the two-card UNO forfeit is a penalty', () => {
    const s = state({
      players: [player('a', [num('red', 1), num('red', 2)]), player('b', [num('blue', 9)])],
      drawPile: pile(10, 'blue'),
      unoRisk: 'b',
      activeColor: 'red',
      turn: 0,
    });
    const { events } = reduce(s, { type: 'catchUno', player: 'a' });
    expect(penalties(events)).toEqual([['b', 2]]);
  });

  test('a deal is not mistaken for a penalty storm', () => {
    const { events } = createGame({
      seed: 3,
      players: [
        { id: 'a', name: 'a', isBot: false },
        { id: 'b', name: 'b', isBot: true },
      ],
    });
    // Dealing emits `dealt`, never `drew`.
    expect(penalties(events)).toEqual([]);
  });
});
