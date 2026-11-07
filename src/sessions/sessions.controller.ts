import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VoiceTokenService } from '../auth/voice-token.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { CreateSessionDto, CreateSessionResponseDto } from './create-session.dto';
import { SessionStore, type CallSession, type SessionSummary } from './session.store';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionStore,
    private readonly tokens: VoiceTokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @ApiCreatedResponse({ type: CreateSessionResponseDto })
  create(@Body() body: CreateSessionDto, @Req() req: Request): CreateSessionResponseDto {
    const session = this.sessions.create(body.callerName?.trim() || undefined);
    const { token, expiresAt } = this.tokens.sign(session.id);
    return {
      sessionId: session.id,
      wsUrl: this.config.publicWsUrl ?? deriveWsUrl(req),
      voiceToken: token,
      expiresAt: expiresAt.toISOString(),
      realtimeMode: this.config.realtime.mock ? 'mock' : 'openai',
    };
  }

  @Get()
  list(): SessionSummary[] {
    return this.sessions.list().map((s) => this.sessions.summarize(s));
  }

  @Get(':id')
  get(@Param('id') id: string): CallSession & { summary: SessionSummary } {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    return { ...session, summary: this.sessions.summarize(session) };
  }
}

function deriveWsUrl(req: Request): string {
  const forwarded = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = (forwarded ?? req.protocol) === 'https';
  return `${secure ? 'wss' : 'ws'}://${req.header('host') ?? 'localhost'}/voice/stream`;
}
