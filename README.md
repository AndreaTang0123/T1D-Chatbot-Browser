# T1D Chat — 浏览器客户端

iPhone Safari / 桌面浏览器上的语音对话页，连接本机的 xiaozhi-esp32-server。
按住说话 → server 本地 FunASR 识别 → LLM 回复 → **浏览器端朗读**（Gemini Puck 云端语音优先，失败时降级为浏览器自带语音）。

## 数据去向（先读这一节）

| 环节 | 在哪里处理 | 是否离开本机 |
|---|---|---|
| 语音识别 | server 本地 FunASR | 否 |
| 回复生成 | Ollama **云端**模型 `gemma4:31b-cloud` | **是**：persona、CGM/pump 数据、对话内容都会发到 Ollama 服务器 |
| 朗读：`cloud_first` | Google Gemini TTS | **是**：回复文本（可能含血糖值、胰岛素剂量）发到 Google |
| 朗读：`local_only` | 浏览器 `speechSynthesis` | 否（详见下方注意事项） |

- web-client 在 hello 里发 `features.server_tts: false`，server 不再用 Edge TTS 合成语音，所以回复文本**不会**发给微软。ESP32 设备不受影响，仍然使用 Edge TTS。
- **`local_only` 只管朗读这一步。** 只要 LLM 还是 `gemma4:31b-cloud`，对话内容就会离开本机。要做到真正全本地，需要把 server `config.yaml` 里 `LLM.openai.model_name` 改回本地模型（例如 `qwen2.5:3b`）。

## 启动

```bash
cd T1D-Chatbot-Browser
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # 只需一次
cp .env.example .env                                                 # 只需一次，然后填写 key
.venv/bin/python serve.py                                            # 替代原来的 python3 -m http.server 5173
```

server（`.venv311/bin/python app.py`）和 Tailscale serve 的启动方式不变。`serve.py` 仍然监听 `127.0.0.1:5173`，`/api/tts` 跟页面同源。

## 配置

都写在 `.env` 里（已在 `.gitignore` 中，不会进 git），也可以直接用环境变量，环境变量优先：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TTS_MODE` | `cloud_first` | `cloud_first`：云端优先，浏览器兜底；`local_only`：只用浏览器语音，`/api/tts` 一律返回 403 |
| `GEMINI_API_KEY` | （空） | 在 [Google AI Studio](https://aistudio.google.com/apikey) 申请。为空时自动用浏览器语音 |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Google 推荐的后继模型是 `gemini-3.8-flash-tts` |
| `GEMINI_TTS_VOICE` | `Puck` | |

- 改 `.env` 后要重启 `serve.py`。
- 临时在某台设备上只用本地语音：打开页面时加 `?tts=local_only`。这个参数只能降级，不能在 `local_only` 的 server 上强制使用云端。

## 界面标识

右上角的标签显示当前（或下一轮）使用的语音：

- `✨ Puck Neural Voice`：Gemini 云端语音
- `✨ Puck Voice (Browser)`：浏览器语音。出现在 `local_only` 模式、没有配置 key，或者云端失败之后

降级的触发条件：没有 key、配额超限、模型不可用、网络错误，或者第一段音频 5 秒内没有返回。降级后 60 秒内的回复都直接用浏览器语音，避免每轮都要等超时；60 秒后自动重试云端。

## 下载高质量浏览器语音（推荐）

浏览器语音优先使用系统里的 Premium/Enhanced 声音：

- 英文：Ava (Premium) → Zoe (Premium) → Evan (Enhanced)
- 中文：Tingting / Meijia 的 Enhanced 或 Premium 版本

都没有时使用系统默认声音。Chrome 里名字带 "Google" 的声音是联网合成的，不会被优先选用。

- **macOS**：System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → 下载上面的声音
- **iOS**：Settings → Accessibility → Spoken Content → Voices → English / 中文 → 下载对应声音

下载完成后要刷新页面，Safari 有时需要完全关闭后重新打开。

## 手动测试

每个测试都打开浏览器控制台，日志以 `[tts]` 开头。iPhone 可以用 Mac Safari 的「开发」菜单连接查看。

**1. 云端正常**
1. `.env` 中设 `TTS_MODE=cloud_first` 并填写有效的 `GEMINI_API_KEY`，重启 `serve.py`。
2. 打开页面，点一下任意位置（iOS 需要用这一下解锁声音），然后发一条消息。
3. 预期结果：
   - 标签显示 `✨ Puck Neural Voice`，能听到 Puck 的声音；
   - 控制台有 `path=cloud` 和 `cloud chunk 1/N ready in …ms`；
   - `serve.py` 终端有 `cloud TTS ok: N chars -> … bytes`。

**2. 云端失败，自动降级**
1. 把 `.env` 里的 `GEMINI_API_KEY` 改成一个错误的值（例如在末尾加个 `x`），重启 `serve.py`。
2. 发一条消息。
3. 预期结果：
   - 1 秒内改为浏览器语音读出，标签变成 `✨ Puck Voice (Browser)`；
   - 控制台有 `cloud failed, falling back to browser voice: HTTP 502`；
   - `serve.py` 终端有 `cloud TTS failed … API key not valid`。
4. 想测超时的话：断开 Mac 的网络（保持 Tailscale 连接）再发消息，约 5 秒后应该降级。
5. 测完把 key 改回来。

**3. `local_only`**
1. `.env` 中设 `TTS_MODE=local_only`，重启 `serve.py`。终端应打印 `local_only: /api/tts 一律 403`。
2. 发一条消息。
3. 预期结果：标签显示 `✨ Puck Voice (Browser)`，控制台有 `path=browser`。
4. 确认没有文本被发往外部：
   - `serve.py` 终端不应出现任何 `POST /api/tts` 记录；
   - 浏览器 Network 面板里不应有 `/api/tts` 请求；
   - server 日志（`src/xiaozhi-esp32-server/main/xiaozhi-server/data/app.log` 或启动终端）里，这一轮不应出现 `TTS generation success` 或 `core.providers.tts.edge` 的记录。启动时那条 `Component initialized: TTS success edge` 只是初始化，不是合成。只有 ESP32 设备说话时才会出现合成记录。

## 文件

- `index.html`、`app.js`：页面和 xiaozhi 协议（见 `PROTOCOL.md`）
- `tts-player.js`：朗读组件，负责云端/浏览器切换、选声音和 iOS 解锁
- `serve.py`：静态文件服务（白名单）加 `/api/tts`
- `mic-worklet.js`、`libopus.js`：麦克风采集和 Opus 编码
