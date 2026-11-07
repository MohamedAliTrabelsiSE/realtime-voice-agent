import { testConfig } from '../testing/test-config';
import { MockRealtimeSession } from './mock-realtime.session';
import { OpenAIRealtimeSession } from './openai-realtime.session';
import { RealtimeSessionFactory } from './realtime-session.factory';
import type { RealtimeSessionOptions } from './realtime.types';

describe('RealtimeSessionFactory', () => {
  const opts = {
    instructions: '',
    tools: [],
    greeting: '',
    handlers: {},
  } as unknown as RealtimeSessionOptions;

  it('creates mock sessions in mock mode', () => {
    const f = new RealtimeSessionFactory(testConfig({ MOCK_REALTIME: 'true' }));
    expect(f.mode).toBe('mock');
    expect(f.create(opts)).toBeInstanceOf(MockRealtimeSession);
  });

  it('creates OpenAI sessions when a key is configured', () => {
    const f = new RealtimeSessionFactory(
      testConfig({ MOCK_REALTIME: 'false', OPENAI_API_KEY: 'sk-x' }),
    );
    expect(f.mode).toBe('openai');
    expect(f.create(opts)).toBeInstanceOf(OpenAIRealtimeSession);
  });
});
