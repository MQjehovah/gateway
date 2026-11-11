import { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { Agent, fetch } from 'undici';
import { WebSocket } from 'ws';
import { resolveProvider } from './helpers.js';

const ASR_MODEL = 'voice-asr';
const ASR_STREAM_MODEL = 'voice-asr-moss';
const TTS_MODEL = 'voice-tts';
const ASR_UPSTREAM_MODEL = 'qwen3-asr-0.6b';
const ASR_UPSTREAM_MODELS: Record<string, string> = {
  [ASR_MODEL]: ASR_UPSTREAM_MODEL,
  [ASR_STREAM_MODEL]: 'moss-transcribe-diarize'
};
const UPSTREAM_ASR_PATH = '/v1/audio/transcriptions';
const UPSTREAM_ASR_STREAM_PATH = '/v1/audio/transcriptions/stream';
const UPSTREAM_TTS_PATH = '/v1/audio/speech';
const UPSTREAM_TTS_STREAM_PATH = '/v1/audio/speech/stream';

// 会议转写可能持续几十分钟；关闭 undici 的 5 分钟 body/headers 超时。
const ASR_DISPATCHER = new Agent({
  connect: { timeout: 120000 },
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 120000
});

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
  // ---------- ASR: multipart 上传（支持 SSE 流式） ----------
  fastify.post('/v1/audio/transcriptions', {
    preHandler: [fastify.authenticate, fastify.rateLimit]
  }, async (req, reply) => {
    let filePart: any = null;
    let buffer: Buffer | null = null;
    const fields: Record<string, string> = {};

    try {
      // 用 parts() 而不是 file().fields：保证 file 之后出现的 stream/max_new_tokens 也被读取。
      for await (const part of (req as any).parts()) {
        if (part.type === 'file') {
          if (filePart) {
            part.file.resume();
            continue;
          }
          filePart = part;
          buffer = await part.toBuffer();
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (err: any) {
      req.log.warn(err, 'ASR multipart parse failed');
      return reply.status(400).send({
        error: { message: 'invalid multipart body', type: 'invalid_request_error', code: 'invalid_multipart' }
      });
    }

    if (!filePart || !buffer) {
      return reply.status(400).send({
        error: { message: 'file is required', type: 'invalid_request_error', code: 'missing_file' }
      });
    }

    const streamRequested = ['1', 'true', 'yes', 'on'].includes(
      String(fields.stream || '').trim().toLowerCase()
    );
    const formModel = String(fields.model || '').trim();
    const model =
      gatewayModel(req, '') ||
      formModel ||
      (streamRequested ? ASR_STREAM_MODEL : ASR_MODEL);

    const resolved = await resolveProvider(req, model);
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }

    try {
      const form = new FormData();
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: filePart.mimetype || 'application/octet-stream' });
      form.append('file', blob, filePart.filename || 'audio.wav');
      form.append('model', ASR_UPSTREAM_MODELS[model] || ASR_UPSTREAM_MODEL);

      for (const [name, value] of Object.entries(fields)) {
        if (name === 'model' || name === 'file') continue;
        if (value.trim()) form.append(name, value.trim());
      }

      const response = await fetch(upstreamUrl(resolved.config.baseUrl, UPSTREAM_ASR_PATH), {
        method: 'POST',
        headers: authHeaders(resolved.config.apiKey),
        body: form as any,
        dispatcher: ASR_DISPATCHER
      });

      const contentType = response.headers.get('content-type') || '';
      const shouldStream = streamRequested || contentType.includes('text/event-stream');

      if (!response.ok || !shouldStream) {
        return sendUpstreamText(reply, response);
      }
      if (!response.body) {
        return proxyError(reply, 502, 'ASR upstream returned empty stream');
      }

      reply.hijack();
      reply.raw.writeHead(response.status, {
        'content-type': contentType || 'text/event-stream; charset=utf-8',
        'cache-control': response.headers.get('cache-control') || 'no-cache',
        'x-accel-buffering': response.headers.get('x-accel-buffering') || 'no',
        connection: 'keep-alive'
      });

      const stream = Readable.fromWeb(response.body as any);
      stream.pipe(reply.raw);
      stream.on('error', () => {
        try { reply.raw.destroy(); } catch { /* ignore */ }
      });
      reply.raw.on('close', () => {
        stream.destroy();
        try { response.body?.cancel(); } catch { /* ignore */ }
      });
      return;
    } catch (err: any) {
      req.log.error(err, 'ASR proxy failed');
      if (!reply.raw.headersSent) {
        return proxyError(reply, 502, 'ASR upstream request failed');
      }
      reply.raw.destroy();
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
