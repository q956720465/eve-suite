import {
  buildNotifyMessage,
  buildWebhookRequest,
  evaluateNotifyRules,
  markNotifyRuleFired,
  readWebhookConfig,
} from '@eve-suite/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/**
 * 提醒引擎（P5-7，应用级）。
 *
 * 每 60 秒评估一次已启用规则（方案 §7「仅应用运行时生效」）：
 * 1. 命中 → 合并为**一条**消息（方案红线：钉钉 20 条/分钟限频 → 本地合并去重）
 * 2. 通道：**系统托盘通知**（`notify_desktop`）+（可选）**通用 Webhook**（`notify_webhook_post`）
 * 3. 至少一个通道成功后，才写 `last_fired_at`（否则下一轮会重试，宁可重复也不漏报）
 *
 * 无任何启用规则时不产生任何请求与通知。
 */

/** 评估间隔（毫秒）——同时充当「最小发送间隔」 */
export const NOTIFY_TICK_MS = 60_000;

/** 一次运行的摘要（供界面回显） */
export interface NotifyRunSummary {
  evaluatedAt: string;
  /** 命中条数 */
  hits: number;
  quietSuppressed: number;
  cooldownSuppressed: number;
  missingPrice: number;
  enabledRuleCount: number;
  /** 托盘通知是否发送成功 */
  desktopSent: boolean;
  /** Webhook 是否发送成功；未启用为 null */
  webhookSent: boolean | null;
  /** 命中的条目摘要（最多前 5 条） */
  preview: string[];
}

export interface NotifyEngineHandle {
  /** 立即评估并发送一次 */
  run: () => Promise<void>;
  lastSummary: NotifyRunSummary | null;
  lastError: string | null;
  running: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNotifyEngine(): NotifyEngineHandle {
  const [lastSummary, setLastSummary] = useState<NotifyRunSummary | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inFlightRef = useRef(false);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRunning(true);
    try {
      const { db } = await initCoreRuntime();
      const evaluation = await evaluateNotifyRules(db);

      const base: Omit<NotifyRunSummary, 'desktopSent' | 'webhookSent' | 'preview'> = {
        evaluatedAt: evaluation.evaluatedAt,
        hits: evaluation.hits.length,
        quietSuppressed: evaluation.quietSuppressed,
        cooldownSuppressed: evaluation.cooldownSuppressed,
        missingPrice: evaluation.missingPrice,
        enabledRuleCount: evaluation.enabledRuleCount,
      };
      if (evaluation.hits.length === 0) {
        setLastSummary({ ...base, desktopSent: false, webhookSent: null, preview: [] });
        setLastError(null);
        return;
      }

      const message = buildNotifyMessage(evaluation.hits, Date.parse(evaluation.evaluatedAt));
      const preview = [
        ...new Set(evaluation.hits.map((hit) => `${hit.typeName} @ ${hit.regionName}`)),
      ].slice(0, 5);

      // ① 托盘通知（无配置，方案 §7 定为 v1 默认开）
      let desktopSent = false;
      let desktopError: string | null = null;
      if (isTauri()) {
        try {
          await invoke('notify_desktop', { title: message.title, body: message.text });
          desktopSent = true;
        } catch (error) {
          desktopError = describeError(error);
        }
      } else {
        desktopError = '非 Tauri 环境（浏览器预览）无法发送系统通知';
      }

      // ② 通用 Webhook（可选）
      const config = await readWebhookConfig(db);
      let webhookSent: boolean | null = null;
      let webhookError: string | null = null;
      if (config.enabled && config.url.trim().length > 0) {
        try {
          const request = await buildWebhookRequest(config, message, Date.parse(evaluation.evaluatedAt));
          await invoke<number>('notify_webhook_post', {
            url: request.url,
            headers: request.headers,
            body: request.body,
          });
          webhookSent = true;
        } catch (error) {
          webhookSent = false;
          webhookError = describeError(error);
        }
      }

      // 至少一个通道成功才记「已触发」——失败则下一轮重试
      if (desktopSent || webhookSent === true) {
        for (const ruleId of new Set(evaluation.hits.map((hit) => hit.ruleId))) {
          await markNotifyRuleFired(db, ruleId, evaluation.evaluatedAt);
        }
      }

      setLastSummary({ ...base, desktopSent, webhookSent, preview });
      setLastError(desktopError ?? webhookError);
    } catch (error) {
      setLastError(describeError(error));
    } finally {
      inFlightRef.current = false;
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    void run();
    const timer = setInterval(() => void run(), NOTIFY_TICK_MS);
    return () => clearInterval(timer);
  }, [run]);

  return { run, lastSummary, lastError, running };
}
