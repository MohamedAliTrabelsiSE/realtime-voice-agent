import { Module } from '@nestjs/common';
import { ToolRegistry } from '../tools/tool-registry';
import { buildAppointmentTools } from './appointment.tools';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

@Module({
  controllers: [AppointmentsController],
  providers: [
    AppointmentsService,
    { provide: ToolRegistry, useFactory: buildAppointmentTools, inject: [AppointmentsService] },
  ],
  exports: [AppointmentsService, ToolRegistry],
})
export class AppointmentsModule {}
