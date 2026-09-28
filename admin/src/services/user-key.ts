import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient, Prisma } from '@prisma/client';
import { keyVerifyCache } from '../key-cache.js';
import { encrypt, decrypt } from '../crypto-utils.js';
import { encryptionKey } from '../env.js';

/** 启动即校验:生产环境缺失/弱值会让进程在模块加载时立刻失败;开发回退开发密钥。 */
const ENCRYPTION_KEY = encryptionKey();

/// 工作台自动创建/托管 key 的统一名称，/api/me/key 按该名字 find-or-create
export const SSO_KEY_NAME = '默认密钥';

/** 历史版本的自动开通 key 名称:命中后会被原地改名为 SSO_KEY_NAME 并标记 isSystem */
export const LEGACY_SSO_KEY_NAMES = ['sso'];

/// 查询「用户的工作台托管 key」的条件(排除逻辑删除与非 ACTIVE 的历史行):
/// 既认新语义(isSystem=true), 也认历史命名(sso), 供 ensureUserKey 与 /api/me/usage 复用
export function systemKeyWhere(userId: number): Prisma.ApiKeyWhereInput {
  return {
    userId,
    status: 'ACTIVE',
    deletedAt: null,
    OR: [{ isSystem: true }, { name: { in: [SSO_KEY_NAME, ...LEGACY_SSO_KEY_NAMES] } }]
  };
}

/** 无 key 时创建、复用回显时的默认限流与配额(与 ApiKey schema 默认值一致; 配额 0 = 不限) */
export const DEFAULT_RATE_LIMIT = 60;
export const DEFAULT_DAILY_QUOTA = 0;
export const DEFAULT_MONTHLY_QUOTA = 0;

export interface EnsuredUserKey {
  key: string;
  keyId: number;
  created: boolean;
  rotated: boolean;
  rateLimit: number;
  dailyQuota: number;
  monthlyQuota: number;
}

/// 按用户 find-or-create 托管 key，保证幂等：已有则重复发放同一把
/// （逻辑删除的 key 不参与复用，否则会发出一把已失效的密钥）
export async function ensureUserKey(prisma: PrismaClient, userId: number): Promise<EnsuredUserKey> {
  const existing = await prisma.apiKey.findFirst({
    where: systemKeyWhere(userId),
    orderBy: { id: 'desc' }
  });

  let key: string;
  let keyId: number;
  let created = false;
  let rotated = false;

  // 命中历史命名或丢失 isSystem 标记的行: 原地改名/补标记, 不轮换 key 材料
  const needsSystemMark = !!existing && (existing.name !== SSO_KEY_NAME || !existing.isSystem);

  if (existing?.keyEncrypted) {
    if (needsSystemMark) {
      await prisma.apiKey.update({
        where: { id: existing.id },
        data: { name: SSO_KEY_NAME, isSystem: true }
      });
    }
    keyId = existing.id;
    key = decrypt(existing.keyEncrypted, ENCRYPTION_KEY);
  } else {
    key = `sk-${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = bcrypt.hashSync(key, 10);
    const keyEncrypted = encrypt(key, ENCRYPTION_KEY);

    if (existing) {
      // 旧 key 没有加密副本（历史数据），轮换后补上，旧 key 立即失效；有历史命名时一并改名/标记
      const updated = await prisma.apiKey.update({
        where: { id: existing.id },
        data: {
          keyHash,
          keyEncrypted,
          ...(needsSystemMark ? { name: SSO_KEY_NAME, isSystem: true } : {})
        }
      });
      keyId = updated.id;
      rotated = true;
    } else {
      const row = await prisma.apiKey.create({
        data: {
          userId,
          keyHash,
          keyEncrypted,
          name: SSO_KEY_NAME,
          isSystem: true,
          rateLimit: DEFAULT_RATE_LIMIT,
          dailyQuota: DEFAULT_DAILY_QUOTA,
          monthlyQuota: DEFAULT_MONTHLY_QUOTA
        }
      });
      keyId = row.id;
      created = true;
    }
    keyVerifyCache.clear();
  }

  return {
    key,
    keyId,
    created,
    rotated,
    rateLimit: existing?.rateLimit ?? DEFAULT_RATE_LIMIT,
    dailyQuota: Number(existing?.dailyQuota ?? DEFAULT_DAILY_QUOTA),
    monthlyQuota: Number(existing?.monthlyQuota ?? DEFAULT_MONTHLY_QUOTA)
  };
}
