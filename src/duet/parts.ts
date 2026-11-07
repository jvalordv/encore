/**
 * Builds singer B's audio objects: a mic (the real one, or the page's own
 * tone when the `?secondFake` seam is in the address; see second-mic.ts), a
 * pitch tracker of its own and a capture for calibrating that mic. Kept apart
 * from the controller so tests hand it fake parts instead.
 */
import { PitchTracker } from '../analysis/pitch-tracker';
import type { SessionParts, SecondParts } from '../app/session/types';
import { PcmCapture } from '../audio/capture';
import { MicCapture } from '../audio/mic';
import { FakeSecondMic, fakeSecondHz } from './second-mic';

/** Singer B's parts on the session's audio engine; null without Web Audio. */
export function buildSecondParts(
  parts: SessionParts | null,
  clarityThreshold: number,
  search: string = globalThis.location?.search ?? '',
): SecondParts | null {
  if (!parts) return null;
  const { engine } = parts;
  const hz = fakeSecondHz(search);
  const fake = hz === null ? null : new FakeSecondMic(engine.context, hz);
  return {
    mic: fake ?? new MicCapture(engine),
    tracker: new PitchTracker(engine, { clarityThreshold }),
    capture: fake ? null : new PcmCapture(engine),
  };
}
