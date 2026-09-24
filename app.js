// xiaozhi web-client —— 文字对话 + TTS 播放
// 协议细节见 PROTOCOL.md

'use strict';

// ---------- 身份 ----------

function makeUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// localStorage 可能不可用（隐私模式），失败时每次生成新的
function loadOrCreate(key, factory) {
  try {
    let v = localStorage.getItem(key);
    if (!v) {
      v = factory();
      localStorage.setItem(key, v);
    }
    return v;
  } catch (e) {
    return factory();
  }
}

// server 按 client-id 加载人设和数据：data/<client-id>/{prompt.txt,prompts/,config.json,memory.json}
// 默认用 Joe（与 ESP32 设备共用记忆和 CGM/pump 数据）；测试或换人设时用 ?client-id=<id> 覆盖
const JOE_CLIENT_ID = '26ea0ba9-2d55-4368-a56d-19c4a27c0772';

const deviceId = loadOrCreate('xz-device-id', () => 'web-' + makeUuid().slice(0, 8));
const clientId = new URLSearchParams(location.search).get('client-id') || JOE_CLIENT_ID;

// 默认同源；本地调试可用 ?ws=ws://127.0.0.1:8000/xiaozhi/v1/ 覆盖
function buildWsUrl() {
  const override = new URLSearchParams(location.search).get('ws');
  const base = override || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/xiaozhi/v1/`;
  const url = new URL(base);
  url.searchParams.set('device-id', deviceId);
  url.searchParams.set('client-id', clientId);
  return url.toString();
}

// ---------- UI ----------

const $messages = document.getElementById('messages');
const $form = document.getElementById('inputForm');
const $input = document.getElementById('textInput');
const $send = document.getElementById('sendBtn');
const $dot = document.getElementById('statusDot');
const $statusText = document.getElementById('statusText');
const $reconnect = document.getElementById('reconnectBtn');

// state: 'disconnected' | 'connecting' | 'ready'
function setStatus(state, text) {
  $dot.className = state === 'disconnected' ? '' : state;
  $statusText.textContent = text;
  $send.disabled = state !== 'ready';
  $reconnect.hidden = state !== 'disconnected';
}

function scrollToBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = 'bubble ' + role;
  el.textContent = text;
  $messages.appendChild(el);
  scrollToBottom();
  return el;
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  $messages.appendChild(el);
  scrollToBottom();
}

// ---------- 助手回复合并 ----------
// server 每句发一条 tts sentence_start（去过 markdown），
// LLM 结束时再发一条带全文的 sentence_start（原文去 emoji）。
// 比较时去掉空白、标点和符号，避免 markdown 差异造成重复显示。

function normalize(s) {
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

let botBubble = null; // 本轮的助手气泡
let botText = '';

function resetTurn() {
  botBubble = null;
  botText = '';
}

function onAssistantText(text) {
  const incoming = normalize(text);
  if (!incoming) return;
  const current = normalize(botText);

  if (current.includes(incoming)) {
    console.log('[ws] sentence_start already shown, skip');
    return;
  }
  if (incoming.includes(current)) {
    // 全文（或更长的版本）到达，整体替换
    botText = text;
  } else {
    botText = botText ? botText + ' ' + text : text;
  }

  if (!botBubble) botBubble = addBubble('bot', botText);
  else botBubble.textContent = botText;
  scrollToBottom();
}

// ---------- Opus 解码 ----------
// libopus.js 是 asm.js 构建，堆固定 16MB 且不可增长，所以输入/输出缓冲只分配一次。
// server 下发：16kHz、单声道、60ms（960 采样点）一包。

const OPUS_RATE = 16000;
const OPUS_MAX_FRAME = 1920; // 16kHz 下 opus 单包最长 120ms
const OPUS_MAX_PACKET = 4000;

function createOpusDecoder() {
  const mod = (typeof Module !== 'undefined' && Module.instance) || null;
  if (!mod || typeof mod._opus_decoder_get_size !== 'function') {
    console.log('[audio] libopus not loaded, Module.instance missing');
    return null;
  }

  const size = mod._opus_decoder_get_size(1);
  const decPtr = mod._malloc(size);
  const inPtr = mod._malloc(OPUS_MAX_PACKET);
  const outPtr = mod._malloc(OPUS_MAX_FRAME * 2);

  function reset() {
    const err = mod._opus_decoder_init(decPtr, OPUS_RATE, 1);
    if (err < 0) console.log('[audio] opus_decoder_init failed', err);
    return err >= 0;
  }

  // 返回 Float32Array（[-1,1)），失败返回 null
  function decode(packet) {
    if (packet.length === 0 || packet.length > OPUS_MAX_PACKET) {
      console.log('[audio] skip packet, length=' + packet.length);
      return null;
    }
    mod.HEAPU8.set(packet, inPtr);
    const n = mod._opus_decode(decPtr, inPtr, packet.length, outPtr, OPUS_MAX_FRAME, 0);
    if (n < 0) {
      console.log('[audio] opus_decode error', n);
      return null;
    }
    const pcm = mod.HEAP16.subarray(outPtr >> 1, (outPtr >> 1) + n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = pcm[i] / 32768;
    return out;
  }

  if (!reset()) return null;
  console.log('[audio] opus decoder ready, state size=' + size);
  return { decode, reset };
}

// ---------- 重采样 ----------
// 16kHz → AudioContext 原生采样率的流式线性插值。
// 跨包保留上一包最后一个采样点和小数位置，保证包与包之间波形连续（无爆音）。

function createResampler(inRate, outRate) {
  const step = inRate / outRate;
  let last = 0; // 上一包最后一个采样点，起始为静音
  let pos = 0;  // 在 [last, ...input] 这个扩展序列里的位置

  function process(input) {
    if (inRate === outRate) return input;
    const n = input.length;
    const out = new Float32Array(Math.ceil((n - pos) / step) + 1);
    let k = 0;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? last : input[i - 1];
      const b = input[i];
      out[k++] = a + (b - a) * frac;
      pos += step;
    }
    pos -= n;
    last = input[n - 1];
    return out.subarray(0, k);
  }

  function reset() {
    last = 0;
    pos = 0;
  }

  return { process, reset };
}

// ---------- TTS 播放 ----------
// 每包解码后按 nextStartTime 首尾相接排队播放。
// 队列播空（首包或网络断流）时，重新留 START_BUFFER 的缓冲再开始，并做短淡入避免爆音。

const START_BUFFER_S = 0.5; // 实测句间 TTS 生成空档约 0.6s，需要约 0.25s 缓冲才不断流
const MIN_LEAD_S = 0.02;
const FADE_IN_S = 0.004;

let audioCtx = null;
let decoder = null;
let resampler = null;
let nextStartTime = 0;
const activeSources = new Set();
let turnStats = null;

function newTurnStats() {
  return { frames: 0, seconds: 0, underruns: 0, dropped: 0 };
}

// 必须在用户点击/按键事件里同步调用（iOS 要求）
function unlockAudio() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
      // 让 iPhone 静音键不影响播放
      navigator.audioSession.type = 'playback';
      console.log('[audio] audioSession.type=playback');
    }
  } catch (e) {
    console.log('[audio] audioSession not settable', e);
  }

  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioCtx.onstatechange = () => console.log('[audio] context state=' + audioCtx.state);
    resampler = createResampler(OPUS_RATE, audioCtx.sampleRate);
    console.log('[audio] context created, sampleRate=' + audioCtx.sampleRate);

    // 播一个极短的静音 buffer，兼容较老的 iOS 解锁方式
    const silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = silent;
    src.connect(audioCtx.destination);
    src.start(0);
  }
  if (audioCtx.state !== 'running') {
    audioCtx.resume().then(
      () => console.log('[audio] context resumed, state=' + audioCtx.state),
      (e) => console.log('[audio] context resume failed', e)
    );
  }
  if (!decoder) decoder = createOpusDecoder();
}

function playOpusFrame(buffer) {
  if (!turnStats) turnStats = newTurnStats();
  if (!audioCtx || !decoder) {
    turnStats.dropped++;
    if (turnStats.dropped === 1) console.log('[audio] frame dropped, audio not unlocked yet (tap send first)');
    return;
  }

  const pcm16k = decoder.decode(new Uint8Array(buffer));
  if (!pcm16k) {
    turnStats.dropped++;
    return;
  }

  const now = audioCtx.currentTime;
  const startingRun = nextStartTime < now + MIN_LEAD_S;
  if (startingRun) {
    if (turnStats.frames > 0) {
      turnStats.underruns++;
      console.log('[audio] underrun, late by ' + (now - nextStartTime).toFixed(3) + 's, rebuffering');
    } else {
      console.log('[audio] first frame, start in ' + START_BUFFER_S + 's, ctx state=' + audioCtx.state);
    }
    nextStartTime = now + START_BUFFER_S;
  }

  const pcm = resampler.process(pcm16k);
  if (pcm.length === 0) return;

  const audioBuffer = audioCtx.createBuffer(1, pcm.length, audioCtx.sampleRate);
  const channel = audioBuffer.getChannelData(0);
  channel.set(pcm);
  if (startingRun) {
    const fade = Math.min(channel.length, Math.round(FADE_IN_S * audioCtx.sampleRate));
    for (let i = 0; i < fade; i++) channel[i] *= i / fade;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(audioCtx.destination);
  src.onended = () => activeSources.delete(src);
  src.start(nextStartTime);
  activeSources.add(src);

  const duration = pcm.length / audioCtx.sampleRate;
  nextStartTime += duration;
  turnStats.frames++;
  turnStats.seconds += duration;
}

// tts stop：server 已发完本轮音频。重置解码/重采样状态和统计，
// 已排队的音频继续播完（立即停掉会截掉句尾）。
function resetPlaybackQueue() {
  const s = turnStats || newTurnStats();
  const tail = audioCtx ? Math.max(0, nextStartTime - audioCtx.currentTime) : 0;
  console.log('[audio] turn done: frames=' + s.frames + ' audio=' + s.seconds.toFixed(2) + 's underruns=' +
    s.underruns + ' dropped=' + s.dropped + ' remaining=' + tail.toFixed(2) + 's');
  turnStats = null;
  if (decoder) decoder.reset();
  if (resampler) resampler.reset();
}

// 断线时立即停止所有已排队的音频
function stopAllAudio() {
  for (const src of activeSources) {
    try {
      src.stop();
    } catch (e) {
      // 已经结束的 source 调 stop 会抛错，忽略
    }
  }
  activeSources.clear();
  nextStartTime = 0;
  turnStats = null;
  if (decoder) decoder.reset();
  if (resampler) resampler.reset();
  console.log('[audio] all playback stopped');
}

// ---------- WebSocket ----------

const HELLO_TIMEOUT_MS = 5000;

let ws = null;
let sessionId = null;
let helloTimer = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  const url = buildWsUrl();
  console.log('[ws] connecting', url);
  setStatus('connecting', '连接中…');
  sessionId = null;

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[ws] open');
    setStatus('connecting', '握手中…');
    sendHello();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleText(event.data);
    } else {
      playOpusFrame(event.data);
    }
  };

  ws.onerror = (event) => {
    console.log('[ws] error', event);
  };

  ws.onclose = (event) => {
    console.log('[ws] close code=' + event.code + ' reason=' + (event.reason || '(none)') + ' clean=' + event.wasClean);
    clearTimeout(helloTimer);
    ws = null;
    sessionId = null;
    resetTurn();
    stopAllAudio();
    setStatus('disconnected', '已断开');
    addNotice('连接已断开');
  };
}

function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[ws] send skipped, socket not open', obj);
    return false;
  }
  const text = JSON.stringify(obj);
  console.log('[ws] send', text);
  ws.send(text);
  return true;
}

function sendHello() {
  sendJson({
    type: 'hello',
    version: 1,
    transport: 'websocket',
    features: { mcp: false },
    audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
  });
  clearTimeout(helloTimer);
  helloTimer = setTimeout(() => {
    console.log('[ws] hello timeout, no reply in ' + HELLO_TIMEOUT_MS + 'ms');
    setStatus('connecting', '握手超时');
  }, HELLO_TIMEOUT_MS);
}

function handleText(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    console.log('[ws] non-JSON text', raw);
    return;
  }
  console.log('[ws] recv', msg.type, msg);

  switch (msg.type) {
    case 'hello':
      clearTimeout(helloTimer);
      sessionId = msg.session_id;
      console.log('[ws] hello ok, session_id=' + sessionId + ' audio_params=' + JSON.stringify(msg.audio_params));
      setStatus('ready', '已连接');
      break;

    case 'stt':
      // 就绪通知 {state:"listening"} 没有 text
      if (msg.text) {
        resetTurn();
        addBubble('user', msg.text);
      }
      break;

    case 'tts':
      if (msg.state === 'sentence_start' && msg.text) {
        onAssistantText(msg.text);
      } else if (msg.state === 'stop') {
        console.log('[ws] tts stop, turn finished');
        resetPlaybackQueue();
      }
      break;

    case 'llm':
      console.log('[ws] emotion', msg.emotion, msg.text);
      break;

    default:
      console.log('[ws] unhandled type', msg.type);
  }
}

// ---------- 输入 ----------

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  // 发送按钮/键盘回车是用户手势，在这里解锁音频（iOS 要求）
  unlockAudio();
  const text = $input.value.trim();
  if (!text || !sessionId) return;
  if (sendJson({ type: 'listen', mode: 'manual', state: 'detect', text: text })) {
    $input.value = '';
  }
});

$reconnect.addEventListener('click', () => {
  console.log('[ws] manual reconnect');
  unlockAudio();
  connect();
});

console.log('[ws] device-id=' + deviceId + ' client-id=' + clientId + (clientId === JOE_CLIENT_ID ? ' (Joe)' : ' (override)'));
connect();
