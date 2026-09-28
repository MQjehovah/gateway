/**
 * 控制台令牌存取:切到 gateway_token 后仍兼容读取旧 router_token(过渡),
 * 命中旧键时顺手迁移,登出/401 两键同清。
 */
const TOKEN_KEY = 'gateway_token'
const LEGACY_TOKEN_KEY = 'router_token'

export function getToken(): string {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) return token
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY)
  if (legacy) {
    localStorage.setItem(TOKEN_KEY, legacy)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  }
  return legacy ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}
