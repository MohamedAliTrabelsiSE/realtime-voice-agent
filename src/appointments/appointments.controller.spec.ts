import { BadRequestException } from '@nestjs/common';
import { fixedClock } from '../config/clock';
import { HealthController } from '../health.controller';
import { MONDAY_8AM_PARIS, testConfig } from '../testing/test-config';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

describe('AppointmentsController', () => {
  const service = new AppointmentsService(testConfig(), fixedClock(MONDAY_8AM_PARIS));
  const controller = new AppointmentsController(service);

  it('returns slots and appointments', () => {
    expect(controller.slots(undefined, '2')).toHaveLength(2);
    expect(controller.slots('2026-01-06')[0].start).toBe('2026-01-06T09:00');
    service.book({ slotStart: '2026-01-05T09:00', customerName: 'Ann', phone: '+15550100' });
    expect(controller.list()).toHaveLength(1);
  });

  it('maps domain errors to 400 and rethrows others', () => {
    expect(() => controller.slots('2026-13-01')).toThrow(BadRequestException);
    const broken = new AppointmentsController({
      listAvailableSlots: () => {
        throw new Error('boom');
      },
    } as unknown as AppointmentsService);
    expect(() => broken.slots()).toThrow('boom');
  });
});

describe('HealthController', () => {
  it('reports the realtime mode', () => {
    expect(new HealthController(testConfig()).health()).toEqual({
      status: 'ok',
      realtimeMode: 'mock',
      model: 'gpt-realtime',
      business: 'Test Clinic',
    });
  });
});
