# xiaozhi WebSocket 协议（web-client 用）

所有结论都来自 server 源码和官方测试页，不凭记忆写。
`S/` = `src/xiaozhi-esp32-server/main/xiaozhi-server/`
`T/` = 官方测试页目录。它不在 `S/` 下，只存在于 `xiaozhi-server-andrea.zip` 的 `xiaozhi-server/test/` 里。
`T/js/utils/libopus.js` 和 `src/xiaozhi-esp32-server/main/digital-human/js/utils/libopus.js` 逐字节相同。

---

## 1. 连接与握手

URL：`wss://${location.host}/xiaozhi/v1/?device-id=<id>&client-id=<uuid>`

- 浏览器的 WebSocket 不能自定义 header，所以身份信息放在 query 里。
- `S/core/websocket_server.py:103`：header 里没有 `device-id` 时，解析 URL query：
  - `:115-119`：query 里也没有 `device-id` 时，server 发送纯文本 `"The port is working. To test use... test_page.html"` 后关闭连接。
  - `:121`：把 query 的 `device-id` 写回 header。
  - `:122-123`：把 `client-id` 写回 header（可选）。
  - `:124-127`：把 `authorization` 写回 header（可选）。
- `S/core/connection.py:230`：`client_id` 缺省时回退为 `device_id`。
- `S/core/connection.py:233-240`：`device-id == "b0:a6:04:5b:d7:98"` 会被强制映射到固定的 client-id。web-client 不要使用这个 device-id。
- 普通 HTTP 请求（非 Upgrade）返回 `200 "Server is running"`（`websocket_server.py:168-175`）。
- `S/core/connection.py:273`：连接后后台初始化 ASR 等组件。完成后 server 主动推送一条：
  `{"type":"stt","state":"listening","session_id":...}`（`connection.py:577`）。这条消息**没有 `text` 字段**。

### 鉴权：关闭

- `websocket_server.py:64-65`：`auth_enable = config["server"].get("auth", {}).get("enabled", False)`。
- `config.yaml` 和 `data/.config.yaml` 内容相同，`server:` 段里都没有 `auth:`，所以值为 **False**，`_handle_auth` 直接跳过。
  文件第 3 行的 `enabled: false` 属于 `manager_api`，和鉴权无关。
- 因此不需要 `authorization` 参数。

### 消息门控

`connection.py:358-384`：除 hello 以外的消息，要等 `bind_completed_event` 就绪（最多等 1 秒），超时的消息会被丢弃。
客户端应先完成 hello 往返，再发 listen 和音频。

---

## 2. hello

**客户端 → server**（server 只读取 `audio_params.format` 和 `features`，见 `S/core/handle/helloHandle.py:45-52`）：

```json
{
  "type": "hello",
  "version": 1,
  "transport": "websocket",
  "features": { "mcp": false },
  "audio_params": { "format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60 }
}
```

- `audio_params.format` 会写入 `conn.audio_format`。必须是 `"opus"`：填 `"pcm"` 时 TTS 走 PCM 分支，见 `S/core/providers/tts/base.py:497`。
- 不带 `audio_params` 时 `audio_format` 保持默认值 `"opus"`（`connection.py:118`）。
- 官方测试页发送的是 `{type, device_id, device_name, device_mac, token, features:{mcp:true}}`（`T/js/core/network/websocket.js:29-38`），这些字段 server 都不读取。
- `features.mcp: true` 会让 server 在第一条非 hello 消息时发起 MCP `initialize` 和 `tools/list`（`textMessageProcessor.py:31-39`），客户端需要回复。**web-client 建议填 `mcp: false`**。

**server → 客户端**（`helloHandle.py:59-74`，发送前 sleep 0.1 秒）：

```json
{
  "type": "hello",
  "version": 1,
  "transport": "websocket",
  "auth_key": "<config.xiaozhi.auth_key>",
  "session_id": "<uuid hex>",
  "message": "success",
  "features": { "...客户端的 features...": "", "mcp": true },
  "audio_params": { "format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration": 60 }
}
```

- `version` 和 `transport` 回显客户端的值，缺省分别为 `1` 和 `"websocket"`。
- 回复里的 `features.mcp` **总是被强制设为 true**。它只是回显，不影响 server 行为，server 行为只看客户端发来的 `features`。
- **TTS 采样率：16000 Hz**。这个值在回复里是硬编码的；实际编码出的 TTS 也是 16k，原因见第 5 节。

