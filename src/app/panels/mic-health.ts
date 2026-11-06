/**
 * The mic's health under the level meter: a mark on the meter where the noise
 * floor sits, one plain line saying whether the mic is hearing the singer, and,
 * in speaker mode, a second line when the mic seems to be hearing the song
 * through the speakers (or that it cannot tell until the song is prepared).
 * Both lines are drawn from `state.input` alone; the Session measures. The
 * words are chosen by `describeMicHealth`, which is pure and tested.
 */
import type { AppState, InputState, StateStore } from '../state';
import { METER_FLOOR_DB } from '../state';
import type { MountPanel } from './panel';

/** Said when the mic is hearing a voice. */
export const HEARING_LINE = 'Hearing you';
/** Said when something reaches the mic but not at voice level. */
export const QUIET_LINE = 'Too quiet — move closer or raise the mic';
/** Said when the mic is at its noise floor. */
export const NOTHING_LINE = 'Nothing from the mic';
/** Said in speaker mode when the mic's pitch follows the song's melody. */
export const BLEED_LINE =
  'The mic may be hearing the song through the speakers. Stop singing for a few seconds: ' +
  'if the line keeps moving, it is the speakers.';
/** Said in speaker mode when there is no melody to compare the mic with. */
export const CANNOT_CHECK_LINE =
  'Cannot check whether the mic is hearing the song until the song is prepared.';

/** The meter's peak reads 3 dB above RMS for a steady tone; the mark allows for it. */
const PEAK_OVER_RMS_DB = 3;
/** A floor at or below this is not measured yet, so no mark is drawn. */
const UNMEASURED_DB = -100;

/** What the two lines say, or empty text for a line with nothing to say. */
export interface MicHealthView {
  state: string;
  bleed: string;
  /** 'warn' while bleed is suspected, for the line's emphasis. */
  bleedKind: 'info' | 'warn';
}

/** The words under the meter for an input; empty while no mic is open. */
export function describeMicHealth(input: InputState): MicHealthView {
  const none: MicHealthView = { state: '', bleed: '', bleedKind: 'info' };
  if (!input.open) return none;
  const state =
    input.micState === 'hearing' ? HEARING_LINE : input.micState === 'quiet' ? QUIET_LINE : NOTHING_LINE;
  if (!input.requestedAec) return { ...none, state };
  if (input.bleed.state === 'suspected') return { state, bleed: BLEED_LINE, bleedKind: 'warn' };
  if (input.bleed.reason === 'no_reference') return { state, bleed: CANNOT_CHECK_LINE, bleedKind: 'info' };
  return { ...none, state };
}

/** Where the floor mark sits along the meter, 0..1; null when not measured. */
export function floorMarkFraction(floorDb: number): number | null {
  if (!(floorDb > UNMEASURED_DB)) return null;
  const db = floorDb + PEAK_OVER_RMS_DB;
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** What the panel needs: the state to draw and the meter to mark. */
export interface MicHealthPanelDeps {
  store: StateStore;
  meter: HTMLElement;
}

/** Builds the lines into `host` and the floor mark into the meter. */
export const mountMicHealthPanel: MountPanel<MicHealthPanelDeps> = (host, { store, meter }) => {
  const doc = host.ownerDocument;
  const mark = doc.createElement('div');
  mark.className = 'meter-floor';
  mark.dataset.testid = 'mic-floor';
  mark.title = 'Noise floor: the level of the room when you are not singing';
  mark.hidden = true;
  meter.append(mark);

  const stateLine = doc.createElement('div');
  stateLine.className = 'song-meta mic-state';
  stateLine.dataset.testid = 'mic-state';
  const bleedLine = doc.createElement('div');
  bleedLine.className = 'song-meta mic-bleed';
  bleedLine.dataset.testid = 'mic-bleed';
  host.append(stateLine, bleedLine);

  const render = (state: AppState): void => {
    const { input } = state;
    const view = describeMicHealth(input);
    stateLine.textContent = view.state;
    stateLine.hidden = view.state === '';
    stateLine.dataset.state = input.open ? input.micState : '';
    bleedLine.textContent = view.bleed;
    bleedLine.hidden = view.bleed === '';
    bleedLine.dataset.kind = view.bleedKind;
    const at = input.open ? floorMarkFraction(input.floorDb) : null;
    mark.hidden = at === null;
    if (at !== null) mark.style.left = `${(at * 100).toFixed(1)}%`;
  };
  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.has('input')) render(state);
  });
  render(store.state);

  return () => {
    unsubscribe();
    mark.remove();
    host.replaceChildren();
  };
};
