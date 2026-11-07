/**
 * The duet's part of the app state: whether singer B is on, the names and
 * colours, how the two are heard (turns on the one mic, or a mic each), the
 * turns the lane shows, and singer B's latency and calibration. Singer B's mic
 * itself (level, floor, state) is `AppState.singers[1].input`, which exists
 * only while B has a second mic open. Nothing here knows about Web Audio.
 */
import type { SingerIndex } from './settings';
import { defaultDuet } from './settings';
import type { TurnSource, TurnSpan } from './turns';

/** How the two singers are heard; 'off' while singer B is off. */
export type DuetKind = 'off' | 'one-mic' | 'two-mics';

/** What the singers panel and the lane draw. */
export interface DuetState {
  secondSinger: boolean;
  names: [string, string];
  colours: [string | null, string | null];
  /** Singer B's chosen input id; null is the system default. */
  deviceIdB: string | null;
  kind: DuetKind;
  /** The stretches of the loaded song with a singer each; one mic only. */
  turns: TurnSpan[];
  turnSource: TurnSource;
  /** Round trip for singer B's mic and the output; null when not set. */
  latencyBS: number | null;
  calibratingB: boolean;
}

/** The duet state of a page just loaded: off. */
export function initialDuet(): DuetState {
  const d = defaultDuet();
  return {
    secondSinger: false,
    names: d.names,
    colours: d.colours,
    deviceIdB: null,
    kind: 'off',
    turns: [],
    turnSource: 'none',
    latencyBS: null,
    calibratingB: false,
  };
}

/** The singer's name from the state. */
export function singerName(duet: Pick<DuetState, 'names'>, singer: SingerIndex): string {
  return duet.names[singer];
}
