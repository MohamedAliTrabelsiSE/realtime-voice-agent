import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { VoiceTokenService } from '../auth/voice-token.service';
import { fixedClock } from '../config/clock';
import { testConfig } from '../testing/test-config';
import { SessionsController } from './sessions.controller';
import { SessionStore } from './session.store';

function req(headers: Record<string, string>, protocol = 'http'): Request {
  return { protocol, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe('SessionsController', () => {
  const clock = fixedClock('2026-01-05T10:00:00Z');

  function controller(env: Record<string, string> = {}): {
    c: SessionsController;
    tokens: VoiceTokenService;
  } {
    const config = testConfig(env);
    const tokens = new VoiceTokenService(config, clock);
    return { c: new SessionsController(new SessionStore(clock), tokens, config), tokens };
  }

  it('creates a session with a valid token and derived ws url', () => {
    const { c, tokens } = controller();
    const res = c.create({ callerName: '  Ann ' }, req({ host: 'localhost:3000' }));
    expect(res.wsUrl).toBe('ws://localhost:3000/voice/stream');
    expect(res.realtimeMode).toBe('mock');
    expect(tokens.verify(res.voiceToken, res.sessionId).valid).toBe(true);
    expect(c.get(res.sessionId).callerName).toBe('Ann');
  });

  it('uses wss behind a TLS proxy, or the configured public url', () => {
    const { c } = controller();
    const viaProxy = c.create(
      {},
      req({ host: 'voice.example.com', 'x-forwarded-proto': 'https, http' }),
    );
    expect(viaProxy.wsUrl).toBe('wss://voice.example.com/voice/stream');
    expect(c.create({}, req({}, 'https')).wsUrl).toBe('wss://localhost/voice/stream');

    const fixed = controller({ PUBLIC_WS_URL: 'wss://calls.example.com/voice/stream' }).c;
    expect(fixed.create({}, req({ host: 'internal:3000' })).wsUrl).toBe(
      'wss://calls.example.com/voice/stream',
    );
  });

  it('lists summaries and 404s on unknown ids', () => {
    const { c } = controller();
    const { sessionId } = c.create({ callerName: '' }, req({ host: 'h' }));
    expect(c.get(sessionId).callerName).toBeUndefined();
    expect(c.list()).toEqual([expect.objectContaining({ sessionId, userTurns: 0 })]);
    expect(c.get(sessionId).summary.sessionId).toBe(sessionId);
    expect(() => c.get('missing')).toThrow(NotFoundException);
  });
});
