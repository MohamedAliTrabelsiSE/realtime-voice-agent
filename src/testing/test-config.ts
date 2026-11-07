import { loadConfig, type AppConfig } from '../config/app-config';

/** Monday 5 January 2026, 08:00 in Europe/Paris. */
export const MONDAY_8AM_PARIS = '2026-01-05T07:00:00.000Z';

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    MOCK_REALTIME: 'true',
    VOICE_TOKEN_SECRET: 'test-secret-at-least-16-chars',
    BUSINESS_NAME: 'Test Clinic',
    BUSINESS_TIMEZONE: 'Europe/Paris',
    ...env,
  });
}
