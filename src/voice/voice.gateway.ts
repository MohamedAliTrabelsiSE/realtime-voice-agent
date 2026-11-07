import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';
import { AppointmentsService } from '../appointments/appointments.service';
import { VoiceTokenService } from '../auth/voice-token.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RealtimeSessionFactory } from '../realtime/realtime-session.factory';
import { SessionStore } from '../sessions/session.store';
import { ToolRegistry } from '../tools/tool-registry';
import { VoiceConversation } from './voice-conversation';
import type { SendFn } from './voice.protocol';

/**
 * WebSocket endpoint at /voice/stream. Frames are JSON `{ "event": string, "data": object }`.
 * Client events: start, audio, text, interrupt, stop, ping.
 */
@WebSocketGateway({ path: '/voice/stream' })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(VoiceGateway.name);
  private readonly conversations = new Map<WebSocket, VoiceConversation>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionStore,
    private readonly tokens: VoiceTokenService,
    private readonly tools: ToolRegistry,
    private readonly appointments: AppointmentsService,
    private readonly realtime: RealtimeSessionFactory,
  ) {}

  get activeConnections(): number {
    return this.conversations.size;
  }

  handleConnection(client: WebSocket): void {
    const send: SendFn = (event, data) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ event, data }));
    };
    this.conversations.set(
      client,
      new VoiceConversation(
        {
          config: this.config,
          sessions: this.sessions,
          tokens: this.tokens,
          tools: this.tools,
          appointments: this.appointments,
          realtime: this.realtime,
        },
        send,
      ),
    );
  }

  handleDisconnect(client: WebSocket): void {
    this.conversations.get(client)?.dispose();
    this.conversations.delete(client);
  }

  @SubscribeMessage('start')
  async onStart(@ConnectedSocket() client: WebSocket, @MessageBody() data: unknown): Promise<void> {
    await this.conversation(client)?.start(data);
  }

  @SubscribeMessage('audio')
  onAudio(@ConnectedSocket() client: WebSocket, @MessageBody() data: unknown): void {
    this.conversation(client)?.audio(data);
  }

  @SubscribeMessage('text')
  onText(@ConnectedSocket() client: WebSocket, @MessageBody() data: unknown): void {
    this.conversation(client)?.text(data);
  }

  @SubscribeMessage('interrupt')
  onInterrupt(@ConnectedSocket() client: WebSocket): void {
    this.conversation(client)?.interrupt();
  }

  @SubscribeMessage('stop')
  onStop(@ConnectedSocket() client: WebSocket): void {
    this.conversation(client)?.stop();
  }

  @SubscribeMessage('ping')
  onPing(): { event: 'pong'; data: { at: string } } {
    return { event: 'pong', data: { at: new Date().toISOString() } };
  }

  private conversation(client: WebSocket): VoiceConversation | undefined {
    const c = this.conversations.get(client);
    if (!c) this.logger.warn('Message from unknown socket');
    return c;
  }
}
