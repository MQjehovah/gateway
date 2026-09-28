import { randomBytes, webcrypto } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

// jose 依赖 Web Crypto(globalThis.crypto.subtle);node:18 默认未暴露,补全局垫片
if (!globalThis.crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
}

let discoveryCache: { value: Discovery; expiresAt: number } | null = null;
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let remoteJwksUri: string | null = null;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export function isOidcConfigured(audience?: string): boolean {
  return Boolean(process.env.OIDC_ISSUER && (audience || process.env.OIDC_AUDIENCE));
}

async function discover(issuer: string): Promise<Discovery> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) {
    return discoveryCache.value;
  }

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }
  const doc = (await response.json()) as Discovery;
  if (doc.issuer !== issuer) {
    throw new Error(`OIDC issuer mismatch: expected ${issuer}, got ${doc.issuer}`);
  }
  discoveryCache = { value: doc, expiresAt: now + DISCOVERY_TTL_MS };
  return doc;
}

async function getJwksFetcher(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const directUri = process.env.OIDC_JWKS_URI;
  const issuer = process.env.OIDC_ISSUER!;
  const jwksUri = directUri || (await discover(issuer)).jwks_uri;

  if (!remoteJwks || remoteJwksUri !== jwksUri) {
    remoteJwks = createRemoteJWKSet(new URL(jwksUri));
    remoteJwksUri = jwksUri;
  }
  return remoteJwks;
}

/// 校验 IdP 签发的 ID Token（签名、iss、aud、exp），返回 payload
///
/// audience 显式传入时优先于 OIDC_AUDIENCE：浏览器授权码回调拿到的 id_token
/// 受众是本控制台自己的 client_id（OIDC_CLIENT_ID），与 OIDC_AUDIENCE 可能不同。
export async function verifyIdToken(idToken: string, audience?: string): Promise<JWTPayload> {
  const resolvedAudience = audience || process.env.OIDC_AUDIENCE;
  if (!isOidcConfigured(resolvedAudience)) {
    throw new Error('OIDC not configured');
  }

  const jwks = await getJwksFetcher();
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: process.env.OIDC_ISSUER,
    audience: resolvedAudience,
    clockTolerance: 30
  });
  return payload;
}

/// 员工端交换出的 SSO token 可接受受众:env 显式配置时以配置为准;
/// 未配置时过渡期默认同时接受 gateway(新)与 router(旧),保证新旧桌面端并存
function ssoTokenAudiences(): string[] {
  const explicit = [process.env.SSO_GATEWAY_AUDIENCE, process.env.SSO_ROUTER_AUDIENCE].filter(
    (value): value is string => Boolean(value && value.trim())
  );
  return explicit.length > 0 ? [...new Set(explicit)] : ['gateway', 'router'];
}

/// SSO gateway token 验签是否可用(员工端 dashboard 交换出的 token 受众)
export function isSsoTokenConfigured(): boolean {
  return isOidcConfigured(ssoTokenAudiences()[0]);
}

/// 校验员工端交换来的 gateway token(签名/iss/aud/exp);依次尝试 gateway/router 受众,任一通过即可
export async function verifySsoToken(token: string): Promise<JWTPayload> {
  const audiences = ssoTokenAudiences();
  if (!isOidcConfigured(audiences[0])) {
    throw new Error('OIDC not configured (OIDC_ISSUER missing)');
  }

  const jwks = await getJwksFetcher();
  let lastError: unknown;
  for (const audience of audiences) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: process.env.OIDC_ISSUER,
        audience,
        algorithms: ['RS256'],
        clockTolerance: 30
      });
      return payload;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/// 从 payload 提取工号：优先取配置的 claim（OIDC_EMPLOYEE_ID_CLAIM），再尝试常见命名，
/// 最后回退 sub（SSO 的 id_token 默认把工号放在 sub）
export function extractEmployeeId(payload: JWTPayload): string | null {
  const candidates = [
    process.env.OIDC_EMPLOYEE_ID_CLAIM,
    'employee_number',
    'employeeNumber',
    'employee_id',
    'employeeId',
    'emp_no',
    'empNo',
    'job_number',
    'sub'
  ].filter((name): name is string => Boolean(name));

  for (const name of candidates) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

// ---- 浏览器 SSO 登录（授权码流程）----

const SSO_STATE_TTL_MS = 10 * 60 * 1000;
const ssoStates = new Map<string, number>();

/// 浏览器 SSO 登录是否可用：issuer + client_id + redirect_uri 齐备
export function isSsoLoginConfigured(): boolean {
  return Boolean(
    process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_REDIRECT_URI
  );
}

/// 生成一次性 state（附带清理过期项，避免 Map 无界增长）
export function newSsoState(): string {
  const state = randomBytes(16).toString('base64url');
  const now = Date.now();
  for (const [key, ts] of ssoStates) {
    if (now - ts > SSO_STATE_TTL_MS) ssoStates.delete(key);
  }
  ssoStates.set(state, now);
  return state;
}

/// 校验并消费 state：不存在/已用过/过期均返回 false
export function consumeSsoState(state: string): boolean {
  const ts = ssoStates.get(state);
  if (ts === undefined) return false;
  ssoStates.delete(state);
  return Date.now() - ts <= SSO_STATE_TTL_MS;
}

/// 构造授权跳转 URL（浏览器访问，用配置的 issuer 公网地址）
export function buildSsoAuthorizeUrl(state: string): string {
  if (!isSsoLoginConfigured()) throw new Error('SSO login not configured');
  const issuer = process.env.OIDC_ISSUER!.replace(/\/$/, '');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.OIDC_CLIENT_ID!,
    redirect_uri: process.env.OIDC_REDIRECT_URI!,
    state,
    scope: 'openid profile'
  });
  return `${issuer}/authorize?${params.toString()}`;
}

/// authorization_code → token 交换，返回 id_token
///
/// 同时带 client_secret_basic（Authorization 头）与 client_secret_post（表单字段），
/// 兼容两种支持方式。
export async function exchangeCodeForIdToken(code: string): Promise<string> {
  if (!isSsoLoginConfigured()) throw new Error('SSO login not configured');
  const issuer = process.env.OIDC_ISSUER!.replace(/\/$/, '');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.OIDC_REDIRECT_URI!,
    client_id: process.env.OIDC_CLIENT_ID!
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const secret = process.env.OIDC_CLIENT_SECRET;
  if (secret) {
    form.set('client_secret', secret);
    headers.Authorization =
      'Basic ' + Buffer.from(`${process.env.OIDC_CLIENT_ID}:${secret}`).toString('base64');
  }

  const response = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers,
    body: form.toString()
  });
  if (!response.ok) {
    throw new Error(`token 交换失败：HTTP ${response.status}`);
  }
  const data = (await response.json()) as { id_token?: string };
  if (!data.id_token) throw new Error('token 响应缺少 id_token');
  return data.id_token;
}
