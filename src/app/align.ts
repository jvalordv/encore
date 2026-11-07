/**
 * Scoring a karaoke track against its original: what the song panel says
 * about the alignment. A karaoke video has no vocal, so no melody; the
 * service can take the melody of the original and warp it onto the karaoke
 * (chroma alignment, service/encore_service/align.py). This file is the state
 * of that job and its wording, with no page and no service in it, so the
 * words are tested alone: `AlignState`, `describeAlign` and the key offset
 * in plain terms. The Session's AlignController (session/align.ts) drives it.
 */
import type { AlignmentStatus } from '../service/types';

/** Where aligning stands: nothing asked, under way, or how it ended. */
export type AlignPhase = 'idle' | 'working' | 'done' | 'refused' | 'failed';

/** What the song panel knows about the alignment. */
export interface AlignState {
  phase: AlignPhase;
  /** 0 to 1 while working. */
  progress: number;
  /** Semitones the original's melody was shifted by, once known. */
  keyOffset: number | null;
  /** 0 to 1, once known. */
  confidence: number | null;
  /** The plain reason for a refusal or a failure; empty otherwise. */
  message: string;
}

/** The state of a song with no alignment asked for. */
export function initialAlign(): AlignState {
  return { phase: 'idle', progress: 0, keyOffset: null, confidence: null, message: '' };
}

/** The line shown while the original is being prepared for the match. */
export const PREPARING_ORIGINAL = 'Preparing the original�';

/** The state after the service's alignment status, in the panel's terms. */
export function alignStateOf(alignment: AlignmentStatus): AlignState {
  const ended: Partial<Record<AlignmentStatus['state'], AlignPhase>> = {
    done: 'done',
    refused: 'refused',
    failed: 'failed',
  };
  return {
    phase: ended[alignment.state] ?? 'working',
    progress: alignment.progress,
    keyOffset: alignment.key_offset ?? null,
    confidence: alignment.confidence ?? null,
    message: alignment.reason?.trim() ?? '',
  };
}

/** A key offset in plain words: "in the same key", "2 semitones higher". */
export function describeKeyOffset(semitones: number): string {
  if (semitones === 0) return 'in the same key as the original';
  const unit = Math.abs(semitones) === 1 ? 'semitone' : 'semitones';
  return `${Math.abs(semitones)} ${unit} ${semitones > 0 ? 'higher' : 'lower'} than the original`;
}

/** What the panel says about the alignment; empty while there is nothing to say. */
export function describeAlign(state: AlignState): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'working':
      if (state.progress > 0) return `Matching this track to the original… ${Math.round(state.progress * 100)}%`;
      return state.message || 'Matching this track to the original…';
    case 'done': {
      const key = state.keyOffset === null ? '' : `, ${describeKeyOffset(state.keyOffset)}`;
      const sure = state.confidence === null ? '' : ` (match ${Math.round(state.confidence * 100)}%)`;
      return `Scoring against the original's melody${key}${sure}.`;
    }
    case 'refused':
      return state.message || 'The arrangement differs too much from the original.';
    case 'failed':
      return state.message || 'The match with the original failed.';
  }
}
