import { fixedClock } from '../config/clock';
import { MONDAY_8AM_PARIS, testConfig } from '../testing/test-config';
import { buildAppointmentTools } from './appointment.tools';
import { AppointmentsService } from './appointments.service';

describe('appointment tools', () => {
  const ctx = { sessionId: 'session-42' };
  let service: AppointmentsService;
  let tools: ReturnType<typeof buildAppointmentTools>;

  beforeEach(() => {
    service = new AppointmentsService(testConfig(), fixedClock(MONDAY_8AM_PARIS));
    tools = buildAppointmentTools(service);
  });

  it('exposes the four booking tools to the model', () => {
    expect(tools.names()).toEqual([
      'list_available_slots',
      'book_appointment',
      'find_appointment',
      'cancel_appointment',
    ]);
    const book = tools.specs().find((s) => s.name === 'book_appointment');
    expect(book?.parameters).toMatchObject({
      required: ['slotStart', 'customerName', 'phone'],
    });
  });

  it('lists 5 slots by default', async () => {
    const out = await tools.execute('list_available_slots', '{}', ctx);
    expect(out.ok).toBe(true);
    expect((out.result.slots as unknown[]).length).toBe(5);
  });

  it('runs a full book, find, cancel flow', async () => {
    const booked = await tools.execute(
      'book_appointment',
      JSON.stringify({
        slotStart: '2026-01-05T09:30',
        customerName: 'Sam Lee',
        phone: '+1 555 0100',
      }),
      ctx,
    );
    expect(booked.ok).toBe(true);
    const id = (booked.result.appointment as { id: string; sessionId: string }).id;
    expect(service.list()[0].sessionId).toBe('session-42');

    const found = await tools.execute(
      'find_appointment',
      JSON.stringify({ phone: '+15550100' }),
      ctx,
    );
    expect((found.result.appointments as Array<{ id: string }>).map((a) => a.id)).toEqual([id]);

    const cancelled = await tools.execute(
      'cancel_appointment',
      JSON.stringify({ appointmentId: id }),
      ctx,
    );
    expect(cancelled.result).toMatchObject({ ok: true, appointment: { status: 'cancelled' } });
  });

  it('turns domain errors into model-readable failures', async () => {
    const args = JSON.stringify({
      slotStart: '2026-01-05T09:00',
      customerName: 'Sam',
      phone: '+15550100',
    });
    await tools.execute('book_appointment', args, ctx);
    const again = await tools.execute('book_appointment', args, ctx);
    expect(again).toMatchObject({ ok: false, result: { code: 'slot_unavailable' } });
  });

  it('validates arguments before touching the service', async () => {
    const bad = await tools.execute(
      'book_appointment',
      JSON.stringify({ slotStart: 'next monday', customerName: 'S', phone: 'call me' }),
      ctx,
    );
    expect(bad.ok).toBe(false);
    expect(bad.result.error).toMatch(/slotStart.*customerName.*phone/);
    expect(service.list()).toEqual([]);

    const empty = await tools.execute('find_appointment', '{}', ctx);
    expect(empty.result.error).toContain('provide appointmentId or phone');

    const badId = await tools.execute('cancel_appointment', '{"appointmentId":"123"}', ctx);
    expect(badId.result.code).toBe('invalid_arguments');
  });
});
