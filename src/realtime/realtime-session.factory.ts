import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { MockRealtimeSession } from './mock-realtime.session';
import {
  defaultSocketFactory,
  OpenAIRealtimeSession,
  type RealtimeSocketFactory,
} from './openai-realtime.session';
import type { RealtimeSession, RealtimeSessionOptions } from './realtime.types';

export const REALTIME_SOCKET_FACTORY = Symbol('REALTIME_SOCKET_FACTORY');

@Injectable()
export class RealtimeSessionFactory {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REALTIME_SOCKET_FACTORY)
    private readonly socketFactory: RealtimeSocketFactory = defaultSocketFactory,
  ) {}

  get mode(): 'mock' | 'openai' {
    return this.config.realtime.mock ? 'mock' : 'openai';
  }

  create(opts: RealtimeSessionOptions): RealtimeSession {
    const rt = this.config.realtime;
    return rt.mock
      ? new MockRealtimeSession(opts, rt.pcmRate)
      : new OpenAIRealtimeSession(rt, opts, this.socketFactory);
  }
}
