import { durationMs, float32ToPcm16 } from '../audio/pcm.util';
import type { RealtimeSession, RealtimeSessionOptions } from './realtime.types';

const AUDIO_TURN_MS = 1500;

interface Intent {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Deterministic stand-in for OpenAI Realtime. It recognises a few typed phrases,
 * drives the same tool-calling path as the real model, and emits a short tone as
 * "speech" so the browser lab and e2e tests work offline and for free.
 */
export class MockRealtimeSession implements RealtimeSession {
  private ready = false;
  private closed = false;
  private bufferedAudioBytes = 0;
  private speaking = false;

  constructor(
    private readonly opts: RealtimeSessionOptions,
    private readonly pcmRate: number,
  ) {}

  async connect(): Promise<void> {
    await tick();
    this.ready = true;
    this.opts.handlers.onReady();
  }

  greet(): void {
    if (this.ready) void this.speak(this.opts.greeting);
  }

  sendText(text: string): void {
    if (!this.ready || this.closed || !text.trim()) return;
    void this.respondTo(text.trim());
  }

  appendAudio(pcm: Buffer): void {
    if (!this.ready || this.closed) return;
    if (this.bufferedAudioBytes === 0) this.opts.handlers.onSpeechStarted();
    this.bufferedAudioBytes += pcm.length;
    const ms = durationMs(this.bufferedAudioBytes, this.pcmRate);
    if (ms >= AUDIO_TURN_MS) {
      this.bufferedAudioBytes = 0;
      const heard = `[mock speech-to-text] ${(ms / 1000).toFixed(1)} seconds of audio received`;
      this.opts.handlers.onUserTranscript(heard);
      void this.speak(
        'I can hear you. In mock mode I only understand typed messages; set an OpenAI key for real speech.',
      );
    }
  }

  cancelResponse(): void {
    this.speaking = false;
  }

  close(): void {
    this.closed = true;
    this.ready = false;
  }

  private async respondTo(text: string): Promise<void> {
    const intent = detectIntent(text);
    if (!intent) {
      await this.speak(
        `You said: "${text}". Try "what slots are available tomorrow", ` +
          '"book 2026-01-05T10:00 for Jane Doe phone +15551234567", "find APT-1234" or "cancel APT-1234".',
      );
      return;
    }
    const output = await this.opts.handlers.onFunctionCall({
      callId: `mock_${Math.random().toString(36).slice(2, 10)}`,
      name: intent.tool,
      arguments: JSON.stringify(intent.args),
    });
    await this.speak(describeResult(intent.tool, output));
  }

  private async speak(text: string): Promise<void> {
    const h = this.opts.handlers;
    this.speaking = true;
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (!this.speaking || this.closed) return;
      h.onAssistantDelta(i === 0 ? words[i] : ` ${words[i]}`);
      await tick();
    }
    if (this.closed) return;
    h.onAudioDelta(tone(this.pcmRate));
    h.onAssistantDone(text);
    this.speaking = false;
  }
}

export function detectIntent(text: string): Intent | null {
  const appointmentId = /\b(APT-[A-Z0-9]+)\b/i.exec(text)?.[1]?.toUpperCase();

  if (/\bcancel\b/i.test(text) && appointmentId) {
    return { tool: 'cancel_appointment', args: { appointmentId } };
  }

  const book =
    /\bbook\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+for\s+(.+?)(?:[, ]+phone\s+([+\d][\d\s-]{5,}))?$/i.exec(
      text,
    );
  if (book) {
    return {
      tool: 'book_appointment',
      args: {
        slotStart: book[1],
        customerName: book[2].trim(),
        phone: (book[3] ?? '+10000000000').replace(/[\s-]/g, ''),
        reason: 'Booked via mock agent',
      },
    };
  }

  if (/\b(slots?|available|availability|free|open)\b/i.test(text)) {
    const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
    return { tool: 'list_available_slots', args: date ? { date, limit: 5 } : { limit: 5 } };
  }

  if (appointmentId) return { tool: 'find_appointment', args: { appointmentId } };
  return null;
}

function describeResult(tool: string, output: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return 'Sorry, something went wrong.';
  }
  if (parsed.ok === false) return `Sorry, I could not do that: ${String(parsed.error)}.`;

  switch (tool) {
    case 'list_available_slots': {
      const slots = (parsed.slots as Array<{ start: string; label: string }> | undefined) ?? [];
      return slots.length
        ? `The next available slots are ${slots.map((s) => `${s.label} (${s.start})`).join(', ')}.`
        : 'There are no free slots in that period.';
    }
    case 'book_appointment': {
      const a = parsed.appointment as { id: string; label: string };
      return `You're booked for ${a.label}. Your confirmation number is ${a.id}.`;
    }
    case 'cancel_appointment': {
      const a = parsed.appointment as { id: string };
      return `Appointment ${a.id} has been cancelled.`;
    }
    case 'find_appointment': {
      const list =
        (parsed.appointments as Array<{ id: string; label: string; status: string }>) ?? [];
      return list.length
        ? list.map((a) => `${a.id} on ${a.label} is ${a.status}`).join('. ') + '.'
        : 'I could not find any appointment with those details.';
    }
    default:
      return 'Done.';
  }
}

function tone(rate: number, ms = 180, freq = 660): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const envelope = Math.min(1, i / 200, (n - i) / 200);
    samples[i] = 0.15 * envelope * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return float32ToPcm16(samples);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
