/**
 * Test audio for the end-to-end run, written to e2e/.tmp before the browser
 * starts. `a440.wav` is what Chromium's fake microphone plays back (a steady
 * 440 Hz sine, so the live tracker has one right answer). `song.wav` is the
 * "mp3" the test drops on the page: a 220 Hz tone that begins after half a
 * second of silence, so its duration and playback position are observable
 * without decoding anything. Both go through the app's own WAV encoder, which
 * also proves the encoder writes files a real decoder accepts. `vocals.wav` and
 * `no_vocals.wav` stand in for the stems the service makes (the stand-in
 * serves them as FLAC would be served; the browser sniffs the bytes, so WAV
 * decodes the same) and are as long as the song.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../src/audio/wav';

/** Port the built app is served on; playwright.config.ts starts it here. */
export const PORT = 4173;

/** Sample rate of both fixtures; matches the engine's 48 kHz context. */
export const FIXTURE_RATE = 48000;

/** Length of the song fixture in seconds; the test checks the decoded one. */
export const SONG_SECONDS = 4;

/** Directory the fixtures are written to (git-ignored). */
export const TMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');

/** Absolute path of the fake-microphone file. */
export const MIC_FILE = path.join(TMP_DIR, 'a440.wav');

/** Absolute path of the song the test loads. */
export const SONG_FILE = path.join(TMP_DIR, 'song.wav');

/** Absolute paths of the stand-ins for the two stems of a separated song. */
export const VOCALS_FILE = path.join(TMP_DIR, 'vocals.wav');
export const NO_VOCALS_FILE = path.join(TMP_DIR, 'no_vocals.wav');

/** `seconds` of a sine at `hz`, silent for the first `silenceS` seconds. */
export function sine(hz: number, seconds: number, peak: number, silenceS = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * FIXTURE_RATE));
  const first = Math.round(silenceS * FIXTURE_RATE);
  for (let i = first; i < out.length; i++) {
    out[i] = peak * Math.sin((2 * Math.PI * hz * (i - first)) / FIXTURE_RATE);
  }
  return out;
}

/** Writes the fixtures; Playwright runs this once before any test. */
export default function writeFixtures(): void {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(MIC_FILE, Buffer.from(encodeWav(sine(440, 8, 0.5), FIXTURE_RATE, 16)));
  writeFileSync(SONG_FILE, Buffer.from(encodeWav(sine(220, SONG_SECONDS, 0.5, 0.5), FIXTURE_RATE, 16)));
  writeFileSync(VOCALS_FILE, Buffer.from(encodeWav(sine(330, SONG_SECONDS, 0.3, 0.5), FIXTURE_RATE, 16)));
  writeFileSync(NO_VOCALS_FILE, Buffer.from(encodeWav(sine(110, SONG_SECONDS, 0.3), FIXTURE_RATE, 16)));
}
