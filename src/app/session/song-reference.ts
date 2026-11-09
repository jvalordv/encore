/**
 * The Song reference in the session: the one place that turns "Get the
 * melody" into the right mechanism. It tries the download first (the Prepare
 * flow, session/prepare.ts); if that fails for any reason it arms the
 * recording of the song's sound (session/capture.ts) for the next Play or
 * Record press, which is a user gesture and so can ask for Chrome's share
 * prompt, and the recording then runs alongside the take. It also holds the
 * rest of the card's behaviour: the prompt in learning mode, the automatic
 * setting that skips it, "Not now" for the session, the early end of a
 * recording once a take ends, and scoring earlier takes again when the melody
 * arrives. Both mechanisms underneath are unchanged in how they talk to the
 * service. The words and decisions are pure (src/app/song-reference.ts).
 */
import { canStop } from '../capture';
import { originalQueryFor } from '../learning';
import { skippedForNoVocal } from '../reference';
import { fallbackFor, melodySourceOf, offerFor, titleLooksKaraoke } from '../song-reference';
import type { AppState } from '../state';
import type { SessionCore } from './core';

/** Said when earlier takes were scored again against the melody that came. */
function rescoredStatus(count: number): string {
  return count === 1
    ? 'Your earlier take was scored again with the melody.'
    : `Your ${count} earlier takes were scored again with the melody.`;
}

/** Drives the Song reference card for the song in use. */
export class SongReferenceController {
  // Songs the singer said "Not now" to, by song hash, for this page's life.
  private readonly declined = new Set<string>();
  // Songs the automatic setting has already started since they loaded, so a
  // run that ends without a melody is not started again at once.
  private readonly started = new Set<string>();
  // True from a press (or an automatic start) of Get the melody until its
  // download has ended: only a download that was asked for arms the recording.
  private asked = false;
  // The melody last scored against, so a repeat of the same one scores nothing.
  private rescored = '';

  constructor(private readonly core: SessionCore) {
    core.store.subscribe((state, changed) => this.onChange(state, changed));
  }

  /** Turns the automatic start on or off and remembers it. */
  setAutoReference(on: boolean): void {
    this.core.current.autoReference = on === true;
    this.core.persist();
  }

  /**
   * "Get the melody": downloads the song through the service, and if that
   * fails arms the recording of its sound for the next take. Does nothing
   * unless the card is offering it.
   */
  async getMelody(): Promise<void> {
    const { core } = this;
    if (core.capture.busy) return;
    const { phase } = core.store.state.prepare;
    if (phase !== 'ready' && phase !== 'failed') return;
    // A press starts afresh: an earlier failure's arm and details go.
    this.asked = true;
    this.patch({ armed: false, details: '' });
    // An earlier recording's failure ("The share was cancelled") would
    // otherwise keep speaking over the new try's note and hint.
    core.capture.clearFinished();
    await core.prepare.prepare();
  }

  /** "Not now": the prompt stays away for this song until the page reloads. */
  notNow(): void {
    const hash = this.core.store.state.song?.hash;
    if (hash) this.declined.add(hash);
    this.patch({ declined: true });
  }

  /** True when a Play or Record press would start the recording of the song's sound. */
  get hasArmed(): boolean {
    const { songRef, prepare } = this.core.store.state;
    return songRef.armed && prepare.phase === 'failed' && !!this.core.songs.embed;
  }

  /**
   * Called by a Play or Record press. When the download failed and the
   * recording is armed, starts it now (the share prompt wants this gesture)
   * and returns the promise that resolves once the share has been answered,
   * so the song starts after it and not under the dialog; null when there is
   * nothing armed.
   */
  takeArmed(): Promise<void> | null {
    if (!this.hasArmed) return null;
    this.patch({ armed: false });
    return this.core.capture.start();
  }

  /**
   * The download failed (the Prepare flow's last word). Arms the recording
   * when this browser can make one and says in plain words what will happen;
   * the service's own text goes only into the card's Details. A failure after
   * a recording was sent on is that recording's, and keeps the service's words.
   */
  downloadFailed(message: string): void {
    const { core } = this;
    const { store } = core;
    const { phase } = store.state.capture;
    if (phase === 'uploading' || phase === 'preparing') {
      store.setStatus(message, 'error');
      return;
    }
    const fallback = fallbackFor(message, core.capture.supported, this.asked);
    this.asked = false;
    this.patch({ armed: fallback.arm, details: fallback.details });
    store.setStatus(fallback.note, 'warn');
  }

  private patch(fields: Partial<AppState['songRef']>): void {
    const { store } = this.core;
    const next = { ...store.state.songRef, ...fields };
    const now = store.state.songRef;
    if (next.armed !== now.armed || next.details !== now.details || next.declined !== now.declined) {
      store.patch({ songRef: next });
    }
  }

  private onChange(state: AppState, changed: ReadonlySet<keyof AppState>): void {
    if (changed.has('song') || changed.has('prepare')) this.syncSong(state);
    const asks = ['prepare', 'mode', 'settingsRev', 'reference', 'songRef', 'capture', 'song'] as const;
    if (asks.some((key) => changed.has(key))) this.startAutomatically(state);
    if (changed.has('recording') && !state.recording && state.capture.phase === 'capturing' && canStop(state.capture)) {
      // The take is over and the song has been heard through: send it on.
      void this.core.capture.stop();
    }
    if (changed.has('reference')) this.rescoreEarlierTakes(state);
  }

  /** Keeps what the card remembers in step with the song in use. */
  private syncSong(state: AppState): void {
    if (state.prepare.phase === 'none') {
      this.started.clear();
      this.asked = false;
    }
    const hash = state.song?.hash;
    const declined = hash !== undefined && this.declined.has(hash);
    if (state.prepare.phase === 'none') this.patch({ armed: false, details: '', declined });
    else this.patch({ declined });
  }

  /** With the automatic setting on, starts "Get the melody" without the prompt. */
  private startAutomatically(state: AppState): void {
    const hash = state.song?.hash;
    if (!hash || this.started.has(hash)) return;
    const query = originalQueryFor(state);
    const offer = offerFor({
      mode: state.mode,
      autoReference: this.core.current.autoReference,
      declined: state.songRef.declined,
      armed: state.songRef.armed,
      prepare: state.prepare.phase,
      melody: melodySourceOf(state.reference),
      capture: state.capture.phase,
      karaoke: titleLooksKaraoke(query.title, query.channel) || skippedForNoVocal(state.reference),
    });
    if (offer !== 'auto') return;
    this.started.add(hash);
    void this.getMelody();
  }

  /** Scores the song's earlier takes against a melody that has just arrived. */
  private rescoreEarlierTakes(state: AppState): void {
    const { reference, song } = state;
    if (reference.phase !== 'ready' || !song) return;
    const which = `${song.hash}|${reference.alignedFrom ?? ''}|${reference.notes}`;
    if (which === this.rescored) return;
    this.rescored = which;
    void this.core.scoring
      .rescoreWithMelody()
      .then((count) => {
        // Karaoke mode shows nothing from learning mode, this line included.
        if (count > 0 && this.core.store.state.mode === 'learning') {
          this.core.store.setStatus(rescoredStatus(count));
        }
      })
      .catch(() => {
        // The old reports stay; the singer can sing again.
      });
  }
}
