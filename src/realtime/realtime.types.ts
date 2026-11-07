export interface RealtimeToolSpec {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface RealtimeSessionHandlers {
  onReady(): void;
  /** Final transcript of what the caller said (from speech-to-text). */
  onUserTranscript(text: string): void;
  onAssistantDelta(text: string): void;
  onAssistantDone(text: string): void;
  /** Mono PCM16 audio chunk at the configured rate, ready to stream to the client. */
  onAudioDelta(pcm: Buffer): void;
  /** Caller started talking; clients should stop playback (barge-in). */
  onSpeechStarted(): void;
  /** Executes a tool call and resolves to the JSON string sent back to the model. */
  onFunctionCall(call: RealtimeFunctionCall): Promise<string>;
  onError(message: string): void;
  onClose(): void;
}

export interface RealtimeSession {
  connect(): Promise<void>;
  appendAudio(pcm: Buffer): void;
  sendText(text: string): void;
  /** Asks the model to speak first (greeting). */
  greet(): void;
  cancelResponse(): void;
  close(): void;
}

export interface RealtimeSessionOptions {
  instructions: string;
  tools: RealtimeToolSpec[];
  greeting: string;
  handlers: RealtimeSessionHandlers;
}
