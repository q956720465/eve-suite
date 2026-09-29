import {
  DEFAULT_UNDERCUT_BASIS,
  DEFAULT_UNDERCUT_THRESHOLD_PERCENT,
  TRADE_HUBS,
  buildNotifyMessage,
  buildWebhookRequest,
  deleteNotifyRule,
  getUndercutRule,
  listNotifyRules,
  listWatchItems,
  readWebhookConfig,
  saveUndercutRule,
  saveWatchPriceRule,
  setNotifyRuleEnabled,
  writeWebhookConfig,
  type NotifyRule,
  type ValuationBasis,
  type WatchlistItem,
  type WebhookConfig,
} from '@eve-suite/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

import type { NotifyEngineHandle } from './useNotifyEngine';

/** Webhook 类型标签（方案 §7.1：同一套代码覆盖四种） */
const WEBHOOK_KINDS: readonly { id: WebhookConfig['kind']; label: string }[] = [
  { id: 'dingtalk', label: '钉钉（支持加签）' },
  { id: 'wecom', label: '企业微信' },
  { id: 'feishu', label: '飞书' },
  { id: 'custom', label: '自定义（POST JSON {title,text}）' },
];

const BASIS_LABELS: Record<ValuationBasis, string> = {
  p5_sell: '5% 分位（默认，抗钓鱼单）',
  best_sell: '最低卖价',
  wavg_sell: '挂单量加权均价',
  w5_sell: '挂单量加权 5% 分位',
};

