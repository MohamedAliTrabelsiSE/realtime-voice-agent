import { fixedClock } from '../config/clock';
import { testConfig } from '../testing/test-config';
import { VoiceTokenService } from './voice-token.service';

describe('VoiceTokenService', () => {
  const clock = fixedClock('2026-01-05T10:00:00Z');
  const config = testConfig({ VOICE_TOKEN_TTL_SECONDS: '60' });
  const service = new VoiceTokenService(config, clock);

  beforeEach(() => clock.set('2026-01-05T10:00:00Z'));

  it('signs a token that verifies for the same session', () => {
    const { token, expiresAt } = service.sign('session-1');
    expect(expiresAt.toISOString()).toBe('2026-01-05T10:01:00.000Z');
    expect(service.verify(token, 'session-1')).toEqual({
      valid: true,
      claims: { sid: 'session-1', exp: expiresAt.getTime() / 1000 },
    });
  });

  it('rejects a token for another session', () => {
    const { token } = service.sign('session-1');
    expect(service.verify(token, 'session-2')).toEqual({
      valid: false,
      reason: 'session_mismatch',
    });
  });

  it('rejects expired tokens', () => {
    const { token } = service.sign('session-1');
    clock.set('2026-01-05T10:01:00Z');
    expect(service.verify(token)).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects tampered payloads and signatures', () => {
    const { token } = service.sign('session-1');
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'admin', exp: 9e9 })).toString('base64url');
    expect(service.verify(`${forged}.${sig}`)).toEqual({ valid: false, reason: 'bad_signature' });
    expect(service.verify(`${token}x`)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects tokens signed with another secret', () => {
    const other = new VoiceTokenService(
      testConfig({ VOICE_TOKEN_SECRET: 'another-secret-value-123' }),
      clock,
    );
    expect(service.verify(other.sign('session-1').token)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it.each(['', 'abc', 'a.b.c', '.sig'])('rejects malformed token %p', (token) => {
    expect(service.verify(token)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects correctly signed bodies with the wrong shape', () => {
    const signBody = (body: string): string =>
      (service as unknown as { signature(b: string): string }).signature(body);
    const body = Buffer.from(JSON.stringify({ sid: 1 })).toString('base64url');
    expect(service.verify(`${body}.${signBody(body)}`)).toEqual({
      valid: false,
      reason: 'malformed',
    });
    const notJson = Buffer.from('nope').toString('base64url');
    expect(service.verify(`${notJson}.${signBody(notJson)}`)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
