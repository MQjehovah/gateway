import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { keyVerifyCache } from '../key-cache.js';
import { writeAudit } from '../audit.js';

const prisma = new PrismaClient();

interface AllowedModelInput {
  modelId: number;
  dailyQuota?: number;
  monthlyQuota?: number;
}

interface CreateKeyBody {
  name: string;
  userId?: number;
  rateLimit?: number;
  dailyQuota?: number;
  monthlyQuota?: number;
  expiresAt?: string;
  allowedModels?: AllowedModelInput[];
}

interface UpdateKeyBody {
  name?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'EXPIRED';
  rateLimit?: number;
  dailyQuota?: number;
  monthlyQuota?: number;
  expiresAt?: string;
  allowedModels?: AllowedModelInput[];
}

function generateApiKey(): string {
  return `sk-${crypto.randomBytes(32).toString('hex')}`;
}

function hashKey(key: string): string {
  return bcrypt.hashSync(key, 10);
}

export async function keyRoutes(fastify: FastifyInstance) {
  /**
   * 取「未逻辑删除」的密钥。
   *
   * 删除采用逻辑删除（置 deletedAt），用量与账单记录因外键保留；
   * 逻辑删除后对管理端各接口一律不可见（与列表一致按 404 处理）。
   * db 可注入(测试替身), 默认用模块级客户端。
   */
  const findLiveKey = (id: number, db: PrismaClient = prisma) => db.apiKey.findFirst({ where: { id, deletedAt: null } });

  fastify.get('/api/keys', {
    preHandler: [fastify.authenticate]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    // 逻辑删除的密钥不出现在列表里（用量/账单记录仍然保留在库中）
    const where = req.user.role === 'ADMIN'
      ? { deletedAt: null }
      : { userId: req.user.id, deletedAt: null };
    
    const keys = await prisma.apiKey.findMany({
      where,
      include: {
        user: { select: { name: true, email: true } },
        allowedModels: { include: { model: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    return keys.map(k => ({
      ...k,
      keyHash: k.keyHash.substring(0, 8) + '****',
      dailyQuota: Number(k.dailyQuota),
      monthlyQuota: Number(k.monthlyQuota),
      allowedModels: k.allowedModels.map(a => ({
        id: a.model.id,
        name: a.model.name,
        status: a.model.status,
        dailyQuota: Number(a.dailyQuota),
        monthlyQuota: Number(a.monthlyQuota)
      })),
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt?.toISOString()
    }));
  });

  fastify.post<{ Body: CreateKeyBody }>('/api/keys', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const userId = req.user.role === 'ADMIN' && req.body.userId ? req.body.userId : req.user.id;
    
    const rawKey = generateApiKey();
    const keyHash = hashKey(rawKey);
    
    const apiKey = await prisma.apiKey.create({
      data: {
        userId,
        keyHash,
        name: req.body.name,
        rateLimit: req.body.rateLimit || 60,
        dailyQuota: req.body.dailyQuota ?? 0,
        monthlyQuota: req.body.monthlyQuota ?? 0,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        allowedModels: req.body.allowedModels?.length
          ? { create: req.body.allowedModels.map(m => ({ modelId: m.modelId, dailyQuota: m.dailyQuota ?? 0, monthlyQuota: m.monthlyQuota ?? 0 })) }
          : undefined
      }
    });

    keyVerifyCache.clear();

    writeAudit({
      actorId: req.user.id,
      action: 'create',
      targetType: 'key',
      targetId: apiKey.id,
      detail: { name: apiKey.name, userId }
    });

    return {
      id: apiKey.id,
      key: rawKey,
      name: apiKey.name,
      rateLimit: apiKey.rateLimit,
      dailyQuota: Number(apiKey.dailyQuota),
      monthlyQuota: Number(apiKey.monthlyQuota),
      createdAt: apiKey.createdAt.toISOString(),
      expiresAt: apiKey.expiresAt?.toISOString()
    };
  });

  fastify.put<{ Params: { id: string }, Body: UpdateKeyBody }>('/api/keys/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const keyId = parseInt(req.params.id);
    const key = await findLiveKey(keyId);
    
    if (!key) {
      return reply.status(404).send({ error: 'Key not found' });
    }
    
    if (req.user.role !== 'ADMIN' && key.userId !== req.user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    keyVerifyCache.clear();

    const data: any = {};
    if (req.body.name) data.name = req.body.name;
    if (req.body.status) data.status = req.body.status;
    if (req.body.rateLimit) data.rateLimit = req.body.rateLimit;
    if (req.body.dailyQuota !== undefined) data.dailyQuota = req.body.dailyQuota;
    if (req.body.monthlyQuota !== undefined) data.monthlyQuota = req.body.monthlyQuota;
    if (req.body.expiresAt) data.expiresAt = new Date(req.body.expiresAt);

    const updated = await prisma.$transaction(async (tx) => {
      if (req.body.allowedModels) {
        await tx.apiKeyAllowedModel.deleteMany({ where: { apiKeyId: keyId } });
        if (req.body.allowedModels.length) {
          await tx.apiKeyAllowedModel.createMany({
            data: req.body.allowedModels.map(m => ({
              apiKeyId: keyId,
              modelId: m.modelId,
              dailyQuota: m.dailyQuota ?? 0,
              monthlyQuota: m.monthlyQuota ?? 0
            }))
          });
        }
      }
      return tx.apiKey.update({ where: { id: keyId }, data });
    });

    writeAudit({
      actorId: req.user.id,
      action: 'update',
      targetType: 'key',
      targetId: keyId,
      detail: { data }
    });

    return {
      id: updated.id,
      userId: updated.userId,
      name: updated.name,
      status: updated.status,
      rateLimit: updated.rateLimit,
      dailyQuota: Number(updated.dailyQuota),
      monthlyQuota: Number(updated.monthlyQuota),
      expiresAt: updated.expiresAt?.toISOString(),
      createdAt: updated.createdAt.toISOString()
    };
  });

  fastify.post<{ Params: { id: string } }>('/api/keys/:id/regenerate', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const keyId = parseInt(req.params.id);
    const key = await findLiveKey(keyId);

    if (!key) {
      return reply.status(404).send({ error: 'Key not found' });
    }

    if (req.user.role !== 'ADMIN' && key.userId !== req.user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    keyVerifyCache.clear();
    const rawKey = generateApiKey();
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { keyHash: hashKey(rawKey) }
    });

    writeAudit({
      actorId: req.user.id,
      action: 'regenerate',
      targetType: 'key',
      targetId: keyId,
      detail: { name: key.name }
    });

    return {
      id: key.id,
      key: rawKey,
      name: key.name,
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt?.toISOString()
    };
  });

  fastify.delete<{ Params: { id: string } }>('/api/keys/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const keyId = parseInt(req.params.id);
    const db = fastify.prisma ?? prisma;
    const key = await findLiveKey(keyId, db);
    
    if (!key) {
      return reply.status(404).send({ error: 'Key not found' });
    }
    
    if (req.user.role !== 'ADMIN' && key.userId !== req.user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // 系统托管密钥由工作台自动使用/复用, 普通用户删除会立刻被 ensureUserKey 重建, 故按 409 拒绝
    if (req.user.role !== 'ADMIN' && key.isSystem) {
      return reply.status(409).send({ error: '系统托管密钥不可删除（工作台自动使用）；如需更换请使用“重新生成”' });
    }

    keyVerifyCache.clear();
    // 逻辑删除: 该密钥被用量/账单记录以外键引用且无级联, 硬删会 500 且会丢审计数据。
    // 置 deletedAt 后: 列表与使用统计都不再显示, 验签立即失效, 记录仍留在库里。
    // 同时置 status=INACTIVE 作为双保险(任何未过滤 deletedAt 的旧路径也会拒绝)。
    await db.apiKey.update({
      where: { id: keyId },
      data: { deletedAt: new Date(), status: 'INACTIVE' }
    });

    writeAudit({
      actorId: req.user.id,
      action: 'delete',
      targetType: 'key',
      targetId: keyId,
      detail: { name: key.name, deleted: true }
    }, db);

    return { success: true, deleted: true };
  });

  fastify.get<{ Params: { id: string } }>('/api/keys/:id/stats', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const keyId = parseInt(req.params.id);
    const key = await findLiveKey(keyId);

    if (!key) {
      return reply.status(404).send({ error: 'Key not found' });
    }

    if (req.user.role !== 'ADMIN' && key.userId !== req.user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const [total, todayUsage, monthlyModels, trendRows] = await Promise.all([
      prisma.usageRecord.aggregate({
        where: { apiKeyId: keyId },
        _sum: { tokensIn: true, tokensOut: true, cachedTokens: true, cost: true },
        _count: true
      }),
      prisma.usageRecord.aggregate({
        where: { apiKeyId: keyId, createdAt: { gte: today } },
        _sum: { tokensIn: true, tokensOut: true, cachedTokens: true, cost: true },
        _count: true
      }),
      prisma.usageRecord.groupBy({
        by: ['model'],
        where: { apiKeyId: keyId, createdAt: { gte: monthStart } },
        _sum: { tokensIn: true, tokensOut: true, cachedTokens: true, cost: true },
        orderBy: { _sum: { cost: 'desc' } },
        take: 10
      }),
      prisma.$queryRaw<Array<{ day: Date; tokensIn: bigint; tokensOut: bigint; cachedTokens: bigint; cost: number }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("tokensIn"), 0)::int AS "tokensIn",
               COALESCE(SUM("tokensOut"), 0)::int AS "tokensOut",
               COALESCE(SUM("cachedTokens"), 0)::int AS "cachedTokens",
               COALESCE(SUM("cost"), 0) AS cost
        FROM "UsageRecord"
        WHERE "apiKeyId" = ${keyId} AND "createdAt" >= ${sevenDaysAgo}
        GROUP BY date_trunc('day', "createdAt")
        ORDER BY day ASC
      `
    ]);

    const shape = (u: { _count: number; _sum: { tokensIn: number | null; tokensOut: number | null; cachedTokens: number | null; cost: unknown } }) => ({
      requests: u._count,
      tokensIn: u._sum.tokensIn || 0,
      tokensOut: u._sum.tokensOut || 0,
      cachedTokens: u._sum.cachedTokens || 0,
      cost: Number(u._sum.cost || 0)
    });

    const trendByDay = new Map<string, { tokensIn: number; tokensOut: number; cachedTokens: number; cost: number }>();
    for (const r of trendRows) {
      const day = r.day.toISOString().slice(0, 10);
      trendByDay.set(day, {
        tokensIn: Number(r.tokensIn || 0),
        tokensOut: Number(r.tokensOut || 0),
        cachedTokens: Number(r.cachedTokens || 0),
        cost: Number(r.cost || 0)
      });
    }
    const trend: Array<{ date: string; tokensIn: number; tokensOut: number; cachedTokens: number; cost: number }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(sevenDaysAgo.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      const row = trendByDay.get(date);
      trend.push(row ? { date, ...row } : { date, tokensIn: 0, tokensOut: 0, cachedTokens: 0, cost: 0 });
    }

    return {
      keyId,
      name: key.name,
      total: shape(total),
      today: shape(todayUsage),
      trend,
      monthlyModels: monthlyModels.map(m => ({
        model: m.model,
        tokensIn: m._sum.tokensIn || 0,
        tokensOut: m._sum.tokensOut || 0,
        cachedTokens: m._sum.cachedTokens || 0,
        cost: Number(m._sum.cost || 0)
      }))
    };
  });
}