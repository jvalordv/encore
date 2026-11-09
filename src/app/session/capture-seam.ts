/**
 * Test seam for recording the song's sound: `?captureFake` in the page address
 * swaps the tab share, which a headless browser cannot answer, for a stream of
 * the engine's own making, a steady tone. `?captureFake=noaudio` gives a share
 * with no sound, for the path that tells the singer to turn tab audio on.
 * Without the parameter nothing here runs and the real share is asked for.
 */
import type { TabAudioSource } from '../../audio/tab-capture';

/** Pitch of the stand-in tone, Hz. */
const TONE_HZ = 330;
/** Level of the stand-in tone; quiet, in case a test is listening. */
const TONE_GAIN = 0.2;

/** The fake source when the address asks for one, else null. */
export function fakeCaptureSource(
  context: AudioContext,
  search: string = globalThis.location?.search ?? '',
): TabAudioSource | null {
  const params = new URLSearchParams(search);
  if (!params.has('captureFake')) return null;
  const silent = params.get('captureFake') === 'noaudio';
  return () => {
    if (silent) return Promise.resolve(new MediaStream());
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = TONE_HZ;
    gain.gain.value = TONE_GAIN;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    return Promise.resolve(destination.stream);
  };
}
