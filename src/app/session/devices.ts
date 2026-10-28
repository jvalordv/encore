/**
 * The audio devices the browser offers and the output the song is sent to:
 * the input and output lists, the watch for devices coming and going, the
 * output choice and its restore on start. Choosing and opening the input
 * (mic) is the input controller's job; this only lists and routes the song.
 */
import { listOutputDevices } from '../../audio/engine';
import { listInputDevices, onDeviceChange } from '../../audio/mic';
import type { SessionCore } from './core';
import type { DeviceLists } from './types';

/** Lists devices, watches for changes and owns the output choice. */
export class DeviceController {
  private lists: DeviceLists = { inputs: [], outputs: [] };
  private readonly listeners = new Set<(devices: DeviceLists) => void>();
  private stopWatch: (() => void) | null = null;

  constructor(private readonly core: SessionCore) {}

  /** The devices seen by the last refreshDevices(). */
  get deviceLists(): DeviceLists {
    return this.lists;
  }

  /** Starts watching for devices coming and going, and restores the output. */
  start(): void {
    this.stopWatch = onDeviceChange(() => void this.refreshDevices());
    void this.restoreOutput().then(() => this.refreshDevices());
  }

  /** Stops the device watch. */
  stop(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  /** Subscribes to device list changes; returns the unsubscribe function. */
  onDevices(cb: (devices: DeviceLists) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Re-reads the input and output devices and tells the listeners. */
  async refreshDevices(): Promise<DeviceLists> {
    const [inputs, outputs] = await Promise.all([listInputDevices(), listOutputDevices()]);
    this.lists = { inputs, outputs };
    const { store, parts } = this.core;
    const { input, output } = store.state;
    store.patchSection('output', { label: this.outputLabel(output.deviceId) });
    if (input.open && parts) store.patchSection('input', { label: parts.mic.label });
    for (const cb of [...this.listeners]) cb(this.lists);
    return this.lists;
  }

  /** Sends the song to an output device (null or '' for the default). */
  async chooseOutput(id: string | null): Promise<void> {
    const { parts, store } = this.core;
    if (!parts) return;
    const deviceId = id === '' ? null : id;
    if (!store.state.output.selectable) {
      store.setStatus('This browser cannot pick an output device; the system default is used.', 'warn');
      return;
    }
    if (!(await parts.engine.setOutputDevice(deviceId))) {
      store.setStatus('That output device could not be used.', 'warn');
      return;
    }
    this.core.current.outputDeviceId = deviceId;
    this.core.persist();
    store.patchSection('output', { deviceId, label: this.outputLabel(deviceId) });
    this.core.latency.refreshLatency();
    const needsCalibration = store.state.latencyS === null;
    store.setStatus(needsCalibration ? 'Output changed. Calibrate latency for this pair.' : 'Output changed.');
  }

  private outputLabel(deviceId: string | null): string {
    if (deviceId === null) return '';
    const found = this.lists.outputs.find((d) => d.deviceId === deviceId);
    return found?.label || 'selected device';
  }

  private async restoreOutput(): Promise<void> {
    const { parts, store } = this.core;
    const saved = this.core.current.outputDeviceId;
    if (!parts || saved === null || !store.state.output.selectable) return;
    // A refused device leaves the default in place and the saved id alone, so
    // plugging the headset back in later restores it.
    if (!(await parts.engine.setOutputDevice(saved))) return;
    store.patchSection('output', { deviceId: saved });
    this.core.latency.refreshLatency();
  }
}
