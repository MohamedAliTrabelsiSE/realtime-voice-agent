const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'),
  mode: $('mode'),
  business: $('business'),
  startBtn: $('startBtn'),
  micBtn: $('micBtn'),
  hangupBtn: $('hangupBtn'),
  meterBar: $('meterBar'),
  transcript: $('transcript'),
  textForm: $('textForm'),
  textInput: $('textInput'),
  sendBtn: $('sendBtn'),
  tools: $('tools'),
  slots: $('slots'),
  appointments: $('appointments'),
  summary: $('summary'),
  callerName: $('callerName'),
};

let ws = null;
let live = false;
let streamingBubble = null;

// ---------- playback ----------
let playbackCtx = null;
let playhead = 0;
const playing = new Set();

function ensurePlayback(sampleRate) {
  if (!playbackCtx || playbackCtx.sampleRate !== sampleRate) {
    playbackCtx?.close();
    playbackCtx = new AudioContext({ sampleRate });
    playhead = 0;
  }
  return playbackCtx;
}

function playPcm16(base64, sampleRate) {
  const ctx = ensurePlayback(sampleRate);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;

  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  playhead = Math.max(playhead, ctx.currentTime + 0.02);
  src.start(playhead);
  playhead += buffer.duration;
  playing.add(src);
  src.onended = () => playing.delete(src);
}

function stopPlayback() {
  for (const src of playing) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  playing.clear();
  playhead = 0;
}

// ---------- microphone ----------
let mic = null;

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = ({ data }) => {
    ui.meterBar.style.width = `${Math.min(100, data.peak * 140)}%`;
    if (!live) return;
    send('audio', {
      audio: toBase64(new Uint8Array(data.pcm)),
      format: 'pcm16',
      sampleRate: ctx.sampleRate,
    });
  };
  source.connect(node);
  mic = { stream, ctx, node };
  ui.micBtn.classList.add('active');
  ui.micBtn.textContent = 'Mic off';
}

function stopMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close();
  mic = null;
  ui.meterBar.style.width = '0';
  ui.micBtn.classList.remove('active');
  ui.micBtn.textContent = 'Mic on';
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ---------- websocket ----------
function send(event, data = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
}

async function startCall() {
  ui.startBtn.disabled = true;
  setStatus('connecting');
  try {
    const res = await fetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerName: ui.callerName.value.trim() || undefined }),
    });
    if (!res.ok) throw new Error(`POST /sessions failed: ${res.status}`);
    const session = await res.json();
    ensurePlayback(24000).resume();

    ws = new WebSocket(session.wsUrl);
    ws.onopen = () => send('start', { sessionId: session.sessionId, token: session.voiceToken });
    ws.onmessage = (msg) => handleServerEvent(JSON.parse(msg.data));
    ws.onclose = () => endCall('disconnected');
    ws.onerror = () => setStatus('socket error', 'error');
  } catch (err) {
    addMessage('system', err.message);
    setStatus('error', 'error');
    ui.startBtn.disabled = false;
  }
}

function handleServerEvent({ event, data }) {
  switch (event) {
    case 'ready':
      live = true;
      setStatus('live', 'live');
      ui.mode.textContent = `mode: ${data.realtimeMode}`;
      setCallControls(true);
      addMessage('system', `Connected. Session ${data.sessionId.slice(0, 8)}`);
      break;
    case 'agent_delta':
      if (!streamingBubble) streamingBubble = addMessage('assistant', '', true);
      streamingBubble.textContent += data.text;
      scrollTranscript();
      break;
    case 'transcript':
      if (data.role === 'assistant') {
        if (streamingBubble) {
          streamingBubble.textContent = data.text;
          streamingBubble.classList.remove('streaming');
          streamingBubble = null;
        } else addMessage('assistant', data.text);
      } else addMessage('user', data.text);
      break;
    case 'audio':
      playPcm16(data.audio, data.sampleRate);
      break;
    case 'speech_started':
      stopPlayback();
      if (streamingBubble) {
        streamingBubble.classList.remove('streaming');
        streamingBubble = null;
      }
      break;
    case 'tool_call':
      addToolCall(data);
      refreshAppointments();
      refreshSlots();
      break;
    case 'ended':
      ui.summary.textContent = JSON.stringify(data.summary, null, 2);
      ws?.close();
      break;
    case 'error':
      addMessage('system', `Error [${data.code}]: ${data.message}`);
      break;
  }
}

function endCall(label = 'ended') {
  live = false;
  stopMic();
  stopPlayback();
  streamingBubble = null;
  setCallControls(false);
  setStatus(label);
  ws = null;
}

function setCallControls(on) {
  ui.startBtn.disabled = on;
  ui.micBtn.disabled = !on;
  ui.hangupBtn.disabled = !on;
  ui.textInput.disabled = !on;
  ui.sendBtn.disabled = !on;
  if (on) ui.textInput.focus();
}

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `badge ${kind}`;
}

// ---------- rendering ----------
function addMessage(role, text, streaming = false) {
  const el = document.createElement('div');
  el.className = `msg ${role}${streaming ? ' streaming' : ''}`;
  el.textContent = text;
  ui.transcript.appendChild(el);
  scrollTranscript();
  return el;
}

function scrollTranscript() {
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function addToolCall({ name, args, ok, result }) {
  const el = document.createElement('div');
  el.className = `tool${ok ? '' : ' fail'}`;
  el.textContent = `${name}(${JSON.stringify(args)})\n→ ${JSON.stringify(result)}`;
  ui.tools.prepend(el);
}

async function refreshAppointments() {
  const list = await fetch('/appointments').then((r) => r.json());
  ui.appointments.replaceChildren(
    ...list.map((a) => {
      const tr = document.createElement('tr');
      for (const v of [a.id, a.label, a.customerName, a.phone, a.status]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      if (a.status === 'cancelled') tr.lastChild.classList.add('cancelled');
      return tr;
    }),
  );
}

async function refreshSlots() {
  const slots = await fetch('/appointments/slots?limit=8').then((r) => r.json());
  ui.slots.replaceChildren(
    ...slots.map((s) => {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.title = `Insert "book ${s.start} for ..." (mock mode helper)`;
      b.onclick = () => {
        ui.textInput.value = `book ${s.start} for ${ui.callerName.value.trim() || 'Jane Doe'} phone +15551234567`;
        ui.textInput.focus();
      };
      return b;
    }),
  );
}

// ---------- wiring ----------
ui.startBtn.onclick = startCall;
ui.hangupBtn.onclick = () => send('stop');
ui.micBtn.onclick = async () => {
  try {
    if (mic) stopMic();
    else await startMic();
  } catch (err) {
    addMessage('system', `Microphone error: ${err.message}`);
  }
};
ui.textForm.onsubmit = (e) => {
  e.preventDefault();
  const text = ui.textInput.value.trim();
  if (!text || !live) return;
  stopPlayback();
  send('text', { text });
  ui.textInput.value = '';
};
$('refreshSlots').onclick = refreshSlots;

fetch('/health')
  .then((r) => r.json())
  .then((h) => {
    ui.mode.textContent = `mode: ${h.realtimeMode}`;
    ui.business.textContent = `${h.business} · ${h.model}`;
    if (h.realtimeMode === 'openai') $('hint').textContent = 'Turn the mic on and just talk.';
  });
refreshAppointments();
refreshSlots();
