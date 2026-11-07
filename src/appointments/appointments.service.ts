import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig, type BusinessConfig } from '../config/app-config';
import { CLOCK, type Clock } from '../config/clock';
import {
  addDays,
  clockToMinutes,
  humanLabel,
  isRealDate,
  LOCAL_DATETIME_RE,
  minutesToClock,
  toLocalDateTime,
  weekday,
} from './local-time';

export type AppointmentStatus = 'booked' | 'cancelled';

export interface Appointment {
  id: string;
  start: string;
  end: string;
  label: string;
  customerName: string;
  phone: string;
  reason?: string;
  status: AppointmentStatus;
  createdAt: string;
  cancelledAt?: string;
  sessionId?: string;
}

export interface Slot {
  start: string;
  end: string;
  label: string;
}

export type AppointmentErrorCode =
  | 'invalid_slot'
  | 'slot_in_past'
  | 'slot_unavailable'
  | 'not_found'
  | 'already_cancelled'
  | 'invalid_query';

export class AppointmentError extends Error {
  constructor(
    readonly code: AppointmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppointmentError';
  }
}

export interface BookingRequest {
  slotStart: string;
  customerName: string;
  phone: string;
  reason?: string;
  sessionId?: string;
}

/** In-memory booking engine for a single-practitioner business. */
@Injectable()
export class AppointmentsService {
  private readonly appointments = new Map<string, Appointment>();
  private readonly business: BusinessConfig;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.business = config.business;
  }

  nowLocal(): string {
    return toLocalDateTime(this.clock.now(), this.business.timezone);
  }

  listAvailableSlots(query: { date?: string; limit?: number } = {}): Slot[] {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    if (query.date !== undefined && !isRealDate(query.date)) {
      throw new AppointmentError('invalid_query', `"${query.date}" is not a valid YYYY-MM-DD date`);
    }
    const now = this.nowLocal();
    const taken = this.takenStarts();
    const days = query.date ? [query.date] : this.horizonDates();
    const result: Slot[] = [];

    for (const date of days) {
      if (!this.horizonDates().includes(date)) continue;
      for (const start of this.slotsOn(date)) {
        if (start <= now || taken.has(start)) continue;
        result.push(this.toSlot(start));
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  book(req: BookingRequest): Appointment {
    const start = req.slotStart.trim();
    if (!this.isBookableSlot(start)) {
      throw new AppointmentError(
        'invalid_slot',
        `${start} is not a valid slot. Use list_available_slots to get valid start times.`,
      );
    }
    if (start <= this.nowLocal()) {
      throw new AppointmentError('slot_in_past', `${start} is in the past`);
    }
    if (this.takenStarts().has(start)) {
      throw new AppointmentError('slot_unavailable', `${start} is already booked`);
    }

    const slot = this.toSlot(start);
    const appointment: Appointment = {
      id: this.newId(),
      ...slot,
      customerName: req.customerName.trim(),
      phone: normalizePhone(req.phone),
      reason: req.reason?.trim() || undefined,
      status: 'booked',
      createdAt: this.clock.now().toISOString(),
      sessionId: req.sessionId,
    };
    this.appointments.set(appointment.id, appointment);
    return { ...appointment };
  }

  find(query: { appointmentId?: string; phone?: string }): Appointment[] {
    if (query.appointmentId) {
      const a = this.appointments.get(query.appointmentId.trim().toUpperCase());
      return a ? [{ ...a }] : [];
    }
    if (query.phone) {
      const phone = normalizePhone(query.phone);
      return this.list().filter((a) => a.phone === phone);
    }
    throw new AppointmentError('invalid_query', 'Provide an appointmentId or a phone number');
  }

  cancel(appointmentId: string): Appointment {
    const a = this.appointments.get(appointmentId.trim().toUpperCase());
    if (!a) throw new AppointmentError('not_found', `No appointment with id ${appointmentId}`);
    if (a.status === 'cancelled') {
      throw new AppointmentError('already_cancelled', `${a.id} is already cancelled`);
    }
    a.status = 'cancelled';
    a.cancelledAt = this.clock.now().toISOString();
    return { ...a };
  }

  list(): Appointment[] {
    return [...this.appointments.values()]
      .map((a) => ({ ...a }))
      .sort((x, y) => x.start.localeCompare(y.start));
  }

  private isBookableSlot(start: string): boolean {
    if (!LOCAL_DATETIME_RE.test(start)) return false;
    const [date] = start.split('T');
    return this.horizonDates().includes(date) && this.slotsOn(date).includes(start);
  }

  private horizonDates(): string[] {
    const today = this.nowLocal().slice(0, 10);
    const dates: string[] = [];
    for (let i = 0; i < this.business.horizonDays; i++) {
      const d = addDays(today, i);
      const wd = weekday(d);
      if (wd !== 0 && wd !== 6) dates.push(d);
    }
    return dates;
  }

  private slotsOn(date: string): string[] {
    const { openingHour, closingHour, slotMinutes } = this.business;
    const out: string[] = [];
    for (let m = openingHour * 60; m + slotMinutes <= closingHour * 60; m += slotMinutes) {
      out.push(`${date}T${minutesToClock(m)}`);
    }
    return out;
  }

  private toSlot(start: string): Slot {
    const [date, time] = start.split('T');
    const end = `${date}T${minutesToClock(clockToMinutes(time) + this.business.slotMinutes)}`;
    return { start, end, label: humanLabel(start) };
  }

  private takenStarts(): Set<string> {
    const taken = new Set<string>();
    for (const a of this.appointments.values()) if (a.status === 'booked') taken.add(a.start);
    return taken;
  }

  private newId(): string {
    let id: string;
    do {
      id = `APT-${randomBytes(3).toString('hex').toUpperCase()}`;
    } while (this.appointments.has(id));
    return id;
  }
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s().-]/g, '');
}