---

## 3. 客户端 → server 消息

分发入口在 `S/core/handle/textMessageProcessor.py`，类型定义在 `textMessageType.py`：`hello / abort / listen / iot / mcp / server / ping`。

### listen（`S/core/handle/textHandler/listenMessageHandler.py`）

| 字段 | 说明 |
|---|---|
| `type` | `"listen"` |
| `mode` | 可选：`"manual"` / `"auto"` / `"realtime"`。只要带上就会写入 `conn.client_listen_mode`（`:30-31`），默认值为 `"auto"`（`connection.py:128`） |
| `state` | **必填**。`:35` 直接用 `msg_json["state"]` 读取，缺少时抛 KeyError |
| `text` | 仅在 `state:"detect"` 时使用 |

- **start**（`:35-37`）：`reset_audio_states()`，清空之前缓存的音频。
  在 manual 模式下，之后收到的每个二进制帧都会追加到 `conn.asr_audio`（`S/core/providers/asr/base.py:75-77`），不经过 VAD 判定。
- **stop**（`:38-54`）：设置 `client_voice_stop = True`。
  - 当前 ASR 是 `fun_local`，属于非流式：把 `asr_audio` 拷贝出来、重置，然后调用 `handle_voice_stop`，把 opus 解码为 16k PCM 后识别。
  - `asr_audio` 为空时什么都不做，也**不会回复任何消息**。
  - `conn.asr is None`（尚未初始化完）时直接 return。
- **detect**（`:55-116`）：清空音频状态。带 `text` 时把它当作用户文本输入：
  - 以 `[device_call]` 开头：直接用 TTS 念出后面的文本。
  - 命中 `wakeup_words`：按唤醒词流程处理。
  - 其他文本：`startToChat(text)`，等同于语音识别出这段文本后的流程。
  - 官方测试页的文字输入就是这样发的：`{"type":"listen","mode":"manual","state":"detect","text":"..."}`（`T/js/core/network/websocket.js:422-427`）。

按住说话的完整时序：

```
按下 → {"type":"listen","mode":"manual","state":"start"}
     → 二进制 opus 帧 × N（每帧 60ms）
松开 → （测试页会先发一个 0 字节的二进制帧，可省略；server 解码时跳过空包，见 asr/base.py:337）
     → {"type":"listen","mode":"manual","state":"stop"}
```

注意：二进制帧先进入 `asr_audio_queue`，由另一个线程搬到 `asr_audio`。stop 是文本消息，处理路径不同。所以最后几帧可能在 stop 处理时还没搬过去，建议最后一帧发出后稍等（约 100ms）再发 stop。

### abort（`S/core/handle/abortHandle.py`）

- 客户端发送：`{"type":"abort"}`。server **不读取任何其他字段**。
  测试页还会带 `session_id` 和 `reason:"wake_word_detected"`，这两个字段没有作用。
- server 的处理：设置 `client_abort = True`，清空队列，并回复 `{"type":"tts","state":"stop","session_id":...}`（`:16-18`）。
- `client_abort` 在下一轮 TTS 收到 `SentenceType.FIRST` 时清除（`S/core/providers/tts/base.py` 的 `tts_text_priority_thread`）。这一行在移植时丢过，2026-09-24 已恢复；没有它的话，打断一次后所有回复都会被丢掉。
- **严格门控**：`client_is_speaking=True` 期间，ASR 线程会**丢弃所有上行音频**（`S/core/providers/asr/base.py` 的 `asr_text_priority_thread`）。这个标记在识别出文字后变成 True，在 `tts stop` 或 abort 时清除。所以 TTS 还在播放时按下说话，**必须先发 abort**，否则这段录音会被直接丢掉。

### ping

- 客户端发送：`{"type":"ping"}`。
- 只有配置了 `enable_websocket_ping: true` 才会回复 `{"type":"pong","timestamp":"..."}`，当前配置里没有打开，所以会被忽略。

### 其他

- 非 JSON 文本会被原样发回（`textMessageProcessor.py:53-56`）。
- 纯数字 JSON 也会被原样发回。

---

## 4. server → 客户端消息

