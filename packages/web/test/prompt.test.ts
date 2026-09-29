/**
 * What the table asks you, per state.
 *
 * These exist because this logic has had two bugs reported against it and it
 * used to be untestable: it lived inside the render function, branching
 * against the live DOM. The rule they all defend is one sentence - while a
 * draw stack is live, the game must never offer to draw one card, because the
 * engine rejects that action outright.
 */
import { describe, expect, test } from 'bun:test';
import { reduce, redactFor, type GameState } from '@mercy/engine';
import { decidePrompt, type PromptSpec } from '../src/game/prompt.js';
import { card, num, player, state, pile } from '../../engine/test/helpers.js';

const ask = (s: GameState, you: string, over = false): PromptSpec =>
  decidePrompt(redactFor(s, you), {
    youId: you,
    isOver: over || s.phase.type === 'gameOver',
    spectator: false,
    waiting:
      s.phase.type !== 'gameOver' &&
      (s.phase.type === 'chooseRouletteColor'
        ? s.phase.victim === you
        : s.players[s.turn]?.id === you),
    aggressor: 'them',
  });

describe('a live draw stack is never an ordinary turn', () => {
  for (const [kind, value] of [
    ['drawTwo', 2],
    ['drawFour', 4],
    ['wildDrawSix', 6],
    ['wildDrawTen', 10],
  ] as const) {
    test(`+${value} landing on you offers only the stack`, () => {
      const s = state({
        players: [player('you', [num('green', 3)]), player('them', [num('blue', 1)])],
        drawPile: pile(30, 'blue'),
        pendingDraw: value,
        stackValue: value,
        discardPile: [card(kind, kind.startsWith('wild') ? undefined : 'red')],
        activeColor: 'red',
        turn: 0,
      });
      const spec = ask(s, 'you');
      expect(spec.kind).toBe('stack');
      if (spec.kind !== 'stack') return;
      expect(spec.total).toBe(value);
      expect(spec.need).toBe(value);
      expect(spec.canStack).toBe(false);
    });
  }

  test('a stacked +2 → +6 → +10 asks for the whole 18, not the last card', () => {
    const s = state({
      players: [player('you', [num('green', 3)]), player('them', [])],
      drawPile: pile(40, 'blue'),
      // 2 + 6 + 10 accumulated; the last card played was the +10.
      pendingDraw: 18,
      stackValue: 10,
      discardPile: [card('wildDrawTen')],
      activeColor: 'red',
      turn: 0,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('stack');
    if (spec.kind !== 'stack') return;
    expect(spec.total).toBe(18);
    expect(spec.need).toBe(10);
  });

  test('holding a big enough draw card still shows the stack, and says you can pass it', () => {
    const s = state({
      players: [player('you', [card('wildDrawTen'), num('green', 3)]), player('them', [])],
      drawPile: pile(30, 'blue'),
      pendingDraw: 6,
      stackValue: 6,
      discardPile: [card('wildDrawSix')],
      activeColor: 'red',
      turn: 0,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('stack');
    if (spec.kind !== 'stack') return;
    expect(spec.canStack).toBe(true);
  });
});

describe('the full +10 sequence, played through the engine', () => {
  test('after the colour is picked, the next player gets the stack and not a turn', () => {
    const w10 = card('wildDrawTen');
    let s = state({
      players: [player('them', [w10, num('red', 1)]), player('you', [num('green', 3)])],
      drawPile: pile(30, 'blue'),
      activeColor: 'red',
      turn: 0,
    });

    // Their turn while the wild is resolving - you are only waiting.
    s = reduce(s, { type: 'play', player: 'them', cardId: w10.id }).state;
    expect(s.phase.type).toBe('chooseColor');
    expect(s.pendingDraw).toBe(10);
    expect(ask(s, 'you').kind).toBe('waiting');

    s = reduce(s, { type: 'chooseColor', player: 'them', color: 'blue' }).state;
    expect(s.players[s.turn]!.id).toBe('you');

    const spec = ask(s, 'you');
    expect(spec.kind).toBe('stack');
    if (spec.kind !== 'stack') return;
    expect(spec.total).toBe(10);
    expect(spec.by).toBe('them');
  });

  test('a coloured +4 needs no colour step and lands as a stack immediately', () => {
    const d4 = card('drawFour', 'red');
    let s = state({
      players: [player('them', [d4, num('red', 1)]), player('you', [num('green', 3)])],
      drawPile: pile(30, 'blue'),
      activeColor: 'red',
      turn: 0,
    });
    s = reduce(s, { type: 'play', player: 'them', cardId: d4.id }).state;
    expect(ask(s, 'you').kind).toBe('stack');
  });

  test('once the stack is eaten, an ordinary turn comes back', () => {
    let s = state({
      players: [player('you', [num('green', 3)]), player('them', [num('blue', 1)])],
      drawPile: pile(30, 'blue'),
      pendingDraw: 10,
      stackValue: 10,
      discardPile: [card('wildDrawTen')],
      activeColor: 'blue',
      turn: 0,
    });
    const before = s.players[0]!.hand.length;
    s = reduce(s, { type: 'takeStack', player: 'you' }).state;
    // The whole accumulated penalty, not one card.
    expect(s.players[0]!.hand.length).toBe(before + 10);
    expect(s.pendingDraw).toBe(0);
    expect(ask(s, 'them').kind).toBe('turn');
  });
});

describe('everything else still asks what it used to', () => {
  test('a plain turn offers the draw', () => {
    const s = state({
      players: [player('you', [num('red', 3)]), player('them', [])],
      drawPile: pile(10, 'blue'),
      activeColor: 'red',
      turn: 0,
    });
    expect(ask(s, 'you').kind).toBe('turn');
  });

  test("somebody else's turn is passive", () => {
    const s = state({
      players: [player('you', [num('red', 3)]), player('them', [num('red', 4)])],
      drawPile: pile(10, 'blue'),
      activeColor: 'red',
      turn: 1,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('waiting');
    if (spec.kind === 'waiting') expect(spec.who).toBe('them');
  });

  test('a wild you played asks for a colour', () => {
    const s = state({
      players: [player('you', [num('red', 3)]), player('them', [])],
      phase: { type: 'chooseColor', card: card('wildDrawSix') },
      activeColor: 'red',
      turn: 0,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('color');
    if (spec.kind === 'color') expect(spec.action).toBe('chooseColor');
  });

  test('a roulette aimed at you asks YOU for the colour, off-turn', () => {
    const s = state({
      players: [player('them', [num('red', 3)]), player('you', [num('red', 4)])],
      phase: { type: 'chooseRouletteColor', victim: 'you' },
      activeColor: 'red',
      turn: 0,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('color');
    if (spec.kind === 'color') expect(spec.action).toBe('chooseRouletteColor');
  });

  test('a 7 asks who to swap with, and never offers yourself', () => {
    const s = state({
      players: [
        player('you', [num('red', 3)]),
        player('them', [num('red', 4)]),
        player('gone', [], { eliminated: true }),
      ],
      phase: { type: 'chooseSwapTarget', card: num('red', 7) },
      activeColor: 'red',
      turn: 0,
    });
    const spec = ask(s, 'you');
    expect(spec.kind).toBe('swap');
    if (spec.kind !== 'swap') return;
    expect(spec.targets.map((t) => t.id)).toEqual(['them']);
  });

  test('a finished game asks nothing', () => {
    const s = state({
      players: [player('you', []), player('them', [num('red', 4)])],
      phase: { type: 'gameOver', winner: 'you' },
      turn: 0,
    });
    expect(ask(s, 'you').kind).toBe('none');
  });
});
