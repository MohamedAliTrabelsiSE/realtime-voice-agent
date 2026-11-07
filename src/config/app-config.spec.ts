import { loadConfig } from './app-config';

describe('loadConfig', () => {
  it('applies defaults and falls back to mock mode without an API key', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3000);
    expect(cfg.realtime.mock).toBe(true);
    expect(cfg.realtime.pcmRate).toBe(24000);
    expect(cfg.voiceToken.secret.length).toBeGreaterThanOrEqual(16);
    expect(cfg.business.openingHour).toBe(9);
  });

  it('uses OpenAI when a key is present, unless MOCK_REALTIME=true', () => {
    expect(loadConfig({ OPENAI_API_KEY: 'sk-test' }).realtime.mock).toBe(false);
    expect(loadConfig({ OPENAI_API_KEY: 'sk-test', MOCK_REALTIME: 'true' }).realtime.mock).toBe(
      true,
    );
  });

  it('coerces numbers and treats empty strings as unset', () => {
    const cfg = loadConfig({ PORT: '8080', VAD_THRESHOLD: '0.7', PUBLIC_WS_URL: '' });
    expect(cfg.port).toBe(8080);
    expect(cfg.realtime.vadThreshold).toBe(0.7);
    expect(cfg.publicWsUrl).toBeUndefined();
  });

  it.each([
    [{ MOCK_REALTIME: 'false' }, 'OPENAI_API_KEY is required'],
    [{ NODE_ENV: 'production' }, 'VOICE_TOKEN_SECRET is required'],
    [{ OPENING_HOUR: '18', CLOSING_HOUR: '9' }, 'CLOSING_HOUR must be greater'],
    [{ VAD_THRESHOLD: '3' }, 'VAD_THRESHOLD'],
    [{ NOISE_REDUCTION: 'loud' }, 'NOISE_REDUCTION'],
  ])('rejects invalid env %p', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
