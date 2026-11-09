import Fastify, { FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';

import { corsOrigins, requireSecret } from './env.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { quotaCheck } from './middleware/quota.js';
import { chatRoutes } from './routes/chat.js';
import { responsesRoutes } from './routes/responses.js';
import { messagesRoutes } from './routes/messages.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { audioRoutes } from './routes/audio.js';

export async function buildApp(opts: FastifyServerOptions = {}) {
  requireSecret('INTERNAL_SECRET', process.env.INTERNAL_SECRET);
  const bodyLimitMb = Number(process.env.BODY_LIMIT_MB) || 64;
  const fastify = Fastify({ ...opts, bodyLimit: bodyLimitMb * 1024 * 1024 });

  await fastify.register(cors, { origin: corsOrigins(), credentials: true });
  await fastify.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
  await fastify.register(websocket);

  fastify.decorate('authenticate', authenticate);
  fastify.decorate('rateLimit', rateLimit);
  fastify.decorate('quotaCheck', quotaCheck);

  await fastify.register(chatRoutes);
  await fastify.register(responsesRoutes);
  await fastify.register(messagesRoutes);
  await fastify.register(embeddingsRoutes);
  await fastify.register(audioRoutes);

  fastify.get('/health', async () => ({ status: 'ok' }));

  return fastify;
}
