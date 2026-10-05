// TTS 播放组件：云端 Gemini（Puck）优先，失败自动降级到浏览器 speechSynthesis
// 对外：TTSPlayer.init() / unlock() / speak(text) / stop() / isSpeaking()
// 模式由 serve.py 的 TTS_MODE 决定；?tts=local_only 可在前端强制只用浏览器（只能降级，不能升级）

'use strict';

const TTSPlayer = (() => {
  const FIRST_CHUNK_TIMEOUT_MS = 5000;  // 用户在等第一声：超过就改用浏览器
  const NEXT_CHUNK_TIMEOUT_MS = 15000;  // 后续分段在前一段播放时预取，可以宽松些
  const CLOUD_COOLDOWN_MS = 60000;      // 云端失败后这段时间内直接用浏览器，避免每轮都等超时
  const FIRST_CHUNK_CHARS = 80;
  const CHUNK_CHARS = 300;
  const VOICES_WAIT_MS = 1500;          // Safari 有时不触发 voiceschanged

  const LABEL_CLOUD = '✨ Puck Neural Voice';
  const LABEL_BROWSER = '✨ Puck Voice (Browser)';

  const $label = document.getElementById('voiceLabel');
  const audio = new Audio();
  audio.preload = 'auto';

  let mode = 'local_only'; // 拿到 config 之前按最保守处理
  let cloudAvailable = false;
  let cloudFailedAt = 0;
  let unlocked = false;
  let generation = 0;      // stop() 时自增，让正在进行的 speak 循环退出
  let speaking = false;
  let voices = [];

  // ---------- 配置 ----------

  async function init() {
    const forceLocal = new URLSearchParams(location.search).get('tts') === 'local_only';
    try {
      const res = await fetch('/api/tts/config', { cache: 'no-store' });
      const cfg = await res.json();
      mode = forceLocal ? 'local_only' : cfg.mode;
      cloudAvailable = mode === 'cloud_first' && cfg.cloud_available;
      console.log('[tts] config mode=' + mode + ' cloud_available=' + cloudAvailable + (forceLocal ? ' (forced by ?tts=local_only)' : ''));
    } catch (e) {
      mode = 'local_only';
      cloudAvailable = false;
      console.log('[tts] config fetch failed, browser voice only', e);
    }
    setLabel(cloudUsable());
    loadVoices();
  }

  function cloudUsable() {
    return mode === 'cloud_first' && cloudAvailable && Date.now() - cloudFailedAt > CLOUD_COOLDOWN_MS;
  }

  function setLabel(cloud) {
    if ($label) $label.textContent = cloud ? LABEL_CLOUD : LABEL_BROWSER;
  }

  // ---------- 浏览器声音 ----------
  // getVoices() 异步加载：先读一次，再监听 voiceschanged

  function loadVoices() {
    if (!window.speechSynthesis) {
      console.log('[tts] speechSynthesis not supported');
      return;
    }
    const update = () => {
      voices = speechSynthesis.getVoices();
      console.log('[tts] voices loaded: ' + voices.length);
    };
    update();
    speechSynthesis.addEventListener('voiceschanged', update);
  }

  let voicesWaited = false; // 只等一次：有的浏览器列表一直为空，之后直接用系统默认

  function waitForVoices() {
    if (voices.length || voicesWaited || !window.speechSynthesis) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        speechSynthesis.removeEventListener('voiceschanged', done);
        voices = speechSynthesis.getVoices();
        voicesWaited = true;
        resolve();
      };
      speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(done, VOICES_WAIT_MS);
    });
  }

  // 名字带 Google 的是联网合成（Chrome），localService=false 的同理，都排到最后
  function isNetworkVoice(v) {
    return /google/i.test(v.name) || v.localService === false;
  }

  function isQuality(v) {
    return /premium|enhanced|高级|优化/i.test(v.name);
  }

  const PREFERRED = {
    en: [/^Ava\b.*premium/i, /^Zoe\b.*premium/i, /^Evan\b.*enhanced/i],
    zh: [/(tingting|婷婷).*(premium|enhanced|高级|优化)/i, /(meijia|美佳).*(premium|enhanced|高级|优化)/i],
  };

  function pickVoice(lang) {
    const prefix = lang === 'zh' ? 'zh' : 'en';
    const local = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix) && !isNetworkVoice(v));
    for (const re of PREFERRED[lang]) {
      const v = local.find((x) => re.test(x.name));
      if (v) return v;
    }
    const zhCN = (v) => v.lang.toLowerCase().replace('_', '-') === 'zh-cn';
    const ordered = lang === 'zh'
      ? [(v) => isQuality(v) && zhCN(v), isQuality, (v) => /tingting|婷婷/i.test(v.name), zhCN, () => true]
      : [isQuality, (v) => v.default, () => true];
    for (const test of ordered) {
      const v = local.find(test);
      if (v) return v;
    }
    return null; // 没有本地声音：交给系统默认
  }

  // 汉字占比足够高就按中文读
  function detectLang(text) {
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    const latinWords = (text.match(/[A-Za-z]+/g) || []).length;
    return han > 0 && han >= latinWords ? 'zh' : 'en';
  }

  function speakBrowser(text, gen) {
    if (!window.speechSynthesis) return Promise.resolve();
    return waitForVoices().then(() => new Promise((resolve) => {
      if (gen !== generation) return resolve();
      const lang = detectLang(text);
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(lang);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
      }
      u.onend = () => resolve();
      u.onerror = (e) => {
        console.log('[tts] browser utterance error', e.error);
        resolve();
      };
      console.log('[tts] browser speak lang=' + lang + ' voice=' + (v ? v.name + ' (' + v.lang + ')' : 'system default') + ' chars=' + text.length);
      speechSynthesis.speak(u);
    }));
  }

  // ---------- 云端 ----------

  async function fetchCloud(text, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch (e) { /* 非 JSON */ }
        throw new Error('HTTP ' + res.status + ' ' + detail);
      }
      return URL.createObjectURL(await res.blob());
    } finally {
      clearTimeout(timer);
    }
  }

  function playUrl(url, gen) {
    return new Promise((resolve, reject) => {
      if (gen !== generation) return resolve();
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio element error'));
      audio.src = url;
      audio.play().catch(reject);
    });
  }

  // ---------- 分段 ----------
  // 第一段短一些尽快出声，其余合并成较长的段，减少云端请求次数

  function splitChunks(text) {
    const sentences = text.match(/[^。！？!?；;\n.]+[。！？!?；;\n.]*/g) || [text];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
      const limit = chunks.length === 0 ? FIRST_CHUNK_CHARS : CHUNK_CHARS;
      if (cur && (cur + s).length > limit) {
        chunks.push(cur);
        cur = '';
      }
      cur += s;
    }
    if (cur.trim()) chunks.push(cur);
    return chunks.map((c) => c.trim()).filter(Boolean);
  }

  // 朗读前去掉 markdown 符号和 emoji
  function cleanForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>|~]+/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // ---------- 对外接口 ----------

  async function speak(rawText) {
    stop();
    const text = cleanForSpeech(rawText || '');
    if (!text) return;
    const gen = generation;
    speaking = true;
    const chunks = splitChunks(text);
    let useCloud = cloudUsable();
    setLabel(useCloud);
    console.log('[tts] speak ' + text.length + ' chars in ' + chunks.length + ' chunk(s), path=' + (useCloud ? 'cloud' : 'browser'));

    try {
      let pending = useCloud ? fetchCloud(chunks[0], FIRST_CHUNK_TIMEOUT_MS) : null;
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== generation) return;
        if (useCloud) {
          try {
            const t0 = performance.now();
            const url = await pending;
            // 播当前段的同时预取下一段
            pending = i + 1 < chunks.length ? fetchCloud(chunks[i + 1], NEXT_CHUNK_TIMEOUT_MS) : null;
            if (pending) pending.catch(() => {}); // 失败在轮到它时处理
            console.log('[tts] cloud chunk ' + (i + 1) + '/' + chunks.length + ' ready in ' + Math.round(performance.now() - t0) + 'ms');
            try {
              await playUrl(url, gen);
            } finally {
              URL.revokeObjectURL(url);
            }
            continue;
          } catch (e) {
            if (gen !== generation) return;
            console.log('[tts] cloud failed, falling back to browser voice: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
            cloudFailedAt = Date.now();
            useCloud = false;
            pending = null;
            setLabel(false);
          }
        }
        await speakBrowser(chunks[i], gen);
      }
    } finally {
      if (gen === generation) speaking = false;
    }
  }

  function stop() {
    generation++;
    speaking = false;
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {
      // 忽略
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  function isSpeaking() {
    return speaking || (window.speechSynthesis ? speechSynthesis.speaking : false);
  }

  // iOS：<audio> 和 speechSynthesis 都要在用户手势里先发一次声才允许之后自动播放
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      audio.src = SILENT_WAV;
      audio.play().then(
        () => console.log('[tts] audio element unlocked'),
        (e) => console.log('[tts] audio element unlock failed', e)
      );
    } catch (e) {
      console.log('[tts] audio element unlock error', e);
    }
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
      console.log('[tts] speechSynthesis unlocked');
    }
  }

  return { init, unlock, speak, stop, isSpeaking };
})();
