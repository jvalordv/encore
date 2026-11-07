/**
 * What singer B's input needs from a microphone, and the test seam that
 * stands in for one. Chromium's fake capture plays one file for every device,
 * so two distinct fake mics cannot be told apart: `?secondFake` in the page
 * address swaps singer B's mic for a steady tone made inside the page (330 Hz,
 * a fourth under the e2e's own 440 Hz fake mic), and `?secondFake=HZ` picks the
 * pitch. Without the parameter nothing here runs and the real device is opened.
 */
import type { MonitorMode } from '../audio/mic';

/** The slice of MicCapture singer B's input uses; MicCapture satisfies it. */
export interface SecondMic {
  open(deviceId: string | null, channels?: 1 | 2, mode?: MonitorMode): Promise<void>;
  close(): void;
  readonly source: AudioNode | null;
  readonly label: string;
  readonly settings: MediaTrackSettings | null;
  level(): number;
  onEnded(cb: () => void): () => void;
}

/** Pitch of the stand-in voice when the address gives none, Hz. */
const DEFAULT_HZ = 330;
/** Level of the stand-in voice: clearly above the floor, well under clipping. */
const GAIN = 0.4;

/** The pitch the address asks for, or null when there is no seam. */
export function fakeSecondHz(search: string = globalThis.location?.search ?? ''): number | null {
  const params = new URLSearchParams(search);
  if (!params.has('secondFake')) return null;
  const hz = Number(params.get('secondFake'));
  return Number.isFinite(hz) && hz >= 60 && hz <= 1000 ? hz : DEFAULT_HZ;
}

/** A mic that is a steady tone inside the page; never touches a device. */
export class FakeSecondMic implements SecondMic {
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly hz: number,
  ) {}

  open(): Promise<void> {
    this.close();
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = this.hz;
    gain.gain.value = GAIN;
    oscillator.connect(gain);
    oscillator.start();
    this.oscillator = oscillator;
    this.gain = gain;
    return Promise.resolve();
  }

  close(): void {
    this.oscillator?.stop();
    this.oscillator?.disconnect();
    this.gain?.disconnect();
    this.oscillator = null;
    this.gain = null;
  }

  get source(): AudioNode | null {
    return this.gain;
  }

  get label(): string {
    return this.gain ? 'Second fake mic' : '';
  }

  get settings(): MediaTrackSettings | null {
    return this.gain ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : null;
  }

  level(): number {
    return this.gain ? GAIN : 0;
  }

  onEnded(): () => void {
    return () => {};
  }
}
