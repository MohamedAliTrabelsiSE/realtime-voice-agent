import { detectIntent, MockRealtimeSession } from './mock-realtime.session';
import type { RealtimeSessionHandlers } from './realtime.types';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

function handlers(output = '{"ok":true}'): jest.Mocked<RealtimeSessionHandlers> {
  return {
    onReady: jest.fn(),
    onUserTranscript: jest.fn(),
    onAssistantDelta: jest.fn(),
    onAssistantDone: jest.fn(),
    onAudioDelta: jest.fn(),
    onSpeechStarted: jest.fn(),
    onFunctionCall: jest.fn().mockResolvedValue(output),
    onError: jest.fn(),
    onClose: jest.fn(),
  };
}

describe('detectIntent', () => {
  it.each([
    ['What slots are available?', { tool: 'list_available_slots', args: { limit: 5 } }],
    [
      'any free time on 2026-01-06',
      { tool: 'list_available_slots', args: { date: '2026-01-06', limit: 5 } },
    ],
    [
      'book 2026-01-05T10:00 for Jane Doe phone +33 6 12 34 56 78',
      {
        tool: 'book_appointment',
        args: {
          slotStart: '2026-01-05T10:00',
          customerName: 'Jane Doe',
          phone: '+33612345678',
          reason: 'Booked via mock agent',
        },
      },
    ],
    [
      'Book 2026-01-05T10:00 for Sam',
      {
        tool: 'book_appointment',
        args: {
          slotStart: '2026-01-05T10:00',
          customerName: 'Sam',
          phone: '+10000000000',
          reason: 'Booked via mock agent',
        },
      },
    ],
    [
      'please cancel apt-1a2b3c',
      { tool: 'cancel_appointment', args: { appointmentId: 'APT-1A2B3C' } },
    ],
    ['where is APT-1A2B3C', { tool: 'find_appointment', args: { appointmentId: 'APT-1A2B3C' } }],
  ])('%s', (text, expected) => {
    expect(detectIntent(text)).toEqual(expected);
  });

  it('returns null for small talk', () => {
    expect(detectIntent('hello there')).toBeNull();
  });
});

describe('MockRealtimeSession', () => {
  const greeting = 'Hello from the clinic';

  it('connects, greets with streamed text and a tone', async () => {
    const h = handlers();
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    s.greet();
    await s.connect();
    expect(h.onReady).toHaveBeenCalled();
    s.greet();
    await settle();
    expect(h.onAssistantDelta.mock.calls.map((c) => c[0]).join('')).toBe(greeting);
    expect(h.onAssistantDone).toHaveBeenCalledWith(greeting);
    expect(h.onAudioDelta.mock.calls[0][0].length).toBeGreaterThan(1000);
  });

  it('routes recognised text through the tool handler and speaks the result', async () => {
    const h = handlers(
      JSON.stringify({ ok: true, appointment: { id: 'APT-9', label: 'Monday 5 January, 10:00' } }),
    );
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    await s.connect();
    s.sendText('book 2026-01-05T10:00 for Jane Doe');
    await settle();
    expect(h.onFunctionCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'book_appointment',
        callId: expect.stringMatching(/^mock_/),
      }),
    );
    expect(h.onAssistantDone).toHaveBeenCalledWith(
      "You're booked for Monday 5 January, 10:00. Your confirmation number is APT-9.",
    );
  });

  it.each([
    [
      'what is available',
      { ok: true, slots: [{ start: 'S1', label: 'L1' }] },
      'The next available slots are L1 (S1).',
    ],
    ['what is available', { ok: true, slots: [] }, 'There are no free slots in that period.'],
    [
      'cancel APT-1',
      { ok: true, appointment: { id: 'APT-1' } },
      'Appointment APT-1 has been cancelled.',
    ],
    [
      'find APT-1',
      { ok: true, appointments: [{ id: 'APT-1', label: 'L', status: 'booked' }] },
      'APT-1 on L is booked.',
    ],
    [
      'find APT-1',
      { ok: true, appointments: [] },
      'I could not find any appointment with those details.',
    ],
    ['cancel APT-1', { ok: false, error: 'not found' }, 'Sorry, I could not do that: not found.'],
  ])('describes %s -> %j', async (text, output, spoken) => {
    const h = handlers(JSON.stringify(output));
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    await s.connect();
    s.sendText(text);
    await settle();
    expect(h.onAssistantDone).toHaveBeenCalledWith(spoken);
  });

  it('handles unparseable tool output', async () => {
    const h = handlers('oops');
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    await s.connect();
    s.sendText('cancel APT-1');
    await settle();
    expect(h.onAssistantDone).toHaveBeenCalledWith('Sorry, something went wrong.');
  });

  it('echoes unrecognised text with usage hints', async () => {
    const h = handlers();
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    await s.connect();
    s.sendText('   ');
    s.sendText('good morning');
    await settle();
    expect(h.onFunctionCall).not.toHaveBeenCalled();
    expect(h.onAssistantDone.mock.calls[0][0]).toContain('You said: "good morning"');
  });

  it('turns every 1.5 s of audio into a pseudo transcript', async () => {
    const h = handlers();
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    s.appendAudio(Buffer.alloc(10));
    await s.connect();
    s.appendAudio(Buffer.alloc(48000));
    expect(h.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(h.onUserTranscript).not.toHaveBeenCalled();
    s.appendAudio(Buffer.alloc(24000));
    expect(h.onUserTranscript).toHaveBeenCalledWith(expect.stringContaining('1.5 seconds'));
    await settle();
    expect(h.onAssistantDone).toHaveBeenCalled();
  });

  it('stops speaking on cancel and goes silent after close', async () => {
    const h = handlers();
    const s = new MockRealtimeSession(
      { instructions: '', tools: [], greeting, handlers: h },
      24000,
    );
    await s.connect();
    s.greet();
    s.cancelResponse();
    await settle();
    expect(h.onAssistantDone).not.toHaveBeenCalled();

    s.greet();
    await new Promise((r) => setImmediate(r));
    s.close();
    await settle();
    expect(h.onAssistantDone).not.toHaveBeenCalled();
    s.sendText('cancel APT-1');
    s.appendAudio(Buffer.alloc(100000));
    await settle();
    expect(h.onFunctionCall).not.toHaveBeenCalled();
  });
});
