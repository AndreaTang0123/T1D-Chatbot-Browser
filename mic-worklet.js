// 麦克风采集 AudioWorklet：原生采样率 → 16kHz 单声道 Int16，每 960 个采样点（60ms）发一帧给主线程
// 不依赖 AudioContext 的 sampleRate 参数，按 worklet 全局 sampleRate 自己降采样

'use strict';

const OUT_RATE = 16000;
const FRAME_SAMPLES = 960;
const LOWPASS_HZ = 7000; // 低于 16k 的奈奎斯特频率 8k，防混叠

// RBJ 低通 biquad，Direct Form I
function makeLowpass(fs, fc, q) {
  const w0 = 2 * Math.PI * fc / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = -2 * cos / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    process(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
      return y;
    },
    reset() {
      x1 = x2 = y1 = y2 = 0;
    },
  };
}

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate;
    this.step = this.inRate / OUT_RATE; // 每个输出采样点前进多少个输入采样点
    // 4 阶 Butterworth = 两级 biquad；输入已是 16k 时不需要
    this.filters = this.inRate > OUT_RATE
      ? [makeLowpass(this.inRate, LOWPASS_HZ, 0.5412), makeLowpass(this.inRate, LOWPASS_HZ, 1.3066)]
      : [];
    this.recording = false;
    this.resetState();

    this.port.onmessage = (event) => {
      const cmd = event.data && event.data.cmd;
      if (cmd === 'start') {
        this.resetState();
        this.recording = true;
      } else if (cmd === 'stop') {
        this.recording = false;
        // 不足一帧的尾巴补零发出，避免丢掉最后一个字
        if (this.frameIndex > 0) {
          this.frame.fill(0, this.frameIndex);
          this.postFrame();
        }
        this.port.postMessage({ type: 'stopped', frames: this.framesSent });
      }
    };

    this.port.postMessage({ type: 'ready', sampleRate: this.inRate });
  }

  resetState() {
    for (const f of this.filters) f.reset();
    this.last = 0;   // 上一个（滤波后）输入采样点
    this.pos = 1;    // 在 [last, ...input] 扩展序列里的位置
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameIndex = 0;
    this.framesSent = 0;
    this.peak = 0;
  }

  postFrame() {
    const pcm = this.frame;
    this.port.postMessage({ type: 'frame', pcm, peak: this.peak }, [pcm.buffer]);
    this.framesSent++;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameIndex = 0;
    this.peak = 0;
  }

  pushSample(v) {
    const abs = v < 0 ? -v : v;
    if (abs > this.peak) this.peak = abs;
    const s = v < -1 ? -1 : v > 1 ? 1 : v;
    this.frame[this.frameIndex++] = s < 0 ? s * 32768 : s * 32767;
    if (this.frameIndex === FRAME_SAMPLES) this.postFrame();
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!this.recording || !input) return true;

    const n = input.length;
    // 先低通滤波，再流式线性插值降采样
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x = input[i];
      for (const f of this.filters) x = f.process(x);
      filtered[i] = x;
    }

    if (this.step === 1) {
      for (let i = 0; i < n; i++) this.pushSample(filtered[i]);
      return true;
    }

    // 扩展序列 ext[0] = last, ext[k] = filtered[k-1]；插值需要 ext[i+1]，所以 pos < n
    while (this.pos < n) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.last : filtered[i - 1];
      const b = filtered[i];
      this.pushSample(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= n;
    this.last = filtered[n - 1];
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
