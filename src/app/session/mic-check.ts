/**
 * The Mic check: a guided 40 s run that measures the room and the mic and
 * offers tuned settings. It borrows the audio player for a synthesised test
 * track (the song in use is put aside and comes back untouched), records the
 * mic as a take marked `mic-check` with the labelled stretches in its trace,
 * walks the singer through the four steps by the song clock, then posts the
 * take to the service for analysis. The steps run, and the take is saved,
 * with the service away; only the advice needs it. The pure parts (the step
 * machine, the words) are in src/app/mic-check.ts, the track in
 * src/analysis/test-melody.ts. Speaks about the mic and the room, never the
 * singing, and so runs in either practice mode.
 */
import { applyTuningChange } from '../../analysis/mic-tuning';
import { generateTestMelody, micCheckSections } from '../../analysis/test-melody';
import type { MelodyRange, MicCheckSection, TestMelody } from '../../analysis/test-melody';
import type { Player } from '../../audio/player';
import { encodeWavBlob } from '../../audio/wav';
import { isAbortError, ServiceClient, ServiceError } from '../../service/client';
import { initialMicCheck, isActivePhase, PAIR_CHANGED, secondsLeft, sectionAt, stepMachine } from '../mic-check';
import type { MicCheckEvent, MicCheckState } from '../mic-check';
import type { SessionCore } from './core';
import { messageOf, sleep } from './helpers';

/** The key the test track is filed under; no real song has it. */
export const MIC_CHECK_SONG_KEY = 'mic-check';
/** Wait after starting the track so its sources are really running. */
const START_LEAD_MS = 60;
/** Smallest step-length factor the test seam accepts. */
const MIN_SCALE = 0.05;

/** Said when the service cannot be reached. */
export const NEEDS_SERVICE =
  'The advice needs the service. Start it as the README describes, then run the check again. ' +
  'Your recording is saved: use Save WAV and Save JSON below.';

/**
 * Test seam: `?micCheckScale=0.1` in the page address shortens every step by
 * that factor so the end-to-end run need not wait 40 s. Absent or invalid, the
 * steps have their real length.
 */
export function durationScale(search: string = globalThis.location?.search ?? ''): number {
  const raw = new URLSearchParams(search).get('micCheckScale');
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= MIN_SCALE && value <= 1 ? value : 1;
}

/** What one run keeps until it is over. */
interface Run {
  sections: MicCheckSection[];
  unsubscribe: Array<() => void>;
  /** Settles the wait for the end of the steps. */
  end: () => void;
  /** Why the run stopped early, or null if it ran its course. */
  stopped: { kind: 'cancel' | 'failed'; message: string } | null;
}

/** Runs the Mic check and applies what it recommends. */
export class MicCheckController {
  /** True from the press of the button until the song is back. */
  active = false;
  private run: Run | null = null;
  private analysis: AbortController | null = null;
  // The mic and speakers the check ran on; its advice is for that pair only.
  private checkedPair: string | null = null;
  // Puts the video set aside for the run back, once the song is.
  private resumeEmbed: (() => void) | null = null;

  constructor(private readonly core: SessionCore) {}

  /** Starts a check with the melody in `range`; refused while busy. */
  async start(range: MelodyRange): Promise<void> {
    const { parts, store, takes } = this.core;
    if (!parts || this.active) return;
    const state = store.state;
    if (isActivePhase(state.micCheck.phase)) return;
    if (state.recording || takes.startingRecord || state.calibrating) {
      store.setStatus('Finish recording or calibrating before the Mic check.', 'warn');
      return;
    }
    this.active = true;
    try {
      if (!(await this.core.input.ensureInput())) return;
      if (store.state.tracker !== 'running') {
        store.setStatus('The Mic check needs live pitch, which is unavailable here.', 'warn');
        return;
      }
      if (takes.solo || store.state.playingTakeId !== null) takes.stopTake();
      this.checkedPair = this.core.latency.pairKey();
      const scale = durationScale();
      const melody = generateTestMelody(parts.engine.context.sampleRate, range, scale);
      this.publish({ ...initialMicCheck(), range, phase: 'quiet' });
      await this.execute(parts.player, melody);
    } finally {
      this.active = false;
    }
    await this.analyse();
  }

