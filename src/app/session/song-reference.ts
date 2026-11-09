/**
 * The Song reference in the session: the one place that turns "Get the
 * melody" into action. For a YouTube song the service already holds from an
 * earlier session, that means taking it over at once; otherwise it means
 * arming the recording of the song's sound (session/capture.ts) for the next
 * Play or Record press, which is a user gesture and so can ask for Chrome's
 * share prompt; the recording then runs alongside the take. Encore never
 * downloads the video.
 * It also holds the rest of the card's behaviour: the prompt in learning mode,
 * the automatic setting that arms the recording without the prompt, "Not now"
 * for the session, the early end of a recording once a take ends, and scoring
 * earlier takes again when the melody or the key arrives. The words and
 * decisions are pure (src/app/song-reference.ts).
 */
import { canStop } from '../capture';
import { originalQueryFor } from '../learning';
import { skippedForNoVocal } from '../reference';
import { melodySourceOf, NO_RECORDING_NOTE, offerFor, titleLooksKaraoke } from '../song-reference';
import type { AppState } from '../state';
import type { SessionCore } from './core';

/** Said when earlier takes were scored again against the melody that came. */
function rescoredStatus(count: number): string {
  return count === 1
    ? 'Your earlier take was scored again with the melody.'
    : `Your ${count} earlier takes were scored again with the melody.`;
}

/** Said when earlier takes were scored again against the key that came. */
function rescoredKeyStatus(count: number): string {
  return count === 1
    ? 'Your earlier take was scored again with the key.'
    : `Your ${count} earlier takes were scored again with the key.`;
}

/** Drives the Song reference card for the song in use. */
export class SongReferenceController {
  // Songs the singer said "Not now" to, by song hash, for this page's life.
  private readonly declined = new Set<string>();
  // Songs the automatic setting has already started since they loaded, so a
  // song whose recording ends without a melody is not armed again at once.
  private readonly started = new Set<string>();
  // The melody last scored against, so a repeat of the same one scores nothing.
  private rescored = '';
  // The key last scored against, likewise.
  private rescoredKey = '';

  constructor(private readonly core: SessionCore) {
    core.store.subscribe((state, changed) => this.onChange(state, changed));
  }

  /** Turns the automatic start on or off and remembers it. */
  setAutoReference(on: boolean): void {
    this.core.current.autoReference = on === true;
    this.core.persist();
  }

  /**
   * "Get the melody": arms the recording of the song's sound for the next
   * Play or Record press. Does nothing unless the card is offering it, and
   * says so when this browser cannot record a tab.
   */
  async getMelody(): Promise<void> {
    const { core } = this;
    if (core.capture.busy) return;
    const { phase } = core.store.state.prepare;
    if (phase !== 'ready' && phase !== 'failed') return;
    // An earlier recording's failure ("The share was cancelled") would
    // otherwise keep speaking over the new try's note and hint.
    core.capture.clearFinished();
    // A recording made in an earlier session is already the service's: take it
    // over at once, with no share prompt and no replay.
    if (await core.prepare.adoptIfHeld()) return;
    const { phase: after } = core.store.state.prepare;
    if (core.capture.busy || (after !== 'ready' && after !== 'failed')) return;
    if (!core.capture.supported) {
      core.store.setStatus(NO_RECORDING_NOTE, 'warn');
      return;
    }
    this.patch({ armed: true });
    core.store.setStatus("Encore will record the song's sound while you sing your first take.");
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
    const open = prepare.phase === 'ready' || prepare.phase === 'failed';
    return songRef.armed && open && !!this.core.songs.embed;
  }

  /**
   * Called by a Play or Record press. When the recording is armed, starts it
   * now (the share prompt wants this gesture) and returns the promise that
   * resolves once the share has been answered, so the song starts after it and
   * not under the dialog; null when there is nothing armed.
   */
  takeArmed(): Promise<void> | null {
    if (!this.hasArmed) return null;
    this.patch({ armed: false });
    return this.core.capture.start();
  }

  private patch(fields: Partial<AppState['songRef']>): void {
    const { store } = this.core;
    const next = { ...store.state.songRef, ...fields };
    const now = store.state.songRef;
    if (next.armed !== now.armed || next.declined !== now.declined) {
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
    if (changed.has('key')) this.rescoreForKey(state);
  }

  /** Keeps what the card remembers in step with the song in use. */
  private syncSong(state: AppState): void {
    if (state.prepare.phase === 'none') this.started.clear();
    const hash = state.song?.hash;
    const declined = hash !== undefined && this.declined.has(hash);
    if (state.prepare.phase === 'none') this.patch({ armed: false, declined });
    else this.patch({ declined });
  }

  /** With the automatic setting on, arms "Get the melody" without the prompt. */
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
      recordable: this.core.capture.supported,
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

  /**
   * Scores the song's earlier learning takes against a key that has just
   * arrived, alone or before a melody: the melody's own re-score reaches only
   * takes that had no melody, and leaves the rest judged on the singing's own
   * key.
   */
  private rescoreForKey(state: AppState): void {
    const { key, song } = state;
    if (key.phase !== 'ready' || !song) return;
    const which = song.hash;
    if (which === this.rescoredKey) return;
    this.rescoredKey = which;
    void this.core.scoring
      .rescoreWithKey()
      .then((count) => {
        if (count > 0 && this.core.store.state.mode === 'learning') {
          this.core.store.setStatus(rescoredKeyStatus(count));
        }
      })
      .catch(() => {
        // The old reports stay; the singer can sing again.
      });
  }
}
