/**
 * Song playback: decodes a dropped audio file and plays it, plus any number
 * of extra "stems" (karaoke or vocal-only buffers in Phase 2, your own
 * recorded take now), in sync through per-stem gains into the engine's master
 * gain. Transport (play, pause, seek, loop region) is built on one rule: song
 * time is derived from the AudioContext clock, never from timers, so the
 * playhead, the pitch lane and the recorder agree to the sample. Web Audio
 * sources are one-shot, so every play, seek and loop change builds a fresh
 * set of sources that all start at the same context time. The transport maths
 * lives in pure exported functions with unit tests; the class is the thin glue
 * around them. The Player is the engine-clock Transport (see transport.ts):
 * the Session reads it through that interface, the same way it reads an
 * embedded YouTube player. DOM-free.
 */
import type { AudioEngine } from './engine';
import type { LoopRegion, TrackInfo, Transport, TransportEvent } from './transport';

/**
 * What we know about the loaded song. `hash` is sha256 hex of the file, or an
 * 8-character FNV-1a hex when crypto.subtle is missing.
 */
export interface SongInfo extends TrackInfo {
  sampleRate: number;
  channels: number;
}

/** Transport state. 'ready' is loaded and idle at the start. */
export type PlayerState = 'empty' | 'ready' | 'playing' | 'paused';

/**
 * Things listeners can react to: the transport events (which never include
 * 'state' for the player, whose states change only with the other events) and
 * 'stems', which means the stem set or a stem gain changed. 'ended' means the
 * playhead reached the end with no loop; the state is then 'paused' with
 * position() at the song's duration.
 */
export type PlayerEvent = TransportEvent | 'stems';

/** Id of the stem created by `load()`; it defines the song's duration. */
const ORIGINAL = 'original';
/**
 * Sources start this far in the future so that every stem's start call lands
 * in the same audio render quantum and they cannot drift apart at the start.
 */
const START_LEAD_S = 0.03;
/** Loops shorter than this are rejected; they would just buzz. */
const MIN_LOOP_S = 0.1;
/** Positions this close to the end count as the end. */
const END_EPS_S = 1e-3;
/** Time constant for gain changes, long enough to avoid clicks. */
const GAIN_SMOOTH_S = 0.01;

/** Clamps a seek target into [0, durationS]; NaN becomes 0. */
export function clampSeek(positionS: number, durationS: number): number {
  if (Number.isNaN(positionS)) return 0;
  return Math.min(Math.max(positionS, 0), Math.max(durationS, 0));
}

/**
 * Folds a position that has run past the loop's end back into the loop. Before
 * the loop's end (including the lead-in before its start) the position is
 * unchanged, so this can be applied to an ever-growing clock reading.
 */
export function wrapLoop(positionS: number, loop: LoopRegion | null, durationS: number): number {
  const p = clampSeek(positionS, Number.POSITIVE_INFINITY);
  const end = loop ? Math.min(loop.endS, durationS) : 0;
  if (!loop || end - loop.startS <= 0 || p < end) return clampSeek(p, durationS);
  return loop.startS + ((p - loop.startS) % (end - loop.startS));
}

/** Song time at a context time, for a run that began at the given anchors. */
export function songTimeAt(
  contextNow: number,
  startedAtContext: number,
  startedAtSong: number,
): number {
  return startedAtSong + (contextNow - startedAtContext);
}

/**
 * Orders a loop's ends, clamps them into the song, and returns null when the
 * result is shorter than 0.1 s or not a number.
 */
export function normaliseLoop(region: LoopRegion, durationS: number): LoopRegion | null {
  if (!Number.isFinite(region.startS) || !Number.isFinite(region.endS)) return null;
  const a = clampSeek(Math.min(region.startS, region.endS), durationS);
  const b = clampSeek(Math.max(region.startS, region.endS), durationS);
  return b - a < MIN_LOOP_S ? null : { startS: a, endS: b };
}

