/**
 * Two singers in the session: whether singer B is on, the names and colours,
 * singer B's mic, and the turns of one mic shared by two. It keeps the duet's
 * state and the lane's turns strip in step with the settings, the song, its
 * melody (or its synced lyrics) and the clicks on the strip, and hands the take
 * recorder what a duet take needs (singer B's frames, the turns as they stood
 * when it began). Karaoke mode attributes and judges nothing: the strip only
 * says whose turn it is. Scoring each singer is src/duet/take.ts and split.ts;
 * the second mic is second-input.ts.
 */
import type { Span } from '../analysis/free-phrases';
import type { SessionCore } from '../app/session/core';
import type { SingerFrame } from '../app/session/frame-bus';
import type { SecondParts } from '../app/session/types';
import { toTakeFrame } from '../app/take-trace';
import type { TakeFrame } from '../app/take-trace';
import { buildSecondParts } from './parts';
import { cleanColour, cleanName } from './settings';
import type { SingerIndex } from './settings';
import { SecondInput } from './second-input';
import type { SecondOutcome } from './second-input';
import type { DuetCapture } from './take';
import { loadTurnOverrides, saveTurnOverrides } from './turn-store';
import { assignTurns, clickTurn, spansFromLyrics, spansFromNotes, whoAt } from './turns';
import type { Overrides, TimedLine, TurnSource, TurnSpan } from './turns';

/** Runs the duet: B's mic, the turns and what a take keeps of them. */
export class DuetController {
  private second: SecondInput | null = null;
  private overrides: Overrides = {};
  private lines: readonly TimedLine[] = [];
  private spans: Span[] = [];
  private songHash: string | null = null;
  private begun: Omit<DuetCapture, 'framesB'> | null = null;
  private framesB: TakeFrame[] = [];
  private wasOpen = false;
  private monitor: string;

  constructor(
    private readonly core: SessionCore,
    private readonly makeParts?: () => SecondParts | null,
  ) {
    const { duet } = core.current;
    this.monitor = core.current.monitor;
    core.store.patch({
      duet: {
        ...core.store.state.duet,
        secondSinger: duet.secondSinger,
        names: [...duet.names],
        colours: [...duet.colours],
        deviceIdB: duet.inputDeviceIdB,
        kind: duet.secondSinger ? 'one-mic' : 'off',
      },
    });
    core.store.subscribe((state, changed) => {
      if (changed.has('song')) this.onSong(state.song?.hash ?? null);
      // The singers entry changes with every meter tick; only B's mic opening
      // or closing changes what the turns are.
      const open = state.singers[1]?.input.open === true;
      const moved = open !== this.wasOpen;
      this.wasOpen = open;
      if (changed.has('song') || changed.has('reference') || moved) this.recompute();
      if (changed.has('output')) this.second?.refresh();
      if (changed.has('input') && state.input.monitor !== this.monitor) this.followMonitor(state.input.monitor);
    });
    // The take recorder's half for singer B: its frames go into the take.
    core.bus.subscribe((message) => this.onFrame(message));
  }

  /** Gives a lane attached after the strip was built the strip and the click. */
  syncLane(): void {
    const { lane } = this.core;
    if (!lane) return;
    lane.setTurnClick?.((startS) => this.clickTurn(startS));
    this.pushToLane();
  }

  // ---- Singers --------------------------------------------------------------

  /** Turns singer B on or off. Off closes the second mic. */
  setSecondSinger(on: boolean): void {
    const { current } = this.core;
    if (current.duet.secondSinger === on) return;
    if (this.core.store.state.recording) {
      this.core.store.setStatus('Stop recording first.', 'warn');
      return;
    }
    current.duet = { ...current.duet, secondSinger: on };
    this.core.persist();
    if (!on) this.second?.close();
    this.patchSettings();
    this.core.store.setStatus(
      on ? 'Singer B is on. Share the mic by turns, or pick a second input.' : 'Singer B is off.',
    );
  }

  /** Renames a singer; an empty name goes back to the default. */
  setName(singer: SingerIndex, name: string): void {
    const { current } = this.core;
    const names: [string, string] = [...current.duet.names];
    names[singer] = cleanName(name, singer === 0 ? 'Singer A' : 'Singer B');
    current.duet = { ...current.duet, names };
    this.core.persist();
    this.patchSettings();
  }

  /** Sets a singer's ribbon colour (`#rrggbb`), or null for the skin's. */
  setColour(singer: SingerIndex, colour: string | null): void {
    const { current } = this.core;
    const colours: [string | null, string | null] = [...current.duet.colours];
    colours[singer] = cleanColour(colour);
    current.duet = { ...current.duet, colours };
    this.core.persist();
    this.patchSettings();
  }

  /** Reopens B's mic in A's new monitor mode, or closes it with a warning. */
  private followMonitor(mode: string): void {
    this.monitor = mode;
    const { store, current } = this.core;
    if (!this.second || !this.second.open) return;
    if (store.state.recording) {
      store.setStatus('Stop recording before changing the monitor mode.', 'warn');
      return;
    }
    void this.second.openDevice(current.duet.inputDeviceIdB, false).then((outcome) => {
      if (outcome === 'failed') {
        this.second?.close();
        store.setStatus('The second microphone could not follow the monitor mode and was closed. Pick it again.', 'warn');
      }
    });
  }

  // ---- Second mic -----------------------------------------------------------

  /** Opens singer B's input (null or '' for the system default). */
  async chooseSecondInput(id: string | null): Promise<SecondOutcome> {
    const { store } = this.core;
    if (!this.core.current.duet.secondSinger) this.setSecondSinger(true);
    if (store.state.recording) {
      store.setStatus('Stop recording before changing the second microphone.', 'warn');
      return 'failed';
    }
    const input = this.input();
    if (input === null) {
      store.setStatus('This browser cannot open a second microphone here.', 'warn');
      return 'failed';
    }
    return input.openDevice(id === '' ? null : id);
  }

