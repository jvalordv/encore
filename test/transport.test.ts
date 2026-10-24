/**
 * Tests for the small pure part of the transport contract: which states count
 * as "the song is meant to be going", which is what the Play button and the
 * Space key read to choose between Play and Pause.
 */
import { describe, expect, it } from 'vitest';
import { isRunning } from '../src/audio/transport';
import type { TransportState } from '../src/audio/transport';

describe('isRunning', () => {
  it('is true while playing, buffering or waiting out an ad', () => {
    for (const state of ['playing', 'buffering', 'ad'] as const) {
      expect(isRunning(state), state).toBe(true);
    }
  });

  it('is false for a song that is empty, ready or paused', () => {
    for (const state of ['empty', 'ready', 'paused'] as const) {
      expect(isRunning(state), state).toBe(false);
    }
  });

  it('answers for every state there is', () => {
    const all: Record<TransportState, boolean> = {
      empty: false,
      ready: false,
      playing: true,
      paused: false,
      buffering: true,
      ad: true,
    };
    for (const [state, running] of Object.entries(all)) {
      expect(isRunning(state as TransportState), state).toBe(running);
    }
  });
});
