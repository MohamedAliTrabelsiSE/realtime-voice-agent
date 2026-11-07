import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { testConfig } from '../src/testing/test-config';
import { startApp, VoiceClient } from './helpers';

describe('Voice agent (mock realtime, e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl, wsUrl } = await startApp(testConfig({ MOCK_REALTIME: 'true' })));
  });

  afterAll(async () => {
    await app.close();
  });

  async function newSession(
    callerName?: string,
  ): Promise<{ sessionId: string; voiceToken: string; wsUrl: string }> {
    const res = await request(baseUrl).post('/sessions').send({ callerName }).expect(201);
    return res.body;
  }

  it('serves health, docs and the test lab', async () => {
    await request(baseUrl).get('/health').expect(200, {
      status: 'ok',
      realtimeMode: 'mock',
      model: 'gpt-realtime',
      business: 'Test Clinic',
    });
    const docs = await request(baseUrl).get('/docs-json').expect(200);
    expect(Object.keys(docs.body.paths)).toEqual(
      expect.arrayContaining([
        '/sessions',
        '/sessions/{id}',
        '/appointments',
        '/appointments/slots',
      ]),
    );
    const lab = await request(baseUrl).get('/').expect(200);
    expect(lab.text).toContain('Voice Agent Test Lab');
  });

  it('validates session creation input', async () => {
    await request(baseUrl)
      .post('/sessions')
      .send({ callerName: 'x'.repeat(81) })
      .expect(400);
    await request(baseUrl).get('/sessions/does-not-exist').expect(404);
    await request(baseUrl).get('/appointments/slots?date=2026-02-31').expect(400);
  });

  it('books an appointment through a voice session end to end', async () => {
    const session = await newSession('Jane Doe');
    expect(session.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/voice\/stream$/);

    const [slot] = (await request(baseUrl).get('/appointments/slots?limit=1').expect(200)).body;
    expect(slot.start).toBe('2026-01-05T09:00');

    const client = await VoiceClient.connect(wsUrl);
    client.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await client.waitFor('ready');
    await client.waitFor(
      'transcript',
      (d) => d.role === 'assistant' && String(d.text).includes('Test Clinic'),
    );
    expect(client.frames.some((f) => f.event === 'audio')).toBe(true);

    client.send('text', { text: `book ${slot.start} for Jane Doe phone +33612345678` });
    const tool = await client.waitFor('tool_call');
    expect(tool.data).toMatchObject({ name: 'book_appointment', ok: true });
    const appointmentId = (tool.data.result as { appointment: { id: string } }).appointment.id;
    await client.waitFor(
      'transcript',
      (d) => d.role === 'assistant' && String(d.text).includes(appointmentId),
    );

    const list = (await request(baseUrl).get('/appointments').expect(200)).body;
    expect(list).toEqual([
      expect.objectContaining({
        id: appointmentId,
        start: slot.start,
        customerName: 'Jane Doe',
        status: 'booked',
      }),
    ]);

    client.send('stop');
    const ended = await client.waitFor('ended');
    expect(ended.data.summary).toMatchObject({
      sessionId: session.sessionId,
      userTurns: 1,
      toolCalls: 1,
      bookedAppointmentIds: [appointmentId],
    });
    await client.close();

    const stored = (await request(baseUrl).get(`/sessions/${session.sessionId}`).expect(200)).body;
    expect(stored.status).toBe('ended');
    expect(stored.callerName).toBe('Jane Doe');
    expect(stored.toolCalls).toHaveLength(1);
    expect(stored.transcript.map((t: { role: string }) => t.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('streams microphone audio and rejects double booking', async () => {
    const session = await newSession();
    const client = await VoiceClient.connect(wsUrl);
    client.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await client.waitFor('ready');

    const oneSecondAt48k = Buffer.alloc(96000).toString('base64');
    client.send('audio', { audio: oneSecondAt48k, sampleRate: 48000 });
    client.send('audio', { audio: oneSecondAt48k, sampleRate: 48000 });
    await client.waitFor('speech_started');
    await client.waitFor(
      'transcript',
      (d) => d.role === 'user' && String(d.text).includes('seconds of audio'),
    );

    client.send('text', { text: 'book 2026-01-05T09:00 for Someone Else' });
    const tool = await client.waitFor('tool_call');
    expect(tool.data).toMatchObject({ ok: false, result: { code: 'slot_unavailable' } });
    await client.close();
  });

  it('rejects bad tokens and reused sessions', async () => {
    const session = await newSession();
    const intruder = await VoiceClient.connect(wsUrl);
    intruder.send('start', {
      sessionId: session.sessionId,
      token: `${session.voiceToken}tampered`,
    });
    const err = await intruder.waitFor('error');
    expect(err.data).toMatchObject({ code: 'unauthorized' });
    intruder.send('text', { text: 'hello?' });
    await intruder.waitFor('error', (d) => d.code === 'not_started');
    await intruder.close();

    const first = await VoiceClient.connect(wsUrl);
    first.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await first.waitFor('ready');
    await first.close();

    const replay = await VoiceClient.connect(wsUrl);
    replay.send('start', { sessionId: session.sessionId, token: session.voiceToken });
    await replay.waitFor('error', (d) => d.code === 'session_used');
    await replay.close();
  });

  it('answers ping', async () => {
    const client = await VoiceClient.connect(wsUrl);
    client.send('ping');
    await client.waitFor('pong');
    await client.close();
  });
});
