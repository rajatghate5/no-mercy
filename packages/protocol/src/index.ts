/**
 * Wire protocol, shared by server and client.
 *
 * Design rule: the client sends INTENT, never state. The server owns the
 * GameState and broadcasts redacted views. A modified client can therefore
 * ask for something illegal, but it cannot make it happen, and it cannot see
 * another player's hand because that data never crosses the wire.
 */

import type { Action, Color, GameEvent, RedactedState } from '@mercy/engine';
import type { Difficulty } from '@mercy/bots';

export const PROTOCOL_VERSION = 1;

/** Room codes are short, unambiguous, and safe to read aloud over a call. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const CODE_LENGTH = 4;

/**
 * House rules a host can change before dealing.
 *
 * A subset of the engine's RuleConfig - only the parts that make sense as a
 * table setting. Everything here is clamped server-side: it arrives from a
 * client and must not be trusted.
 */
export interface HouseRules {
  /** Cards dealt to each player. */
  startingHand: number;
  /** Mercy Rule threshold. Reach this many cards and you are out. */
  handLimit: number;
  /** Draw cards can be stacked onto an equal-or-lower draw card. */
  stacking: boolean;
  /**
   * 'escalating' is the real rule - your card must be equal or higher, so a
   * stack only gets worse. 'any' lets a +2 answer a +10, which makes stacks
   * survivable and sharply reduces eliminations.
   */
  stackMode: 'escalating' | 'sum' | 'any';
  /** 7 swaps hands with a player of your choice. */
  sevenSwap: boolean;
  /** May the player of a 7 decline the swap and keep their hand? House rule. */
  sevenDecline: boolean;
  /** 0 passes every hand in the direction of play. */
  zeroPass: boolean;
  /**
   * Draw until something is playable, instead of drawing exactly one card.
   * A printed No Mercy rule, not a house rule - hence the default.
   */
  drawUntilPlayable: boolean;
  /** A drawn card that can be played is played for you. Also a printed rule. */
  forcePlay: boolean;
  /** Shout UNO on one card, or be caught and draw 2. Printed rule too. */
  unoCalls: boolean;
}

export const DEFAULT_HOUSE_RULES: HouseRules = {
  startingHand: 7,
  handLimit: 25,
  stacking: true,
  stackMode: 'escalating',
  sevenSwap: true,
  sevenDecline: true,
  zeroPass: true,
  drawUntilPlayable: true,
  forcePlay: true,
  unoCalls: true,
};

/** Bounds enforced by the server. A hand limit below the deal is unplayable. */
export const HOUSE_RULE_LIMITS = {
  startingHand: { min: 3, max: 12 },
  handLimit: { min: 10, max: 60 },
} as const;

/** How long bots pause before acting, so the table stays readable. */
export type BotSpeed = 'fast' | 'normal' | 'slow';

export const BOT_SPEED_MS: Record<BotSpeed, number> = {
  fast: 300,
  normal: 700,
  slow: 1400,
};

/** Seconds a player gets per turn. 0 means no limit. */
export type TurnSeconds = 0 | 15 | 30 | 60;
export const TURN_SECONDS: TurnSeconds[] = [0, 15, 30, 60];

export function cleanTurnSeconds(v: unknown): TurnSeconds {
  return TURN_SECONDS.includes(v as TurnSeconds) ? (v as TurnSeconds) : 0;
}

export interface RoomSettings {
  botCount: number;
  difficulty: Difficulty;
  maxPlayers: number;
  /**
   * Auto-play for anyone who takes longer than this. Without a limit, one
   * person walking away freezes the room for everybody else.
   */
  turnSeconds: TurnSeconds;
  /** Pace of bot turns. Purely presentational; it changes no outcome. */
  botSpeed: BotSpeed;
  /** Whether strangers with the code may watch without playing. */
  allowSpectators: boolean;
  rules: HouseRules;
}

/** A fresh room's settings. One place to change when a field is added. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  botCount: 0,
  difficulty: 'medium',
  maxPlayers: 6,
  turnSeconds: 0,
  botSpeed: 'normal',
  allowSpectators: true,
  rules: DEFAULT_HOUSE_RULES,
};

export function cleanBotSpeed(v: unknown): BotSpeed {
  return v === 'fast' || v === 'slow' ? v : 'normal';
}

/** Clamp untrusted house rules into a playable range. */
export function cleanHouseRules(raw: unknown): HouseRules {
  const r = (raw ?? {}) as Partial<HouseRules>;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(lo, Math.min(hi, Math.floor(v)))
      : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

  const startingHand = num(
    r.startingHand,
    DEFAULT_HOUSE_RULES.startingHand,
    HOUSE_RULE_LIMITS.startingHand.min,
    HOUSE_RULE_LIMITS.startingHand.max,
  );
  const handLimit = num(
    r.handLimit,
    DEFAULT_HOUSE_RULES.handLimit,
    HOUSE_RULE_LIMITS.handLimit.min,
    HOUSE_RULE_LIMITS.handLimit.max,
  );

  return {
    startingHand,
    // A limit at or below the deal would eliminate everyone on the first turn.
    handLimit: Math.max(handLimit, startingHand + 3),
    stacking: bool(r.stacking, DEFAULT_HOUSE_RULES.stacking),
    stackMode:
      r.stackMode === 'any' || r.stackMode === 'sum' ? r.stackMode : 'escalating',
    sevenSwap: bool(r.sevenSwap, DEFAULT_HOUSE_RULES.sevenSwap),
    sevenDecline: bool(r.sevenDecline, DEFAULT_HOUSE_RULES.sevenDecline),
    zeroPass: bool(r.zeroPass, DEFAULT_HOUSE_RULES.zeroPass),
    drawUntilPlayable: bool(r.drawUntilPlayable, DEFAULT_HOUSE_RULES.drawUntilPlayable),
    forcePlay: bool(r.forcePlay, DEFAULT_HOUSE_RULES.forcePlay),
    unoCalls: bool(r.unoCalls, DEFAULT_HOUSE_RULES.unoCalls),
  };
}

