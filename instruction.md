# web-client：xiaozhi 手机浏览器客户端（研究 demo）

## 目标
iPhone Safari 上的语音对话客户端，连接本机的 xiaozhi-esp32-server。
用于导师组会 demo：按住说话 → 本地 ASR/LLM/TTS → 语音回复。

## 相关路径
- Server: /Users/andreatang/Downloads/Research/src/xiaozhi-esp32-server/main/xiaozhi-server
  （WebSocket 8000 端口，路径 /xiaozhi/v1/）
- 官方浏览器测试页：server 仓库 test 目录下的 test_page.html 和 libopus.js
- 本客户端：/Users/andreatang/Downloads/Research/web-client

## 部署
- Tailscale serve 提供 HTTPS：/ → 127.0.0.1:5173（静态页），/xiaozhi/v1 → 127.0.0.1:8000
- 页面和 WebSocket 同源：wss://${location.host}/xiaozhi/v1/?device-id=...&client-id=...

## 硬性约束
- 纯 HTML + 原生 JS，不用任何框架和构建工具，不引入 npm 依赖
- 音频是裸 Opus 包（16kHz、单声道、60ms 即 960 个采样点），不用 MediaRecorder
- Opus 编解码复用 test 目录里的 libopus.js
- 麦克风采集用 AudioWorklet，自己降采样到 16kHz，不依赖 AudioContext 的 sampleRate 参数
- 交互用 listen mode "manual"（按住说话）
- AudioContext 和 getUserMedia 必须在用户点击事件里启动（iOS 要求）
- 不修改 server 代码；如果确实需要改，先说明原因，等我确认

## 工作方式
- 协议细节以 server 源码为准，不要凭记忆写
- 每个关键事件都打 console.log，带 [ws] [audio] [mic] 前缀，方便我在手机上排查
- 你无法在 iPhone 上测试：每步结束时告诉我具体怎么验证，我会把结果和日志贴回来