import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { billingRoutes } from '../src/routes/billing.js';

// 充值接口: 管理员可为指定用户代充(userId), 缺省给自己充; 普通用户 403; 目标不存在 404。
// Prisma 以 fastify.prisma 注入内存替身, authenticate 换固定用户。

interface FakeUser {
  id: number;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  balance: number;
}

function buildApp(user: FakeUser, users: FakeUser[]) {
  const calls = {
    updates: [] as any[],
    txs: [] as any[],
    audits: [] as any[]
  };

  const prisma = {
    user: {
      findUnique: async (args: any) => {
        const u = users.find((x) => x.id === args.where.id);
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
      update: async (args: any) => {
        calls.updates.push(args);
        const u = users.find((x) => x.id === args.where.id)!;
        u.balance += Number(args.data.balance.increment);
        return u;
      }
    },
    transaction: {
      create: async (args: any) => {
        calls.txs.push(args);
        return { id: calls.txs.length, ...args.data };
      }
    },
    auditLog: {
      create: async (args: any) => {
        calls.audits.push(args);
        return { id: calls.audits.length, ...args.data };
      }
    }
  };

  const app = Fastify();
  app.decorate('prisma', prisma as unknown as PrismaClient);
  app.decorate('authenticate', async (req: any) => {
    req.user = user;
  });

  return app.register(billingRoutes).then(() => ({ app, calls }));
}

const ADMIN: FakeUser = { id: 1, email: 'admin@example.com', name: '管理员', role: 'ADMIN', balance: 10 };
const TARGET: FakeUser = { id: 9, email: 'zhang@example.com', name: '张三', role: 'USER', balance: 5 };
const PLAIN: FakeUser = { id: 8, email: 'user@example.com', name: '普通用户', role: 'USER', balance: 5 };

test('POST recharge: 管理员为他人充值(目标余额/流水/审计)', async () => {
  const { app, calls } = await buildApp(ADMIN, [ADMIN, TARGET]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/transactions/recharge',
    payload: { amount: 30, userId: 9, description: '测试代充' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().userId, 9);
  assert.equal(res.json().balance, 35);
  assert.equal(TARGET.balance, 35, '目标余额应 +30');
  assert.equal(ADMIN.balance, 10, '代充不应给自己加钱');
  assert.equal(calls.txs.length, 1);
  assert.equal(calls.txs[0].data.userId, 9);
  assert.equal(calls.txs[0].data.type, 'RECHARGE');
  assert.equal(calls.txs[0].data.description, '测试代充');
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].data.action, 'recharge_for_user');

  await app.close();
});

test('POST recharge: 管理员缺省 userId 给自己充(行为不变)', async () => {
  const { app, calls } = await buildApp(ADMIN, [ADMIN]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/transactions/recharge',
    payload: { amount: 20 }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().userId, 1);
  assert.equal(ADMIN.balance, 30);
  assert.equal(calls.txs[0].data.userId, 1);
  assert.equal(calls.txs[0].data.description, 'Balance recharge');
  assert.equal(calls.audits[0].data.action, 'recharge');

  await app.close();
});

test('POST recharge: 普通用户被拒(403) 且不写库', async () => {
  const { app, calls } = await buildApp(PLAIN, [PLAIN]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/transactions/recharge',
    payload: { amount: 20, userId: 1 }
  });

  assert.equal(res.statusCode, 403);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.txs.length, 0);

  await app.close();
});

test('POST recharge: 目标用户不存在返回 404 且不写库', async () => {
  const { app, calls } = await buildApp(ADMIN, [ADMIN]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/transactions/recharge',
    payload: { amount: 20, userId: 999 }
  });

  assert.equal(res.statusCode, 404);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.txs.length, 0);

  await app.close();
});
