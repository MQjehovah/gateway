import { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { fetch } from 'undici';
import { WebSocket } from 'ws';
import { resolveProvider } from './helpers.js';

const ASR_MODEL = 'voice-asr';
const TTS_MODEL = 'voice-tts';
const ASR_UPSTREAM_MODEL = 'qwen3-asr-0.6b';
const UPSTREAM_ASR_PATH = '/v1/audio/transcriptions';
const UPSTREAM_ASR_STREAM_PATH = '/v1/audio/transcriptions/stream';
const UPSTREAM_TTS_PATH = '/v1/audio/speech';
const UPSTREAM_TTS_STREAM_PATH = '/v1/audio/speech/stream';

function gatewayModel(req: FastifyRequest, fallback: string): string {
  const q = (req.query as any)?.model;
  if (typeof q === 'string' && q.trim()) return q.trim();
  const h = req.headers['x-gateway-model'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const b = (req.body as any)?.model;
  if (typeof b === 'string' && b.trim()) return b.trim();
  return fallback;
}

function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function proxyError(reply: any, status: number, message: string) {
  return reply.status(status).send({
    error: { message, type: 'proxy_error', code: 'audio_proxy_failed' }
  });
}

async function sendUpstreamText(reply: any, response: any) {
  const text = await response.text();
  reply.status(response.status);
  reply.header('content-type', response.headers.get('content-type') || 'application/json');
  return reply.send(text);
}

export async function audioRoutes(fastify: FastifyInstance) {
  // ---------- ASR: multipart 上传 ----------
  fastify.post('/v1/audio/transcriptions', {
    preHandler: [fastify.authenticate, fastify.rateLimit]
  }, async (req, reply) => {
    const model = gatewayModel(req, ASR_MODEL);
    const resolved = await resolveProvider(req, model);
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }

    const part = await (req as any).file();
    if (!part) {
      return reply.status(400).send({
        error: { message: 'file is required', type: 'invalid_request_error', code: 'missing_file' }
      });
    }

    try {
      const buffer = await part.toBuffer();
      const fields = (part as any).fields || {};
      const form = new FormData();
      const blob = new Blob([buffer], { type: part.mimetype || 'application/octet-stream' });
      form.append('file', blob, part.filename || 'audio.wav');
      form.append('model', ASR_UPSTREAM_MODEL);

      for (const name of ['language', 'response_format']) {
        const field: any = fields[name];
        const value = field?.value;
        if (typeof value === 'string' && value.trim()) {
          form.append(name, value.trim());
        }
      }

      const response = await fetch(upstreamUrl(resolved.config.baseUrl, UPSTREAM_ASR_PATH), {
        method: 'POST',
        headers: authHeaders(resolved.config.apiKey),
        body: form as any
      });

      return sendUpstreamText(reply, response);
    } catch (err: any) {
      req.log.error(err, 'ASR proxy failed');
      return proxyError(reply, 502, 'ASR upstream request failed');
    }
  });

  // ---------- TTS: JSON -> wav ----------
  fastify.post('/v1/audio/speech', {
    preHandler: [fastify.authenticate, fastify.rateLimit]
  }, async (req, reply) => {
    const body: any = { ...(req.body as any) };
    const model = gatewayModel(req, TTS_MODEL);
    delete body.model;

    if (!body.input || typeof body.input !== 'string') {
      return reply.status(400).send({
        error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_input' }
      });
    }

    const resolved = await resolveProvider(req, model);
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }

    try {
      const response = await fetch(upstreamUrl(resolved.config.baseUrl, UPSTREAM_TTS_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(resolved.config.apiKey) },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        return sendUpstreamText(reply, response);
      }

      const audio = Buffer.from(await response.arrayBuffer());
      reply.status(response.status);
      reply.header('content-type', response.headers.get('content-type') || 'audio/wav');
      reply.header('content-length', String(audio.length));
      return reply.send(audio);
    } catch (err: any) {
      req.log.error(err, 'TTS proxy failed');
      return proxyError(reply, 502, 'TTS upstream request failed');
    }
  });

  // ---------- TTS: 流式 PCM16 帧 ----------
  fastify.post('/v1/audio/speech/stream', {
    preHandler: [fastify.authenticate, fastify.rateLimit]
  }, async (req, reply) => {
    const body: any = { ...(req.body as any) };
    const model = gatewayModel(req, TTS_MODEL);
    delete body.model;

    if (!body.input || typeof body.input !== 'string') {
      return reply.status(400).send({
        error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_input' }
      });
    }

    const resolved = await resolveProvider(req, model);
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }

    try {
      const response = await fetch(upstreamUrl(resolved.config.baseUrl, UPSTREAM_TTS_STREAM_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(resolved.config.apiKey) },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        return sendUpstreamText(reply, response);
      }
      if (!response.body) {
        return proxyError(reply, 502, 'TTS upstream returned empty stream');
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': response.headers.get('content-type') || 'application/vnd.evs.pcm16-frames',
        'x-audio-sample-rate': response.headers.get('x-audio-sample-rate') || '24000',
        'cache-control': 'no-cache',
        'transfer-encoding': 'chunked'
      });

      const stream = Readable.fromWeb(response.body as any);
      stream.pipe(reply.raw);
      stream.on('error', () => {
        try { reply.raw.destroy(); } catch { /* ignore */ }
      });
      req.raw.on('close', () => {
        stream.destroy();
        try { response.body?.cancel(); } catch { /* ignore */ }
      });
    } catch (err: any) {
      req.log.error(err, 'TTS stream proxy failed');
      if (!reply.raw.headersSent) {
        return proxyError(reply, 502, 'TTS upstream stream failed');
      }
      reply.raw.destroy();
    }
  });

  // ---------- ASR: WebSocket 实时转写 ----------
  fastify.get('/v1/audio/transcriptions/stream', { websocket: true }, (socket, req) => {
    // 同步挂载 message 监听，避免 resolveProvider 期间客户端发来的 start 帧丢失。
    const pending: Array<[any, boolean]> = [];
    let upstream: WebSocket | null = null;
    let closed = false;

    const closeClient = (code: number, reason: string) => {
      try { socket.close(code, reason); } catch { /* ignore */ }
    };
    const closeUpstream = () => {
      try { upstream?.terminate(); } catch { /* ignore */ }
    };

    socket.on('message', (data: any, isBinary: boolean) => {
      if (closed) return;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (pending.length < 256) {
        pending.push([data, isBinary]);
      }
    });
    socket.on('close', () => { closed = true; closeUpstream(); });
    socket.on('error', () => { closed = true; closeUpstream(); });

    (async () => {
      // 浏览器 WS 不能带自定义头，允许 ?api_key= 或 ?token=
      if (!req.headers.authorization) {
        const query: any = req.query || {};
        const token = query.api_key || query.token;
        if (typeof token === 'string' && token.trim()) {
          req.headers.authorization = `Bearer ${token.trim()}`;
        }
      }

      const model = gatewayModel(req, ASR_MODEL);
      const resolved = await resolveProvider(req, model);
      if (!resolved.ok) {
        closeClient(1008, `unauthorized: ${resolved.status}`);
        return;
      }
      if (closed) return;

      const wsUrl = upstreamUrl(resolved.config.baseUrl, UPSTREAM_ASR_STREAM_PATH).replace(/^http/, 'ws');
      upstream = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${resolved.config.apiKey}` }
      });

      const timer = setTimeout(() => {
        closeUpstream();
        closeClient(1011, 'upstream connect timeout');
      }, 10000);

      upstream.on('open', () => {
        clearTimeout(timer);
        while (upstream && upstream.readyState === WebSocket.OPEN && pending.length) {
          const [data, isBinary] = pending.shift()!;
          upstream.send(data, { binary: isBinary });
        }
      });

      upstream.on('message', (data: any, isBinary: boolean) => {
        if (socket.readyState === 1) {
          socket.send(data, { binary: isBinary });
        }
      });

      upstream.on('close', () => {
        clearTimeout(timer);
        closeClient(1000, 'upstream closed');
      });

      upstream.on('error', (err) => {
        clearTimeout(timer);
        req.log.warn({ err }, 'ASR upstream websocket error');
        closeClient(1011, 'upstream error');
      });
    })().catch((err) => {
      req.log.error(err, 'ASR websocket setup failed');
      closeClient(1011, 'gateway error');
    });
  });
}
