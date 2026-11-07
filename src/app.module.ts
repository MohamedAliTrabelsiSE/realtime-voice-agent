import { Module } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { SessionsModule } from './sessions/sessions.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [ConfigModule, AppointmentsModule, SessionsModule, VoiceModule],
  controllers: [HealthController],
})
export class AppModule {}
