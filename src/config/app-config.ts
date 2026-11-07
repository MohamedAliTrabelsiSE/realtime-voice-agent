import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_WS_URL: z.string().url().optional(),

    OPENAI_API_KEY: z.string().trim().optional(),
    MOCK_REALTIME: bool.optional(),
    REALTIME_MODEL: z.string().default('gpt-realtime'),
    REALTIME_VOICE: z.string().default('marin'),
    REALTIME_TRANSCRIPT_MODEL: z.string().default('gpt-4o-mini-transcribe'),
    REALTIME_URL: z.string().url().default('wss://api.openai.com/v1/realtime'),
    PCM_RATE: z.coerce.number().int().positive().default(24000),
    NOISE_REDUCTION: z.enum(['near_field', 'far_field', 'none']).default('near_field'),
    VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    VAD_PREFIX_PADDING_MS: z.coerce.number().int().nonnegative().default(300),
    VAD_SILENCE_MS: z.coerce.number().int().positive().default(500),

    VOICE_TOKEN_SECRET: z.string().min(16).optional(),
    VOICE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),

    BUSINESS_NAME: z.string().default('Bright Smile Dental Clinic'),
    BUSINESS_TIMEZONE: z.string().default('Europe/Paris'),
    OPENING_HOUR: z.coerce.number().int().min(0).max(23).default(9),
    CLOSING_HOUR: z.coerce.number().int().min(1).max(24).default(17),
    SLOT_MINUTES: z.coerce.number().int().positive().default(30),
    BOOKING_HORIZON_DAYS: z.coerce.number().int().positive().default(14),

    NODE_ENV: z.string().default('development'),
  })
  .superRefine((env, ctx) => {
    if (env.MOCK_REALTIME === false && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when MOCK_REALTIME=false',
      });
    }
    if (env.NODE_ENV === 'production' && !env.VOICE_TOKEN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['VOICE_TOKEN_SECRET'],
        message: 'VOICE_TOKEN_SECRET is required in production',
      });
    }
    if (env.CLOSING_HOUR <= env.OPENING_HOUR) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOSING_HOUR'],
        message: 'CLOSING_HOUR must be greater than OPENING_HOUR',
      });
    }
  });

export interface RealtimeConfig {
  mock: boolean;
  apiKey: string;
  url: string;
  model: string;
  voice: string;
  transcriptModel: string;
  pcmRate: number;
  noiseReduction: 'near_field' | 'far_field' | 'none';
  vadThreshold: number;
  vadPrefixPaddingMs: number;
  vadSilenceMs: number;
}

export interface BusinessConfig {
  name: string;
  timezone: string;
  openingHour: number;
  closingHour: number;
  slotMinutes: number;
  horizonDays: number;
}

export interface AppConfig {
  port: number;
  publicWsUrl?: string;
  realtime: RealtimeConfig;
  voiceToken: { secret: string; ttlSeconds: number };
  business: BusinessConfig;
}

const DEV_TOKEN_SECRET = 'dev-only-voice-token-secret-change-me';

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const e = parsed.data;
  const apiKey = e.OPENAI_API_KEY ?? '';

  return {
    port: e.PORT,
    publicWsUrl: e.PUBLIC_WS_URL,
    realtime: {
      mock: e.MOCK_REALTIME ?? apiKey.length === 0,
      apiKey,
      url: e.REALTIME_URL,
      model: e.REALTIME_MODEL,
      voice: e.REALTIME_VOICE,
      transcriptModel: e.REALTIME_TRANSCRIPT_MODEL,
      pcmRate: e.PCM_RATE,
      noiseReduction: e.NOISE_REDUCTION,
      vadThreshold: e.VAD_THRESHOLD,
      vadPrefixPaddingMs: e.VAD_PREFIX_PADDING_MS,
      vadSilenceMs: e.VAD_SILENCE_MS,
    },
    voiceToken: {
      secret: e.VOICE_TOKEN_SECRET ?? DEV_TOKEN_SECRET,
      ttlSeconds: e.VOICE_TOKEN_TTL_SECONDS,
    },
    business: {
      name: e.BUSINESS_NAME,
      timezone: e.BUSINESS_TIMEZONE,
      openingHour: e.OPENING_HOUR,
      closingHour: e.CLOSING_HOUR,
      slotMinutes: e.SLOT_MINUTES,
      horizonDays: e.BOOKING_HORIZON_DAYS,
    },
  };
}
