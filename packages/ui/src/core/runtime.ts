/**
 * 应用级 core 运行时（单例）。
 *
 * 为什么集中在这里：方案 §4.4 要求「全局令牌桶单例，所有管道共享」，
 * 且 `TokenManager` 必须是**进程内唯一**——它内存持有访问令牌并单飞刷新，
 * 多实例会导致同一角色被重复刷新（EVE SSO 会轮换刷新令牌，旧实例随即失效）。
 *
 * 纯逻辑都在 core，本文件只做依赖装配与生命周期。
 */

import {
  createFetchHttpClient,
  createFetchTokenHttp,
  EsiClient,
  EVE_CLIENT_ID,
  OAuthTokenStore,
  PersonalSyncer,
  RequestScheduler,
  TokenManager,
  type DbAdapter,
  type LoopbackServer,
  type TokenHttp,
} from '@eve-suite/core';
import { initDatabase, openAdapter } from '@eve-suite/core/db/tauri';
import { createTauriLoopbackServer } from '@eve-suite/core/esi/tauri';
import { createTauriSecretStore } from '@eve-suite/core/esi/tauri-secrets';

export interface CoreRuntime {
  db: DbAdapter;
  scheduler: RequestScheduler;
  esiClient: EsiClient;
  tokenManager: TokenManager;
  /** 刷新令牌存储（登出时需按角色删除钥匙串条目） */
  tokenStore: OAuthTokenStore;
  syncer: PersonalSyncer;
  /** 本地回环授权能力（Rust 侧） */
  loopback: LoopbackServer;
  /** 令牌端点 HTTP（渲染进程 fetch） */
  tokenHttp: TokenHttp;
}

let runtime: CoreRuntime | null = null;
let initializing: Promise<CoreRuntime> | null = null;

/** 初始化（幂等、并发安全）：打开数据库 → 装配限流 / 认证 / 同步 */
export async function initCoreRuntime(): Promise<CoreRuntime> {
  if (runtime !== null) return runtime;
  if (initializing !== null) return initializing;

  initializing = (async (): Promise<CoreRuntime> => {
    await initDatabase();
    const db = await openAdapter();

    const scheduler = new RequestScheduler({ requestsPerSecond: 10, burst: 20, maxConcurrent: 4 });
    const tokenHttp = createFetchTokenHttp();
    const tokenStore = new OAuthTokenStore(createTauriSecretStore());
    const tokenManager = new TokenManager({
      clientId: EVE_CLIENT_ID,
      tokenHttp,
      store: tokenStore,
    });
    const esiClient = new EsiClient({ http: createFetchHttpClient(), auth: tokenManager });
    const syncer = new PersonalSyncer({ db, client: esiClient, scheduler });

    runtime = {
      db,
      scheduler,
      esiClient,
      tokenManager,
      tokenStore,
      syncer,
      loopback: createTauriLoopbackServer(),
      tokenHttp,
    };
    return runtime;
  })();

  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

/** 取已初始化的运行时（未初始化即调用属编程错误） */
export function getCoreRuntime(): CoreRuntime {
  if (runtime === null) {
    throw new Error('core 运行时尚未初始化，请先调用 initCoreRuntime()');
  }
  return runtime;
}
