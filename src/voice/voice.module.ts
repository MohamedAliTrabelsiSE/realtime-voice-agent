import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { defaultSocketFactory } from '../realtime/openai-realtime.session';
import {
  REALTIME_SOCKET_FACTORY,
  RealtimeSessionFactory,
} from '../realtime/realtime-session.factory';
import { SessionsModule } from '../sessions/sessions.module';
import { VoiceGateway } from './voice.gateway';

@Module({
  imports: [AppointmentsModule, SessionsModule],
  providers: [
    VoiceGateway,
    RealtimeSessionFactory,
    { provide: REALTIME_SOCKET_FACTORY, useValue: defaultSocketFactory },
  ],
})
export class VoiceModule {}