  /** Stops the check, or the wait for its analysis, at the singer's request. */
  cancel(): void {
    if (this.run) this.stop('cancel', 'Mic check cancelled.');
    else this.analysis?.abort();
  }

  /** Closes the result card. */
  close(): void {
    this.send({ type: 'close' });
  }

  /** Stores the recommended values for this device pair, and the latency. */
  applySettings(): void {
    const { micCheck } = this.core.store.state;
    const offer = micCheck.analysis?.recommended;
    if (!offer || this.pairChanged()) return;
    const { health, latency, store } = this.core;
    health.setTuning(
      applyTuningChange(health.tuning(), {
        drawMarginDb: offer.draw_margin_db,
        clarityThreshold: offer.clarity_threshold,
        bleedMatchCents: offer.bleed_match_cents,
        bleedMinMatch: offer.bleed_min_match,
        bleedMaxMedianCents: offer.bleed_max_median_cents,
      }),
    );
    if (offer.latency_s !== null) latency.setLatency(offer.latency_s);
    this.publish({ ...micCheck, applied: true });
    store.setStatus('Mic settings updated for this microphone and output.');
  }

  /** Returns this device pair's mic rules to the defaults. */
  resetSettings(): void {
    if (this.pairChanged()) return;
    this.core.health.setTuning(null);
    this.publish({ ...this.core.store.state.micCheck, applied: false });
    this.core.store.setStatus('Mic settings are back to the defaults for this microphone and output.');
  }

  /** True, and said, when the pair is not the one the check ran on. */
  private pairChanged(): boolean {
    if (this.checkedPair === null || this.checkedPair === this.core.latency.pairKey()) return false;
    this.publish({ ...this.core.store.state.micCheck, pairChanged: true });
    this.core.store.setStatus(PAIR_CHANGED, 'warn');
    return true;
  }

  /**
   * Plays the track and records the take, then puts the song back. Resolves
   * once the steps are over (or stopped) and the song is restored, leaving
   * the phase at 'analysing', or at its end if the run was stopped.
   */
  private async execute(player: Player, melody: TestMelody): Promise<void> {
    const { store, takes, songs, stems } = this.core;
    let end: () => void = () => {};
    const over = new Promise<void>((resolve) => (end = resolve));
    const run: Run = { sections: melody.sections, unsubscribe: [], end, stopped: null };
    this.run = run;
    const savedBefore = takes.lastSavedId;
    try {
      // A video is paused and set aside first, so it is never heard beside the
      // track and comes back, paused where it was.
      this.resumeEmbed = songs.parkEmbed();
      takes.endReplay();
      this.core.lane?.clearFrames();
      stems.showTransient(melody.reference);
      const wav = encodeWavBlob(melody.pcm, melody.sampleRate, 16);
      await player.loadTransient(wav, 'Mic check', MIC_CHECK_SONG_KEY);
      songs.activate(player);
      this.core.input.resetFrameClock();
      run.unsubscribe.push(
        store.subscribe((state, changed) => {
          if (changed.has('positionS')) this.onTime(player.position());
          if (changed.has('input') && !state.input.open) {
            this.stop('failed', 'The microphone closed, so the Mic check stopped.');
          }
        }),
        player.on('ended', () => run.end()),
        player.on('pause', () => this.stop('cancel', 'Playback was paused, so the Mic check stopped.')),
        player.on('seek', () => this.stop('cancel', 'The song was moved, so the Mic check stopped.')),
        player.on('load', () => {
          if (player.info?.hash !== MIC_CHECK_SONG_KEY) {
            this.stop('cancel', 'A song was loaded, so the Mic check stopped.');
          }
        }),
      );
      store.setStatus('Mic check: follow the prompts.');
      player.play();
      await sleep(START_LEAD_MS);
      if (!run.stopped && !(await takes.beginMicCheckTake(melody.sections))) {
        this.stop('failed', store.state.status.text || 'The Mic check could not start.');
      }
      if (!run.stopped) await over;
      // Finished (or dropped) while the test track is still the song.
      await takes.finishRecording();
    } catch (error) {
      run.stopped ??= { kind: 'failed', message: messageOf(error) };
      await takes.finishRecording();
    } finally {
      for (const off of run.unsubscribe) off();
      this.run = null;
      await this.restore(player);
    }
    if (run.stopped) {
      // A stopped run leaves no take behind: it would be a partial recording.
      const id = takes.lastSavedId;
      if (id !== null && id !== savedBefore) await takes.deleteTake(id);
      this.finish(run.stopped.kind, run.stopped.message);
    } else {
      this.send({ type: 'recorded' });
    }
  }

