/**
 * The karaoke mix: which of the song's stems the singer hears, and how loud.
 * Owns the stems it put into the audio Player (the instrumental and the
 * vocal), the chosen mix, the level of the vocal guide and whether a take is
 * laid over the song, which lowers the whole mix. The levels come from the pure
 * rule in src/app/mix.ts. A change of mix only moves the stems' gains, so the
 * song carries on at the same position with no restart, and the stems join a
 * song that is already playing on its clock, in step with the original. The
 * stems arrive from src/app/session/stems.ts.
 */
import { STEM_LEAD_S } from '../../audio/player';
import { clampLevel, initialMix, mixLevels } from '../mix';
import type { MixChoice } from '../mix';
import type { SessionCore } from './core';
import { DUCKED_ORIGINAL_GAIN } from './takes';

/** Ids of the stems in the Player; 'original' is the Player's own. */
const ORIGINAL = 'original';
const VOCALS = 'vocals';
const NO_VOCALS = 'no_vocals';

/** The stems of a separated song, decoded, and the gain they were made with. */
export interface DecodedStems {
  vocals: AudioBuffer;
  noVocals: AudioBuffer;
  /** The factor the song was multiplied by to make the stems; at most 1. */
  gain: number;
}

/** Chooses what is heard from the original and its stems. */
export class MixController {
  // Whether the stems are in the Player, and the factor they were made with.
  private installed = false;
  private stemGain = 1;
  // True while a take is laid over the song, which plays the mix lower.
  private ducked = false;

  constructor(private readonly core: SessionCore) {
    core.store.patch({ mix: initialMix(core.current.guideLevel) });
  }

  /**
   * Puts the stems into the song and makes Karaoke the mix, at the position
   * the song is at: a song that is playing carries on, the original easing out
   * as the stems begin. Does nothing without Web Audio or a loaded song.
   */
  install(stems: DecodedStems): void {
    const player = this.core.parts?.player;
    if (!player || player.state === 'empty') return;
    const playing = player.state === 'playing';
    // Added silent, then raised with the original's fall, so a stem is never
    // heard at full level for the moment before its gain is set.
    player.addStem(NO_VOCALS, stems.noVocals, 0, 0);
    player.addStem(VOCALS, stems.vocals, 0, 0);
    this.installed = true;
    this.stemGain = stems.gain;
    this.core.store.patch({ mix: { ...this.core.store.state.mix, available: true, choice: 'karaoke' } });
    this.apply(playing ? STEM_LEAD_S : 0);
  }

  /** Takes the stems out again, e.g. when another song takes over. */
  clear(): void {
    const player = this.core.parts?.player;
    if (this.installed && player) {
      player.removeStem(VOCALS);
      player.removeStem(NO_VOCALS);
    }
    this.installed = false;
    this.stemGain = 1;
    this.core.store.patch({ mix: initialMix(this.core.current.guideLevel) });
    this.apply(0);
  }

  /** True once the stems are in and the mix can be changed. */
  get available(): boolean {
    return this.installed;
  }

  /** Chooses the original, the instrumental, or the instrumental with a guide. */
  setMix(choice: MixChoice): void {
    if (!this.installed || this.core.store.state.mix.choice === choice) return;
    this.core.store.patch({ mix: { ...this.core.store.state.mix, choice } });
    this.apply(0);
  }

  /** Sets, and remembers, the level of the vocal in the guide mix (0..1). */
  setGuideLevel(level: number): void {
    const guideLevel = clampLevel(level);
    this.core.current.guideLevel = guideLevel;
    this.core.persist();
    this.core.store.patch({ mix: { ...this.core.store.state.mix, guideLevel } });
    if (this.installed && this.core.store.state.mix.choice === 'guide') this.apply(0);
  }

  /** Lowers the whole mix while a take plays over it, and raises it after. */
  setDucked(on: boolean): void {
    this.ducked = on;
    this.apply(0);
  }

  /** Moves every stem's gain to what the current mix asks for. */
  private apply(delayS: number): void {
    const player = this.core.parts?.player;
    if (!player) return;
    const { choice, guideLevel } = this.core.store.state.mix;
    const duck = this.ducked ? DUCKED_ORIGINAL_GAIN : 1;
    const levels = mixLevels(choice, guideLevel, this.installed ? this.stemGain : 1, duck);
    // The delay is only passed when there is one: it is the join of stems into
    // a playing song, where the original must not fall before they sound.
    const set = (id: string, level: number): void => {
      if (delayS > 0) player.setStemGain(id, level, delayS);
      else player.setStemGain(id, level);
    };
    set(ORIGINAL, levels.original);
    if (!this.installed) return;
    set(NO_VOCALS, levels.no_vocals);
    set(VOCALS, levels.vocals);
  }
}