| 消息 | 字段 | 来源 |
|---|---|---|
| stt（就绪） | `{"type":"stt","state":"listening","session_id"}`（**无 text**） | `connection.py:577` |
| stt（识别结果） | `{"type":"stt","text","session_id"}`，text 已去掉标点和 emoji | `sendAudioHandle.py:316-319` |
| stt（纯显示） | `{"type":"stt","text","session_id"}` | `sendAudioHandle.py:325-332` |
| llm | `{"type":"llm","text":"<一个emoji>","emotion":"happy 等","session_id"}`，每轮只在开头发一次，**text 只有表情，不是回复正文** | `S/core/utils/textUtils.py:89-111`，调用处 `connection.py:1802-1808` |
| tts start | `{"type":"tts","state":"start","session_id"}`，紧跟在识别结果 stt 之后 | `sendAudioHandle.py:320` |
| tts sentence_start | `{"type":"tts","state":"sentence_start","text","session_id"}`，每句开始时发一次，text 已去掉 emoji 和换行 | `sendAudioHandle.py:30-43, 267-273` |
| tts sentence_start（全文） | 同上的格式，但 text 是**整轮 LLM 回复全文**，会在音频还在播放时额外发一次 | `connection.py:2170-2186` |
| tts stop | `{"type":"tts","state":"stop","session_id"}`，server 会**等音频包全部发完**（再多等 7×60ms 预缓冲时间）才发送 | `sendAudioHandle.py:50-52, 276-291` |
| hello | 见第 2 节 | |
| 二进制 | 裸 opus 包，16k、单声道、60ms 一帧，每个 WebSocket 消息一个包，无包头 | `sendAudioHandle.py:259-260` |

- `sentence_end` 在 server 代码里没有发送点，测试页处理了它，但实际不会收到。
- 带 16 字节包头的格式只用于 `?from=mqtt_gateway` 连接，与浏览器无关。
- 发送节奏：每轮前 5 个包立即发出，之后由 `AudioRateController` 按每 60ms 一包的实时速率发送（`sendAudioHandle.py:234-243`）。
- 测试页收到 `tts stop` 时会调用 `clearAllAudio()` 清空播放缓冲（`T/js/core/network/websocket.js:153-158`）。
  server 发 stop 前已经等了预缓冲时间，但客户端如果自己缓冲得更多，照抄这个做法会截掉句尾。**web-client 建议收到 stop 后让已排队的音频自然播完**，只有 abort 时才清空。

一轮语音对话的典型顺序：

```
stt(text) → tts start → llm(emoji) → tts sentence_start(全文) → tts sentence_start(句子1) → [opus...] → ... → tts stop
（2026-09-23 本机实测：短回复时“全文”那条先于逐句那条到达，两者先后不固定）
```

---

## 5. TTS 实际采样率（核对结果）

- `connection.py:119` 的 `self.sample_rate = 24000` 带有注释“从 hello 更新”，但 `helloHandle.py` **并没有更新它**。
- 当前 TTS 是 `edge`，配置 `delete_audio: false`，所以走写文件分支：
  `base.py:_process_audio_file_stream` → `audio_to_opus_data_stream` → `util.audio_to_data_stream`（默认 `sample_rate=16000`）。
- 这条路径用 pydub 把音频 `set_frame_rate(16000)`，编码器也硬编码为 `Encoder(16000, 1, …)`（`S/core/utils/util.py:275, 387`）。
- **结论：发给客户端的 opus 是 16 kHz，与 hello 回复一致。**

✅ **已修复（2026-09-23，经确认后修改）**：
`S/core/utils/util.py` 的 `pcm_to_data_stream` 原来只接受 3 个参数，并用到未定义的 `sample_rate`，而两个调用方都传 5 个参数，TTS 编码会抛 `TypeError`。
现在它接受 `sample_rate` 和 `opus_encoder` 两个参数，但忽略它们，固定按 16k、每帧 960 个采样点编码。理由：两个调用方在调用前都已把 PCM 重采样到 16k。
已用 server 的 venv 拿一个真实的 edge TTS mp3 验证：文件路径和 bytes 路径都能输出合法的 16k Opus 包（每包 960 个采样点）。**server 需要重启才会生效。**

---

## 6. 测试页如何使用 libopus.js

**加载**

- `T/test_page.html:248`：用普通 `<script src="js/utils/libopus.js">` 引入，不是 module。
- 这个文件是 Emscripten 的 **asm.js** 构建（没有 WebAssembly），同步初始化。文件末尾是：
  `var Module = function(Module){...; return Module;}; Module.instance = Module();`
