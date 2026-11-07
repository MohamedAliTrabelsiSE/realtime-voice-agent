import { z } from 'zod';
import { ToolRegistry, ToolUserError } from '../tools/tool-registry';
import { AppointmentError, type AppointmentsService } from './appointments.service';

const phone = z
  .string()
  .regex(/^\+?[\d\s().-]{6,20}$/, 'must be a phone number, digits only, optionally starting with +')
  .describe('Caller phone number, e.g. +33612345678');

const appointmentId = z
  .string()
  .regex(/^APT-[A-Za-z0-9]+$/, 'must look like APT-1A2B3C')
  .describe('Confirmation number, e.g. APT-1A2B3C');

export function buildAppointmentTools(appointments: AppointmentsService): ToolRegistry {
  const registry = new ToolRegistry((err) =>
    err instanceof AppointmentError ? new ToolUserError(err.code, err.message) : null,
  );

  return registry
    .register({
      name: 'list_available_slots',
      description:
        'List free appointment start times. Call before proposing times; never invent slots.',
      schema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Local date YYYY-MM-DD. Omit to get the next free slots.'),
        limit: z.number().int().min(1).max(20).optional().describe('Max slots, default 5'),
      }),
      execute: ({ date, limit }) => ({
        slots: appointments.listAvailableSlots({ date, limit: limit ?? 5 }),
      }),
    })
    .register({
      name: 'book_appointment',
      description:
        'Book a slot after the caller confirmed the time, their full name and phone number.',
      schema: z.object({
        slotStart: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
          .describe('Exact slot start returned by list_available_slots, YYYY-MM-DDTHH:mm'),
        customerName: z.string().trim().min(2).max(80).describe('Caller full name'),
        phone,
        reason: z.string().max(200).optional().describe('Short reason for the visit'),
      }),
      execute: (args, ctx) => ({
        appointment: appointments.book({ ...args, sessionId: ctx.sessionId }),
      }),
    })
    .register({
      name: 'find_appointment',
      description: 'Look up existing appointments by confirmation number or phone number.',
      schema: z
        .object({ appointmentId: appointmentId.optional(), phone: phone.optional() })
        .refine((v) => v.appointmentId || v.phone, {
          message: 'provide appointmentId or phone',
        }),
      execute: (args) => ({ appointments: appointments.find(args) }),
    })
    .register({
      name: 'cancel_appointment',
      description: 'Cancel an appointment. Confirm with the caller before calling this.',
      schema: z.object({ appointmentId }),
      execute: ({ appointmentId: id }) => ({ appointment: appointments.cancel(id) }),
    });
}
