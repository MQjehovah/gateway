import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/crypto-utils.js';
import { extractEmployeeId, isOidcConfigured, isSsoLoginConfigured, newSsoState, consumeSsoState, buildSsoAuthorizeUrl } from '../src/oidc.js';

test('crypto-utils: encrypt/decrypt roundtrip', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const raw = 'sk-abc123';
  assert.equal(decrypt(encrypt(raw, key), key), raw);
});

test('crypto-utils: encrypt output uses iv:cipher hex format', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const out = encrypt('sk-abc123', key);
  const parts = out.split(':');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^[0-9a-f]{32}$/);
  assert.match(parts[1], /^[0-9a-f]+$/);
});

test('extractEmployeeId: prefers configured claim', () => {
  process.env.OIDC_EMPLOYEE_ID_CLAIM = 'staff_no';
  try {
    const id = extractEmployeeId({ staff_no: 'E001', employee_number: 'E002' });
    assert.equal(id, 'E001');
  } finally {
    delete process.env.OIDC_EMPLOYEE_ID_CLAIM;
  }
});

test('extractEmployeeId: falls back to common claim names', () => {
  assert.equal(extractEmployeeId({ employee_number: '1001' }), '1001');
  assert.equal(extractEmployeeId({ employeeNumber: 1002 }), '1002');
});

test('extractEmployeeId: returns null when no claim matches', () => {
  assert.equal(extractEmployeeId({ email: 'a@b.c' }), null);
});

test('extractEmployeeId: falls back to sub (SSO 工号默认在 sub)', () => {
  assert.equal(extractEmployeeId({ sub: '10086', email: 'a@b.c' }), '10086');
  process.env.OIDC_EMPLOYEE_ID_CLAIM = 'staff_no';
  try {
    assert.equal(extractEmployeeId({ staff_no: 'E001', sub: '10086' }), 'E001');
  } finally {
    delete process.env.OIDC_EMPLOYEE_ID_CLAIM;
  }
});

test('extractEmployeeId: ignores empty or whitespace-only claim values', () => {
  process.env.OIDC_EMPLOYEE_ID_CLAIM = 'staff_no';
  try {
    assert.equal(extractEmployeeId({ staff_no: '   ' }), null);
  } finally {
    delete process.env.OIDC_EMPLOYEE_ID_CLAIM;
  }
});

test('isOidcConfigured: requires issuer and audience', () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  assert.equal(isOidcConfigured(), false);
  process.env.OIDC_ISSUER = 'https://idp.example.com';
  assert.equal(isOidcConfigured(), false);
  process.env.OIDC_AUDIENCE = 'gateway-admin';
  assert.equal(isOidcConfigured(), true);
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
});

test('isOidcConfigured: explicit audience substitutes for OIDC_AUDIENCE', () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  process.env.OIDC_ISSUER = 'https://idp.example.com';
  try {
    assert.equal(isOidcConfigured(), false);
    assert.equal(isOidcConfigured('gateway-admin'), true);
  } finally {
    delete process.env.OIDC_ISSUER;
  }
});

// ---- 浏览器 SSO 登录：state 一次性 / 过期 / 授权 URL 构造 ----

function withSsoLoginEnv<T>(fn: () => T): T {
  process.env.OIDC_ISSUER = 'https://sso.example.com';
  process.env.OIDC_CLIENT_ID = 'gateway-admin';
  process.env.OIDC_REDIRECT_URI = 'https://ai.example.com/gateway/api/auth/oidc/callback';
  try {
    return fn();
  } finally {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
  }
}

test('isSsoLoginConfigured: requires issuer + client_id + redirect_uri', () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_REDIRECT_URI;
  assert.equal(isSsoLoginConfigured(), false);
  process.env.OIDC_ISSUER = 'https://sso.example.com';
  process.env.OIDC_CLIENT_ID = 'gateway-admin';
  assert.equal(isSsoLoginConfigured(), false);
  process.env.OIDC_REDIRECT_URI = 'https://ai.example.com/cb';
  try {
    assert.equal(isSsoLoginConfigured(), true);
  } finally {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
  }
});

test('sso state: consumed exactly once', () => {
  const state = newSsoState();
  assert.equal(consumeSsoState(state), true);
  assert.equal(consumeSsoState(state), false);
});

test('sso state: unknown state rejected', () => {
  assert.equal(consumeSsoState('never-issued'), false);
});

test('sso state: expired state rejected', () => {
  const realNow = Date.now;
  const state = newSsoState();
  try {
    Date.now = () => realNow() + 11 * 60 * 1000;
    assert.equal(consumeSsoState(state), false);
  } finally {
    Date.now = realNow;
  }
});

test('buildSsoAuthorizeUrl: carries client_id / redirect_uri / state', () => {
  withSsoLoginEnv(() => {
    const url = buildSsoAuthorizeUrl('st-1');
    assert.match(url, /^https:\/\/sso\.example\.com\/authorize\?/);
    assert.match(url, /client_id=gateway-admin/);
    assert.match(url, /state=st-1/);
    assert.match(
      url,
      /redirect_uri=https%3A%2F%2Fai\.example\.com%2Fgateway%2Fapi%2Fauth%2Foidc%2Fcallback/
    );
    assert.match(url, /response_type=code/);
  });
});

test('buildSsoAuthorizeUrl: throws when login not configured', () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_REDIRECT_URI;
  assert.throws(() => buildSsoAuthorizeUrl('st'), /not configured/);
});
