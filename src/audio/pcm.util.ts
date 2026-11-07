/**
 * Helpers for 16-bit little-endian mono PCM, the format OpenAI Realtime expects
 * for `audio/pcm` input and returns for output.
 */

export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), i * 2);
  }
  return out;
}

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = pcm.readInt16LE(i * 2);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** Linear-interpolation resampler. Good enough for speech; not for music. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate <= 0 || toRate <= 0) {
    throw new RangeError('Sample rates must be positive');
  }
  const inCount = Math.floor(pcm.length / 2);
  if (fromRate === toRate || inCount === 0) {
    return pcm.subarray(0, inCount * 2);
  }
  const outCount = Math.max(1, Math.round((inCount * toRate) / fromRate));
  const out = Buffer.alloc(outCount * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outCount; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm.readInt16LE(Math.min(idx, inCount - 1) * 2);
    const b = pcm.readInt16LE(Math.min(idx + 1, inCount - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

/** Averages interleaved channels into a single mono channel. */
export function downmixPcm16(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((f * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), f * 2);
  }
  return out;
}

export function durationMs(pcmBytes: number, sampleRate: number): number {
  return (pcmBytes / 2 / sampleRate) * 1000;
}

export function encodeWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface DecodedWav {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
}

/** Parses a PCM16 WAV file, walking chunks so files with LIST/fact chunks still work. */
export function decodeWav(wav: Buffer): DecodedWav {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
      if (format !== 1 || bits !== 16) {
        throw new Error(
          `Unsupported WAV encoding (format=${format}, bits=${bits}); expected PCM16`,
        );
      }
    } else if (id === 'data') {
      if (!sampleRate) throw new Error('WAV data chunk found before fmt chunk');
      const end = Math.min(body + size, wav.length);
      return { pcm: wav.subarray(body, end), sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

/**
 * Normalises any supported client payload to mono PCM16 at the target rate.
 */
export function toRealtimePcm(
  payload: Buffer,
  opts: { format: 'pcm16' | 'wav'; sampleRate?: number; targetRate: number },
): Buffer {
  if (opts.format === 'wav') {
    const wav = decodeWav(payload);
    return resamplePcm16(downmixPcm16(wav.pcm, wav.channels), wav.sampleRate, opts.targetRate);
  }
  return resamplePcm16(payload, opts.sampleRate ?? opts.targetRate, opts.targetRate);
}
