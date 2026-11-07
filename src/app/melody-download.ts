/**
 * Saving the song's melody as a MIDI file: the file name from the song's
 * name, and the click that encodes the notes and hands them to the browser.
 * The bytes come from src/audio/midi-file.ts; this is the small glue between
 * the Save melody button and src/app/download.ts.
 */
import { encodeMelodyAndBackingMidi, encodeMelodyMidi } from '../audio/midi-file';
import type { LaneNote } from '../render/lane-geometry';
import { downloadBlob } from './download';

/** `<song name>-melody.mid` (`-melody-backing.mid` with backing), with the song's extension and odd characters dropped. */
export function melodyFileName(songName: string, withBacking = false): string {
  const base = songName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'song'}-melody${withBacking ? '-backing' : ''}.mid`;
}

/** Downloads the melody as a Standard MIDI File; with `backing`, a two-track one. */
export function saveMelody(
  doc: Document,
  songName: string,
  notes: readonly LaneNote[],
  backing: readonly LaneNote[] | null = null,
): void {
  const bytes = backing ? encodeMelodyAndBackingMidi(notes, backing) : encodeMelodyMidi(notes);
  downloadBlob(doc, new Blob([bytes as BlobPart], { type: 'audio/midi' }), melodyFileName(songName, backing !== null));
}
