import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { createAuthenticateSso } from '../src/sso-auth.js';
import { meRoutes, ME_USAGE_RATE_LIMIT } from '../src/routes/me.js';
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_DAILY_QUOTA,
  DEFAULT_MONTHLY_QUOTA,
  SSO_KEY_NAME,
  LEGACY_SSO_KEY_NAMES
} from '../src/services/user-key.js';

// 同 me-auth.test.ts: 本地最小 IdP + 真实 RS256 验签, 只把 Prisma 换成内存替身,
// 端到端覆盖 /api/me/usage 的鉴权分支与聚合语义。
const KID = 'me-usage-key-1';

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

async function signRouterToken(opts: { employeeId?: string; audience?: string } = {}): Promise<string> {
  const jwt = new SignJWT({ name: '张三' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(issuer)
    .setAudience(opts.audience ?? 'router')
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
  balanceResetAt: Date | null;
}

const USER: FakeUser = {
  id: 8,
  employeeId: 'E001',
  name: '张三',
  email: 'zhangsan@example.com',
  role: 'USER',
  balance: 88.5,
  balanceResetAt: null
};

interface FakeKey {
  id: number;
  userId: number;
  name: string;
  isSystem?: boolean;
  status: string;
  deletedAt: Date | null;
  rateLimit: number;
  dailyQuota: bigint;
  monthlyQuota: bigint;
}

const KEY: FakeKey = {
  id: 7,
  userId: USER.id,
  name: 'sso',
  status: 'ACTIVE',
  deletedAt: null,
  rateLimit: 30,
  dailyQuota: 500000n,
  monthlyQuota: 2000000n
};

/// systemKeyWhere 的语义: userId/status/deletedAt 精确匹配, 且 (isSystem=true 或 name 命中新/历史命名)
function matchesSystemKeyWhere(k: FakeKey, where: any): boolean {
  if (k.userId !== where.userId || k.status !== where.status || k.deletedAt !== where.deletedAt) return false;
  return (where.OR ?? []).some(
    (c: any) =>
      (c.isSystem === true && k.isSystem === true) ||
      (c.name?.in ? c.name.in.includes(k.name) : false)
  );
}

/// /api/me/usage 的 key 归属条件应恒等于 systemKeyWhere(userId)
function expectedSystemKeyWhere(userId: number) {
  return {
    userId,
    status: 'ACTIVE',
    deletedAt: null,
    OR: [{ isSystem: true }, { name: { in: [SSO_KEY_NAME, ...LEGACY_SSO_KEY_NAMES] } }]
  };
}

interface FakeUsageRow {
  apiKeyId: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  cost: number;
  createdAt: Date;
}

interface FakeModel {
  id: number;
  name: string;
  status: string;
  providerId: number;
  provider: { id: number; name: string; status: string };
}

interface FakeGrant {
  apiKeyId: number;
  modelId: number;
  dailyQuota: bigint;
  monthlyQuota: bigint;
  model: FakeModel;
}

function makeModel(id: number, name: string, opts: { modelStatus?: string; providerStatus?: string } = {}): FakeModel {
  return {
    id,
    name,
    status: opts.modelStatus ?? 'ACTIVE',
    providerId: 1,
    provider: { id: 1, name: 'provider-1', status: opts.providerStatus ?? 'ACTIVE' }
  };
}

function makeGrant(model: FakeModel, dailyQuota = 5000n, monthlyQuota = 50000n): FakeGrant {
  return { apiKeyId: KEY.id, modelId: model.id, dailyQuota, monthlyQuota, model };
}

interface BuildOptions {
  user?: FakeUser | null;
  /// 库中的 key 集合; findFirst 替身按 where(userId/name/status/deletedAt) 过滤后取 id 最大者
  keys?: FakeKey[];
  usage?: FakeUsageRow[];
  grants?: FakeGrant[];
  models?: FakeModel[];
}

async function buildApp(opts: BuildOptions = {}) {
  // 默认同月已重置(balanceResetAt=本月), 避免无关用例意外触发跨月写库; 需要跨月场景时显式传入
  let user =
    opts.user === undefined
      ? { ...USER, balanceResetAt: new Date() }
      : opts.user === null
        ? null
        : { ...opts.user };
  const keys = opts.keys ?? [];
  const usage = opts.usage ?? [];
  const grants = opts.grants ?? [];
  const models = opts.models ?? [];

  const calls = {
    writes: 0,
    userFindUnique: 0,
    userCreate: 0,
    userUpdateMany: 0,
    transactionCreate: 0,
    keyFindFirst: 0,
    keyWhere: null as any,
    lastUserUpdateMany: null as any,
    lastTransaction: null as any,
    aggregates: [] as any[],
    groupBys: [] as any[],
    modelFindMany: 0
  };

  // 空聚合与 Prisma 一致返回全 null, 覆盖 toBucket 的 ?? 0 路径
  const sumRows = (rows: FakeUsageRow[]) =>
    rows.length === 0
      ? { tokensIn: null, tokensOut: null, cachedTokens: null, cost: null }
      : {
          tokensIn: rows.reduce((s, r) => s + r.tokensIn, 0),
          tokensOut: rows.reduce((s, r) => s + r.tokensOut, 0),
          cachedTokens: rows.reduce((s, r) => s + r.cachedTokens, 0),
          cost: rows.reduce((s, r) => s + r.cost, 0)
        };

  const pickRows = (where: any) =>
    usage.filter(
      (r) =>
        r.apiKeyId === where.apiKeyId &&
        (where.model === undefined || r.model === where.model) &&
        r.createdAt.getTime() >= new Date(where.createdAt.gte).getTime()
    );

  const prisma = {
    user: {
      // authenticateSso 按 employeeId 查; usage handler 按 id 查(取 balanceResetAt 触发月度重置)
      findUnique: async (args: any) => {
        calls.userFindUnique++;
        if (!user) return null;
        if (args.where.employeeId !== undefined) {
          return args.where.employeeId === user.employeeId ? user : null;
        }
        if (args.where.id !== undefined) {
          return args.where.id === user.id ? user : null;
        }
        return null;
      },
      // JIT 建号替身: 内存插入新用户(与 Prisma 默认一致 balance=0/balanceResetAt=null)
      create: async (args: any) => {
        calls.userCreate++;
        user = {
          id: 901,
          employeeId: args.data.employeeId,
          name: args.data.name,
          email: args.data.email,
          role: args.data.role,
          balance: 0,
          balanceResetAt: null
        };
        return user;
      },
      // 跨月重置走条件幂等更新(updateMany), 命中才写 RECHARGE 流水
      updateMany: async (args: any) => {
        calls.userUpdateMany++;
        calls.writes++;
        calls.lastUserUpdateMany = args;
        if (!user || args.where.id !== user.id) return { count: 0 };
        const lt = args.where.OR?.[1]?.balanceResetAt?.lt;
        const missing = user.balanceResetAt === null;
        const old =
          user.balanceResetAt !== null && lt !== undefined && user.balanceResetAt.getTime() < new Date(lt).getTime();
        if (!missing && !old) return { count: 0 };
        user.balance = args.data.balance;
        user.balanceResetAt = args.data.balanceResetAt;
        return { count: 1 };
      }
    },
    transaction: {
      create: async (args: any) => {
        calls.transactionCreate++;
        calls.writes++;
        calls.lastTransaction = args;
        return { id: 1, ...args.data };
      }
    },
    apiKey: {
      findFirst: async (args: any) => {
        calls.keyFindFirst++;
        calls.keyWhere = args;
        const matched = keys.filter((k) => matchesSystemKeyWhere(k, args.where)).sort((a, b) => b.id - a.id);
        return matched[0] ?? null;
      },
      create: async () => {
        calls.writes++;
        throw new Error('me/usage 不得创建 key');
      },
      update: async () => {
        calls.writes++;
        throw new Error('me/usage 不得更新 key');
      },
      delete: async () => {
        calls.writes++;
        throw new Error('me/usage 不得删除 key');
      }
    },
    usageRecord: {
      aggregate: async (args: any) => {
        calls.aggregates.push(args.where);
        return { _sum: sumRows(pickRows(args.where)) };
      },
      groupBy: async (args: any) => {
        calls.groupBys.push(args);
        const byModel = new Map<string, FakeUsageRow[]>();
        for (const row of pickRows(args.where)) {
          const list = byModel.get(row.model) ?? [];
          list.push(row);
          byModel.set(row.model, list);
        }
        return [...byModel.entries()].map(([model, rows]) => ({ model, _sum: sumRows(rows) }));
      }
    },
    apiKeyAllowedModel: {
      findMany: async (args: any) => grants.filter((g) => g.apiKeyId === args.where.apiKeyId)
    },
    model: {
      findMany: async () => {
        calls.modelFindMany++;
        return models;
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

async function injectUsage(app: BuiltApp['app'], authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/me/usage',
    headers: authorization ? { authorization } : {}
  });
}

function todayStartOf(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthStartOf(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1);
}

const ZERO_BUCKET = { tokensIn: 0, tokensOut: 0, tokens: 0, cost: 0 };

test('GET /api/me/usage: 有效 token 返回摘要(模式/值域/模型只取授权 ACTIVE)', async () => {
  const at = new Date();
  const granted = makeModel(11, 'gpt-4o');
  const revoked = makeModel(12, 'gpt-4o-mini', { modelStatus: 'INACTIVE' });
  const { app, calls } = await buildApp({
    keys: [KEY],
    grants: [makeGrant(granted, 5000n, 50000n), makeGrant(revoked, 111n, 222n)],
    usage: [
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 100, tokensOut: 40, cachedTokens: 5, cost: 1, createdAt: at },
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 10, tokensOut: 5, cachedTokens: 0, cost: 2, createdAt: at }
    ]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.balance, 88.5, 'balance 来自 User.balance');
  assert.equal(body.rateLimit, 30, 'rateLimit 来自该用户 sso key');
  assert.deepEqual(body.quota, { daily: 500000, monthly: 2000000 });
  // tokens = tokensIn + tokensOut + cachedTokens(与 internal verify 的 sumTokens 一致); cost 为聚合和
  assert.deepEqual(body.today, { tokensIn: 110, tokensOut: 45, tokens: 160, cost: 3 });
  assert.deepEqual(body.month, { tokensIn: 110, tokensOut: 45, tokens: 160, cost: 3 });
  assert.deepEqual(body.models, [
    {
      name: 'gpt-4o',
      today: { tokensIn: 110, tokensOut: 45, tokens: 160, cost: 3 },
      month: { tokensIn: 110, tokensOut: 45, tokens: 160, cost: 3 },
      dailyQuota: 5000,
      monthlyQuota: 50000
    }
  ]);
  assert.equal(body.truncated, false);
  assert.ok(!Number.isNaN(Date.parse(body.fetchedAt)), 'fetchedAt 应是服务端 ISO 时间');

  // 归属范围: 查找条件与 ensureUserKey 对齐(systemKeyWhere); 默认用户同月, 故重置幂等无写, 也无任何 key 写操作
  assert.deepEqual(calls.keyWhere, {
    where: expectedSystemKeyWhere(USER.id),
    orderBy: { id: 'desc' }
  });
  assert.equal(calls.userUpdateMany, 0);
  assert.equal(calls.writes, 0);
  // 查询有界: 总量 2 次聚合 + 每模型分解 2 次 groupBy(不随模型数增长)
  assert.equal(calls.aggregates.length, 2);
  assert.equal(calls.aggregates[0].apiKeyId, KEY.id);
  assert.equal(calls.aggregates[0].createdAt.gte.getTime(), todayStartOf(at).getTime());
  assert.equal(calls.aggregates[1].createdAt.gte.getTime(), monthStartOf(at).getTime());
  assert.equal(calls.groupBys.length, 2);
  assert.deepEqual(calls.groupBys[0].by, ['model']);
  assert.equal(calls.groupBys[0].where.apiKeyId, KEY.id);

  await app.close();
});

test('GET /api/me/usage: 无 token 返回 401 且不查用量', async () => {
  const { app, calls } = await buildApp({ keys: [KEY] });
  const res = await injectUsage(app);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: 'Unauthorized' });
  assert.equal(calls.userFindUnique, 0);
  assert.equal(calls.keyFindFirst, 0);
  assert.equal(calls.aggregates.length, 0);
  await app.close();
});

test('GET /api/me/usage: aud 不符的 token 返回 401 且不查用量', async () => {
  const { app, calls } = await buildApp({ keys: [KEY] });
  const token = await signRouterToken({ audience: 'other-service' });
  const res = await injectUsage(app, `Bearer ${token}`);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.userFindUnique, 0);
  assert.equal(calls.keyFindFirst, 0);
  await app.close();
});

