/**
 * 机密存储（P3-2）：宿主能力（系统钥匙串）由 Rust 提供，本模块只定义契约与命名约定。
 *
 * 用途：持久化 OAuth 刷新令牌等机密。数据库只存非机密数据（角色、资产、订单等），
 * **令牌明文永不落库**。
 */

/** 宿主提供的机密读写能力（运行时为 Rust 钥匙串，测试可注入假实现） */
export interface SecretStore {
  /** 写入机密（已存在则覆盖） */
  set(account: string, secret: string): Promise<void>;
  /** 读取机密（不存在返回 null） */
  get(account: string): Promise<string | null>;
  /** 删除机密（不存在视为成功） */
  delete(account: string): Promise<void>;
}

/** 钥匙串服务名（与 Rust 侧 `KEYRING_SERVICE` 一致） */
export const KEYRING_SERVICE = 'com.eve-suite.desktop';

/** 刷新令牌账号名前缀 */
export const REFRESH_TOKEN_PREFIX = 'refresh-token:';

/** 某角色的刷新令牌钥匙串账号名 */
export function refreshTokenAccount(characterId: number): string {
  return `${REFRESH_TOKEN_PREFIX}${characterId}`;
}

/**
 * OAuth 令牌存储：**只持久化刷新令牌**。
 *
 * 为何不存访问令牌：刷新令牌是唯一需要长期保留的机密；访问令牌约 20 分钟失效，
 * 落盘收益极小却扩大机密暴露面，因此仅保留在内存（见 P3-3）。
 */
export class OAuthTokenStore {
  constructor(private readonly secrets: SecretStore) {}

  /** 保存刷新令牌（同角色覆盖） */
  async saveRefreshToken(characterId: number, refreshToken: string): Promise<void> {
    assertCharacterId(characterId);
    if (refreshToken.length === 0) {
      throw new Error('刷新令牌不能为空');
    }
    await this.secrets.set(refreshTokenAccount(characterId), refreshToken);
  }

  /** 读取刷新令牌（未保存返回 null） */
  async loadRefreshToken(characterId: number): Promise<string | null> {
    assertCharacterId(characterId);
    return this.secrets.get(refreshTokenAccount(characterId));
  }

  /** 删除刷新令牌（未保存视为成功） */
  async deleteRefreshToken(characterId: number): Promise<void> {
    assertCharacterId(characterId);
    await this.secrets.delete(refreshTokenAccount(characterId));
  }
}

/** 角色 ID 必须是正整数（防止写入无法定位的条目） */
function assertCharacterId(characterId: number): void {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`角色 ID 非法：${characterId}`);
  }
}
