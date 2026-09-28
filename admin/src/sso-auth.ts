import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';
import type { Prisma, PrismaClient } from '@prisma/client';
import { extractEmployeeId, isSsoTokenConfigured, verifySsoToken } from './oidc.js';

/// authenticateSso 挂载到 req.ssoUser 的最小用户信息(不含 passwordHash 等敏感字段)
export const ssoUserSelect = {
  id: true,
  employeeId: true,
  name: true,
  email: true,
  department: true,
  phone: true,
  role: true,
  balance: true
} satisfies Prisma.UserSelect;

export type SsoUser = Prisma.UserGetPayload<{ select: typeof ssoUserSelect }>;

/// 读取非空字符串 claim(trim 后为空视作缺失, 与建号时 email/name 的处理一致)
function nonEmptyClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/// 计算已开通用户的资料回写字段: 仅非空 claim 且与库中值不同才写;
/// email 沿用建号语义(被他人占用则跳过, 避免唯一约束冲突); 无变化时返回 null(不发 update)
async function ssoProfileUpdates(
  prisma: PrismaClient,
  user: SsoUser,
  claims: JWTPayload
): Promise<Prisma.UserUpdateInput | null> {
  const data: Prisma.UserUpdateInput = {};

  const name = nonEmptyClaim(claims.name);
  if (name && name !== user.name) data.name = name;

  const department = nonEmptyClaim(claims.dept);
  if (department && department !== user.department) data.department = department;

  const phone = nonEmptyClaim(claims.mobile);
  if (phone && phone !== user.phone) data.phone = phone;

  const email = nonEmptyClaim(claims.email);
  if (email && email !== user.email) {
    const emailTaken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!emailTaken) data.email = email;
  }

  return Object.keys(data).length > 0 ? data : null;
}

/// 路由侧防御: authenticateSso 未挂载(新路由漏配 preHandler)时明确抛错, 由 Fastify 统一 500,
/// 避免把「拿不到用户」误当成匿名访问继续执行
export function requireSsoUser(req: FastifyRequest): SsoUser {
  if (!req.ssoUser) {
    throw new Error('req.ssoUser 缺失: 请先挂载 authenticateSso 鉴权钩子');
  }
  return req.ssoUser;
}

/// 员工端 dashboard 用 SSO 交换来的 gateway token 访问用户态接口的鉴权钩子：
/// 无 token/验签失败 → 401；token 无工号 → 403；未知工号自动开通(JIT)；通过后把用户挂到 req.ssoUser。
/// 配置缺失与查库故障属于基础设施错误, 抛给 Fastify 走 500(绝不伪装成 401)。
/// 以工厂形式导出，便于测试挂真实 JWKS 端到端覆盖各分支（index.ts 在 decorate 时装配）。
export function createAuthenticateSso(prisma: PrismaClient) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // 验签能力缺失是服务端配置故障, 与请求凭证无关
    if (!isSsoTokenConfigured()) {
      throw new Error('SSO gateway token 未配置(OIDC_ISSUER / SSO_GATEWAY_AUDIENCE)');
    }

    const auth = String(req.headers.authorization ?? '');
    // RFC 7235: scheme 大小写不敏感
    if (auth.slice(0, 7).toLowerCase() !== 'bearer ') {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    let claims: JWTPayload;
    try {
      claims = await verifySsoToken(auth.slice(7));
    } catch (err) {
        req.log.warn({ err }, 'SSO gateway token 校验失败');
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    const employeeId = extractEmployeeId(claims);
    if (!employeeId) {
      reply.status(403).send({ error: 'Forbidden' });
      return;
    }

    let user: SsoUser | null;
    try {
      user = await prisma.user.findUnique({
        where: { employeeId },
        select: ssoUserSelect
      });
    } catch (err) {
      // 查库失败是基础设施故障, 记录后交给 Fastify 统一 500
      req.log.error({ err }, '查询 SSO 用户失败');
      throw err;
    }
    if (!user) {
      // 员工首次通过 SSO 访问: 自动开通(与 rag/market/agent 一致的 JIT 建号)
      const email = nonEmptyClaim(claims.email);
      // 邮箱可能已被本地/其它账号占用(唯一约束): 被占用则不带邮箱建号
      const emailTaken = email
        ? await prisma.user.findUnique({ where: { email }, select: { id: true } })
        : null;
      try {
        user = await prisma.user.create({
          data: {
            employeeId,
            name: nonEmptyClaim(claims.name) ?? employeeId,
            email: emailTaken ? null : email,
            department: nonEmptyClaim(claims.dept),
            phone: nonEmptyClaim(claims.mobile),
            passwordHash: '', // SSO 用户: 本地密码登录不可用
            role: 'USER'
          },
          select: ssoUserSelect
        });
        req.log.info({ employeeId }, 'SSO 用户首次访问, 已自动开通');
      } catch (err) {
        // 并发建号: 工号唯一约束冲突 → 回查兜底
        user = await prisma.user.findUnique({ where: { employeeId }, select: ssoUserSelect });
        if (!user) {
          req.log.error({ err }, 'SSO 用户自动开通失败');
          throw err;
        }
      }
    } else {
      // 已开通用户: 用最新 SSO claims 回写资料(非空且变化才写; role 不在此处调整)
      const updates = await ssoProfileUpdates(prisma, user, claims);
      if (updates) {
        try {
          user = await prisma.user.update({
            where: { employeeId },
            data: updates,
            select: ssoUserSelect
          });
        } catch (err) {
          req.log.error({ err }, 'SSO 用户资料回写失败');
          throw err;
        }
      }
    }
    req.ssoUser = user;
  };
}
