#!/usr/bin/env python3
"""web-client 静态页 + TTS 接口（替代 `python3 -m http.server 5173`）。

- GET  /                → index.html 及白名单里的静态文件（.env、.venv、.git 一律 404）
- GET  /api/tts/config  → 当前 TTS 模式，前端据此决定是否请求云端
- POST /api/tts         → {"text": "..."}，调用 Gemini TTS，返回 audio/wav

配置（环境变量，或同目录 .env，.env 已在 .gitignore 中）：
  TTS_MODE          cloud_first（默认，云端优先、浏览器兜底）| local_only（不调用任何云端 TTS）
  GEMINI_API_KEY    Gemini API key；cloud_first 下缺失时前端自动用浏览器语音
  GEMINI_TTS_MODEL  默认 gemini-2.5-flash-preview-tts
  GEMINI_TTS_VOICE  默认 Puck
  PORT              默认 5173

用法: .venv/bin/python serve.py
"""
import io
import json
import logging
import os
import re
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# 只允许这些文件被访问：目录里还有 .env（含 API key），不能用通用静态文件服务
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/tts-player.js": ("tts-player.js", "text/javascript; charset=utf-8"),
    "/mic-worklet.js": ("mic-worklet.js", "text/javascript; charset=utf-8"),
    "/libopus.js": ("libopus.js", "text/javascript; charset=utf-8"),
}

MAX_TEXT_CHARS = 2000
SERVER_TIMEOUT_MS = 20000  # 前端有自己的更短超时；这里只防止请求无限挂起

logging.basicConfig(level=logging.INFO, format="%(asctime)s [tts] %(message)s")
log = logging.getLogger("tts")


def load_dotenv(path: str) -> None:
    """极简 .env 解析：KEY=VALUE，忽略注释；已存在的环境变量优先。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(os.path.join(HERE, ".env"))

TTS_MODE = os.environ.get("TTS_MODE", "cloud_first").strip()
if TTS_MODE not in ("cloud_first", "local_only"):
    raise SystemExit(f"TTS_MODE 只能是 cloud_first 或 local_only，当前为 {TTS_MODE!r}")
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
VOICE = os.environ.get("GEMINI_TTS_VOICE", "Puck")
PORT = int(os.environ.get("PORT", "5173"))

_client = None


def gemini_client():
    """local_only 模式下永远不会走到这里，SDK 也不会被导入。"""
    global _client
    if _client is None:
        from google import genai
        from google.genai import types

        _client = genai.Client(api_key=API_KEY, http_options=types.HttpOptions(timeout=SERVER_TIMEOUT_MS))
    return _client


def pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # Gemini TTS 输出 16-bit little-endian PCM
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def synthesize(text: str) -> bytes:
    from google.genai import types

    resp = gemini_client().models.generate_content(
        model=MODEL,
        contents=text,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
                )
            ),
        ),
    )
    part = resp.candidates[0].content.parts[0].inline_data
    # mime 形如 audio/L16;codec=pcm;rate=24000
    m = re.search(r"rate=(\d+)", part.mime_type or "")
    return pcm_to_wav(part.data, int(m.group(1)) if m else 24000)


class Handler(BaseHTTPRequestHandler):
    server_version = "t1d-web/1"

    def log_message(self, fmt, *args):
        # 不打印请求体；URL 里没有敏感内容
        log.info("%s %s", self.address_string(), fmt % args)

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/tts/config":
            self._json(200, {
                "mode": TTS_MODE,
                "cloud_available": TTS_MODE == "cloud_first" and bool(API_KEY),
                "voice": VOICE,
            })
            return
        entry = STATIC_FILES.get(path)
        if not entry:
            self._send(404, b"not found", "text/plain")
            return
        with open(os.path.join(HERE, entry[0]), "rb") as f:
            self._send(200, f.read(), entry[1])

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/tts":
            self._send(404, b"not found", "text/plain")
            return
        # local_only：服务端也拒绝，保证就算前端出错也不会有文本发往外部
        if TTS_MODE == "local_only":
            self._json(403, {"error": "local_only"})
            return
        if not API_KEY:
            self._json(503, {"error": "no_api_key"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            text = (json.loads(self.rfile.read(length) or b"{}").get("text") or "").strip()
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "bad_request"})
            return
        if not text or len(text) > MAX_TEXT_CHARS:
            self._json(400, {"error": "bad_text"})
            return

        t0 = time.perf_counter()
        try:
            wav = synthesize(text)
        except Exception as e:  # 配额、模型不可用、网络、超时都走这里，前端会降级
            log.warning("cloud TTS failed after %.1fs: %s: %s", time.perf_counter() - t0,
                        type(e).__name__, str(e)[:300])
            self._json(502, {"error": "cloud_failed", "detail": type(e).__name__})
            return
        log.info("cloud TTS ok: %d chars -> %d bytes in %.1fs", len(text), len(wav), time.perf_counter() - t0)
        self._send(200, wav, "audio/wav")


def main():
    log.info("TTS_MODE=%s, Gemini key %s, model=%s, voice=%s", TTS_MODE,
             "set" if API_KEY else "NOT set", MODEL, VOICE)
    if TTS_MODE == "local_only":
        log.info("local_only: /api/tts 一律 403，不会调用任何云端 TTS")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
