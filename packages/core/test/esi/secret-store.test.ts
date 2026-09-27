import { describe, expect, it } from 'vitest';

import {
  KEYRING_SERVICE,
  OAuthTokenStore,
  REFRESH_TOKEN_PREFIX,
  refreshTokenAccount,
  type SecretStore,
} from '../../src/esi/secret-store';

interface FakeSecrets extends SecretStore {
  /** 底层“钥匙串”内容（供断言账号名与写入值） */
  readonly entries: Map<string, string>;
  /** 每个方法被调用的次数 */
  readonly calls: string[];
}

function createFakeSecrets(): FakeSecrets {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  return {
    entries,
    calls,
    async set(account, secret) {
      calls.push(`set:${account}`);
      entries.set(account, secret);
    },
    async get(account) {
      calls.push(`get:${account}`);
      return entries.get(account) ?? null;
    },
    async delete(account) {
      calls.push(`delete:${account}`);
      entries.delete(account);
    },
  };
}

describe('钥匙串账号命名约定', () => {
  it('服务名与 Rust 侧一致', () => {
    expect(KEYRING_SERVICE).toBe('com.eve-suite.desktop');
  });

  it('刷新令牌账号名 = 前缀 + 角色 ID', () => {
    expect(refreshTokenAccount(2112625428)).toBe(`${REFRESH_TOKEN_PREFIX}2112625428`);
    expect(refreshTokenAccount(2112625428)).toBe('refresh-token:2112625428');
  });
});

describe('OAuth 令牌存储', () => {
  it('保存后可读回，且只写刷新令牌（不含访问令牌）', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await store.saveRefreshToken(2112625428, 'refresh-abc');

    expect(secrets.calls).toEqual(['set:refresh-token:2112625428']);
    expect(secrets.entries.size).toBe(1);
    expect(secrets.entries.get('refresh-token:2112625428')).toBe('refresh-abc');
    await expect(store.loadRefreshToken(2112625428)).resolves.toBe('refresh-abc');
  });

  it('未保存过：读取返回 null', async () => {
    const store = new OAuthTokenStore(createFakeSecrets());
    await expect(store.loadRefreshToken(42)).resolves.toBeNull();
  });

  it('同角色重复保存为覆盖', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await store.saveRefreshToken(7, 'old');
    await store.saveRefreshToken(7, 'new');

    expect(secrets.entries.size).toBe(1);
    await expect(store.loadRefreshToken(7)).resolves.toBe('new');
  });

  it('多角色互不干扰', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await store.saveRefreshToken(1, 't1');
    await store.saveRefreshToken(2, 't2');

    await expect(store.loadRefreshToken(1)).resolves.toBe('t1');
    await expect(store.loadRefreshToken(2)).resolves.toBe('t2');
  });

  it('删除后读取为 null；重复删除不报错', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await store.saveRefreshToken(9, 't9');
    await store.deleteRefreshToken(9);
    await expect(store.loadRefreshToken(9)).resolves.toBeNull();
    await expect(store.deleteRefreshToken(9)).resolves.toBeUndefined();
  });

  it('空刷新令牌被拒，且不触碰钥匙串', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await expect(store.saveRefreshToken(5, '')).rejects.toThrow(/不能为空/);
    expect(secrets.calls).toEqual([]);
  });

  it('非法角色 ID 被拒，且不触碰钥匙串', async () => {
    const secrets = createFakeSecrets();
    const store = new OAuthTokenStore(secrets);

    await expect(store.saveRefreshToken(0, 'x')).rejects.toThrow(/角色 ID 非法/);
    await expect(store.loadRefreshToken(-1)).rejects.toThrow(/角色 ID 非法/);
    await expect(store.deleteRefreshToken(1.5)).rejects.toThrow(/角色 ID 非法/);
    expect(secrets.calls).toEqual([]);
  });

  it('底层失败时向调用方抛错，且错误信息不含令牌明文', async () => {
    const secrets: SecretStore = {
      async set() {
        throw new Error('写入钥匙串失败：拒绝访问');
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const store = new OAuthTokenStore(secrets);
    const token = 'super-secret-refresh-token';

    const error = await store.saveRefreshToken(3, token).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('写入钥匙串失败');
  });
});