/** How to start one stem's source for a run; see `planSource`. */
export interface SourcePlan {
  /** Seconds after the run's start time at which the source starts. */
  delayS: number;
  /** Where in the source's buffer playback begins. */
  offsetS: number;
  /** Loop points in the source buffer's own time, or null for one-shot. */
  loop: LoopRegion | null;
  /**
   * When non-null the stem does not cover the whole loop, so play a
   * zero-padded copy of it whose sample 0 sits at this song time.
   */
  sliceFromS: number | null;
}

/**
 * Plans a stem's source for a run starting at song time `songPosS`. The stem's
 * sample 0 sits at song time `stemOffsetS` (negative is fine). Native
 * `loop` points are used when the stem covers the loop; otherwise a padded
 * slice keeps the stem aligned across wraps. Returns null when the stem has
 * nothing to play for the whole run.
 */
export function planSource(
  songPosS: number,
  stemOffsetS: number,
  bufferDurationS: number,
  loop: LoopRegion | null,
): SourcePlan | null {
  // A run that starts past the loop's end plays on to the end of the song.
  const active = loop && songPosS < loop.endS ? loop : null;
  const bufferPos = songPosS - stemOffsetS;
  const lead = { delayS: Math.max(0, -bufferPos), offsetS: Math.max(0, bufferPos) };
  if (!active) {
    return bufferPos >= bufferDurationS ? null : { ...lead, loop: null, sliceFromS: null };
  }
  const startBuf = active.startS - stemOffsetS;
  const endBuf = active.endS - stemOffsetS;
  if (startBuf >= 0 && endBuf <= bufferDurationS) {
    return { ...lead, loop: { startS: startBuf, endS: endBuf }, sliceFromS: null };
  }
  const from = Math.min(songPosS, active.startS);
  if (stemOffsetS + bufferDurationS <= from || stemOffsetS >= active.endS) return null;
  return {
    delayS: 0,
    offsetS: songPosS - from,
    loop: { startS: active.startS - from, endS: active.endS - from },
    sliceFromS: from,
  };
}

/**
 * Copies `src[srcStart + i]` into `dest[i]` wherever both exist, leaving the
 * rest of `dest` untouched (zero for a fresh AudioBuffer channel).
 */
export function copyOverlap(dest: Float32Array, src: Float32Array, srcStart: number): void {
  const first = Math.max(0, -srcStart);
  const last = Math.min(dest.length, src.length - srcStart);
  if (last > first) dest.set(src.subarray(srcStart + first, srcStart + last), first);
}

/** 32-bit FNV-1a of the bytes as 8 hex chars; the no-crypto fallback hash. */
export function fnv1aHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** sha256 hex of the bytes, or FNV-1a hex when subtle crypto is unavailable. */
export async function hashBytes(
  bytes: Uint8Array,
  subtle: Pick<SubtleCrypto, 'digest'> | null = globalThis.crypto?.subtle ?? null,
): Promise<string> {
  if (subtle) {
    try {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
      return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through: an insecure context can expose subtle but refuse to run.
    }
  }
  return fnv1aHex(bytes);
}

/** One playable layer: a buffer, where it sits in song time, and its gain. */
interface Stem {
  buffer: AudioBuffer;
  offsetS: number;
  level: number;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
}

/** Loads a song and plays it with synced stems, loop and clock-derived time. */
export class Player implements Transport {
  /** The audio engine's sample-accurate clock. */
  readonly clock = 'engine';
  private readonly stems = new Map<string, Stem>();
  private readonly listeners = new Map<PlayerEvent, Set<(p: Player) => void>>();
  private infoValue: SongInfo | null = null;
  private stateValue: PlayerState = 'empty';
  private loopValue: LoopRegion | null = null;
  private pausedAtS = 0;
  // Anchors for the current run: at context time anchorContextS the playhead
  // was at song time anchorSongS. runLoop is the loop that run was built with.
  private anchorContextS = 0;
  private anchorSongS = 0;
  private runLoop: LoopRegion | null = null;
  // Bumped whenever sources are replaced so stale onended events are ignored.
  private runId = 0;
  private loadId = 0;

