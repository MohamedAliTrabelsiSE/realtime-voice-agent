import { fixedClock } from '../config/clock';
import { SessionStore } from './session.store';

describe('SessionStore', () => {
  const clock = fixedClock('2026-01-05T10:00:00Z');
  let store: SessionStore;

  beforeEach(() => {
    clock.set('2026-01-05T10:00:00Z');
    store = new SessionStore(clock);
  });

  it('creates sessions and lists newest first', () => {
    const a = store.create('Ann');
    const b = store.create();
    expect(a.status).toBe('created');
    expect(a.callerName).toBe('Ann');
    expect(store.get(a.id)).toBe(a);
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('records transcript, ignores blank lines and summarises bookings', () => {
    const s = store.create();
    store.markActive(s.id);
    store.appendTranscript(s.id, 'user', '  hi  ');
    store.appendTranscript(s.id, 'user', '   ');
    store.appendTranscript(s.id, 'assistant', 'hello');
    store.recordToolCall(s.id, {
      name: 'book_appointment',
      args: {},
      ok: true,
      result: { ok: true, appointment: { id: 'APT-1' } },
    });
    store.recordToolCall(s.id, { name: 'book_appointment', args: {}, ok: false, result: {} });
    store.recordToolCall(s.id, { name: 'list_available_slots', args: {}, ok: true, result: null });

    clock.set('2026-01-05T10:02:00Z');
    const summary = store.end(s.id);

    expect(s.transcript).toEqual([
      { role: 'user', text: 'hi', at: '2026-01-05T10:00:00.000Z' },
      { role: 'assistant', text: 'hello', at: '2026-01-05T10:00:00.000Z' },
    ]);
    expect(summary).toEqual({
      sessionId: s.id,
      durationMs: 120_000,
      userTurns: 1,
      assistantTurns: 1,
      toolCalls: 3,
      bookedAppointmentIds: ['APT-1'],
    });
  });

  it('end is idempotent and keeps the first end time', () => {
    const s = store.create();
    store.end(s.id);
    clock.set('2026-01-05T11:00:00Z');
    store.end(s.id);
    expect(s.endedAt).toBe('2026-01-05T10:00:00.000Z');
  });

  it('measures live duration for sessions still running', () => {
    const s = store.create();
    store.markActive(s.id);
    clock.set('2026-01-05T10:00:05Z');
    expect(store.summarize(s).durationMs).toBe(5000);
  });

  it('throws on unknown sessions', () => {
    expect(() => store.markActive('nope')).toThrow('Unknown session nope');
  });

  it('evicts the oldest sessions past the cap', () => {
    const first = store.create();
    for (let i = 0; i < 500; i++) store.create();
    expect(store.get(first.id)).toBeUndefined();
    expect(store.list()).toHaveLength(500);
  });
});
