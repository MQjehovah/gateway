import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { createAuthenticateSso } from '../src/sso-auth.js';
import { meRoutes, ME_KEY_RATE_LIMIT } from '../src/routes/me.js';
import { SSO_KEY_NAME } from '../src/services/user-key.js';

// 同 me-auth.test.ts: 本地最小 IdP + 真实 RS256 验签; Prisma 替身保留最小的 apiKey 内存表,
// 以验证「首次创建 / 再次复用」的幂等语义。
const KID = 'me-key-key-1';

let idpServer: http.Server;
let issuer = '';
let privateKey: CryptoKey;

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  idpServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/.well-known/openid-configuration')) {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks.json` }));
      return;
    }
    if (req.url?.startsWith('/jwks.json')) {
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => idpServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(idpServer.address() as { port: number }).port}`;

  process.env.OIDC_ISSUER = issuer;
  process.env.SSO_ROUTER_AUDIENCE = 'router';
});

after(async () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.SSO_ROUTER_AUDIENCE;
  await new Promise<void>((resolve) => idpServer.close(() => resolve()));
});

async function signRouterToken(opts: { employeeId?: string } = {}): Promise<string> {
  const jwt = new SignJWT({ name: '张三' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(issuer)
    .setAudience('router')
    .setIssuedAt()
    .setExpirationTime('1h');
  jwt.setSubject(opts.employeeId ?? 'E001');
  return jwt.sign(privateKey);
}

interface FakeUser {
  id: number;
  employeeId: string;
  name: string;
  email: string | null;
  role: 'ADMIN' | 'USER';
  balance: number;
}

const USER: FakeUser = {
  id: 8,
  employeeId: 'E001',
  name: '张三',
  email: 'zhangsan@example.com',
  role: 'USER',
  balance: 88.5
};

interface FakeKeyRow {
  id: number;
  userId: number;
  name: string;
  isSystem: boolean;
  status: string;
  deletedAt: Date | null;
  keyEncrypted: string | null;
  keyHash: string;
  rateLimit: number;
  dailyQuota: number;
  monthlyQuota: number;
}

async function buildApp(user: FakeUser | null = USER) {
  const rows: FakeKeyRow[] = [];
  let current = user;
  const calls = {
    writes: 0,
    findFirst: 0,
    create: 0,
    userCreate: 0,
    lastCreate: null as any
  };

  // systemKeyWhere 的语义: userId/status/deletedAt 精确匹配, 且 (isSystem=true 或 name 命中新/历史命名)
  const matchesWhere = (r: FakeKeyRow, where: any) =>
    r.userId === where.userId &&
    r.status === where.status &&
    r.deletedAt === where.deletedAt &&
    (where.OR ?? []).some(
      (c: any) =>
        (c.isSystem === true && r.isSystem === true) ||
        (c.name?.in ? c.name.in.includes(r.name) : false)
    );

  const prisma = {
    user: {
      findUnique: async (args: any) => {
        if (args.where.email !== undefined) {
          return current && current.email === args.where.email ? current : null;
        }
        return current && args.where.employeeId === current.employeeId ? current : null;
      },
      // JIT 建号替身: 内存插入新用户, 供 authenticateSso 与后续 ensureUserKey 使用
      create: async (args: any) => {
        calls.userCreate++;
        current = {
          id: 201,
          employeeId: args.data.employeeId,
          name: args.data.name,
          email: args.data.email,
          role: args.data.role,
          balance: 0
        };
        return current;
      }
    },
    apiKey: {
      findFirst: async (args: any) => {
        calls.findFirst++;
        const matched = rows.filter((r) => matchesWhere(r, args.where)).sort((a, b) => b.id - a.id);
        return matched[0] ?? null;
      },
      create: async (args: any) => {
        calls.create++;
        calls.writes++;
        calls.lastCreate = args;
        const row: FakeKeyRow = {
          id: 101,
          status: 'ACTIVE',
          deletedAt: null,
          ...args.data
        };
        rows.push(row);
        return row;
      },
      update: async (args: any) => {
        calls.writes++;
        const row = rows.find((r) => r.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
      }
    }
  };

  const app = Fastify();
  app.decorate('authenticateSso', createAuthenticateSso(prisma as unknown as PrismaClient));
  app.decorate('prisma', prisma as unknown as PrismaClient);
  await app.register(meRoutes);
  return { app, calls };
}

type BuiltApp = Awaited<ReturnType<typeof buildApp>>;

async function injectKey(app: BuiltApp['app'], authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/me/key',
    headers: authorization ? { authorization } : {}
  });
}

test('GET /api/me/key: 首次调用创建系统托管 key(created=true, 默认密钥/isSystem)并带用户字段', async () => {
  const { app, calls } = await buildApp();
  const res = await injectKey(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.created, true);
  assert.equal(body.rotated, false);
  assert.equal(body.keyId, 101);
  assert.match(body.key, /^sk-[0-9a-f]{64}$/);
  assert.equal(body.rateLimit, 60);
  assert.equal(body.dailyQuota, 0);
  assert.equal(body.monthlyQuota, 0);
  assert.equal(body.employeeId, 'E001');
  assert.equal(body.name, '张三');
  assert.equal(body.email, 'zhangsan@example.com');

  assert.equal(calls.create, 1);
  assert.equal(calls.lastCreate.data.userId, USER.id);
  assert.equal(calls.lastCreate.data.name, SSO_KEY_NAME);
  assert.equal(calls.lastCreate.data.isSystem, true);
  await app.close();
});

test('GET /api/me/key: 再次调用复用同一把 key(created=false, 不重复建行)', async () => {
  const { app, calls } = await buildApp();
  const auth = `Bearer ${await signRouterToken()}`;

  const first = (await injectKey(app, auth)).json();
  const second = (await injectKey(app, auth)).json();

  assert.equal(second.key, first.key);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.created, false);
  assert.equal(second.rotated, false);
  assert.equal(calls.create, 1, '已有 key 时不得再建行');
  assert.equal(calls.writes, 1);
  await app.close();
});

test('GET /api/me/key: 无 token 返回 401 且不触碰 key', async () => {
  const { app, calls } = await buildApp();
  const res = await injectKey(app);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.findFirst, 0);
  assert.equal(calls.writes, 0);
  await app.close();
});

test('GET /api/me/key: 未知工号自动开通(JIT)并返回 key', async () => {
  const { app, calls } = await buildApp(null);
  const token = await signRouterToken({ employeeId: 'E404' });
  const res = await injectKey(app, `Bearer ${token}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(calls.userCreate, 1, '未知工号应由 SSO 钩子自动建号');
  assert.equal(body.created, true);
  assert.match(body.key, /^sk-[0-9a-f]{64}$/);
  assert.equal(body.employeeId, 'E404');
  assert.equal(body.name, '张三');
  assert.equal(body.email, null);
  assert.equal(calls.findFirst, 1);
  assert.equal(calls.create, 1, '新建用户首次取 key 应落一行系统托管 key');
  assert.equal(calls.lastCreate.data.userId, 201);
  assert.equal(calls.lastCreate.data.isSystem, true);
  assert.equal(calls.writes, 1);
  await app.close();
});