  constructor(private readonly engine: AudioEngine) {}

  /** The loaded song, or null before the first successful load. */
  get info(): SongInfo | null {
    return this.infoValue;
  }

  /** Transport state. */
  get state(): PlayerState {
    return this.stateValue;
  }

  /** The active loop region, or null. */
  get loop(): LoopRegion | null {
    return this.loopValue;
  }

  /** Song time in seconds; the Transport name for `position()`. */
  get positionS(): number {
    return this.position();
  }

  /** Length of the loaded song, 0 before one is loaded. */
  get durationS(): number {
    return this.duration;
  }

  /**
   * Decodes the file and makes it the 'original' stem at gain 1, dropping all
   * other stems, any loop and any playback. Rejects with a readable message
   * when the file cannot be decoded, and when a newer load overtakes it.
   */
  async load(file: File | Blob, name?: string): Promise<SongInfo> {
    const loadId = ++this.loadId;
    const label = name ?? (file as { name?: string }).name ?? 'untitled';
    const bytes = await file.arrayBuffer();
    // Hash before decoding: decodeAudioData may detach the buffer it is given.
    const hash = await hashBytes(new Uint8Array(bytes));
    let buffer: AudioBuffer;
    try {
      buffer = await this.engine.context.decodeAudioData(bytes);
    } catch (cause) {
      throw new Error(`Could not read "${label}" as audio this browser can decode`, { cause });
    }
    if (loadId !== this.loadId) throw new Error(`Loading "${label}" was superseded`);

    this.haltSources();
    for (const stem of this.stems.values()) stem.gain.disconnect();
    this.stems.clear();
    const hadLoop = this.loopValue !== null;
    this.loopValue = null;
    this.runLoop = null;
    this.pausedAtS = 0;
    this.stateValue = 'ready';
    this.stems.set(ORIGINAL, this.makeStem(buffer));
    this.infoValue = {
      name: label,
      durationS: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      hash,
    };
    this.emit('load');
    this.emit('stems');
    if (hadLoop) this.emit('loop');
    return this.infoValue;
  }

  /**
   * Adds or replaces a stem played in sync with the original. `offsetS` is
   * the song time at which the buffer's first sample plays. Throws before a
   * song is loaded, and for the reserved id 'original' (use `load`).
   */
  addStem(id: string, buffer: AudioBuffer, offsetS = 0): void {
    if (this.stateValue === 'empty') throw new Error('Load a song before adding stems');
    if (id === ORIGINAL) throw new Error("The 'original' stem is set by load()");
    let stem = this.stems.get(id);
    if (stem) {
      this.retire(stem, this.engine.now());
      stem.buffer = buffer;
      stem.offsetS = offsetS;
    } else {
      stem = this.makeStem(buffer, offsetS);
      this.stems.set(id, stem);
    }
    if (this.stateValue === 'playing') {
      const when = this.engine.now() + START_LEAD_S;
      stem.source = this.makeSource(stem, this.positionAt(when), when);
    }
    this.emit('stems');
  }

  /** Removes a stem. The 'original' stem can only be replaced by `load`. */
  removeStem(id: string): void {
    const stem = this.stems.get(id);
    if (!stem || id === ORIGINAL) return;
    this.retire(stem, this.engine.now());
    stem.gain.disconnect();
    this.stems.delete(id);
    this.emit('stems');
  }

  /** Sets a stem's level, clamped to 0..1 and smoothed to avoid clicks. */
  setStemGain(id: string, gain: number): void {
    const stem = this.stems.get(id);
    if (!stem || Number.isNaN(gain)) return;
    stem.level = Math.min(Math.max(gain, 0), 1);
    stem.gain.gain.setTargetAtTime(stem.level, this.engine.now(), GAIN_SMOOTH_S);
    this.emit('stems');
  }

