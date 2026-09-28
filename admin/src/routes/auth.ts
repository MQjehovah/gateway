import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { writeAudit } from '../audit.js';
import {
  buildSsoAuthorizeUrl,
  consumeSsoState,
  exchangeCodeForIdToken,
  extractEmployeeId,
  isSsoLoginConfigured,
  newSsoState,
  verifyIdToken
} from '../oidc.js';

const prisma = new PrismaClient();

interface LoginBody {
  email: string;
  password: string;
}

/// 前端登录页地址（回调携带 token 回到该页）；部署在子路径下时为 /gateway/login
function loginTarget(): string {
  return process.env.OIDC_REDIRECT_TARGET || '/login';
}

/// 出错时回到登录页并带 error 文案，不把 JSON 错误丢给浏览器
function loginErrorRedirect(error: string): string {
  const target = loginTarget();
  const sep = target.includes('?') ? '&' : '?';
  return `${target}${sep}error=${encodeURIComponent(error)}`;
}

/// SSO 自动开通控制台账号时的角色（默认 USER，可用 SSO_DEFAULT_ROLE=ADMIN 提升）
function ssoDefaultRole(): 'ADMIN' | 'USER' {
  const raw = (process.env.SSO_DEFAULT_ROLE ?? '').trim().toUpperCase();
  return raw === 'ADMIN' ? 'ADMIN' : 'USER';
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: LoginBody }>('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body;
    
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      writeAudit({ actorId: null, action: 'login_failed', targetType: 'auth', targetId: email });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      writeAudit({ actorId: user.id, action: 'login_failed', targetType: 'auth', targetId: email });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    writeAudit({ actorId: user.id, action: 'login', targetType: 'auth', targetId: email });

    const token = fastify.jwt.sign(
      { id: user.id, email: user.email ?? '', role: user.role }
    );

    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  fastify.get('/api/auth/me', {
    preHandler: [fastify.authenticate]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, balance: true }
    });
    return user;
  });

  fastify.post('/api/auth/logout', async () => {
    return { success: true };
  });

  // ---- 浏览器 SSO 登录（授权码流程）----

  fastify.get('/api/auth/sso/start', async (_req, reply) => {
    if (!isSsoLoginConfigured()) {
      return reply.status(404).send({ error: 'SSO 登录未启用' });
    }
    try {
      return reply.redirect(buildSsoAuthorizeUrl(newSsoState()));
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'SSO 登录配置错误' });
    }
  });

  fastify.get('/api/auth/oidc/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!isSsoLoginConfigured()) {
      return reply.redirect(loginErrorRedirect('SSO 登录未启用'));
    }
    if (!code || !state) {
      return reply.redirect(loginErrorRedirect('SSO 回调参数缺失'));
    }
    if (!consumeSsoState(state)) {
      return reply.redirect(loginErrorRedirect('SSO 登录状态已失效，请重试'));
    }

    let employeeId: string | null;
    let name: string;
    let email: string | null;
    try {
      const idToken = await exchangeCodeForIdToken(code);
      const payload = await verifyIdToken(idToken, process.env.OIDC_CLIENT_ID);
      employeeId = extractEmployeeId(payload);
      if (!employeeId) {
        return reply.redirect(loginErrorRedirect('SSO 身份缺少工号'));
      }
      name = typeof payload.name === 'string' && payload.name ? payload.name : employeeId;
      email = typeof payload.email === 'string' && payload.email ? payload.email : null;
    } catch (err: any) {
      return reply.redirect(loginErrorRedirect(`SSO 登录失败：${err?.message || '校验失败'}`));
    }

    // 按工号 find-or-create 用户；SSO 用户密码为随机值（不走控制台密码登录）
    let user = await prisma.user.findUnique({ where: { employeeId } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          employeeId,
          email,
          name,
          role: ssoDefaultRole(),
          balance: Number(process.env.SSO_INITIAL_BALANCE ?? 100),
          passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
        }
      });
    } else if (email && user.email !== email) {
      user = await prisma.user.update({ where: { id: user.id }, data: { email } });
    }

    writeAudit({
      actorId: user.id,
      action: 'sso_login',
      targetType: 'auth',
      targetId: employeeId
    });

    const token = fastify.jwt.sign({ id: user.id, email: user.email ?? '', role: user.role });
    const target = loginTarget();
    const sep = target.includes('?') ? '&' : '?';
    return reply.redirect(`${target}${sep}token=${encodeURIComponent(token)}`);
  });

  interface ChangePasswordBody {
    currentPassword: string;
    newPassword: string;
  }

  fastify.put<{ Body: ChangePasswordBody }>('/api/auth/password', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return reply.status(400).send({ error: 'New password must be at least 6 characters' });
    }
    if (newPassword === currentPassword) {
      return reply.status(400).send({ error: 'New password must differ from current password' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return reply.status(400).send({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    writeAudit({ actorId: user.id, action: 'change_password', targetType: 'user', targetId: user.id });

    return { success: true };
  });
}