import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { writeAudit } from '../audit.js';

const prisma = new PrismaClient();

interface RechargeBody {
  amount: number;
  description?: string;
  /** 目标用户 id（管理员为他人充值）；缺省 = 给自己充值 */
  userId?: number;
}

export async function billingRoutes(fastify: FastifyInstance) {
  fastify.get('/api/bills', {
    preHandler: [fastify.authenticate]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const where = req.user.role === 'ADMIN' ? {} : { userId: req.user.id };

    const bills = await prisma.bill.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });

    return bills;
  });

  fastify.get('/api/transactions', {
    preHandler: [fastify.authenticate]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const where = req.user.role === 'ADMIN' ? {} : { userId: req.user.id };

    const transactions = await prisma.transaction.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    return transactions;
  });

  fastify.post<{ Body: RechargeBody }>('/api/transactions/recharge', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    // 仅管理员可充值：普通用户自行充值等于凭空增加额度（计费系统里的造币漏洞）。
    // 管理员可给自己充值（userId 缺省），也可通过 userId 为指定用户充值（代充）。
    if (req.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: '仅管理员可为账号充值' });
    }

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.status(400).send({ error: 'Invalid amount' });
    }

    const db = fastify.prisma ?? prisma;
    const rawTarget = Number(req.body.userId);
    const targetId = Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : req.user.id;
    const isOther = targetId !== req.user.id;

    if (isOther) {
      const target = await db.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true, name: true }
      });
      if (!target) {
        return reply.status(404).send({ error: '目标用户不存在' });
      }
    }

    const user = await db.user.update({
      where: { id: targetId },
      data: { balance: { increment: amount } }
    });

    await db.transaction.create({
      data: {
        userId: targetId,
        type: 'RECHARGE',
        amount,
        balance: user.balance,
        description:
          req.body.description ||
          (isOther ? `管理员代充（操作人:${req.user.email}）` : 'Balance recharge')
      }
    });

    writeAudit({
      actorId: req.user.id,
      action: isOther ? 'recharge_for_user' : 'recharge',
      targetType: 'user',
      targetId,
      detail: { amount, targetUserId: targetId, by: req.user.email }
    }, db);

    return { success: true, balance: user.balance, userId: targetId };
  });
}