export interface LobbyPlayer {
  id: string;
  name: string;
  isBot: boolean;
  isHost: boolean;
  connected: boolean;
}

export interface ChatMessage {
  from: string;
  name: string;
  text: string;
  /** Server-stamped; clients must not be trusted with their own clock. */
  at: number;
}

/**
 * One leg of a WebRTC handshake, relayed between two players in a room.
 *
 * The server never looks inside `sdp`. It checks only that the sender is in
 * the room and the target is too, then forwards it - which is the whole of
 * what a signalling server does. Audio itself is peer to peer and never
 * touches the server at all, which is also why voice costs nothing to run.
 */
export interface VoiceSignal {
  /** Seat id of the other end. */
  readonly peer: string;
  readonly kind: 'offer' | 'answer' | 'ice';
  /** Opaque SDP or ICE candidate. Relayed verbatim, never parsed. */
  readonly sdp: string;
}

/** Whether a player is in voice at all, and whether their mic is open. */
export interface VoicePresence {
  readonly player: string;
  readonly joined: boolean;
  readonly muted: boolean;
}

/** Signalling payload cap. An SDP offer is a few KB; anything past this is abuse. */
export const VOICE_SDP_MAX = 16000;

/** Structural check on an untrusted signal. Shape only - the SDP stays opaque. */
export function isVoiceSignal(v: unknown): v is VoiceSignal {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<VoiceSignal>;
  return (
    typeof s.peer === 'string' &&
    s.peer.length > 0 &&
    s.peer.length <= 64 &&
    (s.kind === 'offer' || s.kind === 'answer' || s.kind === 'ice') &&
    typeof s.sdp === 'string' &&
    s.sdp.length > 0 &&
    s.sdp.length <= VOICE_SDP_MAX
  );
}

// --- client -> server -------------------------------------------------------

export type ClientMessage =
  | { t: 'create'; name: string; settings: RoomSettings; version: number }
  | { t: 'join'; code: string; name: string; version: number }
  | { t: 'spectate'; code: string; name: string; version: number }
  /** Reclaim a seat after a dropped connection. */
  | { t: 'resume'; code: string; token: string; version: number }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'chat'; text: string }
  /** Mid-sentence, or stopped. Fire-and-forget; never affects game state. */
  | { t: 'typing'; typing: boolean }
  /** One leg of a WebRTC handshake, addressed at another seat in this room. */
  | { t: 'voice'; signal: VoiceSignal }
  /** Joining, leaving or muting voice. Broadcast so the rail can draw it. */
  | { t: 'voiceState'; joined: boolean; muted: boolean }
  | { t: 'leave' };

// --- server -> client -------------------------------------------------------

export type ServerMessage =
  /** Sent once on join; `token` is the reconnect credential. */
  | { t: 'welcome'; code: string; you: string; token: string; isHost: boolean; spectator: boolean }
  | {
      t: 'lobby';
      code: string;
      players: LobbyPlayer[];
      settings: RoomSettings;
      hostId: string;
      /** How many people are watching without a seat. */
      spectators: number;
    }
  | { t: 'state'; state: RedactedState; events: GameEvent[] }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'typing'; player: string; name: string; typing: boolean }
  /** A handshake leg from `from`, relayed unmodified. */
  | { t: 'voice'; from: string; signal: VoiceSignal }
  /** The room's whole voice roster. Sent on every change, so it cannot drift. */
  | { t: 'voiceRoster'; players: VoicePresence[] }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'ended'; winner: string | null };

export type ErrorCode =
  | 'no_such_room'
  | 'room_full'
  | 'name_taken'
  | 'already_started'
  | 'not_host'
  | 'bad_version'
  | 'illegal_action'
  | 'bad_message'
  | 'rate_limited';

export const MAX_NAME_LENGTH = 16;
export const MAX_CHAT_LENGTH = 200;
export const MAX_PLAYERS = 10;

/**
 * Strip ASCII control characters and DEL.
 *
 * Names and chat arrive from strangers on the network and get printed straight
 * into a terminal. An unescaped ESC inside a name would let anyone emit ANSI
 * sequences and scribble anywhere on your screen, so this is a security
 * boundary, not cosmetics. Built with new RegExp so the source file itself
 * contains no literal control bytes.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return s.replace(CONTROL_CHARS, '').trim().slice(0, MAX_NAME_LENGTH) || 'player';
}

export function cleanChat(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return s.replace(CONTROL_CHARS, '').trim().slice(0, MAX_CHAT_LENGTH);
}

export function isColor(v: unknown): v is Color {
  return v === 'red' || v === 'yellow' || v === 'green' || v === 'blue';
}

/** Parse an untrusted wire payload. Returns null instead of throwing. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const t = (data as { t?: unknown }).t;
  if (typeof t !== 'string') return null;
  // Shape is validated properly by the server against the room's phase;
  // this is the cheap structural gate.
  return data as ClientMessage;
}