  /** A stem's current level (0..1), or null if there is no such stem. */
  stemGain(id: string): number | null {
    return this.stems.get(id)?.level ?? null;
  }

  /** Ids of all stems, 'original' first; empty before a song is loaded. */
  stemIds(): string[] {
    return [...this.stems.keys()];
  }

  /** Starts or resumes playback; from the start if it had reached the end. */
  play(): void {
    if (this.stateValue === 'empty' || this.stateValue === 'playing') return;
    const from = this.pausedAtS >= this.duration - END_EPS_S ? 0 : this.pausedAtS;
    // Most browsers only let a context start inside a user gesture, and
    // play() is called from one; scheduling on the context clock is safe even
    // if the resume lands a moment later.
    void this.engine.resume().catch(() => {});
    if (!this.startRun(from, this.engine.now() + START_LEAD_S)) return;
    this.stateValue = 'playing';
    this.emit('play');
  }

  /** Pauses at the current position. */
  pause(): void {
    if (this.stateValue !== 'playing') return;
    const at = this.position();
    this.haltSources();
    this.pausedAtS = at;
    this.stateValue = 'paused';
    this.emit('pause');
  }

  /** Pauses and returns to the start, leaving the player 'ready'. */
  stop(): void {
    if (this.stateValue === 'empty') return;
    const wasPlaying = this.stateValue === 'playing';
    const moved = wasPlaying || this.pausedAtS !== 0;
    this.haltSources();
    this.pausedAtS = 0;
    this.stateValue = 'ready';
    if (wasPlaying) this.emit('pause');
    if (moved) this.emit('seek');
  }

  /** Moves the playhead, clamped to the song. Rebuilds sources if playing. */
  seek(positionS: number): void {
    if (this.stateValue === 'empty') return;
    const target = clampSeek(positionS, this.duration);
    let ended = false;
    if (this.stateValue === 'playing') {
      ended = !this.startRun(target, this.engine.now() + START_LEAD_S);
    } else {
      this.pausedAtS = target;
    }
    this.emit('seek');
    if (ended) this.emit('ended');
  }

  /**
   * Sets or clears the loop region (null clears; a region too short to loop
   * also clears). While playing, the swap is gapless: the old sources run
   * until the new ones take over at the same song position.
   */
  setLoop(region: LoopRegion | null): void {
    const next = region && this.infoValue ? normaliseLoop(region, this.duration) : null;
    const prev = this.loopValue;
    if (next?.startS === prev?.startS && next?.endS === prev?.endS) return;
    this.loopValue = next;
    let ended = false;
    if (this.stateValue === 'playing') {
      const when = this.engine.now() + START_LEAD_S;
      ended = !this.startRun(this.positionAt(when), when);
    }
    this.emit('loop');
    if (ended) this.emit('ended');
  }

  /** Song time in seconds, read from the context clock. */
  position(): number {
    return this.stateValue === 'playing' ? this.positionAt(this.engine.now()) : this.pausedAtS;
  }

  /**
   * Song time that corresponds to a context time within the current run, or
   * null when not playing. Lets the recorder stamp mic frames in song time.
   */
  songTimeAtContext(contextTime: number): number | null {
    return this.stateValue === 'playing' ? this.positionAt(contextTime) : null;
  }

