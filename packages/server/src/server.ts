/**
 * WebSocket game server.
 *
 * Built on Bun.serve's native websocket support, so there is no `ws`
 * dependency and nothing to keep upgraded. One process hosts many rooms,
 * each keyed by a short code.
 *
 * Everything a client sends is untrusted: names and chat are stripped of
 * control characters, actions are re-validated against the engine, and each
 * player only ever receives their own redacted view.
 */

import type { ServerWebSocket } from 'bun';
import {
  BOT_SPEED_MS,
  DEFAULT_ROOM_SETTINGS,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  cleanChat,
  cleanBotSpeed,
  cleanHouseRules,
  cleanName,
  cleanTurnSeconds,
  isVoiceSignal,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type RoomSettings,
  type ServerMessage,
} from '@mercy/protocol';
import { BOT_DELAY_MS, Room, makeCode, type Seat } from './room.js';

interface SocketData {
  /** Per-connection id. Changes every time the socket reconnects. */
  id: string;
  /**
   * The SEAT this connection controls. Stable for the life of the game.
   *
   * These must stay separate: GameState player ids are fixed when the deal
   * happens, so a reconnecting player has to rebind to their original seat id.
   * Reusing the connection id as the seat id would leave a resumed player
   * unable to see their own hand, because no player in the state matches.
   */
  seatId: string | null;
  code: string | null;
  spectator: boolean;
}

/** Rooms with no connected humans are swept after this long. */
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
/** Crude per-connection flood guard. */
const RATE_LIMIT_MSGS = 40;
const RATE_LIMIT_WINDOW_MS = 5000;

const DEFAULT_SETTINGS: RoomSettings = DEFAULT_ROOM_SETTINGS;

export interface ServerOptions {
  port?: number;
  hostname?: string;
  /** Override the bot think-time. Tests use 0 to play a game instantly. */
  botDelayMs?: number;
  /** Directory of the built web client. Omit to run as a pure game server. */
  staticRoot?: string | undefined;
}

/**
 * Serve a file from the built client, falling back to index.html so the app
 * survives a refresh on any path.
 *
 * Path traversal is blocked by resolving against the root and rejecting
 * anything that escapes it - the URL comes from the network and is untrusted.
 */
