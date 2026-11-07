import { EventEmitter } from 'node:events';
import type { RealtimeSocket } from '../realtime/openai-realtime.session';

type Listener = (...args: unknown[]) => void;

/** In-process stand-in for the OpenAI Realtime WebSocket. */
export class FakeRealtimeSocket implements RealtimeSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly events = new EventEmitter();

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: never[]) => void): this {
    this.events.on(event, listener as unknown as Listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.events.emit(event, ...args);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }

  /** Simulates a server event arriving from OpenAI. */
  server(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  sentTypes(): string[] {
    return this.sent.map((e) => String(e.type));
  }

  /** Completes the session.created → session.update → session.updated handshake. */
  handshake(): void {
    this.server({ type: 'session.created' });
    this.server({ type: 'session.updated' });
  }
}
