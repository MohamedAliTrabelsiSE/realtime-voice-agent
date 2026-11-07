import { fixedClock } from '../config/clock';
import { MONDAY_8AM_PARIS, testConfig } from '../testing/test-config';
import { AppointmentError, AppointmentsService, normalizePhone } from './appointments.service';

describe('AppointmentsService', () => {
  const clock = fixedClock(MONDAY_8AM_PARIS);
  let service: AppointmentsService;

  const booking = (slotStart: string) => ({
    slotStart,
    customerName: ' Jane Doe ',
    phone: '+33 6 12-34-56-78',
    reason: 'Checkup',
  });

  const expectCode = (fn: () => unknown, code: string): void => {
    try {
      fn();
      throw new Error('expected an AppointmentError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppointmentError);
      expect((err as AppointmentError).code).toBe(code);
    }
  };

  beforeEach(() => {
    clock.set(MONDAY_8AM_PARIS);
    service = new AppointmentsService(
      testConfig({
        OPENING_HOUR: '9',
        CLOSING_HOUR: '12',
        SLOT_MINUTES: '60',
        BOOKING_HORIZON_DAYS: '7',
      }),
      clock,
    );
  });

  it('reports the current local time in the business timezone', () => {
    expect(service.nowLocal()).toBe('2026-01-05T08:00');
  });

  describe('listAvailableSlots', () => {
    it('lists slots in opening hours, starting today', () => {
      expect(service.listAvailableSlots({ limit: 4 })).toEqual([
        { start: '2026-01-05T09:00', end: '2026-01-05T10:00', label: 'Monday 5 January, 09:00' },
        { start: '2026-01-05T10:00', end: '2026-01-05T11:00', label: 'Monday 5 January, 10:00' },
        { start: '2026-01-05T11:00', end: '2026-01-05T12:00', label: 'Monday 5 January, 11:00' },
        { start: '2026-01-06T09:00', end: '2026-01-06T10:00', label: 'Tuesday 6 January, 09:00' },
      ]);
    });

    it('hides past slots', () => {
      clock.set('2026-01-05T09:30:00Z');
      expect(service.listAvailableSlots({ date: '2026-01-05' }).map((s) => s.start)).toEqual([
        '2026-01-05T11:00',
      ]);
    });

    it('skips weekends and dates outside the horizon', () => {
      expect(service.listAvailableSlots({ date: '2026-01-10' })).toEqual([]);
      expect(service.listAvailableSlots({ date: '2026-02-02' })).toEqual([]);
      const days = new Set(
        service.listAvailableSlots({ limit: 50 }).map((s) => s.start.slice(0, 10)),
      );
      expect([...days]).toEqual([
        '2026-01-05',
        '2026-01-06',
        '2026-01-07',
        '2026-01-08',
        '2026-01-09',
      ]);
    });

    it('rejects invalid dates', () => {
      expectCode(() => service.listAvailableSlots({ date: '2026-02-31' }), 'invalid_query');
    });

    it('clamps the limit', () => {
      expect(service.listAvailableSlots({ limit: 0 })).toHaveLength(1);
    });
  });

  describe('book', () => {
    it('books a free slot and removes it from availability', () => {
      const a = service.book({ ...booking('2026-01-05T10:00'), sessionId: 's1' });
      expect(a).toMatchObject({
        start: '2026-01-05T10:00',
        end: '2026-01-05T11:00',
        customerName: 'Jane Doe',
        phone: '+33612345678',
        reason: 'Checkup',
        status: 'booked',
        sessionId: 's1',
      });
      expect(a.id).toMatch(/^APT-[0-9A-F]{6}$/);
      expect(service.listAvailableSlots({ date: '2026-01-05' }).map((s) => s.start)).not.toContain(
        '2026-01-05T10:00',
      );
    });

    it('prevents double booking', () => {
      service.book(booking('2026-01-05T10:00'));
      expectCode(() => service.book(booking('2026-01-05T10:00')), 'slot_unavailable');
    });

    it.each([
      '2026-01-05T10:15',
      '2026-01-05T12:00',
      '2026-01-10T10:00',
      'tomorrow',
      '2026-03-02T10:00',
    ])('rejects non-bookable slot %p', (slot) =>
      expectCode(() => service.book(booking(slot)), 'invalid_slot'),
    );

    it('rejects slots that already started today', () => {
      clock.set('2026-01-05T09:30:00Z');
      expectCode(() => service.book(booking('2026-01-05T09:00')), 'slot_in_past');
    });

    it('frees the slot again after cancellation', () => {
      const a = service.book(booking('2026-01-05T10:00'));
      service.cancel(a.id);
      expect(service.book(booking('2026-01-05T10:00')).id).not.toBe(a.id);
    });

    it('returns copies so callers cannot mutate state', () => {
      const a = service.book(booking('2026-01-05T10:00'));
      a.status = 'cancelled';
      expect(service.list()[0].status).toBe('booked');
    });
  });

  describe('find / cancel / list', () => {
    it('finds by id (case-insensitive) or by phone', () => {
      const a = service.book(booking('2026-01-06T09:00'));
      service.book({ ...booking('2026-01-05T09:00'), phone: '+15550000000' });
      expect(service.find({ appointmentId: a.id.toLowerCase() })[0].id).toBe(a.id);
      expect(service.find({ appointmentId: 'APT-NOPE' })).toEqual([]);
      expect(service.find({ phone: '+33 612 345 678' }).map((x) => x.id)).toEqual([a.id]);
      expectCode(() => service.find({}), 'invalid_query');
    });

    it('cancels once', () => {
      const a = service.book(booking('2026-01-05T09:00'));
      clock.set('2026-01-05T07:10:00Z');
      expect(service.cancel(a.id)).toMatchObject({
        status: 'cancelled',
        cancelledAt: '2026-01-05T07:10:00.000Z',
      });
      expectCode(() => service.cancel(a.id), 'already_cancelled');
      expectCode(() => service.cancel('APT-404'), 'not_found');
    });

    it('lists appointments sorted by start', () => {
      service.book(booking('2026-01-06T09:00'));
      service.book(booking('2026-01-05T11:00'));
      expect(service.list().map((a) => a.start)).toEqual(['2026-01-05T11:00', '2026-01-06T09:00']);
    });
  });

  it('normalizes phone numbers', () => {
    expect(normalizePhone('(555) 123-45.67')).toBe('5551234567');
  });
});