- `T/js/core/audio/opus-codec.js:6-43` 的 `checkOpusLoaded()`：
  - 优先使用 `Module.instance`（检查 `_opus_decoder_get_size` 是否是函数）。
  - 否则使用全局 `Module`。
  - 结果存到 `window.ModuleInstance`。

**编码器**（`opus-codec.js:48-186`，单例）

```
size = mod._opus_encoder_get_size(1)
enc  = mod._malloc(size)
mod._opus_encoder_init(enc, 16000, 1, 2048 /*OPUS_APPLICATION_VOIP*/)   // <0 表示失败
mod._opus_encoder_ctl(enc, 4002, 16000)  // OPUS_SET_BITRATE 16kbps
mod._opus_encoder_ctl(enc, 4010, 5)      // OPUS_SET_COMPLEXITY
mod._opus_encoder_ctl(enc, 4016, 1)      // OPUS_SET_DTX
```

每帧编码：

```
pcmPtr = _malloc(960*2); 逐个写入 HEAP16[(pcmPtr>>1)+i]
outPtr = _malloc(4000)
len = _opus_encode(enc, pcmPtr, 960, outPtr, 4000)       // <0 表示失败
从 HEAPU8[outPtr .. outPtr+len) 拷出 Uint8Array
_free(pcmPtr); _free(outPtr)
```

输入是 Int16Array，长度必须正好 960（16k 下的 60ms）。

⚠️ **测试页的 ctl 用法是错的（2026-09-24 实测）**：在 asm.js 构建里，`_opus_encoder_ctl` 的变参要以**指向堆内存的指针**传入。测试页直接传 `16000`，实测会把码率设成 **300000**。正确写法：先 `HEAP32[p>>2]=24000`，再调用 `_opus_encoder_ctl(enc, 4002, p)`，用 `OPUS_GET_BITRATE`(4003) 读回来是 24000。web-client 用的是指针写法。

**解码器**（`T/js/core/audio/player.js:36-148`）

```
size = _opus_decoder_get_size(1); dec = _malloc(size)
_opus_decoder_init(dec, 16000, 1)
```

每包解码：

```
opusPtr = _malloc(len); HEAPU8.set(data, opusPtr)
pcmPtr  = _malloc(960*2)
n = _opus_decode(dec, opusPtr, len, pcmPtr, 960, 0)      // n = 采样点数，<0 表示失败
从 HEAP16[(pcmPtr>>1) ..] 拷出 n 个 Int16；_free 两块内存
```

之后 `Int16/32768` 转为 Float32，在一个 `sampleRate:16000` 的 AudioContext 上每 120ms 调度一个 `AudioBufferSource` 播放（`T/js/core/audio/stream-context.js`）。

**采集**（`T/js/core/audio/recorder.js`）

- 用 AudioWorklet 按 960 个采样点一帧，把 float 转成 int16 后 postMessage 给主线程，主线程编码后 `ws.send(opus.buffer)`。
- 它**假设 AudioContext 就是 16k**（`new AudioContext({sampleRate:16000})`），自己没有做降采样。
  iOS Safari 上这个假设不可靠。按 instruction.md 的要求，web-client 必须在 worklet 里从 `sampleRate`（44.1k/48k）降到 16k，再按 960 采样点切帧。
- 测试页的 `getUserMedia` 约束：`{echoCancellation:true, noiseSuppression:true, sampleRate:16000, channelCount:1}`。

---

## 7. web-client 实现要点（据上文推出）

1. 连接：`wss://${location.host}/xiaozhi/v1/?device-id=…&client-id=…`，设置 `binaryType='arraybuffer'`。
2. onopen 后发 hello（`features.mcp:false`、`audio_params.format:"opus"`），等收到带 `session_id` 的 hello 回复。
3. 按下时：如果正在播放，先发 `{"type":"abort"}` 并清空播放队列；然后发 `listen start (mode:"manual")`，开始发送 opus 帧。
4. 松开时：flush 剩余 PCM（不足 960 个采样点补零），稍等后发 `listen stop`。
5. 显示：`stt.text` 是用户说的话；`tts sentence_start.text` 是助手的话；`llm` 只用来显示表情。
6. 一律按 16k、单声道、960 个采样点处理接收到的 opus。
