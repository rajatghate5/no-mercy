/**
 * Network game client.
 *
 * Deliberately mirrors LocalGame's shape (view(), subscribe(), apply(),
 * isOver, winner) so the Table screen renders a LAN game and a bot game with
 * the same code and no branching.
 *
 * The client is a thin renderer: it holds only the redacted state the server
 * sends, and sends intents back. It never computes authority.
 */

import type { Action, GameEvent, RedactedState } from '@mercy/engine';
import {
  PROTOCOL_VERSION,
  type ChatMessage,
  type ClientMessage,
  type LobbyPlayer,
  type RoomSettings,
  type ServerMessage,
  type VoicePresence,
  type VoiceSignal,
} from '@mercy/protocol';
import type { LogEntry } from './local.js';
import { describeEvent } from './narrate.js';

export type ConnectionStatus = 'connecting' | 'lobby' | 'playing' | 'ended' | 'error' | 'closed';

export interface NetworkGameOptions {
  url: string;
  name: string;
  /** Create a new room, join an existing one, or watch. */
  mode: { kind: 'create'; settings: RoomSettings } | { kind: 'join'; code: string } | { kind: 'spectate'; code: string };
}

export class NetworkGame {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private state: RedactedState | null = null;
  private reconnectToken: string | null = null;
  private closedByUs = false;

  status: ConnectionStatus = 'connecting';
  error: string | null = null;
  code = '';
  youId = '';
  isHost = false;
  spectator = false;
  lobby: LobbyPlayer[] = [];
  settings: RoomSettings | null = null;
  chat: ChatMessage[] = [];
  /**
   * Who is mid-sentence, and when that claim goes stale.
   *
   * Expiry is the point. A "stopped typing" message can be lost to a dropped
   * socket or a closed tab, and without a deadline the indicator would sit
   * there naming someone who left ten minutes ago.
   */
  /** The room's voice roster, as last broadcast by the server. */
  voiceRoster: VoicePresence[] = [];
  /** Set by whoever owns the VoiceChat instance. */
  onVoiceSignal: ((from: string, signal: VoiceSignal) => void) | null = null;
  onVoiceRoster: ((players: VoicePresence[]) => void) | null = null;

  private typingUntil = new Map<string, { name: string; until: number }>();
  private typingSweep: number | undefined;
  readonly log: LogEntry[] = [];
  winner: string | null = null;
  lastEvents: GameEvent[] = [];

  constructor(private readonly opts: NetworkGameOptions) {
    this.connect();
  }

