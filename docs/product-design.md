# BingwuAI 语聊实时翻译产品设计

## 1. 产品形态

BingwuAI 语聊是一个浏览器内运行的实时语音翻译工具。用户打开页面后选择源语言、目标语言和播报声音，点击通话按钮即可授权麦克风并开始讲话。系统把麦克风 PCM 音频流通过 Cloudflare Worker WebSocket 转发到 Gemini Live API，Gemini 返回目标语言语音、输入转写和输出译文，前端即时播放翻译语音并展示会话文本。

首屏即为可用工作台，不做营销落地页。核心区域包括：

- 顶部状态栏：产品名、连接状态、延迟、主题切换。
- 语言控制区：源语言、目标语言、交换语言、语音角色、自动播放开关。
- 通话区：开始/结束按钮、输入音量波形、输出播放波形、当前系统状态。
- 文本区：源语言实时转写、目标语言译文、会话历史。
- 设置区：模型、音频采样率、响应模式、清空会话。

## 2. 用户流程

1. 用户进入页面，默认源语言为中文，目标语言为英文。
2. 用户调整语言或声音配置。
3. 用户点击开始，浏览器请求麦克风权限。
4. 前端创建到 `/ws/live-translate` 的 WebSocket，并发送 `setup` 消息。
5. 前端用 Web Audio API 采集麦克风音频，转换为 `audio/pcm;rate=16000`，按小片段发送。
6. Worker 连接 Gemini Live API WebSocket，隐藏 `GEMINI_API_KEY`，并透明转发客户端音频和服务端响应。
7. 前端接收 Gemini 的音频分片并排队播放，同时更新转写和译文。
8. 用户点击结束后，前端停止麦克风、关闭 WebSocket、释放音频节点。

## 3. 前端设计

技术栈：Vue 3 CDN、Web Audio API、lucide-vue-next、vue-sonner。

前端状态分层：

- `connection`: idle、connecting、live、closing、error。
- `settings`: sourceLanguage、targetLanguage、voiceName、model、autoPlay。
- `audio`: microphone stream、AudioContext、AudioWorklet/ScriptProcessor、播放队列、输入/输出音量。
- `transcript`: 当前输入转写、当前输出译文、历史消息。

关键浏览器能力：

- `navigator.mediaDevices.getUserMedia({ audio: true })` 获取麦克风。
- Web Audio API 将麦克风采样重采样为 16 kHz PCM16。
- WebSocket 发送 JSON 消息，音频数据使用 base64 编码。
- AudioContext 解码服务端返回的 PCM 音频并顺序播放。

页面布局原则：

- 响应式双栏：桌面端左侧控制、右侧文本；移动端纵向堆叠。
- 支持浅色/深色模式，遵守系统主题，可手动切换。
- 工作台风格，信息密度适中，不使用营销型 hero。
- 通话主按钮固定尺寸，避免状态文本导致布局跳动。

## 4. 后端设计

技术栈：Cloudflare Workers。Worker 负责静态资源托管、健康检查和 WebSocket 代理。

路由：

- `GET /`：通过 `ASSETS` 返回前端静态页面。
- `GET /api/health`：返回服务状态、版本和当前时间。
- `GET /ws/live-translate`：升级为 WebSocket，连接 Gemini Live API。

环境变量：

- `GEMINI_API_KEY`：Gemini API Key，仅保存在 Worker secret 中。

Worker WebSocket 职责：

- 校验请求是否为 WebSocket Upgrade。
- 创建客户端 WebSocketPair。
- 使用服务端 API Key 连接 Gemini Live API WebSocket。
- 把前端消息转发给 Gemini。
- 把 Gemini 响应转发给前端。
- 在任一端关闭或错误时同步关闭另一端。
- 不在浏览器暴露 Gemini API Key。

Gemini Live API WebSocket 地址：

```text
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<GEMINI_API_KEY>
```

## 5. 前后端消息协议

客户端到 Worker：

```json
{
  "type": "setup",
  "sourceLanguage": "zh-CN",
  "targetLanguage": "en-US",
  "voiceName": "Puck",
  "model": "models/gemini-2.0-flash-live-001"
}
```

Worker/Gemini setup 消息：

```json
{
  "setup": {
    "model": "models/gemini-2.0-flash-live-001",
    "generationConfig": {
      "responseModalities": ["AUDIO"]
    },
    "systemInstruction": {
      "parts": [
        {
          "text": "Translate the user's spoken source language into the target language. Respond only with the translated speech."
        }
      ]
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {}
  }
}
```

音频上行：

```json
{
  "realtimeInput": {
    "mediaChunks": [
      {
        "mimeType": "audio/pcm;rate=16000",
        "data": "<base64 pcm16>"
      }
    ]
  }
}
```

服务端下行：

- `setupComplete`：会话可开始发送音频。
- `serverContent.inputTranscription`：源语言转写。
- `serverContent.outputTranscription`：目标语言译文。
- `serverContent.modelTurn.parts[].inlineData`：目标语言音频分片。
- `serverContent.turnComplete`：当前语音轮次结束。

## 6. 错误与降级

- 浏览器不支持麦克风或 Web Audio：展示明确错误。
- 用户拒绝麦克风权限：停留在 idle 状态并给出提示。
- Worker 未配置 `GEMINI_API_KEY`：`/api/health` 和 WebSocket 返回配置错误。
- Gemini WebSocket 连接失败：前端停止录音并显示错误 toast。
- 音频播放失败：保留文本翻译展示，提示用户检查浏览器自动播放设置。

## 7. 验收标准

- 页面可直接作为实时翻译工作台使用。
- API Key 不出现在前端源码或网络请求参数中。
- 可以建立 `/ws/live-translate` WebSocket。
- 点击开始后能采集麦克风、发送 PCM16 音频。
- 能处理 Gemini 返回的 setup、转写、译文和音频分片。
- 结束会话后麦克风、WebSocket、AudioContext 均被释放。
- 深浅色主题、移动端布局和基础错误态可用。