const HUB_NAMES = new Map(TRADE_HUBS.map((hub) => [hub.regionId, hub.nameEn]));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 空串 → null；非法 → null */
function parseOptional(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOf(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * 提醒页（P5-7）。
 *
 * 三块：**通道配置**（托盘默认开 + 通用 Webhook）/ **Undercut 规则** / **监视列表价格带**，
 * 以及最近一次检查的结果回显。全部本地计算，只有「测试发送」与命中时的推送会出网。
 */
export default function NotifyPage({ engine }: { engine: NotifyEngineHandle }) {
  const [webhook, setWebhook] = useState<WebhookConfig | null>(null);
  const [undercut, setUndercut] = useState<{
    enabled: boolean;
    thresholdPercent: string;
    thresholdIsk: string;
    basis: ValuationBasis;
    regionId: number | null;
    quietStart: string;
    quietEnd: string;
  } | null>(null);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [rules, setRules] = useState<NotifyRule[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { db } = await initCoreRuntime();
      const [config, rule, watchItems, allRules] = await Promise.all([
        readWebhookConfig(db),
        getUndercutRule(db),
        listWatchItems(db),
        listNotifyRules(db),
      ]);
      setWebhook(config);
      setUndercut({
        enabled: rule?.enabled ?? false,
        thresholdPercent: String(rule?.thresholdPercent ?? DEFAULT_UNDERCUT_THRESHOLD_PERCENT),
        thresholdIsk: String(rule?.thresholdIsk ?? 0),
        basis: rule?.basis ?? DEFAULT_UNDERCUT_BASIS,
        regionId: rule?.regionId ?? null,
        quietStart: textOf(rule?.quietStartHour ?? null),
        quietEnd: textOf(rule?.quietEndHour ?? null),
      });
      setItems(watchItems);
      setRules(allRules);
    } catch (error) {
      setMessage(`读取提醒配置失败：${describeError(error)}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const watchRules = useMemo(() => {
    const map = new Map<number, NotifyRule>();
    for (const rule of rules) {
      if (rule.kind === 'watch_price' && rule.watchId !== null) map.set(rule.watchId, rule);
    }
    return map;
  }, [rules]);

  const saveWebhook = useCallback(async () => {
    if (webhook === null) return;
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      await writeWebhookConfig(db, webhook);
      setMessage('Webhook 配置已保存（只存地址与加签密钥，不存任何账号凭据）。');
    } catch (error) {
      setMessage(`保存失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [webhook]);

  const testWebhook = useCallback(async () => {
    if (webhook === null) return;
    setBusy(true);
    try {
      const sample = buildNotifyMessage([
        {
          ruleId: 0,
          kind: 'undercut',
          characterId: 0,
          orderId: 0,
          typeId: 34,
          typeName: '三钛合金（测试消息）',
          regionId: TRADE_HUBS[0].regionId,
          regionName: HUB_NAMES.get(TRADE_HUBS[0].regionId) ?? 'The Forge',
          myPrice: 5.2,
          referencePrice: 4.5,
          basis: 'p5_sell',
          deltaIsk: 0.7,
          deltaPercent: 15.56,
        },
      ]);
      const request = await buildWebhookRequest(webhook, sample);
      if (!isTauri()) {
        setMessage('浏览器预览无法发送（需在 Tauri 窗口内）。');
        return;
      }
      const status = await invoke<number>('notify_webhook_post', {
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
      setMessage(`测试消息已发送：HTTP ${status}`);
    } catch (error) {
      setMessage(`测试发送失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [webhook]);

  const saveUndercut = useCallback(async () => {
    if (undercut === null) return;
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      await saveUndercutRule(db, {
        enabled: undercut.enabled,
        thresholdPercent: parseOptional(undercut.thresholdPercent) ?? DEFAULT_UNDERCUT_THRESHOLD_PERCENT,
        thresholdIsk: parseOptional(undercut.thresholdIsk) ?? 0,
        regionId: undercut.regionId,
        basis: undercut.basis,
        quietStartHour: parseOptional(undercut.quietStart),
        quietEndHour: parseOptional(undercut.quietEnd),
      });
      await reload();
      setMessage('Undercut 规则已保存。');
    } catch (error) {
      setMessage(`保存失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [undercut, reload]);

  const saveWatchRule = useCallback(
    async (watchId: number, patch: { enabled?: boolean; minPrice?: string; maxPrice?: string }) => {
      const existing = watchRules.get(watchId);
      const minText = patch.minPrice ?? textOf(existing?.minPrice ?? null);
      const maxText = patch.maxPrice ?? textOf(existing?.maxPrice ?? null);
      try {
        const { db } = await initCoreRuntime();
        await saveWatchPriceRule(db, {
          watchId,
          enabled: patch.enabled ?? existing?.enabled ?? true,
          minPrice: parseOptional(minText),
          maxPrice: parseOptional(maxText),
          quietStartHour: existing?.quietStartHour ?? null,
          quietEndHour: existing?.quietEndHour ?? null,
        });
        await reload();
        setMessage(`价格带规则已保存（监视 #${watchId}）。`);
      } catch (error) {
        setMessage(`保存失败：${describeError(error)}`);
      }
    },
    [watchRules, reload],
  );

  const removeWatchRule = useCallback(
    async (ruleId: number) => {
      try {
        const { db } = await initCoreRuntime();
        await deleteNotifyRule(db, ruleId);
        await reload();
        setMessage('价格带规则已删除。');
      } catch (error) {
        setMessage(`删除失败：${describeError(error)}`);
      }
    },
    [reload],
  );

  const toggleRule = useCallback(
    async (ruleId: number, enabled: boolean) => {
      try {
        const { db } = await initCoreRuntime();
        await setNotifyRuleEnabled(db, ruleId, enabled);
        await reload();
      } catch (error) {
        setMessage(`切换失败：${describeError(error)}`);
      }
    },
    [reload],
  );

  const summary = engine.lastSummary;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>提醒通道</h2>
          <span className="hint">托盘通知默认开启（无需配置）；Webhook 可选，方案红线：只存地址，不存账号凭据</span>
        </div>

        <p className="hint">
          <strong>系统托盘通知</strong>：命中即弹系统通知，无需任何配置。
        </p>

        {webhook === null ? (
          <p className="hint">读取配置中…</p>
        ) : (
          <>
            <div className="params">
              <label className="check">
                <input
                  type="checkbox"
                  checked={webhook.enabled}
                  onChange={(event) => setWebhook({ ...webhook, enabled: event.target.checked })}
                />
                启用 Webhook
              </label>
              <label>
                类型
                <select
                  value={webhook.kind}
                  onChange={(event) =>
                    setWebhook({ ...webhook, kind: event.target.value as WebhookConfig['kind'] })
                  }
                >
                  {WEBHOOK_KINDS.map((kind) => (
                    <option key={kind.id} value={kind.id}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Webhook 地址
                <input
                  className="search"
                  value={webhook.url}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                  onChange={(event) => setWebhook({ ...webhook, url: event.target.value })}
                />
              </label>
              {webhook.kind === 'dingtalk' && (
                <label>
                  加签密钥（SEC…，可留空）
                  <input
                    value={webhook.secret}
                    placeholder="SECxxxxxxxx"
                    onChange={(event) => setWebhook({ ...webhook, secret: event.target.value })}
                  />
                </label>
              )}
              {(webhook.kind === 'dingtalk' || webhook.kind === 'wecom') && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={webhook.mentionAll}
                    onChange={(event) => setWebhook({ ...webhook, mentionAll: event.target.checked })}
                  />
                  @所有人
                </label>
              )}
              <button type="button" onClick={() => void saveWebhook()} disabled={busy}>
                保存
              </button>
              <button
                type="button"
                onClick={() => void testWebhook()}
                disabled={busy || webhook.url.trim().length === 0}
              >
                测试发送
              </button>
            </div>
            <p className="hint">
              同轮命中的多条提醒会<strong>合并为一条消息</strong>发送（钉钉群机器人限 20 条/分钟）。
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Undercut 规则（我的卖单被压价）</h2>
          <span className="hint">
            我的卖价高于市场参照价的幅度超过阈值即提醒；<strong>已触发后 6 小时内不重复</strong>
          </span>
        </div>

        {undercut === null ? (
          <p className="hint">读取中…</p>
        ) : (
          <>
            <div className="params">
              <label className="check">
                <input
                  type="checkbox"
                  checked={undercut.enabled}
                  onChange={(event) => setUndercut({ ...undercut, enabled: event.target.checked })}
                />
                启用
              </label>
              <label>
                阈值（%）
                <input
                  value={undercut.thresholdPercent}
                  onChange={(event) => setUndercut({ ...undercut, thresholdPercent: event.target.value })}
                />
              </label>
              <label>
                绝对下限（ISK，低于不报）
                <input
                  value={undercut.thresholdIsk}
                  onChange={(event) => setUndercut({ ...undercut, thresholdIsk: event.target.value })}
                />
              </label>
              <label>
                参照价口径
                <select
                  value={undercut.basis}
                  onChange={(event) =>
                    setUndercut({ ...undercut, basis: event.target.value as ValuationBasis })
                  }
                >
                  {(Object.keys(BASIS_LABELS) as ValuationBasis[]).map((key) => (
                    <option key={key} value={key}>
                      {BASIS_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                限定区域
                <select
                  value={undercut.regionId === null ? 'all' : String(undercut.regionId)}
                  onChange={(event) =>
                    setUndercut({
                      ...undercut,
                      regionId: event.target.value === 'all' ? null : Number(event.target.value),
                    })
                  }
                >
                  <option value="all">全部区域</option>
                  {TRADE_HUBS.map((hub) => (
                    <option key={hub.regionId} value={hub.regionId}>
                      {hub.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                静默起（小时，可空）
                <input
                  value={undercut.quietStart}
                  placeholder="如 23"
                  onChange={(event) => setUndercut({ ...undercut, quietStart: event.target.value })}
                />
              </label>
              <label>
                静默止（小时，可空）
                <input
                  value={undercut.quietEnd}
                  placeholder="如 7"
                  onChange={(event) => setUndercut({ ...undercut, quietEnd: event.target.value })}
                />
              </label>
              <button type="button" onClick={() => void saveUndercut()} disabled={busy}>
                保存
              </button>
            </div>
            <p className="hint">
              默认参照价 <strong>5% 分位</strong>（抗 1 ISK 钓鱼单，与全站唯一定价口径一致）；
              静默时段按<strong>本地时区</strong>小时，支持跨夜（如 23 → 7）。
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>监视列表价格带（{items.length} 条）</h2>
          <span className="hint">当前最低卖价跌破下限 / 突破上限即提醒；判定可用 best_sell（当前能买到的最低价）</span>
        </div>

        {items.length === 0 ? (
          <p className="hint">监视列表为空。请先在「监视」页加入要盯的物品。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>物品</th>
                <th>区域</th>
                <th>最低卖价</th>
                <th>下限（跌破提醒）</th>
                <th>上限（突破提醒）</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const rule = watchRules.get(item.watchId);
                return (
                  <tr key={item.watchId}>
                    <td>{item.nameZh ?? item.nameEn ?? `typeID ${item.typeId}`}</td>
                    <td>{item.regionNameEn ?? `区域 ${item.regionId}`}</td>
                    <td>{formatIsk(item.bestSell)}</td>
                    <td>
                      <input
                        key={`min-${item.watchId}-${rule?.ruleId ?? 'n'}-${rule?.minPrice ?? 'x'}`}
                        defaultValue={textOf(rule?.minPrice ?? null)}
                        placeholder="—"
                        onBlur={(event) => void saveWatchRule(item.watchId, { minPrice: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        key={`max-${item.watchId}-${rule?.ruleId ?? 'n'}-${rule?.maxPrice ?? 'x'}`}
                        defaultValue={textOf(rule?.maxPrice ?? null)}
                        placeholder="—"
                        onBlur={(event) => void saveWatchRule(item.watchId, { maxPrice: event.target.value })}
                      />
                    </td>
                    <td>
                      {rule === undefined ? (
                        '—'
                      ) : (
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(event) => void toggleRule(rule.ruleId, event.target.checked)}
                        />
                      )}
                    </td>
                    <td>
                      {rule === undefined ? (
                        '—'
                      ) : (
                        <button type="button" onClick={() => void removeWatchRule(rule.ruleId)}>
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="hint">输入价格后<strong>离开输入框即保存</strong>（失焦自动写入）。</p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>立即检查</h2>
          <span className="hint">应用运行期间每 60 秒自动检查一次；此处可手动触发</span>
        </div>
        <div className="params">
          <button type="button" onClick={() => void engine.run()} disabled={engine.running}>
            {engine.running ? '检查中…' : '立即检查并发送'}
          </button>
        </div>

        {summary === null ? (
          <p className="hint">尚未检查。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>检查时刻</th>
                <th>启用规则</th>
                <th>命中</th>
                <th>静默压制</th>
                <th>冷却压制</th>
                <th>缺报价</th>
                <th>托盘</th>
                <th>Webhook</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{summary.evaluatedAt.slice(0, 19).replace('T', ' ')}</td>
                <td>{summary.enabledRuleCount}</td>
                <td className="sell">{summary.hits}</td>
                <td>{summary.quietSuppressed}</td>
                <td>{summary.cooldownSuppressed}</td>
                <td>{summary.missingPrice}</td>
                <td>{summary.hits === 0 ? '—' : summary.desktopSent ? '已发送' : '失败'}</td>
                <td>
                  {summary.hits === 0
                    ? '—'
                    : summary.webhookSent === null
                      ? '未启用'
                      : summary.webhookSent
                        ? '已发送'
                        : '失败'}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {summary !== null && summary.preview.length > 0 && (
          <p className="hint">命中预览：{summary.preview.join('、')}</p>
        )}
        {engine.lastError !== null && <p className="hint">通道回执：{engine.lastError}</p>}
      </div>

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
