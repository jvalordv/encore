/**
 * Pure WAV encoding and decoding, plus the take-to-song time mapping. Takes
 * are stored as mono WAV blobs so the Python service, other tools and the
 * browser's own decoder can all read them; the format is plain enough to write
 * by hand in about a screen of code. Nothing here touches the DOM or Web
 * Audio. The time mapping lives beside the codec because both describe the
 * same thing: where a stored sample sits on the song's clock once the
 * calibrated round-trip latency is taken off (see "Clock" in
 * docs/ARCHITECTURE.md).
 */

/** Size of the canonical header this module writes (RIFF + fmt + data). */
const HEADER_BYTES = 44;
/** Largest RIFF payload a 32-bit size field can describe. */
const MAX_DATA_BYTES = 0xffffffff - (HEADER_BYTES - 8);

/** WAVE format tags this module reads and writes. */
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
/** Marker tag that defers the real format to a sub-format GUID. */
const FORMAT_EXTENSIBLE = 0xfffe;

/** A decoded WAV: mono samples, the file's rate, and its source channels. */
export interface DecodedWav {
  pcm: Float32Array;
  sampleRate: number;
  /** Channel count in the file; `pcm` is always the mix down to one. */
  channels: number;
}

/** Writes a four-character chunk id. */
function writeTag(view: DataView, at: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(at + i, tag.charCodeAt(i));
}

/** Reads a four-character chunk id. */
function readTag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

/**
 * Encodes mono samples as a WAV file. 16-bit (the default) is integer PCM and
 * clips at full scale; 32 is IEEE float and keeps every sample exactly. NaN
 * and infinities become silence because players choke on them.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number, bitsPerSample: 16 | 32 = 16): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    // A header cannot carry a fractional rate; rounding would skew timing.
    throw new RangeError(`WAV sample rate must be a positive integer, got ${sampleRate}`);
  }
  if (bitsPerSample !== 16 && bitsPerSample !== 32) {
    throw new RangeError(`WAV bit depth must be 16 or 32, got ${bitsPerSample}`);
  }
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = pcm.length * bytesPerSample;
  if (dataBytes > MAX_DATA_BYTES) throw new RangeError('Take is too long for a WAV file');

  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeTag(view, 8, 'WAVE');
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitsPerSample === 16 ? FORMAT_PCM : FORMAT_FLOAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  if (bitsPerSample === 16) {
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      // Scale by 32768 and clamp, the inverse of how every decoder reads it,
      // so +1.0 lands on 32767 rather than wrapping.
      const q = Number.isFinite(x) ? Math.round(x * 32768) : 0;
      view.setInt16(HEADER_BYTES + i * 2, Math.max(-32768, Math.min(32767, q)), true);
    }
  } else {
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      view.setFloat32(HEADER_BYTES + i * 4, Number.isFinite(x) ? x : 0, true);
    }
  }
  return buffer;
}

/** Wraps `encodeWav` output in a Blob typed `audio/wav` for storage. */
export function encodeWavBlob(pcm: Float32Array, sampleRate: number, bitsPerSample: 16 | 32 = 16): Blob {
  return new Blob([encodeWav(pcm, sampleRate, bitsPerSample)], { type: 'audio/wav' });
}

/** The sample layout a fmt chunk describes, reduced to what decoding needs. */
interface SampleFormat {
  float: boolean;
  bits: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
}

/** Reads the fmt chunk body at `at`, unwrapping the extensible form. */
function readFormat(view: DataView, at: number, size: number): SampleFormat {
  if (size < 16) throw new Error('Not a usable WAV file: fmt chunk is too short');
  let tag = view.getUint16(at, true);
  // Extensible files (common for float and multichannel) carry the real tag
  // in the first two bytes of the sub-format GUID.
  if (tag === FORMAT_EXTENSIBLE && size >= 26) tag = view.getUint16(at + 24, true);
  const channels = view.getUint16(at + 2, true);
  const sampleRate = view.getUint32(at + 4, true);
  const bits = view.getUint16(at + 14, true);
  const float = tag === FORMAT_FLOAT;
  if (!(float && bits === 32) && !(tag === FORMAT_PCM && bits === 16)) {
    throw new Error(`Unsupported WAV format: ${float ? 'float' : 'PCM tag ' + tag}, ${bits}-bit (need 16-bit PCM or 32-bit float)`);
  }
  if (channels < 1) throw new Error('Not a usable WAV file: zero channels');
  if (sampleRate < 1) throw new Error('Not a usable WAV file: zero sample rate');
  return { float, bits, channels, sampleRate, blockAlign: channels * (bits / 8) };
}

/**
 * Decodes 16-bit PCM or 32-bit float WAV data. Channels are averaged to mono.
 * Unknown chunks are skipped, extensible headers are understood, and a data
 * chunk whose size field overruns the file (a stream cut short, or a writer
 * that left the size unset) is read as far as the bytes go.
 */
export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const view = new DataView(buf);
  if (view.byteLength < 12 || readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new Error('Not a WAV file: missing RIFF/WAVE header');
  }
  let format: SampleFormat | null = null;
  let dataAt = -1;
  let dataBytes = 0;
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const tag = readTag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag === 'fmt ') {
      format = readFormat(view, body, Math.min(size, view.byteLength - body));
    } else if (tag === 'data') {
      dataAt = body;
      dataBytes = Math.min(size, view.byteLength - body);
      break;
    }
    // Chunks are word aligned: an odd size carries one pad byte.
    at = body + size + (size & 1);
  }
  if (!format) throw new Error('Not a usable WAV file: no fmt chunk');
  if (dataAt < 0) throw new Error('Not a usable WAV file: no data chunk');

  const { float, channels, sampleRate, blockAlign } = format;
  const frames = Math.floor(dataBytes / blockAlign);
  const bytesPerSample = format.bits / 8;
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const frameAt = dataAt + i * blockAlign;
    for (let c = 0; c < channels; c++) {
      const sampleAt = frameAt + c * bytesPerSample;
      sum += float ? view.getFloat32(sampleAt, true) : view.getInt16(sampleAt, true) / 32768;
    }
    pcm[i] = channels === 1 ? sum : sum / channels;
  }
  return { pcm, sampleRate, channels };
}

/**
 * Song time of a recorded sample: the take's start on the song clock plus the
 * sample's offset into the take, minus the round-trip latency. What the singer
 * heard at song time t arrives in the mic about `latencyS` later, so taking
 * the latency off puts the sample back on the moment it answers.
 */
export function songTimeOfSample(sampleIndex: number, sampleRate: number, startedAtSongS: number, latencyS: number): number {
  return startedAtSongS + sampleIndex / sampleRate - latencyS;
}
