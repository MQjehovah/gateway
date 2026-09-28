import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { createAuthenticateSso, requireSsoUser } from '../src/sso-auth.js';

// 本地起最小 IdP(同 me-auth.test.ts)：真实 RS256 签发 gateway token,
// 端到端覆盖 authenticateSso 的 JIT 建号与已开通用户资料回写分支；
// prisma 用内存替身, 断言 create/update 的实际参数与调用次数。
const KID = 'writeback-key-1';

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
  const port = (idpServer.address() as { port: number }).port;
  issuer = `http://127.0.0.1:${port}`;

  process.env.OIDC_ISSUER = issuer;
  process.env.SSO_GATEWAY_AUDIENCE = 'gateway';
});

after(async () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.SSO_GATEWAY_AUDIENCE;
  await new Promise<void>((resolve) => idpServer.close(() => resolve()));
});

interface Claims {
  sub: string;
  name?: string;
  email?: string;
  dept?: string;
  mobile?: string;
}

interface FakeUser {
  id: number;
  employeeId: string;
  name: string;
  email: string | null;
  department: string | null;
  phone: string | null;
  role: 'ADMIN' | 'USER';
  balance: number;
}

function buildApp(seed: FakeUser[] = []) {
  const users = [...seed];
  let nextId = 400;
  const calls = {
    create: null as any,
    update: null as any,
    updateCount: 0,
    lastFindUnique: null as any
  };
  const prisma = {
    user: {
      findUnique: async (args: any) => {
        calls.lastFindUnique = args;
        // 邮箱预检与工号查询用各自的 where
        if (args.where.email !== undefined) {
          return users.find((u) => u.email === args.where.email) ?? null;
        }
        return users.find((u) => u.employeeId === args.where.employeeId) ?? null;
      },
      create: async (args: any) => {
        calls.create = args;
        const created = { id: nextId++, balance: 0, ...args.data } as FakeUser;
        users.push(created);
        return created;
      },
      update: async (args: any) => {
        calls.update = args;
        calls.updateCount++;
        const idx = users.findIndex((u) => u.employeeId === args.where.employeeId);
        users[idx] = { ...users[idx], ...args.data };
        return users[idx];
      }
    }
  };

  const app = Fastify();
  app.decorate('authenticateSso', createAuthenticateSso(prisma as unknown as PrismaClient));
  app.get('/api/me', { preHandler: [app.authenticateSso] }, async (req) => {
    const ssoUser = requireSsoUser(req);
    return {
      employeeId: ssoUser.employeeId,
      name: ssoUser.name,
      email: ssoUser.email,
      department: ssoUser.department,
      phone: ssoUser.phone
    };
  });
  return { app, calls, users };
}

async function injectMe(app: ReturnType<typeof buildApp>['app'], claims: Claims) {
  const { sub, ...rest } = claims;
  const token = await new SignJWT({ roles: ['user'], ...rest })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(issuer)
    .setAudience('gateway')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
}

const FULL_CLAIMS: Claims = {
  sub: 'E1001',
  name: '网关测试甲',
  email: 'jit-a@example.com',
  dept: '测试部',
  mobile: '13900000031'
};

const EXISTING: FakeUser = {
  id: 9,
  employeeId: 'E1003',
  name: '旧名',
  email: null,
  department: '旧部',
  phone: '13900000031',
  role: 'USER',
  balance: 0
};

test('JIT 建号: claims 全字段(含 department/phone)落到 create', async () => {
  const { app, calls } = buildApp();
  const res = await injectMe(app, FULL_CLAIMS);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.create.data, {
    employeeId: 'E1001',
    name: '网关测试甲',
    email: 'jit-a@example.com',
    department: '测试部',
    phone: '13900000031',
    passwordHash: '',
    role: 'USER'
  });
  assert.equal(calls.updateCount, 0, 'JIT 建号不应触发 update');
  await app.close();
});

test('JIT 建号: 空 dept/mobile claim 落 null', async () => {
  const { app, calls } = buildApp();
  const res = await injectMe(app, { sub: 'E1002', name: '乙' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.create.data.department, null);
  assert.equal(calls.create.data.phone, null);
  await app.close();
});

test('已存在回写: 仅非空且变化的字段参与 update, 同值/空 claim 不动', async () => {
  const { app, calls } = buildApp([{ ...EXISTING }]);
  // name/dept 变化 → 写; mobile 与库中同值 → 不写; email 空串 → 不写
  const res = await injectMe(app, {
    sub: 'E1003',
    name: '新名',
    email: '   ',
    dept: '新部',
    mobile: '13900000031'
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.update.data, { name: '新名', department: '新部' });
  assert.equal(res.json().name, '新名');
  assert.equal(res.json().department, '新部');
  assert.equal(res.json().phone, '13900000031', '同值 phone 保留');
  assert.equal(res.json().email, null, '空 email 不写入');
  await app.close();
});

test('已存在回写: 空 claims 完全不触发 update(旧值保留)', async () => {
  const { app, calls } = buildApp([{ ...EXISTING }]);
  const res = await injectMe(app, { sub: 'E1003', name: '   ', dept: '', mobile: '' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.updateCount, 0, '无有效变化不应发 update');
  const body = res.json();
  assert.equal(body.name, '旧名');
  assert.equal(body.department, '旧部');
  assert.equal(body.phone, '13900000031');
  await app.close();
});

test('已存在回写: 邮箱变更写入, 被他人占用则跳过(不破坏唯一约束)', async () => {
  const free = buildApp([{ ...EXISTING }]);
  const ok = await injectMe(free.app, { sub: 'E1003', email: 'fresh@example.com' });
  assert.equal(ok.statusCode, 200);
  assert.equal(free.calls.update.data.email, 'fresh@example.com');
  await free.app.close();

  const takenUser: FakeUser = { ...EXISTING, id: 10, employeeId: 'E2000', email: 'taken@example.com' };
  const taken = buildApp([{ ...EXISTING }, takenUser]);
  const res = await injectMe(taken.app, { sub: 'E1003', email: 'taken@example.com', dept: '新部' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(taken.calls.update.data, { department: '新部' }, '被占用邮箱不进 update');
  assert.equal(res.json().email, null);
  await taken.app.close();
});