  /** Brings the song, its melody and the lane back as they were. */
  private async restore(player: Player): Promise<void> {
    const { songs, stems, takes } = this.core;
    player.endTransient();
    stems.showTransient(null);
    this.core.lane?.clearFrames();
    this.core.input.resetFrameClock();
    songs.syncTransport();
    this.resumeEmbed?.();
    this.resumeEmbed = null;
    await takes.refreshTakes();
  }

  /** Posts the saved take to the service and shows what comes back. */
  private async analyse(): Promise<void> {
    const { store, takes } = this.core;
    if (store.state.micCheck.phase !== 'analysing') return;
    const takeId = takes.lastSavedId;
    const controller = new AbortController();
    this.analysis = controller;
    try {
      const json = takeId ? await takes.exportFile(takeId, 'json') : null;
      const wav = takeId ? await takes.exportFile(takeId, 'wav') : null;
      if (!json || !wav) throw new Error('The recording could not be read back.');
      const client = new ServiceClient({ baseUrl: this.core.current.serviceUrl });
      const analysis = await client.analyseTake(json.blob, wav.blob, controller.signal);
      this.publish({ ...store.state.micCheck, analysis, takeId });
      this.send({ type: 'analysed' });
    } catch (error) {
      if (isAbortError(error)) {
        this.finish('cancel', 'Analysis cancelled. Your recording is saved.', { takeId });
      } else if (error instanceof ServiceError && error.kind === 'unreachable') {
        this.finish('failed', NEEDS_SERVICE, { takeId, needsService: true });
      } else {
        this.finish('failed', messageOf(error), { takeId });
      }
    } finally {
      this.analysis = null;
    }
  }

  /** Ends the steps early; the first reason given is kept. */
  private stop(kind: 'cancel' | 'failed', message: string): void {
    const run = this.run;
    if (!run || run.stopped) return;
    run.stopped = { kind, message };
    run.end();
  }

  private finish(
    how: 'cancel' | 'failed',
    message: string,
    extra: { takeId?: string | null; needsService?: boolean } = {},
  ): void {
    this.send({ type: how === 'cancel' ? 'cancel' : 'failed' });
    this.publish({
      ...this.core.store.state.micCheck,
      message,
      takeId: extra.takeId ?? null,
      needsService: extra.needsService ?? false,
    });
    this.core.store.setStatus(message, how === 'failed' ? 'warn' : 'info');
  }

  private onTime(songS: number): void {
    const run = this.run;
    if (!run) return;
    const state = this.core.store.state.micCheck;
    const phase = stepMachine(state.phase, { type: 'time', songS }, run.sections);
    const section = sectionAt(songS, run.sections);
    const stepLeftS = section ? secondsLeft(songS, section) : 0;
    if (phase !== state.phase || stepLeftS !== state.stepLeftS) this.publish({ ...state, phase, stepLeftS });
  }

  private send(event: MicCheckEvent): void {
    const state = this.core.store.state.micCheck;
    const phase = stepMachine(state.phase, event, this.run?.sections ?? micCheckSections(durationScale()));
    if (phase === state.phase) return;
    this.publish(phase === 'idle' ? initialMicCheck() : { ...state, phase, stepLeftS: 0 });
  }

  private publish(next: MicCheckState): void {
    this.core.store.patch({ micCheck: next });
  }
}
