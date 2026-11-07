import type { WebSocket } from 'ws';
import { buildAppointmentTools } from '../appointments/appointment.tools';
import { AppointmentsService } from '../appointments/appointments.service';
import { VoiceTokenService } from '../auth/voice-token.service';
import { fixedClock } from '../config/clock';
import { RealtimeSessionFactory } from '../realtime/realtime-session.factory';
import { SessionStore } from '../sessions/session.store';
import { MONDAY_8AM_PARIS, testConfig } from '../testing/test-config';
import { VoiceGateway } from './voice.gateway';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
};

function fakeClient(): WebSocket & {
  frames: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    readyState: 1,
    frames,
    send: (raw: string) => frames.push(JSON.parse(raw)),
  } as unknown as WebSocket & { frames: typeof frames };
}

describe('VoiceGateway', () => {
  const clock = fixedClock(MONDAY_8AM_PARIS);
  const config = testConfig();
  let sessions: SessionStore;
  let tokens: VoiceTokenService;
  let gateway: VoiceGateway;

  beforeEach(() => {
    sessions = new SessionStore(clock);
    tokens = new VoiceTokenService(config, clock);
    const appointments = new AppointmentsService(config, clock);
    gateway = new VoiceGateway(
      config,
      sessions,
      tokens,
      buildAppointmentTools(appointments),
      appointments,
      new RealtimeSessionFactory(config),
    );
  });

  it('runs a conversation per socket and cleans up on disconnect', async () => {
    const client = fakeClient();
    gateway.handleConnection(client);
    expect(gateway.activeConnections).toBe(1);

    const s = sessions.create();
    await gateway.onStart(client, { sessionId: s.id, token: tokens.sign(s.id).token });
    gateway.onText(client, { text: 'what slots are available' });
    gateway.onAudio(client, { audio: Buffer.alloc(4).toString('base64') });
    gateway.onInterrupt(client);
    await settle();

    const names = client.frames.map((f) => f.event);
    expect(names[0]).toBe('ready');
    expect(names).toContain('tool_call');
    expect(names).toContain('audio');

    gateway.onStop(client);
    expect(client.frames.at(-1)?.event).toBe('ended');

    gateway.handleDisconnect(client);
    expect(gateway.activeConnections).toBe(0);
    expect(sessions.get(s.id)?.status).toBe('ended');
  });

  it('does not write to closed sockets', async () => {
    const client = fakeClient();
    gateway.handleConnection(client);
    (client as { readyState: number }).readyState = 3;
    await gateway.onStart(client, {});
    expect(client.frames).toEqual([]);
  });

  it('ignores messages from unknown sockets and answers pings', async () => {
    const stranger = fakeClient();
    await expect(gateway.onStart(stranger, {})).resolves.toBeUndefined();
    gateway.handleDisconnect(stranger);
    expect(gateway.onPing()).toMatchObject({ event: 'pong', data: { at: expect.any(String) } });
  });
});
