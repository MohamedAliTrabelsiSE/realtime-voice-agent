import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { CLOCK, type Clock } from '../config/clock';

export interface VoiceTokenClaims {
  sid: string;
  exp: number;
}

export type VoiceTokenResult =
  | { valid: true; claims: VoiceTokenClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'session_mismatch' };

/**
 * Short-lived HMAC token that binds a WebSocket connection to one session.
 * Format: base64url(json claims) + "." + base64url(hmac-sha256).
 */
@Injectable()
export class VoiceTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  sign(sessionId: string): { token: string; expiresAt: Date } {
    const expMs = this.clock.now().getTime() + this.config.voiceToken.ttlSeconds * 1000;
    const claims: VoiceTokenClaims = { sid: sessionId, exp: Math.floor(expMs / 1000) };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { token: `${body}.${this.signature(body)}`, expiresAt: new Date(claims.exp * 1000) };
  }

  verify(token: string, expectedSessionId?: string): VoiceTokenResult {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' };
    const [body, sig] = parts;

    const expected = Buffer.from(this.signature(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { valid: false, reason: 'bad_signature' };
    }

    let claims: VoiceTokenClaims;
    try {
      const raw: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!isClaims(raw)) return { valid: false, reason: 'malformed' };
      claims = raw;
    } catch {
      return { valid: false, reason: 'malformed' };
    }

    if (claims.exp * 1000 <= this.clock.now().getTime()) return { valid: false, reason: 'expired' };
    if (expectedSessionId && claims.sid !== expectedSessionId) {
      return { valid: false, reason: 'session_mismatch' };
    }
    return { valid: true, claims };
  }

  private signature(body: string): string {
    return createHmac('sha256', this.config.voiceToken.secret).update(body).digest('base64url');
  }
}

function isClaims(v: unknown): v is VoiceTokenClaims {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.sid === 'string' && typeof o.exp === 'number';
}
