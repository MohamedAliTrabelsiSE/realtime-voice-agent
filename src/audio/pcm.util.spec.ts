import {
  decodeWav,
  downmixPcm16,
  durationMs,
  encodeWav,
  float32ToPcm16,
  pcm16ToFloat32,
  resamplePcm16,
  toRealtimePcm,
} from './pcm.util';

function pcmOf(...samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

function samplesOf(pcm: Buffer): number[] {
  return Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
}

describe('pcm.util', () => {
  describe('float32ToPcm16 / pcm16ToFloat32', () => {
    it('maps full scale and clamps out-of-range values', () => {
      const pcm = float32ToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
      expect(samplesOf(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    });

    it('round-trips within quantisation error', () => {
      const input = new Float32Array([0.25, -0.75, 0.1]);
      const back = pcm16ToFloat32(float32ToPcm16(input));
      back.forEach((v, i) => expect(v).toBeCloseTo(input[i], 3));
    });

    it('ignores a trailing odd byte', () => {
      expect(pcm16ToFloat32(Buffer.from([0, 0, 1]))).toHaveLength(1);
    });
  });

  describe('resamplePcm16', () => {
    it('returns the input unchanged when rates match', () => {
      const pcm = pcmOf(1, 2, 3);
      expect(resamplePcm16(pcm, 24000, 24000)).toEqual(pcm);
    });

    it('upsamples 2x with linear interpolation', () => {
      expect(samplesOf(resamplePcm16(pcmOf(0, 100), 12000, 24000))).toEqual([0, 50, 100, 100]);
    });

    it('downsamples 48k to 24k by half', () => {
      const out = resamplePcm16(pcmOf(0, 10, 20, 30, 40, 50), 48000, 24000);
      expect(samplesOf(out)).toEqual([0, 20, 40]);
    });

    it('rejects non-positive rates', () => {
      expect(() => resamplePcm16(pcmOf(1), 0, 24000)).toThrow(RangeError);
    });

    it('handles empty input', () => {
      expect(resamplePcm16(Buffer.alloc(0), 48000, 24000)).toHaveLength(0);
    });
  });

  it('downmixes interleaved stereo to mono', () => {
    expect(samplesOf(downmixPcm16(pcmOf(100, 300, -50, 50), 2))).toEqual([200, 0]);
    const mono = pcmOf(1, 2);
    expect(downmixPcm16(mono, 1)).toBe(mono);
  });

  it('computes duration', () => {
    expect(durationMs(48000, 24000)).toBe(1000);
  });

  describe('WAV', () => {
    it('encodes and decodes a PCM16 WAV', () => {
      const pcm = pcmOf(1, -1, 1000);
      const wav = encodeWav(pcm, 16000);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(16000);
      const decoded = decodeWav(wav);
      expect(decoded.sampleRate).toBe(16000);
      expect(decoded.channels).toBe(1);
      expect(decoded.pcm).toEqual(pcm);
    });

    it('skips unknown chunks before data', () => {
      const wav = encodeWav(pcmOf(7), 8000);
      const list = Buffer.concat([
        Buffer.from('LIST'),
        Buffer.from([3, 0, 0, 0]),
        Buffer.from('abc\0'),
      ]);
      const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
      expect(samplesOf(decodeWav(withList).pcm)).toEqual([7]);
    });

    it('rejects non-WAV, non-PCM16 and missing data', () => {
      expect(() => decodeWav(Buffer.from('hello world!'))).toThrow('Not a RIFF/WAVE');
      const float = encodeWav(pcmOf(1), 8000);
      float.writeUInt16LE(3, 20);
      expect(() => decodeWav(float)).toThrow('Unsupported WAV encoding');
      expect(() => decodeWav(encodeWav(pcmOf(1), 8000).subarray(0, 36))).toThrow('no data chunk');
      const dataFirst = Buffer.concat([
        Buffer.from('RIFF\0\0\0\0WAVE'),
        Buffer.from('data'),
        Buffer.from([2, 0, 0, 0, 1, 0]),
      ]);
      expect(() => decodeWav(dataFirst)).toThrow('before fmt');
    });
  });

  describe('toRealtimePcm', () => {
    it('resamples raw PCM from the declared rate', () => {
      expect(
        toRealtimePcm(pcmOf(0, 10, 20, 30), {
          format: 'pcm16',
          sampleRate: 48000,
          targetRate: 24000,
        }),
      ).toHaveLength(4);
    });

    it('assumes the target rate when none is given', () => {
      const pcm = pcmOf(5, 6);
      expect(toRealtimePcm(pcm, { format: 'pcm16', targetRate: 24000 })).toEqual(pcm);
    });

    it('decodes, downmixes and resamples WAV', () => {
      const stereo = encodeWav(pcmOf(100, 300, 100, 300), 12000, 2);
      const out = toRealtimePcm(stereo, { format: 'wav', targetRate: 24000 });
      expect(samplesOf(out)).toEqual([200, 200, 200, 200]);
    });
  });
});
