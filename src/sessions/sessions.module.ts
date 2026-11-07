import { Module } from '@nestjs/common';
import { VoiceTokenService } from '../auth/voice-token.service';
import { SessionsController } from './sessions.controller';
import { SessionStore } from './session.store';

@Module({
  controllers: [SessionsController],
  providers: [SessionStore, VoiceTokenService],
  exports: [SessionStore, VoiceTokenService],
})
export class SessionsModule {}
