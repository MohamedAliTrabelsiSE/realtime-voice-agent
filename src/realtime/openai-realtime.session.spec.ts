import { FakeRealtimeSocket } from '../testing/fake-realtime-socket';
import { testConfig } from '../testing/test-config';
import { OpenAIRealtimeSession } from './openai-realtime.session';
import type { RealtimeSessionHandlers } from './realtime.types';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeHandlers(): jest.Mocked<RealtimeSessionHandlers> {
  return {
    onReady: jest.fn(),
    onUserTranscript: jest.fn(),
    onAssistantDelta: jest.fn(),
    onAssistantDone: jest.fn(),
    onAudioDelta: jest.fn(),
    onSpeechStarted: jest.fn(),
    onFunctionCall: jest.fn().mockResolvedValue('{"ok":true}'),
    onError: jest.fn(),
    onClose: jest.fn(),
  };
}

describe('OpenAIRealtimeSession', () => {
  const rt = testConfig({
    OPENAI_API_KEY: 'sk-test',
    MOCK_REALTIME: 'false',
    NOISE_REDUCTION: 'far_field',
  }).realtime;
  const tools = [{ type: 'function' as const, name: 't', description: 'd', parameters: {} }];
  let socket: FakeRealtimeSocket;
  let handlers: jest.Mocked<RealtimeSessionHandlers>;
  let session: OpenAIRealtimeSession;

  async function connected(): Promise<void> {
    const p = session.connect();
    socket.handshake();
    await p;
    socket.sent.length = 0;
  }

  beforeEach(() => {
    handlers = makeHandlers();
    session = new OpenAIRealtimeSession(
      rt,
      { instructions: 'Be nice', tools, greeting: 'Hi there', handlers },
      (url, headers) => (socket = new FakeRealtimeSocket(url, headers)),
    );
  });

  it('connects with auth and configures the session', async () => {
    const p = session.connect();
    expect(socket.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(socket.headers).toEqual({ Authorization: 'Bearer sk-test' });

    socket.server({ type: 'session.created' });
    const update = socket.sent[0] as { type: string; session: Record<string, unknown> };
    expect(update.type).toBe('session.update');
    expect(update.session).toMatchObject({
      type: 'realtime',
      instructions: 'Be nice',
      tools,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: { type: 'far_field' },
          turn_detection: { type: 'server_vad', interrupt_response: true, create_response: true },
        },
        output: { voice: 'marin' },
      },
    });

    socket.server({ type: 'session.updated' });
    await expect(p).resolves.toBeUndefined();
    expect(handlers.onReady).toHaveBeenCalledTimes(1);
    socket.server({ type: 'session.updated' });
    expect(handlers.onReady).toHaveBeenCalledTimes(1);
  });

  it('omits noise reduction when disabled', () => {
    const s = new OpenAIRealtimeSession(
      { ...rt, noiseReduction: 'none' },
      { instructions: '', tools: [], greeting: '', handlers },
    );
    const body = s.buildSessionUpdate() as {
      session: { audio: { input: Record<string, unknown> } };
    };
    expect(body.session.audio.input.noise_reduction).toBeUndefined();
  });

  it('fails fast without an API key', async () => {
    const s = new OpenAIRealtimeSession(
      { ...rt, apiKey: '' },
      { instructions: '', tools: [], greeting: '', handlers },
    );
    await expect(s.connect()).rejects.toThrow('OPENAI_API_KEY');
  });

  it('rejects connect on socket error, early close or error event', async () => {
    let p = session.connect();
    socket.emit('error', new Error('ECONNREFUSED'));
    await expect(p).rejects.toThrow('ECONNREFUSED');
    expect(handlers.onError).toHaveBeenCalledWith('ECONNREFUSED');

    p = session.connect();
    socket.readyState = 3;
    socket.emit('close', 1006, Buffer.from(''));
    await expect(p).rejects.toThrow('closed before session was ready');

    p = session.connect();
    socket.server({ type: 'error', error: { message: 'invalid model' } });
    await expect(p).rejects.toThrow('invalid model');
  });

  it('times out if the handshake never completes', async () => {
    jest.useFakeTimers();
    try {
      const p = session.connect();
      jest.advanceTimersByTime(10_000);
      await expect(p).rejects.toThrow('Timed out');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores garbage frames', async () => {
    const p = session.connect();
    socket.emit('message', Buffer.from('not json'));
    socket.emit('message', Buffer.from('42'));
    socket.emit('message', [Buffer.from('{"type":"session.'), Buffer.from('created"}')]);
    expect(socket.sentTypes()).toEqual(['session.update']);
    socket.server({ type: 'session.updated' });
    await p;
  });

  it('streams audio input only once ready', async () => {
    session.appendAudio(Buffer.alloc(100));
    await connected();
    session.appendAudio(Buffer.alloc(1));
    session.appendAudio(Buffer.from([1, 0, 2, 0]));
    expect(socket.sent).toEqual([{ type: 'input_audio_buffer.append', audio: 'AQACAA==' }]);
  });

  it('sends typed text as a user message then requests a response', async () => {
    await connected();
    session.sendText('   ');
    session.sendText(' Book me in ');
    expect(socket.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Book me in' }],
        },
      },
      { type: 'response.create' },
    ]);
  });

  it('cancels an in-flight response before sending text', async () => {
    await connected();
    socket.server({ type: 'response.created' });
    session.sendText('stop, actually');
    expect(socket.sentTypes()).toEqual([
      'response.cancel',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('greets with the configured greeting', async () => {
    await connected();
    session.greet();
    expect(socket.sent[0]).toMatchObject({
      type: 'response.create',
      response: { instructions: expect.stringContaining('Hi there') },
    });
  });

  it('relays transcripts, audio and barge-in events', async () => {
    await connected();
    socket.server({ type: 'input_audio_buffer.speech_started' });
    socket.server({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: ' hello ',
    });
    socket.server({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '  ',
    });
    socket.server({ type: 'response.created' });
    socket.server({ type: 'response.output_audio_transcript.delta', delta: 'Hi' });
    socket.server({ type: 'response.output_audio_transcript.delta', delta: ' there' });
    socket.server({ type: 'response.output_audio_transcript.delta', delta: '' });
    socket.server({
      type: 'response.output_audio.delta',
      delta: Buffer.from([1, 2]).toString('base64'),
    });
    socket.server({ type: 'response.output_audio.delta' });
    socket.server({ type: 'response.done' });
    socket.server({ type: 'rate_limits.updated' });
    await flush();

    expect(handlers.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(handlers.onUserTranscript).toHaveBeenCalledTimes(1);
    expect(handlers.onUserTranscript).toHaveBeenCalledWith('hello');
    expect(handlers.onAssistantDelta.mock.calls).toEqual([['Hi'], [' there']]);
    expect(handlers.onAssistantDone).toHaveBeenCalledWith('Hi there');
    expect(handlers.onAudioDelta).toHaveBeenCalledWith(Buffer.from([1, 2]));
    expect(socket.sent).toEqual([]);
  });

  it('runs tool calls after response.done and returns outputs to the model', async () => {
    await connected();
    handlers.onFunctionCall
      .mockResolvedValueOnce('{"ok":true,"slots":[]}')
      .mockRejectedValueOnce(new Error('db down'));

    socket.server({ type: 'response.created' });
    socket.server({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'list',
      arguments: '{"a":1}',
    });
    socket.server({
      type: 'response.function_call_arguments.done',
      call_id: 'c2',
      name: 'book',
      arguments: '',
    });
    socket.server({ type: 'response.function_call_arguments.done', call_id: '', name: 'ignored' });
    expect(handlers.onFunctionCall).not.toHaveBeenCalled();

    socket.server({ type: 'response.done' });
    await flush();

    expect(handlers.onFunctionCall.mock.calls).toEqual([
      [{ callId: 'c1', name: 'list', arguments: '{"a":1}' }],
      [{ callId: 'c2', name: 'book', arguments: '{}' }],
    ]);
    expect(socket.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'c1', output: '{"ok":true,"slots":[]}' },
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'c2',
          output: '{"ok":false,"error":"db down"}',
        },
      },
      { type: 'response.create' },
    ]);
  });

  it('reports real errors and swallows benign race errors', async () => {
    await connected();
    socket.server({
      type: 'error',
      error: { message: 'Cancellation failed: no active response found' },
    });
    socket.server({
      type: 'error',
      error: { message: 'Conversation already has an active response' },
    });
    socket.server({ type: 'error', error: { message: 'Rate limit exceeded' } });
    socket.server({ type: 'error', code: 'weird' });
    await flush();
    expect(handlers.onError.mock.calls).toEqual([
      ['Rate limit exceeded'],
      ['{"type":"error","code":"weird"}'],
    ]);
  });

  it('notifies on upstream close but not on local close', async () => {
    await connected();
    socket.emit('close', 1011, Buffer.from('server error'));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    handlers.onClose.mockClear();
    const s2 = new OpenAIRealtimeSession(
      rt,
      { instructions: '', tools: [], greeting: '', handlers },
      (u, h) => (socket = new FakeRealtimeSocket(u, h)),
    );
    const p = s2.connect();
    socket.handshake();
    await p;
    s2.close();
    s2.close();
    expect(socket.closed).toBe(true);
    expect(handlers.onClose).not.toHaveBeenCalled();
    s2.sendText('ignored after close');
    expect(socket.sentTypes()).not.toContain('conversation.item.create');
  });

  it('does not send when the socket is not open', async () => {
    await connected();
    socket.readyState = 0;
    session.greet();
    expect(socket.sent).toEqual([]);
  });

  it('survives a socket that throws on close', async () => {
    await connected();
    socket.close = () => {
      throw new Error('already closed');
    };
    expect(() => session.close()).not.toThrow();
  });
});