test('GET /api/me/usage: 未知工号自动开通(JIT)后返回 200(空用量)', async () => {
  const { app, calls } = await buildApp({ user: null, keys: [] });
  const token = await signRouterToken({ employeeId: 'E404' });
  const res = await injectUsage(app, `Bearer ${token}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(calls.userCreate, 1, '未知工号应由 SSO 钩子自动建号');
  // 新建用户 balanceResetAt 为空: 首访即完成本月额度初始化(与存量员工同口径)
  assert.equal(body.balance, 100, '响应应使用初始化后的月度余额(SSO_MONTHLY_BALANCE 默认 100)');
  assert.equal(calls.userUpdateMany, 1);
  assert.equal(calls.transactionCreate, 1);
  assert.equal(body.rateLimit, DEFAULT_RATE_LIMIT);
  assert.deepEqual(body.quota, { daily: DEFAULT_DAILY_QUOTA, monthly: DEFAULT_MONTHLY_QUOTA });
  assert.deepEqual(body.today, ZERO_BUCKET);
  assert.deepEqual(body.month, ZERO_BUCKET);
  assert.deepEqual(body.models, []);
  assert.equal(calls.keyFindFirst, 1, '新用户无 sso key, 用量为空');
  await app.close();
});

test('GET /api/me/usage: 无 sso key 返回全 0 + 默认 quota(同月无重置写, 且不创建/轮换 key)', async () => {
  // 前提: balanceResetAt 设为本月, 月度重置幂等; 否则会按旧链路口径写一笔 RECHARGE(见跨月用例)
  const { app, calls } = await buildApp({
    user: { ...USER, balanceResetAt: new Date() },
    keys: []
  });
  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.balance, 88.5, 'balance 仍来自 User');
  assert.equal(body.rateLimit, DEFAULT_RATE_LIMIT);
  assert.deepEqual(body.quota, { daily: DEFAULT_DAILY_QUOTA, monthly: DEFAULT_MONTHLY_QUOTA });
  assert.deepEqual(body.today, ZERO_BUCKET);
  assert.deepEqual(body.month, ZERO_BUCKET);
  assert.deepEqual(body.models, []);
  assert.equal(body.truncated, false);

  assert.equal(calls.keyFindFirst, 1);
  assert.deepEqual(calls.keyWhere.where, expectedSystemKeyWhere(USER.id));
  assert.equal(calls.aggregates.length, 0);
  assert.equal(calls.userUpdateMany, 0, '同月不应触发月度重置');
  assert.equal(calls.transactionCreate, 0);
  assert.equal(calls.writes, 0, '同月 + 无 key: 不创建/轮换, 也没有任何写操作');
  await app.close();
});

test('GET /api/me/usage: 模型超过 10 个时按本月花费降序截断并置 truncated', async () => {
  const grants = Array.from({ length: 12 }, (_, i) => makeGrant(makeModel(i + 1, `model-${i + 1}`)));
  const usage = Array.from({ length: 12 }, (_, i) => ({
    apiKeyId: KEY.id,
    model: `model-${i + 1}`,
    tokensIn: 10,
    tokensOut: 0,
    cachedTokens: 0,
    cost: i + 1,
    createdAt: new Date()
  }));
  const { app } = await buildApp({ keys: [KEY], grants, usage });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.truncated, true);
  assert.equal(body.models.length, 10);
  // cost desc: model-12 ... model-3, model-2/model-1 被截掉
  assert.deepEqual(
    body.models.map((m: { name: string }) => m.name),
    ['model-12', 'model-11', 'model-10', 'model-9', 'model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3']
  );
  assert.equal(body.models[0].month.cost, 12);
  assert.equal(body.models[9].month.cost, 3);
  assert.equal(body.models[0].dailyQuota, 5000, '配额仍来自各模型授权');
  await app.close();
});

test('GET /api/me/usage: 模型排序为 month.cost desc → month.tokens desc → name asc', async () => {
  const alpha = makeModel(21, 'alpha');
  const beta = makeModel(22, 'beta');
  const delta = makeModel(24, 'delta');
  const epsilon = makeModel(25, 'epsilon');
  const gamma = makeModel(23, 'gamma');
  const { app } = await buildApp({
    keys: [KEY],
    grants: [alpha, beta, delta, epsilon, gamma].map((m) => makeGrant(m)),
    usage: [
      // gamma: cost 6 最高; delta: cost 5 且 tokens 30(含 cached 5)次之;
      // alpha/beta: cost 5 tokens 20 同名次 → name asc; epsilon: tokens 10 垫底
      { apiKeyId: KEY.id, model: 'alpha', tokensIn: 20, tokensOut: 0, cachedTokens: 0, cost: 5, createdAt: new Date() },
      { apiKeyId: KEY.id, model: 'beta', tokensIn: 15, tokensOut: 5, cachedTokens: 0, cost: 5, createdAt: new Date() },
      { apiKeyId: KEY.id, model: 'delta', tokensIn: 20, tokensOut: 5, cachedTokens: 5, cost: 5, createdAt: new Date() },
      { apiKeyId: KEY.id, model: 'epsilon', tokensIn: 10, tokensOut: 0, cachedTokens: 0, cost: 5, createdAt: new Date() },
      { apiKeyId: KEY.id, model: 'gamma', tokensIn: 3, tokensOut: 2, cachedTokens: 0, cost: 6, createdAt: new Date() }
    ]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(
    body.models.map((m: { name: string }) => m.name),
    ['gamma', 'delta', 'alpha', 'beta', 'epsilon']
  );
  const deltaRow = body.models.find((m: { name: string }) => m.name === 'delta');
  assert.deepEqual(deltaRow.month, { tokensIn: 20, tokensOut: 5, tokens: 30, cost: 5 }, 'groupBy 也须计入 cachedTokens');
  await app.close();
});

test('GET /api/me/usage: 无用量记录时聚合为 null 也归一为 0', async () => {
  const granted = makeModel(31, 'gpt-4o');
  const { app } = await buildApp({ keys: [KEY], grants: [makeGrant(granted)], usage: [] });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(body.today, ZERO_BUCKET);
  assert.deepEqual(body.month, ZERO_BUCKET);
  assert.deepEqual(body.models, [
    { name: 'gpt-4o', today: ZERO_BUCKET, month: ZERO_BUCKET, dailyQuota: 5000, monthlyQuota: 50000 }
  ]);
  await app.close();
});

test('GET /api/me/usage: 同月不触发月度重置(无 update/流水), balance 保持原值', async () => {
  const now = new Date();
  const { app, calls } = await buildApp({
    user: {
      ...USER,
      balance: 42.5,
      balanceResetAt: new Date(now.getFullYear(), now.getMonth(), 1)
    },
    keys: []
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().balance, 42.5);
  assert.equal(calls.userUpdateMany, 0);
  assert.equal(calls.transactionCreate, 0);
  assert.equal(calls.writes, 0);
  await app.close();
});

test('GET /api/me/usage: 跨月触发月度额度重置, 响应使用重置后 balance', async () => {
  const now = new Date();
  const { app, calls } = await buildApp({
    user: {
      ...USER,
      balance: 3,
      balanceResetAt: new Date(now.getFullYear(), now.getMonth() - 1, 15)
    },
    keys: [KEY]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.balance, 100, '响应应使用重置后的余额(SSO_MONTHLY_BALANCE 默认 100)');
  assert.equal(calls.userUpdateMany, 1);
  assert.equal(calls.lastUserUpdateMany.where.id, USER.id);
  // 条件幂等: 仅当库中 balanceResetAt 缺失或早于本月起点时才命中
  assert.deepEqual(calls.lastUserUpdateMany.where.OR, [
    { balanceResetAt: null },
    { balanceResetAt: { lt: new Date(now.getFullYear(), now.getMonth(), 1) } }
  ]);
  assert.equal(calls.lastUserUpdateMany.data.balance, 100);
  assert.equal(calls.lastUserUpdateMany.data.balanceResetAt instanceof Date, true);
  assert.equal(calls.transactionCreate, 1);
  assert.equal(calls.lastTransaction.data.userId, USER.id);
  assert.equal(calls.lastTransaction.data.type, 'RECHARGE');
  assert.equal(calls.lastTransaction.data.amount, 100);
  assert.equal(calls.lastTransaction.data.balance, 100);
  assert.match(calls.lastTransaction.data.description, /^每月额度重置\(\d{4}-\d{2}\)$/);
  await app.close();
});

test('GET /api/me/usage: 存在他人/非 sso/已删 key 时仍只认自己的有效 sso key', async () => {
  // 干扰项的 id 都比 KEY 大: 若替身/实现不按 where 过滤或忽略 orderBy 语义, 就会取错 key
  const decoys: FakeKey[] = [
    { id: 71, userId: 999, name: 'sso', status: 'ACTIVE', deletedAt: null, rateLimit: 11, dailyQuota: 1n, monthlyQuota: 1n },
    { id: 72, userId: USER.id, name: 'sso', status: 'INACTIVE', deletedAt: null, rateLimit: 12, dailyQuota: 2n, monthlyQuota: 2n },
    { id: 73, userId: USER.id, name: 'sso', status: 'ACTIVE', deletedAt: new Date(), rateLimit: 13, dailyQuota: 3n, monthlyQuota: 3n },
    { id: 74, userId: USER.id, name: 'console', status: 'ACTIVE', deletedAt: null, rateLimit: 14, dailyQuota: 4n, monthlyQuota: 4n }
  ];
  const { app, calls } = await buildApp({ keys: [...decoys, KEY] });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(calls.keyFindFirst, 1);
  assert.equal(body.rateLimit, KEY.rateLimit);
  assert.deepEqual(body.quota, { daily: 500000, monthly: 2000000 });
  await app.close();
});

test('GET /api/me/usage: 被改名的系统托管 key(isSystem=true) 仍计入归属', async () => {
  const renamed: FakeKey = {
    id: 80,
    userId: USER.id,
    name: 'rename-by-user',
    isSystem: true,
    status: 'ACTIVE',
    deletedAt: null,
    rateLimit: 44,
    dailyQuota: 111n,
    monthlyQuota: 222n
  };
  const { app, calls } = await buildApp({ keys: [renamed] });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(calls.keyFindFirst, 1);
  assert.equal(body.rateLimit, 44);
  assert.deepEqual(body.quota, { daily: 111, monthly: 222 });
  await app.close();
});

test('GET /api/me/usage: 早于今天但属本月的记录只计入 month(1 号时日月窗口重合)', async () => {
  const at = new Date();
  const firstOfMonth = at.getDate() === 1;
  const { app } = await buildApp({
    keys: [KEY],
    usage: [
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 100, tokensOut: 40, cachedTokens: 0, cost: 1, createdAt: at },
      // 本月 1 日 0 点的记录: 恒在 month 窗口内; 今天不是 1 号时早于 today 窗口
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 10, tokensOut: 5, cachedTokens: 0, cost: 2, createdAt: monthStartOf(at) }
    ]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  const todayOnly = { tokensIn: 100, tokensOut: 40, tokens: 140, cost: 1 };
  const todayAndMonth = { tokensIn: 110, tokensOut: 45, tokens: 155, cost: 3 };
  assert.deepEqual(body.today, firstOfMonth ? todayAndMonth : todayOnly);
  assert.deepEqual(body.month, todayAndMonth);
  await app.close();
});

test('GET /api/me/usage: 上月记录不计入 today 也不计入 month(自然月窗口)', async () => {
  const at = new Date();
  const prevMonthEnd = new Date(monthStartOf(at).getTime() - 1);
  const { app } = await buildApp({
    keys: [KEY],
    usage: [
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 100, tokensOut: 40, cachedTokens: 0, cost: 1, createdAt: at },
      { apiKeyId: KEY.id, model: 'gpt-4o', tokensIn: 7, tokensOut: 3, cachedTokens: 0, cost: 5, createdAt: prevMonthEnd }
    ]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  const currentOnly = { tokensIn: 100, tokensOut: 40, tokens: 140, cost: 1 };
  assert.deepEqual(body.today, currentOnly);
  assert.deepEqual(body.month, currentOnly);
  await app.close();
});

test('GET /api/me/usage: 无授权时列出全部 ACTIVE 模型, 行内用量/配额为 0 且不做分组聚合', async () => {
  const models = [makeModel(1, 'm-1'), makeModel(2, 'm-2', { providerStatus: 'INACTIVE' }), makeModel(3, 'm-3')];
  const { app, calls } = await buildApp({
    keys: [KEY],
    models,
    usage: [{ apiKeyId: KEY.id, model: 'm-1', tokensIn: 50, tokensOut: 0, cachedTokens: 0, cost: 9, createdAt: new Date() }]
  });

  const res = await injectUsage(app, `Bearer ${await signRouterToken()}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // 无授权: internal verify 仅在授权存在时计算模型配额与用量, 故模型行统一为 0; provider 非 ACTIVE 的过滤掉
  assert.deepEqual(
    body.models.map((m: { name: string }) => m.name),
    ['m-1', 'm-3']
  );
  assert.deepEqual(body.models[0], {
    name: 'm-1',
    today: ZERO_BUCKET,
    month: ZERO_BUCKET,
    dailyQuota: 0,
    monthlyQuota: 0
  });
  assert.equal(calls.modelFindMany, 1, '无授权时走全量 ACTIVE 模型清单');
  assert.equal(calls.groupBys.length, 0, '无授权时不做按模型聚合');
  await app.close();
});

// 限流键为 me:usage:<user.id>, 模块级限流状态在同文件内跨用例共享:
// 限流用例用独立自增 user id, 不依赖其它用例未用满的预算。
let rateLimitUserIdSeq = 1000;
function freshRateLimitUser(): FakeUser {
  // balanceResetAt 设为本月, 排除月度重置写库对「不触达」断言的干扰
  const id = rateLimitUserIdSeq++;
  return { ...USER, id, employeeId: `E-RL-${id}`, email: null, balanceResetAt: new Date() };
}

test(`GET /api/me/usage: 每用户超过 ${ME_USAGE_RATE_LIMIT} 次/分钟返回 429(带 Retry-After)且不触达查询/写入`, async () => {
  assert.equal(ME_USAGE_RATE_LIMIT, 60, '限流常量被改动时必须让本用例失败, 防止循环空转');
  const limitedUser = freshRateLimitUser();
  const { app, calls } = await buildApp({
    user: limitedUser,
    keys: [{ ...KEY, userId: limitedUser.id }]
  });
  const auth = `Bearer ${await signRouterToken({ employeeId: limitedUser.employeeId })}`;

  for (let i = 0; i < ME_USAGE_RATE_LIMIT; i++) {
    assert.equal((await injectUsage(app, auth)).statusCode, 200, `第 ${i + 1} 次请求应在限额内`);
  }
  const budgetUsed = {
    aggregates: calls.aggregates.length,
    keyFindFirst: calls.keyFindFirst,
    modelFindMany: calls.modelFindMany,
    writes: calls.writes
  };

  const res = await injectUsage(app, auth);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: 'Too Many Requests' });
  const retryAfter = Number(res.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter > 0,
    `应带正整数 Retry-After, 实际: ${res.headers['retry-after']}`
  );
  assert.ok(retryAfter <= 60, 'Retry-After 不应超过窗口 60s');
  assert.equal(calls.aggregates.length, budgetUsed.aggregates, '429 不应再聚合用量');
  assert.equal(calls.keyFindFirst, budgetUsed.keyFindFirst, '429 不应再查 key');
  assert.equal(calls.modelFindMany, budgetUsed.modelFindMany, '429 不应再查模型');
  assert.equal(calls.writes, budgetUsed.writes, '429 不应写库');
  await app.close();
});
