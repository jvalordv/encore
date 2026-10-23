/**
 * Test audio for the end-to-end run, written to e2e/.tmp before the browser
 * starts. `a440.wav` is what Chromium's fake microphone plays back (a steady
 * 440 Hz sine, so the live tracker has one right answer). `song.wav` is the
 * "mp3" the test drops on the page: a 220 Hz tone that begins after half a
 * second of silence, so its duration and playback position are observable
 * without decoding anything. Both go through the app's own WAV encoder, which
 * also proves the encoder writes files a real decoder accepts.
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

/** `seconds` of a sine at `hz`, silent for the first `silenceS` seconds. */
export function sine(hz: number, seconds: number, peak: number, silenceS = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * FIXTURE_RATE));
  const first = Math.round(silenceS * FIXTURE_RATE);
  for (let i = first; i < out.length; i++) {
    out[i] = peak * Math.sin((2 * Math.PI * hz * (i - first)) / FIXTURE_RATE);
  }
  return out;
}

/** Writes both fixtures; Playwright runs this once before any test. */
export default function writeFixtures(): void {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(MIC_FILE, Buffer.from(encodeWav(sine(440, 8, 0.5), FIXTURE_RATE, 16)));
  writeFileSync(SONG_FILE, Buffer.from(encodeWav(sine(220, SONG_SECONDS, 0.5, 0.5), FIXTURE_RATE, 16)));
}