  /** Subscribes to an event; returns the function that unsubscribes. */
  on(event: PlayerEvent, cb: (p: Player) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  private get duration(): number {
    return this.infoValue?.durationS ?? 0;
  }

  private emit(event: PlayerEvent): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        cb(this);
      } catch (err) {
        // One bad listener must not stop the others or corrupt the transport.
        console.error(`Player '${event}' listener failed`, err);
      }
    }
  }

  /** Song time at a context time for the current run, loop wraps included. */
  private positionAt(contextTime: number): number {
    const linear = songTimeAt(contextTime, this.anchorContextS, this.anchorSongS);
    return wrapLoop(Math.max(this.anchorSongS, linear), this.runLoop, this.duration);
  }

  private makeStem(buffer: AudioBuffer, offsetS = 0): Stem {
    const gain = this.engine.context.createGain();
    gain.gain.value = 1;
    gain.connect(this.engine.master);
    return { buffer, offsetS, level: 1, gain, source: null };
  }

  /**
   * Replaces every stem's source with one that begins at song time `songPos`
   * at context time `when`; old sources are stopped at `when` so the swap has
   * no gap. Returns false (and settles at the end) when there is nothing left
   * to play.
   */
  private startRun(songPos: number, when: number): boolean {
    if (songPos >= this.duration - END_EPS_S) {
      this.haltSources();
      this.pausedAtS = this.duration;
      this.stateValue = 'paused';
      return false;
    }
    this.runId++;
    this.runLoop = this.loopValue && songPos < this.loopValue.endS ? this.loopValue : null;
    this.anchorContextS = when;
    this.anchorSongS = songPos;
    for (const stem of this.stems.values()) {
      this.retire(stem, when);
      stem.source = this.makeSource(stem, songPos, when);
    }
    return true;
  }

  /** Builds and starts one stem's source for the current run, or null. */
  private makeSource(stem: Stem, songPos: number, when: number): AudioBufferSourceNode | null {
    const plan = planSource(songPos, stem.offsetS, stem.buffer.duration, this.runLoop);
    if (!plan) return null;
    const ctx = this.engine.context;
    const src = ctx.createBufferSource();
    src.buffer = plan.sliceFromS === null ? stem.buffer : this.sliceStem(stem, plan.sliceFromS);
    if (plan.loop) {
      src.loop = true;
      src.loopStart = plan.loop.startS;
      src.loopEnd = plan.loop.endS;
    }
    src.connect(stem.gain);
    if (this.stems.get(ORIGINAL) === stem) {
      // The original defines the song, so its natural end is the song's end.
      const run = this.runId;
      src.onended = () => this.handleEnded(run);
    }
    src.start(when + plan.delayS, plan.offsetS);
    return src;
  }

  /**
   * A copy of the stem from song time `fromS` to the loop's end, zero where
   * the stem has no audio, so a looping source stays aligned with the others.
   */
  private sliceStem(stem: Stem, fromS: number): AudioBuffer {
    const { buffer } = stem;
    const rate = buffer.sampleRate;
    const length = Math.max(1, Math.ceil(((this.runLoop?.endS ?? fromS) - fromS) * rate));
    const out = this.engine.context.createBuffer(buffer.numberOfChannels, length, rate);
    const srcStart = Math.round((fromS - stem.offsetS) * rate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      copyOverlap(out.getChannelData(c), buffer.getChannelData(c), srcStart);
    }
    return out;
  }

  /** Stops a stem's source at context time `when` without firing 'ended'. */
  private retire(stem: Stem, when: number): void {
    const src = stem.source;
    if (!src) return;
    stem.source = null;
    src.onended = () => src.disconnect();
    try {
      src.stop(when);
    } catch {
      // Already stopped or never started; either way it is silent.
    }
  }

  /** Silences everything now and invalidates pending end-of-song events. */
  private haltSources(): void {
    this.runId++;
    const now = this.engine.now();
    for (const stem of this.stems.values()) this.retire(stem, now);
  }

  /** The original's source ran out: the song ended with no loop active. */
  private handleEnded(run: number): void {
    if (run !== this.runId || this.stateValue !== 'playing') return;
    this.haltSources();
    this.pausedAtS = this.duration;
    this.stateValue = 'paused';
    this.emit('ended');
  }
}
