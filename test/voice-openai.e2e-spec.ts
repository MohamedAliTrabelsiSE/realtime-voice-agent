import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { REALTIME_SOCKET_FACTORY } from '../src/realtime/realtime-session.factory';
import { FakeRealtimeSocket } from '../src/testing/fake-realtime-socket';
import { testConfig } from '../src/testing/test-config';
import { startApp, VoiceClient } from './helpers';

/**
 * Scripted OpenAI Realtime server: completes the handshake, greets, turns the user's
 * text into a book_appointment call, then confirms using the tool output.
 */
class ScriptedOpenAI extends FakeRealtimeSocket {
  static last: ScriptedOpenAI | undefined;

  constructor(url: string, headers: Record<string, string>) {
    super(url, headers);
    ScriptedOpenAI.last = this;
    setImmediate(() => this.server({ type: 'session.created' }));
  }

  override send(data: string): void {
    super.send(data);
    const msg = JSON.parse(data) as { type: string; item?: { type: string; output?: string } };
    setImmediate(() => this.react(msg));
  }

  private react(msg: { type: string; item?: { type: string; output?: string } }): void {
    if (msg.type === 'session.update') return this.server({ type: 'session.updated' });
    if (msg.type === 'conversation.item.create' && msg.item?.type === 'function_call_output') {
      this.pendingToolOutput = msg.item.output ?? '';
      return;
    }
    if (msg.type !== 'response.create') return;

    this.server({ type: 'response.created' });
    if (this.pendingToolOutput) {
      const { appointment } = JSON.parse(this.pendingToolOutput) as { appointment: { id: string } };
      this.pendingToolOutput = '';
      this.say(`Booked. Your confirmation number is ${appointment.id}.`);
    } else if (this.userSpoke) {
      this.server({
        type: 'response.function_call_arguments.done',
        call_id: 'call_1',
        name: 'book_appointment',
        arguments: JSON.stringify({
          slotStart: '2026-01-05T11:00',
          customerName: 'Ann Lee',
          phone: '+15550100',
        }),
      });
    } else {
      this.say('Hello, how can I help?');
    }
    this.server({ type: 'response.done' });
  }

  private pendingToolOutput = '';
  private get userSpoke(): boolean {
    return this.sent.some((e) => e.type === 'conversation.item.create');
  }

  private say(text: string): void {
    this.server({ type: 'response.output_audio_transcript.delta', delta: text });
    this.server({
      type: 'response.output_audio.delta',
      delta: Buffer.alloc(480).toString('base64'),
    });
  }

  userSaid(transcript: string): void {
    this.server({ type: 'input_audio_buffer.speech_started' });
    this.server({ type: 'conversation.item.input_audio_transcription.completed', transcript });
  }
}

describe('Voice agent (OpenAI realtime protocol against a scripted upstream, e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl, wsUrl } = await startApp(
      testConfig({ MOCK_REALTIME: 'false', OPENAI_API_KEY: 'sk-test-key' }),
      (b) =>
        b
          .overrideProvider(REALTIME_SOCKET_FACTORY)
          .useValue(
            (url: string, headers: Record<string, string>) => new ScriptedOpenAI(url, headers),
          ),
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs greeting, speech transcript, tool call and confirmation through the real client', async () => {
    const { body: session } = await request(baseUrl).post('/sessions').send({}).expect(201);
    expect(session.realtimeMode).toBe('openai');

    const client = await VoiceClient.connect(wsUrl);
    client.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await client.waitFor('ready', (d) => d.realtimeMode === 'openai');

    const upstream = ScriptedOpenAI.last!;
    expect(upstream.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(upstream.headers.Authorization).toBe('Bearer sk-test-key');
    const update = upstream.sent.find((e) => e.type === 'session.update') as {
      session: { tools: Array<{ name: string }>; instructions: string };
    };
    expect(update.session.tools.map((t) => t.name)).toEqual([
      'list_available_slots',
      'book_appointment',
      'find_appointment',
      'cancel_appointment',
    ]);
    expect(update.session.instructions).toContain('Test Clinic');

    await client.waitFor('transcript', (d) => d.text === 'Hello, how can I help?');
    await client.waitFor('audio');

    client.send('audio', { audio: Buffer.alloc(960).toString('base64') });
    await new Promise((r) => setTimeout(r, 50));
    expect(upstream.sent.some((e) => e.type === 'input_audio_buffer.append')).toBe(true);

    upstream.userSaid('Book me at eleven, Ann Lee, plus one five five five zero one zero zero');
    await client.waitFor('speech_started');
    await client.waitFor('transcript', (d) => d.role === 'user');

    client.send('text', { text: 'Yes, please book it' });
    const tool = await client.waitFor('tool_call');
    expect(tool.data).toMatchObject({ name: 'book_appointment', ok: true });
    const id = (tool.data.result as { appointment: { id: string } }).appointment.id;

    expect(upstream.sent).toContainEqual(
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      }),
    );
    await client.waitFor(
      'transcript',
      (d) => d.role === 'assistant' && String(d.text).includes(id),
    );

    const appointments = (await request(baseUrl).get('/appointments').expect(200)).body;
    expect(appointments).toContainEqual(expect.objectContaining({ id, start: '2026-01-05T11:00' }));

    client.send('stop');
    await client.waitFor('ended');
    expect(upstream.closed).toBe(true);
    await client.close();
  });

  it('reports an upstream disconnect to the caller', async () => {
    const { body: session } = await request(baseUrl).post('/sessions').send({}).expect(201);
    const client = await VoiceClient.connect(wsUrl);
    client.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await client.waitFor('ready');

    ScriptedOpenAI.last!.emit('close', 1011, Buffer.from('server error'));
    await client.waitFor('error', (d) => d.code === 'upstream_closed');
    await client.waitFor('ended');
    await client.close();
  });
});