// 限流键为 me:key:<user.id>, 模块级限流状态在同文件内跨用例共享:
// 限流用例用独立自增 user id, 不依赖其它用例未用满的预算。
let rateLimitUserIdSeq = 900;
function freshRateLimitUser(): FakeUser {
  const id = rateLimitUserIdSeq++;
  return { ...USER, id, employeeId: `E-RL-${id}`, email: null };
}

test(`GET /api/me/key: 每用户超过 ${ME_KEY_RATE_LIMIT} 次/分钟返回 429(带 Retry-After)且不触达 key 查询/写入`, async () => {
  assert.equal(ME_KEY_RATE_LIMIT, 30, '限流常量被改动时必须让本用例失败, 防止循环空转');
  const limitedUser = freshRateLimitUser();
  const { app, calls } = await buildApp(limitedUser);
  const auth = `Bearer ${await signRouterToken({ employeeId: limitedUser.employeeId })}`;

  for (let i = 0; i < ME_KEY_RATE_LIMIT; i++) {
    assert.equal((await injectKey(app, auth)).statusCode, 200, `第 ${i + 1} 次请求应在限额内`);
  }
  const budgetUsed = { findFirst: calls.findFirst, writes: calls.writes };

  const res = await injectKey(app, auth);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: 'Too Many Requests' });
  const retryAfter = Number(res.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter > 0,
    `应带正整数 Retry-After, 实际: ${res.headers['retry-after']}`
  );
  assert.ok(retryAfter <= 60, 'Retry-After 不应超过窗口 60s');
  assert.equal(calls.findFirst, budgetUsed.findFirst, '429 不应再查 key');
  assert.equal(calls.writes, budgetUsed.writes, '429 不应再写入');
  await app.close();
});
