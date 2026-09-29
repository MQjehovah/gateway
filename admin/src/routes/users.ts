import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { writeAudit } from '../audit.js';

const prisma = new PrismaClient();

interface CreateUserBody {
  email: string;
  password: string;
  name: string;
  role?: 'ADMIN' | 'USER';
}

interface UpdateUserBody {
  email?: string;
  name?: string;
  role?: 'ADMIN' | 'USER';
  balance?: number;
}

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/api/users', {
    preHandler: [fastify.authenticate]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, employeeId: true, department: true, phone: true, role: true, balance: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    return users;
  });

  fastify.post<{ Body: CreateUserBody }>('/api/users', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    if (req.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { email, password, name, role = 'USER' } = req.body;
    
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(400).send({ error: 'Email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, name, role },
      select: { id: true, email: true, name: true, department: true, phone: true, role: true, createdAt: true }
    });

    writeAudit({
      actorId: req.user.id,
      action: 'create',
      targetType: 'user',
      targetId: user.id,
      detail: { email: user.email, name: user.name, role: user.role }
    });

    return user;
  });

  fastify.put<{ Params: { id: string }, Body: UpdateUserBody }>('/api/users/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    if (req.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const userId = parseInt(req.params.id);
    const { email, name, role, balance } = req.body;

    const data: any = {};
    if (email) data.email = email;
    if (name) data.name = name;
    if (role) data.role = role;
    if (balance !== undefined) data.balance = balance;

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, name: true, department: true, phone: true, role: true, balance: true }
    });

    writeAudit({
      actorId: req.user.id,
      action: 'update',
      targetType: 'user',
      targetId: userId,
      detail: { data }
    });

    return user;
  });

  fastify.delete<{ Params: { id: string } }>('/api/users/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    if (req.user.role !== 'ADMIN') {
      return reply.status(403).send({ error: 'Forbidden' });
    }

      const userId = parseInt(req.params.id);

      // 有依赖数据时给出可操作的提示，而不是让外键报错变成 500
      const [keyCount, txCount, billCount] = await Promise.all([
        prisma.apiKey.count({ where: { userId } }),
        prisma.transaction.count({ where: { userId } }),
        prisma.bill.count({ where: { userId } })
      ]);
      if (keyCount || txCount || billCount) {
        return reply.status(409).send({
          error:
            `该用户名下仍有 ${keyCount} 个密钥、${txCount} 条交易记录、${billCount} 张账单，` +
            '为保留计费与审计记录不能删除；如需停用其访问，请删除（停用）其密钥。'
        });
      }

      await prisma.user.delete({ where: { id: userId } });

    writeAudit({
      actorId: req.user.id,
      action: 'delete',
      targetType: 'user',
      targetId: userId
    });

    return { success: true };
  });
}