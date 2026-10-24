/**
 * Two small pure guards for the embedded YouTube player, both measured rather
 * than assumed (see "Embedded clock, as measured" in docs/ARCHITECTURE.md).
 *
 * The clock guard turns the player's `getCurrentTime()` into a position that is
 * safe to stamp pitch frames with. The API wrapper already extrapolates between
 * the iframe's posts, so the reading is smooth to within about 14 ms, with
 * occasional backward corrections under 20 ms and a rare stall of about 100 ms.
 * While playing, a backward step of up to 250 ms is held (the position never
 * goes backwards; it waits for the clock to catch up). A jump of more than
 * 250 ms either way, or no advance for more than 300 ms of wall time while the
 * state says playing, is a discontinuity and is reported so it can be handled
 * like a seek. Paused or buffering reports the raw value. Nothing here knows
 * about the player or the DOM: samples in, a position and a flag out.
 *
 * The ad detector says whether the iframe is showing an advertisement instead
 * of the requested video, from the video id the player reports and from its
 * duration. No ad was observed in the spike, so both signals are a best guess
 * and the transport treats either one as enough.
 */

/** A backward step up to this is held; a jump beyond it is a discontinuity. */
export const JUMP_S = 0.25;

/** No advance for longer than this while playing counts as a stall. */
export const STALL_S = 0.3;

/** A duration that differs from the known one by more than this is an ad's. */
export const AD_DURATION_EPS_S = 1;

/** Reported-time movement below this is not an advance. */
const ADVANCE_EPS_S = 1e-6;

/** What the player said it was doing, reduced to what the clock cares about. */
export type ClockPlayState = 'playing' | 'paused' | 'buffering';

/** One reading of the embedded player. */
export interface ClockSample {
  /** `getCurrentTime()`, seconds. */
  reportedS: number;
  state: ClockPlayState;
  /** Wall-clock milliseconds (a monotonic clock) when the reading was taken. */
  wallMs: number;
  /** Playback rate; 1 when absent. Only the straight-line check uses it. */
  rate?: number;
}

/** The guard's answer for one sample. */
export interface ClockReading {
  /** The position to use, seconds. */
  positionS: number;
  /** True when the clock jumped or stalled: treat it as a seek. */
  discontinuity: boolean;
}

/** What the guard carries from one sample to the next. */
export interface ClockMemory {
  state: ClockPlayState;
  reportedS: number;
  wallMs: number;
  /** The position last handed out; the floor while a backward step is held. */
  heldS: number;
  /** Wall time at which the reported clock last moved forward. */
  advancedAtMs: number;
  /** True once the current stall has been reported, so it is reported once. */
  stallReported: boolean;
}

/** The next memory and the reading for the sample just taken. */
export interface ClockStep {
  memory: ClockMemory;
  reading: ClockReading;
}

/**
 * One step of the guard. `prev` is null for the first sample ever and after a
 * reset. The first sample, any sample while not playing and the first playing
 * sample after one that was not playing all just anchor: raw value, no flag.
 */
export function stepEmbedClock(prev: ClockMemory | null, sample: ClockSample): ClockStep {
  const { reportedS, state, wallMs } = sample;
  if (state !== 'playing' || prev === null || prev.state !== 'playing') {
    return {
      memory: { state, reportedS, wallMs, heldS: reportedS, advancedAtMs: wallMs, stallReported: false },
      reading: { positionS: reportedS, discontinuity: false },
    };
  }

  const elapsedS = Math.max(0, (wallMs - prev.wallMs) / 1000);
  const rate = sample.rate !== undefined && sample.rate > 0 ? sample.rate : 1;
  // How far the clock is from the straight line through the previous reading,
  // and how far behind the position we have already reported it now is.
  const aheadS = reportedS - (prev.reportedS + elapsedS * rate);
  const behindS = prev.heldS - reportedS;
  const advancedAtMs = reportedS > prev.reportedS + ADVANCE_EPS_S ? wallMs : prev.advancedAtMs;
  const stalled = wallMs - advancedAtMs > STALL_S * 1000;

  if (aheadS > JUMP_S || behindS > JUMP_S) {
    return {
      memory: { state, reportedS, wallMs, heldS: reportedS, advancedAtMs: wallMs, stallReported: false },
      reading: { positionS: reportedS, discontinuity: true },
    };
  }
  if (stalled && !prev.stallReported) {
    return {
      memory: { state, reportedS, wallMs, heldS: reportedS, advancedAtMs, stallReported: true },
      reading: { positionS: reportedS, discontinuity: true },
    };
  }
  // Within tolerance: never go backwards, wait for the clock to catch up.
  const positionS = Math.max(prev.heldS, reportedS);
  return {
    memory: {
      state,
      reportedS,
      wallMs,
      heldS: positionS,
      advancedAtMs,
      stallReported: stalled && prev.stallReported,
    },
    reading: { positionS, discontinuity: false },
  };
}

/** The guard with its memory; one per embedded player. */
export class EmbedClock {
  private memory: ClockMemory | null = null;

  /**
   * Feeds a sample and returns the position to use. A sample whose time is not
   * a finite number is ignored and the last position is repeated.
   */
  sample(sample: ClockSample): ClockReading {
    if (!Number.isFinite(sample.reportedS)) {
      return { positionS: this.memory?.heldS ?? 0, discontinuity: false };
    }
    const step = stepEmbedClock(this.memory, sample);
    this.memory = step.memory;
    return step.reading;
  }

  /**
   * Forgets the past, so the next sample anchors without comparing itself to
   * anything. Called after a seek we made ourselves, and when the player
   * changes what it is showing.
   */
  reset(): void {
    this.memory = null;
  }
}

/** What the iframe reports about itself, for the ad check. */
export interface AdProbe {
  /** The video the transport asked for. */
  requestedVideoId: string;
  /** `getVideoData().video_id`; null or empty when the player has none yet. */
  reportedVideoId: string | null | undefined;
  /** Duration of the requested video as first seen, or null before that. */
  knownDurationS: number | null;
  /** `getDuration()` now; 0 while the player does not know. */
  reportedDurationS: number;
}

/**
 * True when the iframe is showing something other than the requested video:
 * the player reports another video id, or a duration that is not the known one
 * (a pre-roll or mid-roll advertisement carries its own id and length).
 */
export function isAdPlaying(probe: AdProbe): boolean {
  const { reportedVideoId, knownDurationS, reportedDurationS } = probe;
  if (reportedVideoId && reportedVideoId !== probe.requestedVideoId) return true;
  if (knownDurationS === null || !(knownDurationS > 0) || !(reportedDurationS > 0)) return false;
  return Math.abs(reportedDurationS - knownDurationS) > AD_DURATION_EPS_S;
}
