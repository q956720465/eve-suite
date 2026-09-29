/**
 * 角色生命周期（授权 / 登出 / 清单刷新）。
 *
 * 授权流程：PKCE（core）→ Rust 回环收回调 → 换令牌 → 写 characters 行 → 刷新令牌进钥匙串。
 * 本 Hook 只做编排与状态呈现，不直接触碰 Tauri 命令。
 */

import {
  CHARACTER_SCOPES,
  clearCharacterData,
  EVE_CLIENT_ID,
  listCharacters,
  OAuthFlowError,
  parseJwtPayload,
  removeCharacter,
  revokeToken,
  runOAuthFlow,
  TokenManagerError,
  TokenRequestError,
  upsertCharacter,
  type CharacterSummary,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime, type CoreRuntime } from '../core/runtime';

export interface CharactersHandle {
  characters: CharacterSummary[];
  /** 初次加载完成（用于「没有角色就不要启动同步」的判断） */
  ready: boolean;
  busy: boolean;
  message: string;
  authorize: () => Promise<void>;
  logout: (characterId: number) => Promise<void>;
  refresh: () => Promise<void>;
}

/** 把授权链路上的各类错误翻成可读中文 */
function describeAuthError(error: unknown): string {
  if (error instanceof OAuthFlowError) {
    switch (error.kind) {
      case 'denied':
        return '授权被取消（你在授权页点了拒绝）';
      case 'state_mismatch':
        return '回调校验失败（state 不一致），请重试';
      case 'missing_code':
        return '授权回调未返回授权码，请重试';
      default:
        return `授权失败：${error.message}`;
    }
  }
  if (error instanceof TokenRequestError) {
    return `令牌交换失败：${error.message}`;
  }
  if (error instanceof TokenManagerError) {
    return `令牌保存失败：${error.message}`;
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/timeout|超时/i.test(text)) {
    return '等待授权超时（5 分钟），请重试';
  }
  return `授权失败：${text}`;
}

/**
 * 撤销远端刷新令牌的等待上限。
 * 登出是前台操作，而 `TokenHttp.postForm` 没有 signal 能力（网络黑洞时会一直挂着），
 * 故用竞速兜住——超时按「远端撤销失败」处理，本地清理照常完成。
 */
const REVOKE_TIMEOUT_MS = 10_000;

/** 给 Promise 加超时（到时抛错并清理定时器） */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`撤销请求超时（${ms / 1000} 秒）`)), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 撤销远端刷新令牌（best-effort）。
 *
 * 返回值：`null` = 已撤销或本无需撤销；字符串 = 失败原因。
 * 任何失败都**不阻断**本地登出——本地清理是登出的必要部分，远端撤销是尽力而为。
 * 必须先于删除钥匙串调用（撤销需要令牌明文）。
 */
async function revokeRemoteRefreshToken(
  runtime: CoreRuntime,
  characterId: number,
): Promise<string | null> {
  try {
    const token = await runtime.tokenStore.loadRefreshToken(characterId);
    if (token === null || token.length === 0) return null;
    await withTimeout(
      revokeToken(runtime.tokenHttp, { clientId: EVE_CLIENT_ID, token }),
      REVOKE_TIMEOUT_MS,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function useCharacters(): CharactersHandle {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const runtime = await initCoreRuntime();
    setCharacters(await listCharacters(runtime.db));
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const runtime = await initCoreRuntime();
        const rows = await listCharacters(runtime.db);
        if (disposed) return;
        setCharacters(rows);
      } catch (error) {
        if (!disposed) {
          setMessage(`角色列表加载失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!disposed) setReady(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const authorize = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('已打开浏览器，请完成 EVE 账号授权…');
    try {
      const runtime = await initCoreRuntime();
      const tokens = await runOAuthFlow({
        clientId: EVE_CLIENT_ID,
        scopes: CHARACTER_SCOPES,
        tokenHttp: runtime.tokenHttp,
        loopback: runtime.loopback,
      });

      const characterId = tokens.characterId;
      if (characterId === null) {
        throw new Error('令牌响应未包含角色 ID');
      }
      const payload = parseJwtPayload(tokens.accessToken);
      const nameClaim = payload?.name;
      const name = typeof nameClaim === 'string' && nameClaim.length > 0 ? nameClaim : `角色 ${characterId}`;

      await upsertCharacter(runtime.db, {
        characterId,
        name,
        scopes: CHARACTER_SCOPES,
        addedAt: new Date().toISOString(),
      });
      await runtime.tokenManager.setInitialTokens(tokens);
      await refresh();
      // 授权后角色集合变化会由应用壳触发一轮同步，故不再提示用户手点「立即同步」
      setMessage(`授权成功：${name}（正在自动同步…）`);
    } catch (error) {
      setMessage(describeAuthError(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh]);

  const logout = useCallback(
    async (characterId: number) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const runtime = await initCoreRuntime();
        // 顺序：先取刷新令牌 → 撤销远端（撤销需要明文，必须在删钥匙串之前）→ 删钥匙串
        // → 清内存会话 → 清本地数据 → 删角色行。
        // 远端撤销失败不阻断本地清理，只在提示里说明。
        const revokeError = await revokeRemoteRefreshToken(runtime, characterId);
        await runtime.tokenStore.deleteRefreshToken(characterId).catch(() => undefined);
        runtime.tokenManager.clear(characterId);
        await clearCharacterData(runtime.db, characterId);
        await removeCharacter(runtime.db, characterId);
        await refresh();
        setMessage(
          revokeError === null
            ? '已登出：远端令牌已撤销，本地个人数据与刷新令牌均已清除'
            : `已登出：本地个人数据与刷新令牌已清除，但远端令牌撤销失败（${revokeError}）`,
        );
      } catch (error) {
        setMessage(`登出失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );

  return { characters, ready, busy, message, authorize, logout, refresh };
}
