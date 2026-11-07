import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'node:path';

export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('Realtime Voice Agent')
    .setDescription(
      'HTTP API for the real-time voice receptionist. The audio conversation itself runs over the WebSocket at /voice/stream (see README for the protocol).',
    )
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  return app;
}
