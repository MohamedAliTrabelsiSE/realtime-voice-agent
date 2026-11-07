import { z } from 'zod';

/** Max base64 payload for one audio frame (~2.8 s of 24 kHz PCM16). */
export const MAX_AUDIO_B64_LENGTH = 180_000;

export const startPayload = z.object({
  sessionId: z.string().uuid(),
  token: z.string().min(10),
});

export const audioPayload = z.object({
  audio: z.string().min(1).max(MAX_AUDIO_B64_LENGTH),
  format: z.enum(['pcm16', 'wav']).default('pcm16'),
  sampleRate: z.number().int().min(8000).max(48000).optional(),
});

export const textPayload = z.object({
  text: z.string().trim().min(1).max(2000),
});

export type StartPayload = z.infer<typeof startPayload>;
export type AudioPayload = z.infer<typeof audioPayload>;
export type TextPayload = z.infer<typeof textPayload>;

/** Events the server pushes to the client, as `{ event, data }` JSON frames. */
export interface ServerEvents {
  ready: { sessionId: string; realtimeMode: 'mock' | 'openai'; sampleRate: number };
  transcript: { role: 'user' | 'assistant'; text: string };
  agent_delta: { text: string };
  audio: { audio: string; sampleRate: number };
  speech_started: Record<string, never>;
  tool_call: { name: string; args: unknown; ok: boolean; result: unknown };
  ended: { summary: unknown };
  error: { code: string; message: string };
  pong: { at: string };
}

export type ServerEventName = keyof ServerEvents;
export type SendFn = <E extends ServerEventName>(event: E, data: ServerEvents[E]) => void;
