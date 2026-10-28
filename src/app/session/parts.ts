/**
 * Builds the real audio objects the Session sits on. Kept apart from the
 * controllers so tests can hand them fake parts instead; this is the one
 * place that constructs the engine, the player, the mic, the tracker and the
 * recorder.
 */
import { PitchTracker } from '../../analysis/pitch-tracker';
import { PcmCapture } from '../../audio/capture';
import { AudioEngine } from '../../audio/engine';
import { MicCapture } from '../../audio/mic';
import { Player } from '../../audio/player';
import { Recorder } from '../../audio/recorder';
import type { StateStore } from '../state';
import { messageOf } from './helpers';
import type { SessionParts } from './types';

/** The audio objects, or null (with the reason on the status line). */
export function buildParts(store: StateStore, clarityThreshold: number): SessionParts | null {
  if (!AudioEngine.isSupported()) {
    store.setStatus('This browser has no Web Audio. Use a current Chrome or Edge.', 'error');
    return null;
  }
  try {
    const engine = new AudioEngine();
    const mic = new MicCapture(engine);
    const capture = new PcmCapture(engine);
    const tracker = new PitchTracker(engine, { clarityThreshold });
    return {
      engine,
      player: new Player(engine),
      mic,
      capture,
      tracker,
      recorder: new Recorder(engine, mic, capture),
    };
  } catch (error) {
    store.setStatus(`Audio could not start: ${messageOf(error)}`, 'error');
    return null;
  }
}