  private connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.status = 'error';
      this.error = `Could not open ${this.opts.url}: ${String(e)}`;
      this.emit();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const { mode, name } = this.opts;
      // Prefer resuming a seat we already hold over taking a new one.
      if (this.reconnectToken) {
        this.send({ t: 'resume', code: this.code, token: this.reconnectToken, version: PROTOCOL_VERSION });
      } else if (mode.kind === 'create') {
        this.send({ t: 'create', name, settings: mode.settings, version: PROTOCOL_VERSION });
      } else if (mode.kind === 'join') {
        this.send({ t: 'join', code: mode.code.toUpperCase(), name, version: PROTOCOL_VERSION });
      } else {
        this.send({ t: 'spectate', code: mode.code.toUpperCase(), name, version: PROTOCOL_VERSION });
      }
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(msg);
    };

    ws.onerror = () => {
      if (this.closedByUs) return;
      this.status = 'error';
      // Two very different causes land here: no server started locally, and a
      // server address baked into a deployed build that has since gone away.
      // Name the escape hatch, because solo play needs no server at all.
      this.error =
        this.error ??
        `The game server at ${this.opts.url} is not responding. ` +
          `It may be offline. Playing against bots needs no server and still works.`;
      this.emit();
    };

    ws.onclose = () => {
      if (this.closedByUs) return;
      if (this.status !== 'error' && this.status !== 'ended') {
        this.status = 'closed';
        this.error = 'Connection lost.';
      }
      this.emit();
    };
  }

  private receive(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.code = msg.code;
        this.youId = msg.you;
        this.isHost = msg.isHost;
        this.spectator = msg.spectator;
        if (msg.token) this.reconnectToken = msg.token;
        this.status = 'lobby';
        break;
      case 'lobby':
        this.lobby = msg.players;
        this.settings = msg.settings;
        this.isHost = msg.hostId === this.youId;
        break;
      case 'state':
        this.state = msg.state;
        this.status = msg.state.phase.type === 'gameOver' ? 'ended' : 'playing';
        this.lastEvents = msg.events;
        this.narrate(msg.events);
        break;
      case 'typing': {
        if (msg.player === this.youId) break;
        if (msg.typing) {
          this.typingUntil.set(msg.player, { name: msg.name, until: Date.now() + 4000 });
          // Re-render when the claim goes stale. Without this the indicator
          // sits there until some unrelated message happens to arrive.
          window.clearTimeout(this.typingSweep);
          this.typingSweep = window.setTimeout(() => this.emit(), 4100);
        } else {
          this.typingUntil.delete(msg.player);
        }
        break;
      }

      case 'chat':
        this.chat.push(msg.message);
        // Posting ends the sentence, so the indicator must go with it.
        this.typingUntil.delete(msg.message.from);
        if (this.chat.length > 100) this.chat.shift();
        break;
      /*
       * Voice. The controller relays and stores; it never owns a peer
       * connection, because VoiceChat has to survive a socket reconnect and
       * the controller does not.
       */
      case 'voice':
        this.onVoiceSignal?.(msg.from, msg.signal);
        break;

      case 'voiceRoster':
        this.voiceRoster = msg.players;
        this.onVoiceRoster?.(msg.players);
        break;

      case 'ended':
        this.winner = msg.winner;
        this.status = 'ended';
        break;
      case 'error':
        this.error = msg.message;
        // A failed join is fatal; an illegal move is not.
        if (msg.code !== 'illegal_action' && msg.code !== 'rate_limited') this.status = 'error';
        break;
    }
    this.emit();
  }

  private narrate(events: GameEvent[]) {
    const name = (id: string) => this.lobby.find((p) => p.id === id)?.name ?? this.nameFromState(id);
    for (const e of events) {
      const entry = describeEvent(e, name);
      if (entry) this.log.push(entry);
    }
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  private nameFromState(id: string): string {
    return this.state?.players.find((p) => p.id === id)?.name ?? id;
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  // --- the LocalGame-shaped surface the Table renders against --------------

  view(): RedactedState | null {
    return this.state;
  }

  get isOver(): boolean {
    return this.status === 'ended';
  }

  waitingOnHuman(): boolean {
    const s = this.state;
    if (!s || this.spectator || this.isOver) return false;
    const actor = s.phase.type === 'chooseRouletteColor' ? s.phase.victim : s.players[s.turn]?.id;
    return actor === this.youId;
  }

  apply(action: Action): boolean {
    if (this.spectator) return false;
    this.send({ t: 'action', action });
    return true;
  }

  // --- lobby controls ------------------------------------------------------

  start() {
    this.send({ t: 'start' });
  }

  updateSettings(settings: Partial<RoomSettings>) {
    this.send({ t: 'settings', settings });
  }

  /** Names currently mid-sentence, stale entries dropped on read. */
  typingNames(): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [id, t] of this.typingUntil) {
      if (t.until <= now) this.typingUntil.delete(id);
      else out.push(t.name);
    }
    return out;
  }

  setTyping(typing: boolean) {
    this.send({ t: 'typing', typing });
  }

  /** Send one leg of a WebRTC handshake to another seat. */
  sendVoiceSignal(signal: VoiceSignal) {
    this.send({ t: 'voice', signal });
  }

  /** Tell the room whether we are in voice and whether the mic is open. */
  announceVoice(joined: boolean, muted: boolean) {
    this.send({ t: 'voiceState', joined, muted });
  }

  say(text: string) {
    if (text.trim()) this.send({ t: 'chat', text });
  }

  leave() {
    this.closedByUs = true;
    this.send({ t: 'leave' });
    this.ws?.close();
    this.status = 'closed';
    this.emit();
  }
}
