# 语音网关（ASR / TTS）接入

网关把 45 上的语音服务（`http://192.168.31.45:19811`）统一到 LLM 网关的鉴权与入口下。客户端只使用**网关 API Key**，语音服务的 `VOICE_API_KEY` 只保存在网关的 `Voice` provider 里，不下发。

## 入口

| 能力 | 公网入口 | 内网入口（45 本机/容器） |
|---|---|---|
| ASR（multipart） | `POST https://ai.rosiwit.com/gateway/api/v1/audio/transcriptions` | `POST http://192.168.31.45:3100/v1/audio/transcriptions` |
| TTS（wav） | `POST https://ai.rosiwit.com/gateway/api/v1/audio/speech` | `POST http://192.168.31.45:3100/v1/audio/speech` |
| TTS 流式（PCM16 帧） | `POST https://ai.rosiwit.com/gateway/api/v1/audio/speech/stream` | `POST http://192.168.31.45:3100/v1/audio/speech/stream` |
| ASR 实时（WS） | `wss://ai.xzrobot.com/gateway/api/v1/audio/transcriptions/stream` | `ws://192.168.31.45:3100/v1/audio/transcriptions/stream` 或 `wss://192.168.31.45/gateway/api/v1/audio/transcriptions/stream` |

根路径 `/v1/audio/*` 也做了同样的反代（`https://ai.rosiwit.com/v1/audio/...`），方便 OpenAI SDK 兼容客户端。

## 鉴权

```http
Authorization: Bearer <网关 API Key>
```

- 网关 Key 与现有 chat/embeddings 共用，受 `rateLimit` 限制；音频不按 token 计费，暂不写 token 用量。
- 浏览器 WebSocket 不能带自定义头，可用 `?api_key=<网关 Key>` 或 `?token=<网关 Key>`。

## 模型名

| 网关模型 | 上游 | 场景 |
|---|---|---|
| `voice-asr` | `qwen3-asr-0.6b` | 短音频、非流式 |
| `voice-asr-moss` | `moss-transcribe-diarize` | 会议转写、长音频、SSE 流式 |
| `voice-tts` | Qwen3-TTS CustomVoice（`voice: default`） | 语音合成 |

ASR 可以省略 `model`：

- 非流式请求默认 `voice-asr`；
- 带 `stream=true` 的请求默认 `voice-asr-moss`；
- 也可以用 `?model=voice-asr` / `?model=voice-asr-moss` 显式指定。

网关会把表单里的 `model` 改写成对应上游模型名再转发。TTS 请求体里的 `model` 会被网关移除（默认 `voice-tts`）。

## 示例

短音频 ASR：

```bash
curl -H "Authorization: Bearer $GATEWAY_KEY" \
  -F file=@sample.wav \
  -F model=voice-asr \
  https://ai.rosiwit.com/gateway/api/v1/audio/transcriptions
```

会议转写（SSE 流式，长音频）：

```bash
curl -N \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -F file=@meeting.wav \
  -F stream=true \
  -F max_new_tokens=65536 \
  https://ai.xzrobot.com/gateway/api/v1/audio/transcriptions
```

响应为 `text/event-stream`：

```text
event: transcript.text.delta
data: {"type":"transcript.text.delta","delta":"..."}

event: transcript.text.done
data: {"type":"transcript.text.done","text":"...","model":"moss-transcribe-diarize","usage":{...}}
```

也可以显式指定模型：

```bash
-F model=voice-asr-moss
```

TTS：

```bash
curl -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"input":"你好，我是零号员工。","voice":"default"}' \
  -o reply.wav \
  https://ai.rosiwit.com/gateway/api/v1/audio/speech
```

TTS 流式：响应 `Content-Type: application/vnd.evs.pcm16-frames`，采样率见 `X-Audio-Sample-Rate`；帧格式为 1 字节标签 + 4 字节大端长度 + 负载，`A` 音频、`E` 结束、`X` 错误。

ASR 实时（内网）：

```text
ws://192.168.31.45:3100/v1/audio/transcriptions/stream?model=voice-asr&api_key=<网关 Key>
```

发送 `{"type":"start","version":1,"language":"auto","model":null}`，收到 `started` 后发 16k 单声道 PCM16 小端二进制帧，结束时发 `{"type":"end"}`。

## 公网 WebSocket

两个域名的公网链路不同：

- `ai.xzrobot.com`：公网 DNS → `36.154.118.170`，直接回源到 45 的 nginx（`*.xzrobot.com` 证书），**WebSocket 正常**。
- `ai.rosiwit.com`：公网 DNS → `118.31.13.249`，先到一台前置 nginx（`Server: nginx/1.30.6`，`*.rosiwit.com` 证书），该前置代理不转发 WebSocket，升级请求返回 404；HTTP 的 ASR/TTS 正常。

所以实时 ASR 请使用 `ai.xzrobot.com`：

```text
wss://ai.xzrobot.com/gateway/api/v1/audio/transcriptions/stream?model=voice-asr&api_key=<网关 Key>
```

如果必须在 `ai.rosiwit.com` 上使用 WS，需要改 `118.31.13.249` 前置 nginx（增加 `Upgrade`/`Connection` 转发），或新增一个直连 `36.154.118.170` 的子域名（需要匹配的 `*.rosiwit.com` 证书）。

## 部署位置

- 网关 provider：
  - `Voice` → `http://192.168.31.45:19811`（短音频 ASR / TTS）
  - `Voice-MOSS` → `http://192.168.31.34:8311`（会议转写 ASR，SSE）
- 模型：`voice-asr`、`voice-asr-moss`、`voice-tts`（价格 0）
- nginx：`ai-services.conf` 的 `/gateway/api/v1/audio/` 与 `/v1/audio/` location（`proxy_buffering off`、`proxy_request_buffering off`、WS Upgrade、3600s）
- 语音服务：45 上的 `enterprise-voice-api-45`（19811）；会议转写服务在 34 的 `8311` 端口。

## 已知限制

- 音频请求不写 `UsageRecord`（没有 token 口径），目前只走网关访问日志与限流。
- `voice-asr`（qwen3）适合短音频，单次上限约 300 秒；长会议请用 `voice-asr-moss` + `stream=true`。
- 会议转写网关侧使用独立 undici dispatcher，已关闭 5 分钟 body/headers 超时；仍受 nginx 3600 秒限制。
- 公网 WS 受 WAF 限制（见上）。
