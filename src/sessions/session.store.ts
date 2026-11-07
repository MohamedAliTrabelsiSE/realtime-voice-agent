import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, type Clock } from '../config/clock';

export type SessionStatus = 'created' | 'active' | 'ended';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  at: string;
}

export interface CallSession {
  id: string;
  status: SessionStatus;
  callerName?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
}

export interface SessionSummary {
  sessionId: string;
  durationMs: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  bookedAppointmentIds: string[];
}

const MAX_SESSIONS = 500;

/** In-memory session store. Swap for Redis/Postgres behind the same API in production. */
@Injectable()
export class SessionStore {
  private readonly sessions = new Map<string, CallSession>();

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  create(callerName?: string): CallSession {
    const session: CallSession = {
      id: randomUUID(),
      status: 'created',
      callerName,
      createdAt: this.nowIso(),
      transcript: [],
      toolCalls: [],
    };
    this.sessions.set(session.id, session);
    this.evictOldest();
    return session;
  }

  get(id: string): CallSession | undefined {
    return this.sessions.get(id);
  }

  list(): CallSession[] {
    return [...this.sessions.values()].reverse();
  }

  markActive(id: string): CallSession {
    const s = this.require(id);
    s.status = 'active';
    s.startedAt ??= this.nowIso();
    return s;
  }

  appendTranscript(id: string, role: TranscriptEntry['role'], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.require(id).transcript.push({ role, text: trimmed, at: this.nowIso() });
  }

  recordToolCall(id: string, record: Omit<ToolCallRecord, 'at'>): void {
    this.require(id).toolCalls.push({ ...record, at: this.nowIso() });
  }

  end(id: string): SessionSummary {
    const s = this.require(id);
    if (s.status !== 'ended') {
      s.status = 'ended';
      s.endedAt = this.nowIso();
    }
    return this.summarize(s);
  }

  summarize(s: CallSession): SessionSummary {
    const start = Date.parse(s.startedAt ?? s.createdAt);
    const end = s.endedAt ? Date.parse(s.endedAt) : this.clock.now().getTime();
    const booked = s.toolCalls
      .filter((c) => c.ok && c.name === 'book_appointment')
      .map((c) => readAppointmentId(c.result))
      .filter((id): id is string => typeof id === 'string');
    return {
      sessionId: s.id,
      durationMs: Math.max(0, end - start),
      userTurns: s.transcript.filter((t) => t.role === 'user').length,
      assistantTurns: s.transcript.filter((t) => t.role === 'assistant').length,
      toolCalls: s.toolCalls.length,
      bookedAppointmentIds: booked,
    };
  }

  private require(id: string): CallSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown session ${id}`);
    return s;
  }

  private evictOldest(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) return;
      this.sessions.delete(oldest);
    }
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

function readAppointmentId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const appointment = (result as { appointment?: { id?: unknown } }).appointment;
  return typeof appointment?.id === 'string' ? appointment.id : undefined;
}
