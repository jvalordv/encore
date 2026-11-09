/**
 * Tests for the Song reference card's words and decisions, with no page and
 * no service: where the melody and the key came from, every combination of
 * those with a karaoke video in the lines the card shows, what pressing Get the
 * melody leads to (the song's sound is recorded in the first take; there is no
 * download), and when learning mode asks, goes ahead by itself, or stays quiet
 * ("Not now", karaoke mode, a browser that cannot record a tab).
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { initialAlign } from '../src/app/align';
import { initialCapture } from '../src/app/capture';
import type { CaptureState } from '../src/app/capture';
import { initialKey } from '../src/app/key-state';
import { initialPrepare } from '../src/app/prepare';
import type { PrepareState } from '../src/app/prepare';
import { initialReference } from '../src/app/reference';
import type { ReferenceState } from '../src/app/reference';
import {
  ARMED_HINT,
  ARMED_NOTE,
  KARAOKE_HINT,
  NO_RECORDING_NOTE,
  PROMPT_TEXT,
  READY_NOTE,
  describeSongReference,
  initialSongRef,
  keyLine,
  keySourceOf,
  meaningLine,
  melodyLine,
  melodySourceOf,
  offerFor,
  titleLooksKaraoke,
} from '../src/app/song-reference';
import type { SongRefInput } from '../src/app/song-reference';

const ready = (): PrepareState => ({ ...initialPrepare(), phase: 'ready' });
const prepare = (phase: PrepareState['phase'], message = ''): PrepareState => ({ ...initialPrepare(), phase, message });
const melody = (alignedFrom?: string): ReferenceState => ({
  phase: 'ready',
  notes: 12,
  message: '',
  ...(alignedFrom ? { alignedFrom } : {}),
});
const capture = (phase: CaptureState['phase'], extra: Partial<CaptureState> = {}): CaptureState => ({
  ...initialCapture(),
  phase,
  ...extra,
});

function input(over: Partial<SongRefInput> = {}): SongRefInput {
  return {
    prepare: ready(),
    capture: initialCapture(),
    reference: initialReference(),
    key: initialKey(),
    align: initialAlign(),
    mode: 'karaoke',
    autoReference: false,
    songRef: initialSongRef(),
    titleKaraoke: false,
    takes: [],
    captureSupported: true,
    ...over,
  };
}

describe('where the melody and the key came from', () => {
  it('reads the melody as none, from this video, or from the original', () => {
    expect(melodySourceOf(initialReference())).toBe('none');
    expect(melodySourceOf({ phase: 'skipped', alignedFrom: null })).toBe('none');
    expect(melodySourceOf(melody())).toBe('video');
    expect(melodySourceOf(melody('yt-original1'))).toBe('original');
  });

  it('reads the key as the song\'s, else one estimated from the singing, else none', () => {
    const estimated = { report: { voice: { reference: 'estimated_key' } } } as unknown as { report: TakeReport };
    const chromatic = { report: { voice: { reference: 'chromatic' } } } as unknown as { report: TakeReport };
    expect(keySourceOf({ phase: 'ready' }, [], 'learning')).toBe('song');
    expect(keySourceOf({ phase: 'ready' }, [estimated], 'learning')).toBe('song');
    expect(keySourceOf({ phase: 'none' }, [estimated], 'learning')).toBe('singing');
    expect(keySourceOf({ phase: 'unclear' }, [chromatic, {}], 'learning')).toBe('none');
    expect(keySourceOf({ phase: 'missing' }, [], 'learning')).toBe('none');
  });

  it('never reads a key from the singing in karaoke mode, where learning output stays out', () => {
    const estimated = { report: { voice: { reference: 'estimated_key' } } } as unknown as { report: TakeReport };
    expect(keySourceOf({ phase: 'none' }, [estimated], 'karaoke')).toBe('none');
    expect(keySourceOf({ phase: 'ready' }, [estimated], 'karaoke')).toBe('song');
  });

  it('says each in plain words', () => {
    expect(melodyLine('none')).toBe('Melody: none');
    expect(melodyLine('video')).toBe('Melody: from this video');
    expect(melodyLine('original')).toBe('Melody: from the original (aligned)');
    expect(keyLine('none')).toBe('Key: none');
    expect(keyLine('song')).toBe('Key: estimated from the song');
    expect(keyLine('singing')).toBe('Key: estimated from your singing');
  });

  it('says what it means for learning mode, in one line', () => {
    expect(meaningLine('none')).toBe('Without a melody, learning mode comments on your voice only.');
    expect(meaningLine('video')).toMatch(/scores your pitch and timing/);
    expect(meaningLine('original')).toMatch(/original's melody/);
  });
});

describe('describeSongReference', () => {
  const melodies = [
    ['none', initialReference()],
    ['video', melody()],
    ['original', melody('yt-original1')],
  ] as const;
  const keys = [
    ['none', initialKey()],
    ['song', { phase: 'ready', message: '' }],
  ] as const;

  it('states the melody, the key and what they mean for every combination, karaoke or not', () => {
    for (const [source, reference] of melodies) {
      for (const [keySource, key] of keys) {
        for (const titleKaraoke of [false, true]) {
          const view = describeSongReference(
            input({ reference, key, titleKaraoke, mode: 'learning', prepare: prepare('prepared') }),
          );
          const label = `${source} / ${keySource} / karaoke ${titleKaraoke}`;
          expect(view.melody, label).toBe(melodyLine(source));
          expect(view.key, label).toBe(keyLine(keySource));
          expect(view.meaning, label).toBe(meaningLine(source));
          // A karaoke hint only while the melody is not borrowed yet.
          const wants = titleKaraoke && source !== 'original';
          expect(view.hint === KARAOKE_HINT, label).toBe(wants);
        }
      }
    }
  });

  it('is hidden while no YouTube video is the song', () => {
    expect(describeSongReference(input({ prepare: initialPrepare() })).visible).toBe(false);
    expect(describeSongReference(input()).visible).toBe(true);
  });

  it('offers the one button, Get the melody, while the service is there and no melody is', () => {
    const view = describeSongReference(input());
    expect(view.button).toMatchObject({ shown: true, disabled: false, label: 'Get the melody' });
    expect(view.prompt.shown).toBe(false);
  });

  it('turns the button off while it checks, works or waits, and when the service is away', () => {
    for (const phase of ['checking', 'unavailable', 'preparing', 'loading', 'waiting'] as const) {
      expect(describeSongReference(input({ prepare: prepare(phase) })).button, phase).toMatchObject({
        shown: true,
        disabled: true,
      });
    }
    expect(describeSongReference(input({ prepare: prepare('unavailable') })).note).toMatch(/service is not running/);
  });

  it('leaves no button once the song is prepared or has a melody', () => {
    expect(describeSongReference(input({ prepare: prepare('prepared') })).button.shown).toBe(false);
    expect(describeSongReference(input({ reference: melody() })).button.shown).toBe(false);
  });

  it('says nothing about learning mode in karaoke mode: no meaning line, no key from the singing', () => {
    const estimated = { report: { voice: { reference: 'estimated_key' } } } as unknown as { report: TakeReport };
    for (const [, reference] of melodies) {
      const view = describeSongReference(
        input({ reference, mode: 'karaoke', takes: [estimated], prepare: prepare('prepared') }),
      );
      expect(view.meaning).toBe('');
      expect(view.keySource).toBe('none');
      expect(view.key).toBe('Key: none');
    }
    const learning = describeSongReference(input({ mode: 'learning', takes: [estimated], prepare: prepare('prepared') }));
    expect(learning.key).toBe('Key: estimated from your singing');
  });

  it('says what the button does before it is pressed: the sound is recorded, not downloaded', () => {
    const view = describeSongReference(input());
    expect(view.note).toBe(READY_NOTE);
    expect(READY_NOTE).toMatch(/Records this video's sound/);
    expect(READY_NOTE).not.toMatch(/download/i);
  });

  it('says plainly that the song will be recorded in the first take once the melody is asked for', () => {
    const view = describeSongReference(input({ songRef: { armed: true, declined: false } }));
    expect(view.note).toBe(ARMED_NOTE);
    expect(ARMED_NOTE).toBe("Encore will record the song's sound while you sing your first take.");
    expect(view.hint).toBe(ARMED_HINT);
    // Nothing is left to press until the Play or Record that starts it.
    expect(view.button.shown).toBe(false);
  });

  it('keeps the same words after a recording could not be taken over, and offers the button again', () => {
    const failed = describeSongReference(input({ prepare: prepare('failed', 'The service has no audio for this song.') }));
    expect(failed.note).toBe('The service has no audio for this song.');
    expect(failed.button).toMatchObject({ shown: true, disabled: false });
    const armed = describeSongReference(
      input({ prepare: prepare('failed', 'x'), songRef: { armed: true, declined: false } }),
    );
    expect(armed.note).toBe(ARMED_NOTE);
  });

  it('says so, and turns the button off, when the browser cannot record a tab\'s sound', () => {
    const view = describeSongReference(input({ captureSupported: false }));
    expect(view.note).toBe(NO_RECORDING_NOTE);
    expect(view.button).toMatchObject({ shown: true, disabled: true });
  });

  it('shows the recording\'s own progress and a Stop that waits for 90 percent', () => {
    const early = describeSongReference(
      input({ prepare: prepare('failed'), capture: capture('capturing', { coverage: 0.5 }) }),
    );
    expect(early.note).toMatch(/Capturing: 50%/);
    expect(early.stop).toEqual({ shown: true, disabled: true });
    expect(early.button.disabled).toBe(true);
    const late = describeSongReference(
      input({ prepare: prepare('failed'), capture: capture('capturing', { coverage: 0.95 }) }),
    );
    expect(late.stop).toEqual({ shown: true, disabled: false });
    const share = describeSongReference(input({ prepare: prepare('failed'), capture: capture('requesting') }));
    expect(share.note).toMatch(/share dialog/);
  });

  it('shows the match with the original while it works and when it is refused', () => {
    const working = describeSongReference(
      input({ prepare: prepare('prepared'), titleKaraoke: true, align: { ...initialAlign(), phase: 'working', progress: 0.4 } }),
    );
    expect(working.note).toMatch(/Matching this track to the original… 40%/);
    const refused = describeSongReference(
      input({ prepare: prepare('prepared'), titleKaraoke: true, align: { ...initialAlign(), phase: 'refused', message: 'Too different.' } }),
    );
    expect(refused.note).toBe('Too different.');
  });

  it('treats a song the service found no singer in as a karaoke track too', () => {
    const reference: ReferenceState = { phase: 'skipped', notes: 0, message: 'No singing found: only 3%.' };
    const view = describeSongReference(input({ prepare: prepare('prepared'), reference }));
    expect(view.hint).toBe(KARAOKE_HINT);
  });
});

describe('titleLooksKaraoke', () => {
  it('reads the title words for karaoke and instrumental videos', () => {
    for (const title of [
      'Song (Karaoke Version)',
      'Song - Instrumental',
      'Song [Off Vocal]',
      'Song (no guide melody)',
      'Song karaoke',
    ]) {
      expect(titleLooksKaraoke(title), title).toBe(true);
    }
    expect(titleLooksKaraoke('Song (Official Video)')).toBe(false);
    expect(titleLooksKaraoke('Song', 'Sing King')).toBe(true);
  });
});

describe('offerFor', () => {
  const base = {
    mode: 'learning',
    autoReference: false,
    declined: false,
    armed: false,
    prepare: 'ready',
    melody: 'none',
    capture: 'idle',
    karaoke: false,
    recordable: true,
  } as const;

  it('asks in learning mode for a song with no melody', () => {
    expect(offerFor(base)).toBe('prompt');
    expect(describeSongReference(input({ mode: 'learning' })).prompt).toEqual({
      shown: true,
      text: PROMPT_TEXT,
      auto: false,
    });
    expect(PROMPT_TEXT).toBe('Get the melody so learning mode can score you?');
  });

  it('puts the prompt in place of the button, and with the setting on shows no prompt at all', () => {
    const asking = describeSongReference(input({ mode: 'learning' }));
    expect(asking.button.shown).toBe(false);
    expect(asking.prompt.shown).toBe(true);
    const automatic = describeSongReference(input({ mode: 'learning', autoReference: true }));
    expect(automatic.prompt).toMatchObject({ shown: false, auto: true });
    expect(automatic.button.shown).toBe(true);
  });

  it('never asks in karaoke mode, and never starts by itself there', () => {
    expect(offerFor({ ...base, mode: 'karaoke' })).toBe('none');
    expect(offerFor({ ...base, mode: 'karaoke', autoReference: true })).toBe('none');
    expect(describeSongReference(input({ mode: 'karaoke' })).prompt.shown).toBe(false);
  });

  it('offers a karaoke track nothing, however the setting stands; the plain button stays', () => {
    expect(offerFor({ ...base, karaoke: true })).toBe('none');
    expect(offerFor({ ...base, karaoke: true, autoReference: true })).toBe('none');
    for (const autoReference of [false, true]) {
      const view = describeSongReference(input({ mode: 'learning', titleKaraoke: true, autoReference }));
      expect(view.prompt.shown).toBe(false);
      expect(view.button.shown).toBe(true);
      expect(view.hint).toBe(KARAOKE_HINT);
    }
  });

  it('goes ahead without the prompt when the setting is on', () => {
    expect(offerFor({ ...base, autoReference: true })).toBe('auto');
    expect(offerFor({ ...base, autoReference: true, declined: true })).toBe('auto');
  });

  it('asks nothing of a browser that cannot record a tab', () => {
    expect(offerFor({ ...base, recordable: false })).toBe('none');
    expect(offerFor({ ...base, recordable: false, autoReference: true })).toBe('none');
    expect(describeSongReference(input({ mode: 'learning', captureSupported: false })).prompt.shown).toBe(false);
  });

  it('stays away for a song the singer said Not now to', () => {
    expect(offerFor({ ...base, declined: true })).toBe('none');
  });

  it('asks only when the service is there and nothing else is under way or known', () => {
    for (const prepare of ['none', 'checking', 'unavailable', 'preparing', 'loading', 'waiting', 'prepared', 'failed'] as const) {
      expect(offerFor({ ...base, prepare }), prepare).toBe('none');
    }
    expect(offerFor({ ...base, melody: 'video' })).toBe('none');
    expect(offerFor({ ...base, melody: 'original' })).toBe('none');
    expect(offerFor({ ...base, armed: true })).toBe('none');
    expect(offerFor({ ...base, capture: 'capturing' })).toBe('none');
  });
});
