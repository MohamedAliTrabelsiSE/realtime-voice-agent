import { buildAppointmentTools } from '../appointments/appointment.tools';
import { AppointmentsService } from '../appointments/appointments.service';
import { encodeWav } from '../audio/pcm.util';
import { VoiceTokenService } from '../auth/voice-token.service';
import { fixedClock } from '../config/clock';
import type { RealtimeSessionFactory } from '../realtime/realtime-session.factory';
import type { RealtimeSession, RealtimeSessionOptions } from '../realtime/realtime.types';
import { SessionStore } from '../sessions/session.store';
import { MONDAY_8AM_PARIS, testConfig } from '../testing/test-config';
import { VoiceConversation } from './voice-conversation';

class StubRealtime implements RealtimeSession {
  connect = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  appendAudio = jest.fn<void, [Buffer]>();
  sendText = jest.fn<void, [string]>();
  greet = jest.fn();
  cancelResponse = jest.fn();
  close = jest.fn();
  constructor(readonly opts: RealtimeSessionOptions) {}
}

describe('VoiceConversation', () => {
  const clock = fixedClock(MONDAY_8AM_PARIS);
  const config = testConfig({ PCM_RATE: '24000' });
  let sessions: SessionStore;
  let tokens: VoiceTokenService;
  let appointments: AppointmentsService;
  let stub: StubRealtime | undefined;
  let connectBehaviour: (s: StubRealtime) => void;
  let sent: Array<{ event: string; data: unknown }>;
  let convo: VoiceConversation;

  const factory = {
    get mode() {
      return 'mock' as const;
    },
    create: (opts: RealtimeSessionOptions) => {
      stub = new StubRealtime(opts);
      connectBehaviour(stub);
      return stub;
    },
  } as unknown as RealtimeSessionFactory;

  const events = (): string[] => sent.map((e) => e.event);
  const lastError = (): unknown => [...sent].reverse().find((e) => e.event === 'error')?.data;

  async function startLive(callerName?: string): Promise<string> {
    const session = sessions.create(callerName);
    await convo.start({ sessionId: session.id, token: tokens.sign(session.id).token });
    return session.id;
  }

  beforeEach(() => {
    clock.set(MONDAY_8AM_PARIS);
    sessions = new SessionStore(clock);
    tokens = new VoiceTokenService(config, clock);
    appointments = new AppointmentsService(config, clock);
    stub = undefined;
    connectBehaviour = () => undefined;
    sent = [];
    convo = new VoiceConversation(
      {
        config,
        sessions,
        tokens,
        tools: buildAppointmentTools(appointments),
        appointments,
        realtime: factory,
      },
      (event, data) => sent.push({ event, data }),
    );
  });

  describe('start', () => {
    it('authenticates, opens the realtime session and greets', async () => {
      const id = await startLive('Ann');
      expect(convo.currentState).toBe('live');
      expect(sent[0]).toEqual({
        event: 'ready',
        data: { sessionId: id, realtimeMode: 'mock', sampleRate: 24000 },
      });
      expect(stub?.greet).toHaveBeenCalled();
      expect(stub?.opts.instructions).toContain('Test Clinic');
      expect(stub?.opts.instructions).toContain('The caller identified as Ann.');
      expect(stub?.opts.tools.map((t) => t.name)).toContain('book_appointment');
      expect(sessions.get(id)?.status).toBe('active');
    });

    it.each([
      [{}, 'invalid_payload'],
      [{ sessionId: 'not-a-uuid', token: 'xxxxxxxxxxxx' }, 'invalid_payload'],
    ])('rejects bad payload %j', async (payload, code) => {
      await convo.start(payload);
      expect(lastError()).toMatchObject({ code });
      expect(convo.currentState).toBe('idle');
    });

    it('rejects a token for another session', async () => {
      const a = sessions.create();
      const b = sessions.create();
      await convo.start({ sessionId: a.id, token: tokens.sign(b.id).token });
      expect(lastError()).toEqual({
        code: 'unauthorized',
        message: 'Invalid voice token (session_mismatch)',
      });
    });

    it('rejects unknown and already used sessions', async () => {
      const ghost = '6f1c1d1e-0000-4000-8000-000000000000';
      await convo.start({ sessionId: ghost, token: tokens.sign(ghost).token });
      expect(lastError()).toMatchObject({ code: 'not_found' });

      const used = sessions.create();
      sessions.markActive(used.id);
      await convo.start({ sessionId: used.id, token: tokens.sign(used.id).token });
      expect(lastError()).toMatchObject({ code: 'session_used' });
    });

    it('refuses to start twice', async () => {
      await startLive();
      await convo.start({});
      expect(lastError()).toMatchObject({ code: 'already_started' });
    });

    it('ends the session when the upstream connection fails', async () => {
      connectBehaviour = (s) => s.connect.mockRejectedValue(new Error('401'));
      const id = await startLive();
      expect(events()).toEqual(['error', 'ended']);
      expect(lastError()).toMatchObject({ code: 'upstream_unavailable' });
      expect(sessions.get(id)?.status).toBe('ended');
      expect(stub?.close).toHaveBeenCalled();
    });

    it('does not go live if the client hung up during connect', async () => {
      let release!: () => void;
      connectBehaviour = (s) => s.connect.mockReturnValue(new Promise<void>((r) => (release = r)));
      const session = sessions.create();
      const pending = convo.start({ sessionId: session.id, token: tokens.sign(session.id).token });
      convo.dispose();
      release();
      await pending;
      expect(convo.currentState).toBe('ended');
      expect(events()).not.toContain('ready');
    });
  });

  describe('while live', () => {
    it('requires start before audio and text', () => {
      convo.audio({ audio: 'AAAA' });
      convo.text({ text: 'hi' });
      expect(sent.map((e) => (e.data as { code: string }).code)).toEqual([
        'not_started',
        'not_started',
      ]);
    });

    it('resamples PCM to the realtime rate', async () => {
      await startLive();
      const pcm48k = Buffer.alloc(9600);
      convo.audio({ audio: pcm48k.toString('base64'), sampleRate: 48000 });
      expect(stub?.appendAudio.mock.calls[0][0]).toHaveLength(4800);
    });

    it('accepts WAV frames and reports undecodable audio', async () => {
      await startLive();
      convo.audio({ audio: encodeWav(Buffer.alloc(480), 24000).toString('base64'), format: 'wav' });
      expect(stub?.appendAudio.mock.calls[0][0]).toHaveLength(480);
      convo.audio({ audio: Buffer.from('garbage!').toString('base64'), format: 'wav' });
      expect(lastError()).toMatchObject({ code: 'bad_audio' });
      convo.audio({ audio: '', format: 'mp3' });
      expect(lastError()).toMatchObject({ code: 'invalid_payload' });
    });

    it('records typed text and forwards it', async () => {
      const id = await startLive();
      convo.text({ text: '  hello  ' });
      expect(stub?.sendText).toHaveBeenCalledWith('hello');
      expect(sent).toContainEqual({ event: 'transcript', data: { role: 'user', text: 'hello' } });
      expect(sessions.get(id)?.transcript[0]).toMatchObject({ role: 'user', text: 'hello' });
    });

    it('relays realtime events to the client and transcript store', async () => {
      const id = await startLive();
      const h = stub!.opts.handlers;
      h.onReady();
      h.onUserTranscript('I need a checkup');
      h.onAssistantDelta('Sure');
      h.onAssistantDone('Sure, when?');
      h.onAudioDelta(Buffer.from([1, 2, 3, 4]));
      h.onSpeechStarted();
      h.onError('rate limited');

      expect(sent.slice(1)).toEqual([
        { event: 'transcript', data: { role: 'user', text: 'I need a checkup' } },
        { event: 'agent_delta', data: { text: 'Sure' } },
        { event: 'transcript', data: { role: 'assistant', text: 'Sure, when?' } },
        { event: 'audio', data: { audio: 'AQIDBA==', sampleRate: 24000 } },
        { event: 'speech_started', data: {} },
        { event: 'error', data: { code: 'upstream_error', message: 'rate limited' } },
      ]);
      expect(sessions.get(id)?.transcript.map((t) => t.role)).toEqual(['user', 'assistant']);
    });

    it('executes tool calls, records them and returns JSON to the model', async () => {
      const id = await startLive();
      const output = await stub!.opts.handlers.onFunctionCall({
        callId: 'c1',
        name: 'book_appointment',
        arguments: JSON.stringify({
          slotStart: '2026-01-05T09:00',
          customerName: 'Ann Lee',
          phone: '+15550100',
        }),
      });
      const parsed = JSON.parse(output) as { ok: boolean; appointment: { id: string } };
      expect(parsed.ok).toBe(true);
      expect(appointments.list()).toHaveLength(1);
      expect(sent.at(-1)).toMatchObject({
        event: 'tool_call',
        data: { name: 'book_appointment', ok: true },
      });
      expect(sessions.summarize(sessions.get(id)!).bookedAppointmentIds).toEqual([
        parsed.appointment.id,
      ]);
    });

    it('forwards interrupt to the realtime session', async () => {
      convo.interrupt();
      await startLive();
      convo.interrupt();
      expect(stub?.cancelResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('ending', () => {
    it('stop closes upstream and sends a summary once', async () => {
      const id = await startLive();
      convo.stop();
      convo.stop();
      expect(stub?.close).toHaveBeenCalledTimes(1);
      expect(events().filter((e) => e === 'ended')).toHaveLength(1);
      expect(sent.at(-1)).toMatchObject({ event: 'ended', data: { summary: { sessionId: id } } });
    });

    it('stop before start is an error', () => {
      convo.stop();
      expect(lastError()).toMatchObject({ code: 'not_started' });
    });

    it('dispose ends silently', async () => {
      const id = await startLive();
      convo.dispose();
      expect(events()).not.toContain('ended');
      expect(sessions.get(id)?.status).toBe('ended');
    });

    it('upstream close ends the call once', async () => {
      await startLive();
      stub!.opts.handlers.onClose();
      stub!.opts.handlers.onClose();
      expect(events().slice(-2)).toEqual(['error', 'ended']);
      expect(events().filter((e) => e === 'ended')).toHaveLength(1);
    });

    it('does not record tool calls that finish after the call ended', async () => {
      const id = await startLive();
      convo.dispose();
      await stub!.opts.handlers.onFunctionCall({
        callId: 'c',
        name: 'list_available_slots',
        arguments: '{}',
      });
      expect(sessions.get(id)?.toolCalls).toEqual([]);
    });
  });
});
