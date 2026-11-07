import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { APP_CONFIG, type AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional
  }

  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);

  const logger = new Logger('Bootstrap');
  const base = `http://localhost:${config.port}`;
  logger.log(`Test lab:   ${base}/`);
  logger.log(`API docs:   ${base}/docs`);
  logger.log(`Voice WS:   ws://localhost:${config.port}/voice/stream`);
  logger.log(
    `Realtime:   ${config.realtime.mock ? 'MOCK (no OpenAI calls)' : `OpenAI ${config.realtime.model}`}`,
  );
}

void bootstrap();
