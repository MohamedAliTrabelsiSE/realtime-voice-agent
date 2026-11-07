import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { AppointmentsService } from '../appointments/appointments.service';
import { toRealtimePcm } from '../audio/pcm.util';
import type { VoiceTokenService } from '../auth/voice-token.service';
import type { AppConfig } from '../config/app-config';
import { buildAgentInstructions, buildGreeting } from '../prompts/agent.prompt';
import type { RealtimeSessionFactory } from '../realtime/realtime-session.factory';
import type { RealtimeSession, RealtimeSessionHandlers } from '../realtime/realtime.types';
import type { SessionStore } from '../sessions/session.store';
import type { ToolRegistry } from '../tools/tool-registry';
import { audioPayload, startPayload, textPayload, type SendFn } from './voice.protocol';

export interface VoiceConversationDeps {
  config: AppConfig;
  sessions: SessionStore;
  tokens: VoiceTokenService;
  tools: ToolRegistry;
  appointments: AppointmentsService;
  realtime: RealtimeSessionFactory;
}

type State = 'idle' | 'starting' | 'live' | 'ended';

/**
 * One caller's conversation: authenticates the WebSocket, owns the upstream realtime
 * session, executes tool calls, records the transcript and relays events to the client.
 */
export class VoiceConversation {
  private readonly logger = new Logger(VoiceConversation.name);
  private state: State = 'idle';
  private sessionId: string | null = null;
  private realtime: RealtimeSession | null = null;

  constructor(
    private readonly deps: VoiceConversationDeps,
    private readonly send: SendFn,
  ) {}

  get currentState(): State {
    return this.state;
  }

  async start(raw: unknown): Promise<void> {
    if (this.state !== 'idle') return this.fail('already_started', 'Session already started');
    const payload = this.parse(startPayload, raw);
    if (!payload) return;

    const verdict = this.deps.tokens.verify(payload.token, payload.sessionId);
    if (!verdict.valid) return this.fail('unauthorized', `Invalid voice token (${verdict.reason})`);

    const session = this.deps.sessions.get(payload.sessionId);
    if (!session) return this.fail('not_found', 'Unknown session');
    if (session.status !== 'created') {
      return this.fail('session_used', 'This session was already used; create a new one');
    }

    this.state = 'starting';
    this.sessionId = session.id;
    this.deps.sessions.markActive(session.id);

    const { business, realtime: rtCfg } = this.deps.config;
    this.realtime = this.deps.realtime.create({
      instructions: buildAgentInstructions({
        businessName: business.name,
        timezone: business.timezone,
        nowLocal: this.deps.appointments.nowLocal(),
        openingHour: business.openingHour,
        closingHour: business.closingHour,
        callerName: session.callerName,
      }),
      tools: this.deps.tools.specs(),
      greeting: buildGreeting(business.name),
      handlers: this.handlers(session.id),
    });

    try {
      await this.realtime.connect();
    } catch (err) {
      this.logger.warn(`Realtime connect failed: ${(err as Error).message}`);
      this.fail('upstream_unavailable', 'Could not connect to the realtime model');
      this.finish();
      return;
    }
    if (this.state !== 'starting') return;

    this.state = 'live';
    this.send('ready', {
      sessionId: session.id,
      realtimeMode: this.deps.realtime.mode,
      sampleRate: rtCfg.pcmRate,
    });
    this.realtime.greet();
  }

  audio(raw: unknown): void {
    if (!this.requireLive()) return;
    const payload = this.parse(audioPayload, raw);
    if (!payload) return;
    let pcm: Buffer;
    try {
      pcm = toRealtimePcm(Buffer.from(payload.audio, 'base64'), {
        format: payload.format,
        sampleRate: payload.sampleRate,
        targetRate: this.deps.config.realtime.pcmRate,
      });
    } catch (err) {
      return this.fail('bad_audio', (err as Error).message);
    }
    this.realtime?.appendAudio(pcm);
  }

  text(raw: unknown): void {
    if (!this.requireLive()) return;
    const payload = this.parse(textPayload, raw);
    if (!payload || !this.sessionId) return;
    this.deps.sessions.appendTranscript(this.sessionId, 'user', payload.text);
    this.send('transcript', { role: 'user', text: payload.text });
    this.realtime?.sendText(payload.text);
  }

  interrupt(): void {
    if (this.state === 'live') this.realtime?.cancelResponse();
  }

  stop(): void {
    if (this.state === 'idle') return this.fail('not_started', 'Send "start" first');
    this.finish();
  }

  /** Called when the client socket closes. */
  dispose(): void {
    this.finish(false);
  }

  private finish(notify = true): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.realtime?.close();
    this.realtime = null;
    if (this.sessionId) {
      const summary = this.deps.sessions.end(this.sessionId);
      if (notify) this.send('ended', { summary });
    }
  }

  private handlers(sessionId: string): RealtimeSessionHandlers {
    const { sessions, tools, config } = this.deps;
    return {
      onReady: () => undefined,
      onUserTranscript: (text) => {
        sessions.appendTranscript(sessionId, 'user', text);
        this.send('transcript', { role: 'user', text });
      },
      onAssistantDelta: (text) => this.send('agent_delta', { text }),
      onAssistantDone: (text) => {
        sessions.appendTranscript(sessionId, 'assistant', text);
        this.send('transcript', { role: 'assistant', text });
      },
      onAudioDelta: (pcm) =>
        this.send('audio', { audio: pcm.toString('base64'), sampleRate: config.realtime.pcmRate }),
      onSpeechStarted: () => this.send('speech_started', {}),
      onFunctionCall: async (call) => {
        const outcome = await tools.execute(call.name, call.arguments, { sessionId });
        if (this.state !== 'ended') {
          sessions.recordToolCall(sessionId, {
            name: call.name,
            args: outcome.args,
            result: outcome.result,
            ok: outcome.ok,
          });
        }
        this.send('tool_call', {
          name: call.name,
          args: outcome.args,
          ok: outcome.ok,
          result: outcome.result,
        });
        return JSON.stringify(outcome.result);
      },
      onError: (message) => this.send('error', { code: 'upstream_error', message }),
      onClose: () => {
        if (this.state === 'ended') return;
        this.send('error', { code: 'upstream_closed', message: 'Realtime connection closed' });
        this.finish();
      },
    };
  }

  private requireLive(): boolean {
    if (this.state === 'live') return true;
    this.fail('not_started', 'Send "start" and wait for "ready" first');
    return false;
  }

  private parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> | null {
    const result = schema.safeParse(raw ?? {});
    if (result.success) return result.data;
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    this.fail('invalid_payload', message);
    return null;
  }

  private fail(code: string, message: string): void {
    this.send('error', { code, message });
  }
}
