/**
 * Voice chat: a WebRTC mesh over the socket the game already has.
 *
 * Why a mesh and not a media server: rooms cap at six seats, and at six every
 * browser holding a peer connection to every other is fifteen connections
 * across the whole table - trivial. An SFU would mean another service to run,
 * another thing to pay for and another thing to go down, to solve a problem
 * this room size does not have.
 *
 * Why no new transport: WebRTC needs a server for exactly one thing, which is
 * introducing two browsers to each other. The game socket is already open,
 * already authenticated by the room code, and already knows who is in the
 * room. So the handshake rides on it as three message types and the server
 * stays a post box - it never parses an SDP and never carries any audio.
 *
 * Audio is therefore peer to peer and never touches the server at all.
 */

import type { VoicePresence, VoiceSignal } from '@mercy/protocol';

/**
 * A public STUN server, used only to discover what a browser's own address
 * looks like from outside its NAT. No audio and no game data goes near it.
 *
 * There is no TURN server, which is the honest limitation of this design: two
 * players both behind symmetric NAT will fail to connect to each other and
 * will show as joined-but-silent. Relaying that case needs a TURN server,
 * which costs money and bandwidth, and is not worth it until somebody
 * actually hits it.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** How often to sample levels to decide who is talking. */
const LEVEL_MS = 110;
/** RMS above this counts as speech rather than room noise. */
const SPEAK_RMS = 0.022;
/**
 * Keep the "talking" flag up this long after they drop below the threshold.
 *
 * Without it the indicator strobes on every pause between words, which reads
 * as a connection problem rather than as somebody speaking.
 */
const SPEAK_HOLD_MS = 420;

export type MicState = 'none' | 'on' | 'muted' | 'live';

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
  /** Candidates that arrived before the remote description was set. */
  pending: RTCIceCandidateInit[];
  lastLoud: number;
}

export interface VoiceOptions {
  /** Your own seat id. Also decides who offers - see `politeTo`. */
  youId: string;
  /** Send one handshake leg to a specific peer. */
  signal: (signal: VoiceSignal) => void;
  /** Tell the room whether you are in voice and whether your mic is open. */
  announce: (joined: boolean, muted: boolean) => void;
  /** Something changed that the HUD should redraw. */
  onChange: () => void;
}

export class VoiceChat {
  private peers = new Map<string, Peer>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private timer: number | null = null;
  private buf = new Float32Array(1024);
  private roster: VoicePresence[] = [];
  private localLoud = 0;

  /** Seats we are allowed to call. Set from the lobby, minus ourselves. */
  private seats: string[] = [];

  joined = false;
  muted = false;
  /** Push-to-talk is held, so the mic is open right now. */
  talking = false;
  /** Set when getUserMedia fails, so the UI can say why rather than nothing. */
  error: string | null = null;

  constructor(private readonly opts: VoiceOptions) {}

  /** Is voice possible in this browser at all? */
  static get supported(): boolean {
    return (
      typeof RTCPeerConnection !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
    );
  }

  /**
   * Who makes the offer.
   *
   * Both ends learn about each other at the same moment, so without a rule
   * both would offer and the handshakes would collide ("glare"). Comparing
   * ids is an arbitrary but stable tiebreak that both sides compute
   * identically without exchanging a message to agree it.
   */
  private offersTo(peer: string): boolean {
    return this.opts.youId < peer;
  }

  async join(): Promise<boolean> {
    if (this.joined) return true;
    if (!VoiceChat.supported) {
      this.error = 'This browser cannot do voice chat.';
      this.opts.onChange();
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      // Denied, or no microphone. Either way there is nothing to recover.
      this.error = 'No microphone — check the browser’s permission for this page.';
      this.opts.onChange();
      return false;
    }

    // Held, not open: the mic starts closed and V opens it.
    this.gate(false);

    this.ctx = new AudioContext();
    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(this.stream).connect(this.localAnalyser);

    this.joined = true;
    this.error = null;
    this.opts.announce(true, this.muted);
    this.timer = window.setInterval(() => this.sampleLevels(), LEVEL_MS);
    this.connectAll();
    this.opts.onChange();
    return true;
  }

  leave(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.localAnalyser = null;
    if (this.joined) this.opts.announce(false, this.muted);
    this.joined = false;
    this.talking = false;
    this.opts.onChange();
  }

  /** Who else is in the room. Drives who we call and who we hang up on. */
  setSeats(ids: string[]): void {
    this.seats = ids.filter((id) => id !== this.opts.youId);
    if (!this.joined) return;
    for (const id of [...this.peers.keys()]) {
      if (!this.seats.includes(id)) this.drop(id);
    }
    this.connectAll();
  }

  /** The room's voice roster, straight from the server. */
  setRoster(players: VoicePresence[]): void {
    this.roster = players;
    if (this.joined) this.connectAll();
    this.opts.onChange();
  }

  /** Hold-to-talk. Opens the mic while held; a mute overrides it. */
  setTalking(on: boolean): void {
    if (this.talking === on) return;
    this.talking = on;
    this.gate(on && !this.muted);
    this.opts.onChange();
  }

