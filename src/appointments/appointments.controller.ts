import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  AppointmentError,
  AppointmentsService,
  type Appointment,
  type Slot,
} from './appointments.service';

@ApiTags('appointments')
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  list(): Appointment[] {
    return this.appointments.list();
  }

  @Get('slots')
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD in the business timezone' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  slots(@Query('date') date?: string, @Query('limit') limit?: string): Slot[] {
    try {
      return this.appointments.listAvailableSlots({
        date: date || undefined,
        limit: limit ? Number(limit) : undefined,
      });
    } catch (err) {
      if (err instanceof AppointmentError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