async function serveStatic(root: string, pathname: string): Promise<Response | null> {
  const clean = pathname.replace(/\.\.+/g, '.').replace(/^\/+/, '');
  const candidates = clean === '' ? ['index.html'] : [clean, 'index.html'];
  for (const rel of candidates) {
    const file = Bun.file(`${root}/${rel}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          // Hashed asset filenames can cache hard; index.html must not.
          'cache-control': rel.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      });
    }
  }
  return null;
}

export function createServer(opts: ServerOptions = {}) {
  const staticRoot = opts.staticRoot;
  const rooms = new Map<string, Room>();
  const emptySince = new Map<string, number>();
  const rates = new Map<string, { count: number; until: number }>();
  let nextId = 0;

  const send = (ws: ServerWebSocket<SocketData>, msg: ServerMessage) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket closed mid-broadcast; the close handler will clean it up.
    }
  };

  const fail = (ws: ServerWebSocket<SocketData>, code: ErrorCode, message: string) =>
    send(ws, { t: 'error', code, message });

  const freshCode = (): string => {
    // Retry on collision; the space is 32^4 ~= 1M so this is near-instant.
    for (let i = 0; i < 100; i++) {
      const code = makeCode(Math.random);
      if (!rooms.has(code)) return code;
    }
    throw new Error('exhausted room code space');
  };

  const sweep = () => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.empty) {
        const since = emptySince.get(code) ?? now;
        emptySince.set(code, since);
        if (now - since > EMPTY_ROOM_TTL_MS) {
          room.dispose();
          rooms.delete(code);
          emptySince.delete(code);
        }
      } else {
        emptySince.delete(code);
      }
    }
  };
  const sweeper = setInterval(sweep, 60_000);

  const rateLimited = (id: string): boolean => {
    const now = Date.now();
    const entry = rates.get(id);
    if (!entry || now > entry.until) {
      rates.set(id, { count: 1, until: now + RATE_LIMIT_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT_MSGS;
  };

  function handle(ws: ServerWebSocket<SocketData>, msg: ClientMessage) {
    const { id } = ws.data;
    /** The identity the room knows this connection by. */
    const actingAs = () => ws.data.seatId ?? id;

    // --- joining -----------------------------------------------------------
    if (msg.t === 'create' || msg.t === 'join' || msg.t === 'spectate' || msg.t === 'resume') {
      if (msg.version !== PROTOCOL_VERSION) {
        return fail(
          ws,
          'bad_version',
          `Server speaks protocol v${PROTOCOL_VERSION}, you sent v${msg.version}. Update your client.`,
        );
      }
    }

    switch (msg.t) {
      case 'create': {
        const code = freshCode();
        const settings: RoomSettings = {
          ...DEFAULT_SETTINGS,
          ...msg.settings,
          botCount: clamp(msg.settings?.botCount ?? DEFAULT_SETTINGS.botCount, 0, 9),
          maxPlayers: clamp(msg.settings?.maxPlayers ?? DEFAULT_SETTINGS.maxPlayers, 2, MAX_PLAYERS),
          botSpeed: cleanBotSpeed(msg.settings?.botSpeed),
          turnSeconds: cleanTurnSeconds(msg.settings?.turnSeconds),
          allowSpectators: msg.settings?.allowSpectators !== false,
          rules: cleanHouseRules(msg.settings?.rules),
        };
        const room = new Room(
          code,
          settings,
          id,
          (Math.random() * 0xffffffff) >>> 0,
          setTimeout,
          Date.now,
          opts.botDelayMs ?? BOT_SPEED_MS[settings.botSpeed],
        );
        const seat: Seat = {
          id,
          name: cleanName(msg.name),
          isBot: false,
          token: crypto.randomUUID(),
          connected: true,
        };
        room.addSeat(seat);
        room.attach(id, (m) => send(ws, m));
        rooms.set(code, room);
        ws.data.code = code;
        ws.data.seatId = id;
        send(ws, { t: 'welcome', code, you: id, token: seat.token, isHost: true, spectator: false });
        room.broadcastLobby();
        return;
      }

      case 'join': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room) return fail(ws, 'no_such_room', `No room with code ${msg.code}.`);
        if (room.started) return fail(ws, 'already_started', 'That game has already started.');
        if (room.humanSeats.length >= room.settings.maxPlayers) {
          return fail(ws, 'room_full', 'That room is full.');
        }
        const name = cleanName(msg.name);
        if (room.seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          return fail(ws, 'name_taken', `Someone in that room is already called ${name}.`);
        }
        const seat: Seat = { id, name, isBot: false, token: crypto.randomUUID(), connected: true };
        room.addSeat(seat);
        room.attach(id, (m) => send(ws, m));
        ws.data.code = room.code;
        ws.data.seatId = id;
        send(ws, {
          t: 'welcome',
          code: room.code,
          you: id,
          token: seat.token,
          isHost: false,
          spectator: false,
        });
        room.broadcastLobby();
        return;
      }

      case 'spectate': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room) return fail(ws, 'no_such_room', `No room with code ${msg.code}.`);
        if (!room.settings.allowSpectators) {
          return fail(ws, 'room_full', 'This room is not accepting spectators.');
        }
        room.spectators.set(id, (m) => send(ws, m));
        ws.data.code = room.code;
        ws.data.seatId = id;
        ws.data.spectator = true;
        send(ws, { t: 'welcome', code: room.code, you: id, token: '', isHost: false, spectator: true });
        room.broadcastLobby();
        // Catch a late spectator up on a game already in progress.
        if (room.state) room.broadcastState([]);
        return;
      }

      case 'resume': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room) return fail(ws, 'no_such_room', 'That room is gone.');
        const seat = room.seats.find((s) => s.token && s.token === msg.token);
        if (!seat) return fail(ws, 'no_such_room', 'That seat is no longer available.');
        // Rebind this CONNECTION to the existing seat. The seat id must not
        // change: it is the player id baked into the running GameState.
        room.attach(seat.id, (m) => send(ws, m));
        ws.data.code = room.code;
        ws.data.seatId = seat.id;
        send(ws, {
          t: 'welcome',
          code: room.code,
          you: seat.id,
          token: seat.token,
          isHost: room.hostId === seat.id,
          spectator: false,
        });
        room.broadcastLobby();
        if (room.state) room.broadcastState([]);
        return;
      }
    }

    // --- in-room -----------------------------------------------------------
    const room = ws.data.code ? rooms.get(ws.data.code) : undefined;
    if (!room) return fail(ws, 'no_such_room', 'You are not in a room.');

    switch (msg.t) {
      case 'settings': {
        if (room.hostId !== actingAs()) return fail(ws, 'not_host', 'Only the host can change settings.');
        if (room.started) return fail(ws, 'already_started', 'The game has already started.');
        room.settings = {
          ...room.settings,
          ...msg.settings,
          botCount: clamp(msg.settings?.botCount ?? room.settings.botCount, 0, 9),
          maxPlayers: clamp(msg.settings?.maxPlayers ?? room.settings.maxPlayers, 2, MAX_PLAYERS),
          botSpeed: cleanBotSpeed(msg.settings?.botSpeed ?? room.settings.botSpeed),
          turnSeconds: cleanTurnSeconds(msg.settings?.turnSeconds ?? room.settings.turnSeconds),
          allowSpectators:
            msg.settings?.allowSpectators ?? room.settings.allowSpectators,
          // Re-clamped on every change: a client can send anything.
          rules: cleanHouseRules(msg.settings?.rules ?? room.settings.rules),
        };
        // Bot pace can change mid-lobby, so push it to the room.
        room.setBotDelay(BOT_SPEED_MS[room.settings.botSpeed]);
        room.broadcastLobby();
        return;
      }

      case 'start': {
        if (room.hostId !== actingAs()) return fail(ws, 'not_host', 'Only the host can start the game.');
        if (room.started) return fail(ws, 'already_started', 'The game has already started.');
        if (!room.start()) fail(ws, 'bad_message', 'Could not start the game.');
        return;
      }

      case 'action': {
        if (ws.data.spectator) return fail(ws, 'illegal_action', 'Spectators cannot play.');
        if (!msg.action || typeof msg.action !== 'object') {
          return fail(ws, 'bad_message', 'Malformed action.');
        }
        const err = room.submit(actingAs(), msg.action);
        if (err) fail(ws, err, 'That move is not legal right now.');
        return;
      }

      case 'chat': {
        const text = cleanChat(msg.text);
        if (!text) return;
        const seat = room.seats.find((s) => s.id === actingAs());
        room.postChat(actingAs(), seat?.name ?? 'spectator', text);
        return;
      }

      case 'typing': {
        const seat = room.seats.find((s) => s.id === actingAs());
        room.postTyping(actingAs(), seat?.name ?? 'spectator', msg.typing === true);
        return;
      }

      /*
       * Voice signalling. The server relays, it does not participate.
       *
       * Spectators are excluded deliberately: they are strangers with a room
       * code, and letting one open a microphone into the table is not a
       * feature anybody asked for.
       */
      case 'voice': {
        if (ws.data.spectator) return;
        if (!isVoiceSignal(msg.signal)) return fail(ws, 'bad_message', 'Malformed voice signal.');
        room.postVoiceSignal(actingAs(), msg.signal);
        return;
      }

      case 'voiceState': {
        if (ws.data.spectator) return;
        room.setVoiceState(actingAs(), msg.joined === true, msg.muted === true);
        return;
      }

      case 'leave': {
        room.detach(actingAs());
        ws.data.code = null;
        ws.data.seatId = null;
        return;
      }

      default:
        return fail(ws, 'bad_message', 'Unknown message type.');
    }
  }

  const server = Bun.serve<SocketData, never>({
    port: opts.port ?? 4040,
    hostname: opts.hostname ?? '0.0.0.0',

    async fetch(req, srv) {
      const url = new URL(req.url);

      // Plain HTTP health check, so a platform probe does not need a websocket.
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, rooms: rooms.size }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      // A websocket upgrade is a game connection; anything else is the client.
      const id = `u${nextId++}`;
      if (srv.upgrade(req, { data: { id, seatId: null, code: null, spectator: false } })) {
        return undefined;
      }

      // Serve the built client when there is one, so a single process hosts
      // the whole game. In development Vite serves it instead and this never
      // runs.
      if (staticRoot) {
        const served = await serveStatic(staticRoot, url.pathname);
        if (served) return served;
      }

      return new Response(
        'no-mercy server is running. Build the client (bun run build) or use the Vite dev server.',
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );
    },

    websocket: {
      open() {
        // Nothing until the client identifies itself with create/join/resume.
      },
      message(ws, raw) {
        if (rateLimited(ws.data.id)) {
          return fail(ws, 'rate_limited', 'Slow down.');
        }
        const msg = parseClientMessage(typeof raw === 'string' ? raw : raw.toString());
        if (!msg) return fail(ws, 'bad_message', 'Could not parse that message.');
        try {
          handle(ws, msg);
        } catch (e) {
          // A bug must not take the whole server (and everyone else's game) down.
          console.error('[room error]', e);
          fail(ws, 'bad_message', 'Server error handling that message.');
        }
      },
      close(ws) {
        const room = ws.data.code ? rooms.get(ws.data.code) : undefined;
        // Detach the SEAT, so the player is marked away and can resume later.
        room?.detach(ws.data.seatId ?? ws.data.id);
        rates.delete(ws.data.id);
      },
    },
  });

  return {
    server,
    rooms,
    stop() {
      clearInterval(sweeper);
      for (const room of rooms.values()) room.dispose();
      server.stop(true);
    },
  };
}

function clamp(n: unknown, lo: number, hi: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : lo;
  return Math.max(lo, Math.min(hi, v));
}