  /** Closes singer B's mic; B stays on, back to turns on the one mic. */
  closeSecondInput(): void {
    if (this.core.store.state.recording) {
      this.core.store.setStatus('Stop recording before closing the second microphone.', 'warn');
      return;
    }
    this.second?.close();
    this.core.store.setStatus('Second microphone closed.');
  }

  /** Calibrates singer B's mic for the current output. */
  async calibrateSecond(): Promise<void> {
    await this.second?.calibrate();
  }

  /** Sets, or with null clears, singer B's latency for its pair. */
  setSecondLatency(s: number | null): void {
    this.second?.setLatency(s);
  }

  /** The tick loop's call: moves singer B's meter. */
  tick(): void {
    this.second?.tick();
  }

  /** Closes singer B's mic for the Session's dispose. */
  dispose(): void {
    this.second?.close();
  }

  // ---- Turns ----------------------------------------------------------------

  /** Hands over the song's synced lyric lines (or none), which the turns follow. */
  setLyricLines(lines: readonly TimedLine[]): void {
    this.lines = lines;
    this.recompute();
  }

  /** A click on the stretch starting at `startS`: A, then B, then both. */
  clickTurn(startS: number): void {
    const { store } = this.core;
    if (store.state.duet.kind !== 'one-mic' || this.songHash === null) return;
    if (store.state.recording) {
      store.setStatus('Stop recording before changing whose turn it is.', 'warn');
      return;
    }
    this.overrides = clickTurn(this.spans, this.overrides, startS);
    saveTurnOverrides(this.core.settingsStore, this.songHash, this.overrides);
    this.recompute();
  }

  /** The singer whose ribbon a frame is drawn on: its mic's, or by turn in learning mode. */
  laneSinger(message: SingerFrame): 0 | 1 {
    if (message.singer === 1) return 1;
    const { kind, turns } = this.core.store.state.duet;
    // Karaoke mode attributes nothing; the ribbon follows the one mic.
    if (kind !== 'one-mic' || this.core.current.mode !== 'learning') return 0;
    return whoAt(turns, message.frame.t) === 'b' ? 1 : 0;
  }

  // ---- Takes ----------------------------------------------------------------

  /** Starts keeping singer B's frames and a copy of the turns, as a take begins. */
  beginTake(): void {
    const { duet } = this.core.store.state;
    this.framesB = [];
    // One mic and no turns (a song with no spans) has nobody to split between:
    // keep the take as A's alone rather than dropping every frame.
    this.begun =
      duet.kind === 'off' || (duet.kind === 'one-mic' && duet.turns.length === 0)
        ? null
        : {
            mode: duet.kind,
            names: [...duet.names],
            turns: duet.kind === 'one-mic' ? duet.turns.map((t) => ({ ...t })) : [],
          };
  }

  /** What the take just ended collected, or null when it was not a duet. */
  endTake(): DuetCapture | null {
    const begun = this.begun;
    this.begun = null;
    const framesB = this.framesB;
    this.framesB = [];
    return begun === null ? null : { ...begun, framesB };
  }

  // ---- Inside -----------------------------------------------------------------

  private input(): SecondInput | null {
    if (this.second) return this.second;
    const parts = this.makeParts ? this.makeParts() : buildSecondParts(this.core.parts, this.core.current.clarityThreshold);
    if (parts === null) return null;
    this.second = new SecondInput(this.core, parts);
    return this.second;
  }

  private onFrame(message: SingerFrame): void {
    if (message.singer !== 1 || this.begun === null) return;
    this.framesB.push(toTakeFrame(message.frame, message.rawF0, message.gateReason));
  }

  private onSong(hash: string | null): void {
    this.songHash = hash;
    this.lines = [];
    this.overrides = hash === null ? {} : loadTurnOverrides(this.core.settingsStore, hash);
  }

  private patchSettings(): void {
    const { duet } = this.core.current;
    const { store } = this.core;
    store.patch({
      duet: {
        ...store.state.duet,
        secondSinger: duet.secondSinger,
        names: [...duet.names],
        colours: [...duet.colours],
        deviceIdB: duet.inputDeviceIdB,
      },
    });
    this.recompute();
  }

  /** Reads the kind and the turns again and gives the lane and the state the news. */
  private recompute(): void {
    const { store, current, stems } = this.core;
    const open = store.state.singers[1]?.input.open === true;
    const kind = !current.duet.secondSinger ? 'off' : open ? 'two-mics' : 'one-mic';
    let source: TurnSource = 'none';
    let spans: Span[] = [];
    if (kind === 'one-mic') {
      const lyric = spansFromLyrics(this.lines, store.state.durationS);
      if (lyric.length > 0) {
        spans = lyric;
        source = 'lyrics';
      } else {
        spans = spansFromNotes(stems.rawNotes() ?? []);
        source = spans.length > 0 ? 'phrases' : 'none';
      }
    }
    this.spans = spans;
    const turns: TurnSpan[] = assignTurns(spans, this.overrides);
    const before = store.state.duet;
    const changed =
      before.kind !== kind ||
      before.turnSource !== source ||
      JSON.stringify(before.turns) !== JSON.stringify(turns);
    if (changed) store.patch({ duet: { ...before, kind, turns, turnSource: source } });
    this.pushToLane();
  }

  private pushToLane(): void {
    const { lane, store } = this.core;
    const { duet } = store.state;
    lane?.setTurns?.(duet.turns, { names: duet.names, colours: duet.colours });
  }
}