  /** Mute closes the mic whatever push-to-talk is doing. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.gate(this.talking && !muted);
    if (this.joined) this.opts.announce(true, muted);
    this.opts.onChange();
  }

  /**
   * Open or close the microphone.
   *
   * `track.enabled = false` keeps the connection up and sends silence, which
   * is what you want: tearing the track down and rebuilding it on every
   * push-to-talk press would renegotiate the whole peer connection.
   */
  private gate(open: boolean): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = open;
  }

  /** Per-player microphone state, as the turn-order rail draws it. */
  states(): Record<string, MicState> {
    const out: Record<string, MicState> = {};
    for (const p of this.roster) {
      if (!p.joined) continue;
      out[p.player] = p.muted ? 'muted' : 'on';
    }
    const now = performance.now();
    for (const [id, peer] of this.peers) {
      if (out[id] === 'muted' || out[id] === undefined) continue;
      if (now - peer.lastLoud < SPEAK_HOLD_MS) out[id] = 'live';
    }
    if (this.joined) {
      out[this.opts.youId] = this.muted
        ? 'muted'
        : now - this.localLoud < SPEAK_HOLD_MS
          ? 'live'
          : 'on';
    }
    return out;
  }

  /** Your own microphone, for the push-to-talk button. */
  selfState(): MicState {
    if (!this.joined) return 'none';
    if (this.muted) return 'muted';
    return this.talking ? 'live' : 'on';
  }

  // --- the mesh ------------------------------------------------------------

  private connectAll(): void {
    for (const p of this.roster) {
      if (!p.joined || p.player === this.opts.youId) continue;
      if (!this.seats.includes(p.player)) continue;
      if (this.peers.has(p.player)) continue;
      // Only one side opens the connection; the other waits for the offer.
      if (this.offersTo(p.player)) void this.call(p.player);
    }
    // Anyone who left voice should not keep a half-open connection.
    const live = new Set(this.roster.filter((p) => p.joined).map((p) => p.player));
    for (const id of [...this.peers.keys()]) if (!live.has(id)) this.drop(id);
  }

  private ensure(id: string): Peer {
    const hit = this.peers.get(id);
    if (hit) return hit;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, audio, pending: [], lastLoud: 0 };
    this.peers.set(id, peer);

    for (const track of this.stream?.getAudioTracks() ?? []) {
      pc.addTrack(track, this.stream!);
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.opts.signal({ peer: id, kind: 'ice', sdp: JSON.stringify(e.candidate.toJSON()) });
    };

    pc.ontrack = (e) => {
      const [remote] = e.streams;
      if (!remote) return;
      audio.srcObject = remote;
      // Autoplay is allowed here because joining voice was a user gesture.
      void audio.play().catch(() => {});
      if (this.ctx) {
        const an = this.ctx.createAnalyser();
        an.fftSize = 2048;
        this.ctx.createMediaStreamSource(remote).connect(an);
        peer.analyser = an;
      }
      this.opts.onChange();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(id);
    };

    return peer;
  }

  private async call(id: string): Promise<void> {
    const peer = this.ensure(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.opts.signal({ peer: id, kind: 'offer', sdp: JSON.stringify(offer) });
  }

  /** One leg of a handshake arriving from the server. */
  async onSignal(from: string, signal: VoiceSignal): Promise<void> {
    if (!this.joined) return;
    if (!this.seats.includes(from)) return;

    try {
      if (signal.kind === 'offer') {
        const peer = this.ensure(from);
        await peer.pc.setRemoteDescription(JSON.parse(signal.sdp) as RTCSessionDescriptionInit);
        await this.flush(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.opts.signal({ peer: from, kind: 'answer', sdp: JSON.stringify(answer) });
        return;
      }

      const peer = this.peers.get(from);
      if (!peer) return;

      if (signal.kind === 'answer') {
        await peer.pc.setRemoteDescription(JSON.parse(signal.sdp) as RTCSessionDescriptionInit);
        await this.flush(peer);
        return;
      }

      const candidate = JSON.parse(signal.sdp) as RTCIceCandidateInit;
      // Candidates routinely arrive before the description they belong to.
      if (!peer.pc.remoteDescription) peer.pending.push(candidate);
      else await peer.pc.addIceCandidate(candidate);
    } catch {
      // A malformed or out-of-order signal costs one peer, not the call.
      this.drop(from);
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const queued = peer.pending;
    peer.pending = [];
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        // A stale candidate is not worth dropping a working connection for.
      }
    }
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.srcObject = null;
    this.opts.onChange();
  }

  // --- who is talking ------------------------------------------------------

  private sampleLevels(): void {
    const now = performance.now();
    let changed = false;

    const rms = (an: AnalyserNode): number => {
      if (this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i]! * this.buf[i]!;
      return Math.sqrt(sum / this.buf.length);
    };

    // Your own level only counts while the mic is actually open, or the
    // indicator would show you talking into a closed microphone.
    if (this.localAnalyser && this.talking && !this.muted) {
      if (rms(this.localAnalyser) > SPEAK_RMS) {
        changed ||= now - this.localLoud >= SPEAK_HOLD_MS;
        this.localLoud = now;
      }
    }

    for (const peer of this.peers.values()) {
      if (!peer.analyser) continue;
      if (rms(peer.analyser) > SPEAK_RMS) {
        changed ||= now - peer.lastLoud >= SPEAK_HOLD_MS;
        peer.lastLoud = now;
      }
    }

    // Redraw on the way up AND on the way down, or a finished sentence leaves
    // the meter running until something else happens to repaint the rail.
    if (changed) this.opts.onChange();
    else if (this.fading(now)) this.opts.onChange();
  }

  /** Is anybody inside the hold window, and therefore about to go quiet? */
  private fading(now: number): boolean {
    if (now - this.localLoud < SPEAK_HOLD_MS + LEVEL_MS) return true;
    for (const p of this.peers.values()) {
      if (now - p.lastLoud < SPEAK_HOLD_MS + LEVEL_MS) return true;
    }
    return false;
  }
}
