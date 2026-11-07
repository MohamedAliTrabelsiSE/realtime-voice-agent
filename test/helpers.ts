import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config';
import { CLOCK, fixedClock } from '../src/config/clock';
import { MONDAY_8AM_PARIS } from '../src/testing/test-config';

export interface Frame {
  event: string;
  data: Record<string, unknown>;
}

export async function startApp(
  config: AppConfig,
  customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<{ app: INestApplication; baseUrl: string; wsUrl: string }> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(CLOCK)
    .useValue(fixedClock(MONDAY_8AM_PARIS));
  const moduleRef = await customize(builder).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/voice/stream`,
  };
}

/** Thin WebSocket client that buffers frames and lets tests await specific events. */
export class VoiceClient {
  readonly frames: Frame[] = [];
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(frame)) return true;
        w.resolve(frame);
        return false;
      });
    });
  }

  static connect(url: string): Promise<VoiceClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new VoiceClient(ws)));
      ws.once('error', reject);
    });
  }

  send(event: string, data: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ event, data }));
  }

  waitFor(
    event: string,
    match: (data: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Frame> {
    const pred = (f: Frame): boolean => f.event === event && match(f.data);
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for "${event}". Got: ${this.frames.map((f) => f.event).join(', ')}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        match: pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
