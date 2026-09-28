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
  role: true,
  balance: true
} satisfies Prisma.UserSelect;

export type SsoUser = Prisma.UserGetPayload<{ select: typeof ssoUserSelect }>;

/// 路由侧防御: authenticateSso 未挂载(新路由漏配 preHandler)时明确抛错, 由 Fastify 统一 500,
/// 避免把「拿不到用户」误当成匿名访问继续执行
export function requireSsoUser(req: FastifyRequest): SsoUser {
  if (!req.ssoUser) {
    throw new Error('req.ssoUser 缺失: 请先挂载 authenticateSso 鉴权钩子');
  }
  return req.ssoUser;
}

/// 员工端 dashboard 用 SSO 交换来的 gateway token 访问用户态接口的鉴权钩子：
/// 无 token/验签失败 → 401；token 无工号或用户未开通 → 403；通过后把用户挂到 req.ssoUser。
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
      reply.status(403).send({ error: 'Forbidden', detail: '用户未开通' });
      return;
    }
    req.ssoUser = user;
  };
}
