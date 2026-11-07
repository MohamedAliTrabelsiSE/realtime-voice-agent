import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import type { RealtimeConfig } from '../config/app-config';
import type {
  RealtimeFunctionCall,
  RealtimeSession,
  RealtimeSessionOptions,
} from './realtime.types';

/** Minimal surface of a `ws` WebSocket, so tests can inject a fake upstream. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: never[]) => void): unknown;
}

export type RealtimeSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => RealtimeSocket;

export const defaultSocketFactory: RealtimeSocketFactory = (url, headers) =>
  new WebSocket(url, { headers });

const SOCKET_OPEN = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const IGNORABLE_ERRORS = [
  /no active response/i,
  /buffer too small/i,
  /already has an active response/i,
];

type JsonRecord = Record<string, unknown>;

/**
 * Bridges one caller to the OpenAI Realtime API (speech-to-speech over WebSocket).
 *
 * Tool calls are collected while a response is streaming and executed on `response.done`,
 * because the API rejects a new `response.create` while one is still active.
 */
export class OpenAIRealtimeSession implements RealtimeSession {
  private readonly logger = new Logger(OpenAIRealtimeSession.name);
  private socket: RealtimeSocket | null = null;
  private ready = false;
  private closed = false;
  private responseActive = false;
  private assistantText = '';
  private pendingCalls: RealtimeFunctionCall[] = [];

  constructor(
    private readonly cfg: RealtimeConfig,
    private readonly opts: RealtimeSessionOptions,
    private readonly socketFactory: RealtimeSocketFactory = defaultSocketFactory,
  ) {}

  connect(): Promise<void> {
    if (!this.cfg.apiKey) return Promise.reject(new Error('OPENAI_API_KEY is not configured'));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error('Timed out connecting to OpenAI Realtime')),
        CONNECT_TIMEOUT_MS,
      );

      const url = `${this.cfg.url}?model=${encodeURIComponent(this.cfg.model)}`;
      const socket = this.socketFactory(url, { Authorization: `Bearer ${this.cfg.apiKey}` });
      this.socket = socket;

      socket.on('error', (error: Error) => {
        this.opts.handlers.onError(error.message);
        settle(error);
      });
      socket.on('close', () => {
        const wasClosed = this.closed;
        this.closed = true;
        this.ready = false;
        settle(new Error('Realtime socket closed before session was ready'));
        if (!wasClosed) this.opts.handlers.onClose();
      });
      socket.on('message', (raw: unknown) => {
        const event = parseEvent(raw);
        if (event) void this.handleEvent(event, settle);
      });
    });
  }

  appendAudio(pcm: Buffer): void {
    if (!this.ready || pcm.length < 2) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!this.ready || !trimmed) return;
    this.cancelResponse();
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: trimmed }] },
    });
    this.send({ type: 'response.create' });
  }

  greet(): void {
    if (!this.ready) return;
    this.send({
      type: 'response.create',
      response: {
        instructions: `Greet the caller now. Say something close to: "${this.opts.greeting}"`,
      },
    });
  }

  cancelResponse(): void {
    if (this.ready && this.responseActive) this.send({ type: 'response.cancel' });
    this.responseActive = false;
    this.assistantText = '';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }

  buildSessionUpdate(): JsonRecord {
    const input: JsonRecord = {
      format: { type: 'audio/pcm', rate: this.cfg.pcmRate },
      transcription: { model: this.cfg.transcriptModel },
      turn_detection: {
        type: 'server_vad',
        threshold: this.cfg.vadThreshold,
        prefix_padding_ms: this.cfg.vadPrefixPaddingMs,
        silence_duration_ms: this.cfg.vadSilenceMs,
        create_response: true,
        interrupt_response: true,
      },
    };
    if (this.cfg.noiseReduction !== 'none') {
      input.noise_reduction = { type: this.cfg.noiseReduction };
    }
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.cfg.model,
        instructions: this.opts.instructions,
        output_modalities: ['audio'],
        tools: this.opts.tools,
        tool_choice: 'auto',
        audio: {
          input,
          output: { format: { type: 'audio/pcm', rate: this.cfg.pcmRate }, voice: this.cfg.voice },
        },
      },
    };
  }

  private send(payload: JsonRecord): void {
    if (this.socket?.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private async handleEvent(event: JsonRecord, settle: (err?: Error) => void): Promise<void> {
    const h = this.opts.handlers;
    switch (event.type) {
      case 'session.created':
        this.send(this.buildSessionUpdate());
        return;

      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          h.onReady();
          settle();
        }
        return;

      case 'error': {
        const message = readErrorMessage(event);
        if (IGNORABLE_ERRORS.some((re) => re.test(message))) {
          this.logger.debug(`Ignored realtime error: ${message}`);
          return;
        }
        h.onError(message);
        if (!this.ready) settle(new Error(message));
        return;
      }

      case 'response.created':
        this.responseActive = true;
        this.assistantText = '';
        return;

      case 'input_audio_buffer.speech_started':
        this.assistantText = '';
        h.onSpeechStarted();
        return;

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = str(event.transcript).trim();
        if (transcript) h.onUserTranscript(transcript);
        return;
      }

      case 'response.output_audio_transcript.delta': {
        const delta = str(event.delta);
        if (delta) {
          this.assistantText += delta;
          h.onAssistantDelta(delta);
        }
        return;
      }

      case 'response.output_audio.delta': {
        const delta = str(event.delta);
        if (delta) h.onAudioDelta(Buffer.from(delta, 'base64'));
        return;
      }

      case 'response.function_call_arguments.done': {
        const callId = str(event.call_id);
        const name = str(event.name);
        if (callId && name) {
          this.pendingCalls.push({ callId, name, arguments: str(event.arguments) || '{}' });
        }
        return;
      }

      case 'response.done': {
        this.responseActive = false;
        const text = this.assistantText.trim();
        this.assistantText = '';
        if (text) h.onAssistantDone(text);
        await this.flushToolCalls();
        return;
      }

      default:
        return;
    }
  }

  private async flushToolCalls(): Promise<void> {
    if (this.pendingCalls.length === 0) return;
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    for (const call of calls) {
      let output: string;
      try {
        output = await this.opts.handlers.onFunctionCall(call);
      } catch (err) {
        output = JSON.stringify({ ok: false, error: (err as Error).message });
      }
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.callId, output },
      });
    }
    this.send({ type: 'response.create' });
  }
}

function parseEvent(raw: unknown): JsonRecord | null {
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw as Buffer[]).toString('utf8') : String(raw);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function readErrorMessage(event: JsonRecord): string {
  const err = event.error;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return JSON.stringify(event);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
