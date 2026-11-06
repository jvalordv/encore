/**
 * Controller tests for the Mic check on the fake-parts harness: it refuses to
 * start while recording or calibrating, applying the advice writes
 * the tuning and the latency for the current device pair, resetting returns
 * the defaults, the step-length seam reads the page address, and a service
 * that is not there reads as "needs the service" in the analysis types. The
 * steps themselves (audio, the player's shelf) run in e2e/mic-check.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TUNING } from '../src/analysis/mic-tuning';
import { initialMicCheck } from '../src/app/mic-check';
import { durationScale } from '../src/app/session/mic-check';
import { loadSettings } from '../src/app/settings';
import type { TakeAnalysis } from '../src/service/types';
import { PAIR_CHANGED } from '../src/app/mic-check';
import type { LaneReference } from '../src/render/lane-geometry';
import { fakeLane, FakeTransport, makeHarness, songInfo } from './session-harness';

const ANALYSIS: TakeAnalysis = {
  report_text: '',
  findings: ['Your room is quiet.'],
  sections: [],
  current: {
    draw_margin_db: 8,
    clarity_threshold: 0.9,
    bleed_match_cents: 30,
    bleed_min_match: 0.6,
    bleed_max_median_cents: 15,
    latency_s: null,
  },
  recommended: {
    draw_margin_db: 12,
    clarity_threshold: null,
    bleed_match_cents: 22,
    bleed_min_match: null,
    bleed_max_median_cents: null,
    latency_s: 0.1,
  },
  notes: [],
};

describe('starting', () => {
  it('is refused while recording, and says so', async () => {
    const h = makeHarness();
    h.store.patch({ recording: true });
    await h.core.micCheck.start('low');
    expect(h.store.state.micCheck.phase).toBe('idle');
    expect(h.store.state.status.kind).toBe('warn');
    expect(h.core.micCheck.active).toBe(false);
  });

  it('is refused while calibrating', async () => {
    const h = makeHarness();
    h.store.patch({ calibrating: true });
    await h.core.micCheck.start('high');
    expect(h.store.state.micCheck.phase).toBe('idle');
    expect(h.core.micCheck.active).toBe(false);
  });

  it('is refused when no microphone has been chosen', async () => {
    const h = makeHarness();
    await h.core.micCheck.start('low');
    expect(h.store.state.micCheck.phase).toBe('idle');
    expect(h.store.state.status.text).toMatch(/microphone/i);
    expect(h.core.micCheck.active).toBe(false);
  });
});

describe('applying and resetting the advice', () => {
  it('writes the offered values for this pair and keeps the null ones', async () => {
    const h = makeHarness();
    await h.core.input.chooseInput('usb');
    h.store.patch({ micCheck: { ...initialMicCheck(), phase: 'result', analysis: ANALYSIS } });
    h.core.micCheck.applySettings();
    expect(h.core.health.tuning()).toEqual({ ...DEFAULT_TUNING, drawMarginDb: 12, bleedMatchCents: 22 });
    expect(h.store.state.latencyS).toBeCloseTo(0.1, 5);
    expect(h.store.state.micCheck.applied).toBe(true);
    const saved = loadSettings(h.settingsStore);
    expect(Object.values(saved.micTuningByDevicePair)).toHaveLength(1);
    expect(Object.values(saved.latencyByDevicePair)).toEqual([0.1]);
  });

  it('resets the pair to the defaults and leaves the latency alone', async () => {
    const h = makeHarness();
    await h.core.input.chooseInput('usb');
    h.store.patch({ micCheck: { ...initialMicCheck(), phase: 'result', analysis: ANALYSIS } });
    h.core.micCheck.applySettings();
    h.core.micCheck.resetSettings();
    expect(h.core.health.tuning()).toEqual(DEFAULT_TUNING);
    expect(loadSettings(h.settingsStore).micTuningByDevicePair).toEqual({});
    expect(h.store.state.latencyS).toBeCloseTo(0.1, 5);
    expect(h.store.state.micCheck.applied).toBe(false);
  });

  it('writes nothing, and says so, when the pair changed since the check', async () => {
    const h = makeHarness();
    await h.core.input.chooseInput('usb');
    (h.core.micCheck as unknown as { checkedPair: string }).checkedPair = h.core.latency.pairKey();
    await h.core.input.chooseInput('other');
    h.store.patch({ micCheck: { ...initialMicCheck(), phase: 'result', analysis: ANALYSIS } });
    h.core.micCheck.applySettings();
    expect(h.core.health.tuning()).toEqual(DEFAULT_TUNING);
    expect(h.store.state.latencyS).toBeNull();
    expect(h.store.state.micCheck.applied).toBe(false);
    expect(h.store.state.micCheck.pairChanged).toBe(true);
    expect(h.store.state.status.text).toBe(PAIR_CHANGED);
    expect(loadSettings(h.settingsStore).micTuningByDevicePair).toEqual({});
    h.core.micCheck.resetSettings();
    expect(h.store.state.status.text).toBe(PAIR_CHANGED);
  });

  it('does nothing without an analysis', () => {
    const h = makeHarness();
    h.core.micCheck.applySettings();
    expect(h.core.health.tuning()).toEqual(DEFAULT_TUNING);
  });
});

describe('the step-length seam', () => {
  it('is 1 unless the address names a factor in range', () => {
    expect(durationScale('')).toBe(1);
    expect(durationScale('?micCheckScale=0.2')).toBe(0.2);
    for (const bad of ['?micCheckScale=0', '?micCheckScale=2', '?micCheckScale=abc', '?x=1']) {
      expect(durationScale(bad), bad).toBe(1);
    }
  });
});

describe('the lane while the test melody is shown', () => {
  const MELODY = { f0Hz: new Float32Array([440]) } as unknown as LaneReference;

  it('gets its rows back when the song has no melody of its own', () => {
    const h = makeHarness();
    const lane = fakeLane();
    h.core.lane = lane;
    h.core.stems.showTransient(MELODY);
    expect(lane.fitRangeToReference).toHaveBeenCalled();
    h.core.stems.showTransient(null);
    expect(lane.setRange).toHaveBeenCalledWith(48, 72);
  });
});

describe('a video that is the song', () => {
  function withVideo() {
    const h = makeHarness();
    const embed = Object.assign(new FakeTransport(), { videoId: 'abc', mute: () => {}, muted: true });
    embed.clock = 'embed';
    embed.setSong(songInfo('video', 'yt-abc'));
    embed.state = 'playing';
    embed.positionS = 42;
    h.core.songs.embed = embed as never;
    h.core.songs.activate(embed);
    return { h, embed };
  }

  it('is paused for the check and comes back paused where it was', () => {
    const { h, embed } = withVideo();
    const back = h.core.songs.parkEmbed();
    expect(embed.state).toBe('paused');
    h.core.songs.activate(h.player);
    expect(h.core.songs.active).toBe(h.player);
    back?.();
    expect(h.core.songs.active).toBe(embed);
    expect(embed.state).toBe('paused');
    expect(embed.positionS).toBe(42);
  });

  it('stops the follower of a prepared song and starts one again', () => {
    const { h, embed } = withVideo();
    const stop = vi.fn();
    (h.core.prepare as unknown as { follower: { stop: () => void } }).follower = { stop };
    h.core.songs.activate(h.player, { pausePrevious: false });
    const back = h.core.songs.parkEmbed();
    expect(stop).toHaveBeenCalled();
    expect(embed.state).toBe('paused');
    back?.();
    // Still the audio player that is active; the video follows it again.
    expect(h.core.songs.active).toBe(h.player);
    expect((h.core.prepare as unknown as { follower: unknown }).follower).not.toBeNull();
    h.core.prepare.endPrepared();
  });
});
