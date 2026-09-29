import { readSetting, writeSetting } from '../db/settings';
import type { DbAdapter } from '../db/types';
import { basisFallbackChain, type ValuationBasis } from '../engines/valuation';

/**
 * 提醒规则引擎（方案 §7.2「规则」：Undercut 阈值 / 监视列表价格带 / 静默时段）。
 *
 * 设计要点：
 * - **两类规则共用 `notify_rules` 表**（迁移 0010），按 `kind` 区分：`undercut` / `watch_price`
 * - **触发模型 = 冷却式**：当前越界 **且**（从未触发 或 距上次触发 ≥ 冷却期）→ 发送。
 *   等价效果：越界翻转立即提醒；持续越界则每个冷却周期提醒一次（**宁可重复也不漏报**，
 *   避免严格边沿在「应用未运行 / 用户没看到」时永久错过）
 * - **静默时段按规则配置**（本地时区小时，支持跨夜）；静默期间**只记不发**（不延迟）
 * - 引擎**只读本地库**（`my_orders` / `watchlist_items` / `market_stats` / `sde_types`），零 ESI
 */

/** 提醒规则类型 */
export type NotifyRuleKind = 'undercut' | 'watch_price';

/** 默认冷却期（分钟）：同一规则在该窗口内最多提醒一次 */
export const NOTIFY_COOLDOWN_MINUTES = 360;

/** Undercut 默认阈值（%）：我的卖价高于参照价多少才提醒 */
export const DEFAULT_UNDERCUT_THRESHOLD_PERCENT = 5;

/**
 * Undercut 默认参照价口径：`p5_sell`（卖价 5% 分位，抗 1 ISK 钓鱼单，与全站唯一定价口径一致）。
 *
 * 若改用 `best_sell`（最低卖价），一张钓鱼单就会让绝大多数挂单「被压价」而误报。
 */
export const DEFAULT_UNDERCUT_BASIS: ValuationBasis = 'p5_sell';

export interface NotifyRule {
  ruleId: number;
  kind: NotifyRuleKind;
  enabled: boolean;
  /** undercut：差额百分比阈值（%） */
  thresholdPercent: number | null;
  /** undercut：差额绝对下限（ISK），低于该值不提醒 */
  thresholdIsk: number | null;
  /** undercut：限定区域（null = 全部区域） */
  regionId: number | null;
  /** undercut：参照价口径 */
  basis: ValuationBasis | null;
  /** watch_price：关联的监视条目 */
  watchId: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** 静默时段（本地时区小时 0–23；两者都为 null 表示不静默） */
  quietStartHour: number | null;
  quietEndHour: number | null;
  lastFiredAt: string | null;
  createdAt: string;
}

const RULE_SELECT = `SELECT rule_id           AS ruleId,
                            kind              AS kind,
                            enabled           AS enabled,
                            threshold_percent AS thresholdPercent,
                            threshold_isk     AS thresholdIsk,
                            region_id         AS regionId,
                            basis             AS basis,
                            watch_id          AS watchId,
                            min_price         AS minPrice,
                            max_price         AS maxPrice,
                            quiet_start_hour  AS quietStartHour,
                            quiet_end_hour    AS quietEndHour,
                            last_fired_at     AS lastFiredAt,
                            created_at        AS createdAt
                       FROM notify_rules`;

interface NotifyRuleRow extends Omit<NotifyRule, 'kind' | 'enabled' | 'basis'> {
  kind: string;
  enabled: number;
  basis: string | null;
}

/** 解析库里存的口径字符串（P11-1 起含加权口径）；未知值按 null 处理 */
function parseRuleBasis(value: string | null): ValuationBasis | null {
  return value === 'p5_sell' || value === 'best_sell' || value === 'wavg_sell' || value === 'w5_sell'
    ? value
    : null;
}

function rowToRule(row: NotifyRuleRow): NotifyRule {
  return {
    ...row,
    kind: row.kind === 'watch_price' ? 'watch_price' : 'undercut',
    enabled: row.enabled === 1,
    basis: parseRuleBasis(row.basis),
  };
}

/** 全部规则（undercut 在前） */
export async function listNotifyRules(db: DbAdapter): Promise<NotifyRule[]> {
  const rows = await db.select<NotifyRuleRow>(
    `${RULE_SELECT} ORDER BY CASE kind WHEN 'undercut' THEN 0 ELSE 1 END, rule_id`,
  );
  return rows.map(rowToRule);
}

/** 取全局 Undercut 规则（至多一条） */
export async function getUndercutRule(db: DbAdapter): Promise<NotifyRule | null> {
  const rows = await db.select<NotifyRuleRow>(
    `${RULE_SELECT} WHERE kind = 'undercut' ORDER BY rule_id LIMIT 1`,
  );
  return rows[0] === undefined ? null : rowToRule(rows[0]);
}

export interface UndercutRuleInput {
  enabled: boolean;
  thresholdPercent: number;
  thresholdIsk: number;
  regionId: number | null;
  basis: ValuationBasis;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

/** 写入（不存在则创建）全局 Undercut 规则 */
export async function saveUndercutRule(
  db: DbAdapter,
  input: UndercutRuleInput,
  nowMs: number = Date.now(),
): Promise<number> {
  const existing = await getUndercutRule(db);
  const params = [
    input.enabled ? 1 : 0,
    input.thresholdPercent,
    input.thresholdIsk,
    input.regionId,
    input.basis,
    input.quietStartHour,
    input.quietEndHour,
  ];
  if (existing !== null) {
    await db.execute(
      `UPDATE notify_rules
          SET enabled = ?, threshold_percent = ?, threshold_isk = ?, region_id = ?, basis = ?,
              quiet_start_hour = ?, quiet_end_hour = ?
        WHERE rule_id = ?`,
      [...params, existing.ruleId],
    );
    return existing.ruleId;
  }
  await db.execute(
    `INSERT INTO notify_rules (kind, enabled, threshold_percent, threshold_isk, region_id, basis,
                               quiet_start_hour, quiet_end_hour, created_at)
     VALUES ('undercut', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...params, new Date(nowMs).toISOString()],
  );
  const created = await db.select<{ ruleId: number }>(
    `SELECT rule_id AS ruleId FROM notify_rules WHERE kind = 'undercut' ORDER BY rule_id DESC LIMIT 1`,
  );
  const ruleId = created[0]?.ruleId;
  if (ruleId === undefined) throw new Error('保存 Undercut 规则失败：未取回规则 ID');
  return ruleId;
}

export interface WatchPriceRuleInput {
  watchId: number;
  enabled: boolean;
  minPrice: number | null;
  maxPrice: number | null;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

/** 写入价格带规则（同一监视条目已存在则覆盖） */
export async function saveWatchPriceRule(
  db: DbAdapter,
  input: WatchPriceRuleInput,
  nowMs: number = Date.now(),
): Promise<number> {
  const params = [
    input.enabled ? 1 : 0,
    input.minPrice,
    input.maxPrice,
    input.quietStartHour,
    input.quietEndHour,
  ];
  const existing = await db.select<{ ruleId: number }>(
    `SELECT rule_id AS ruleId FROM notify_rules WHERE kind = 'watch_price' AND watch_id = ?`,
    [input.watchId],
  );
  const found = existing[0]?.ruleId;
  if (found !== undefined) {
    await db.execute(
      `UPDATE notify_rules
          SET enabled = ?, min_price = ?, max_price = ?, quiet_start_hour = ?, quiet_end_hour = ?
        WHERE rule_id = ?`,
      [...params, found],
    );
    return found;
  }
  await db.execute(
    `INSERT INTO notify_rules (kind, enabled, watch_id, min_price, max_price,
                               quiet_start_hour, quiet_end_hour, created_at)
     VALUES ('watch_price', ?, ?, ?, ?, ?, ?, ?)`,
    [input.enabled ? 1 : 0, input.watchId, input.minPrice, input.maxPrice,
      input.quietStartHour, input.quietEndHour, new Date(nowMs).toISOString()],
  );
  const created = await db.select<{ ruleId: number }>(
    `SELECT rule_id AS ruleId FROM notify_rules WHERE kind = 'watch_price' AND watch_id = ?`,
    [input.watchId],
  );
  const ruleId = created[0]?.ruleId;
  if (ruleId === undefined) throw new Error('保存价格带规则失败：未取回规则 ID');
  return ruleId;
}

/** 启用 / 停用规则 */
export async function setNotifyRuleEnabled(
  db: DbAdapter,
  ruleId: number,
  enabled: boolean,
): Promise<void> {
  await db.execute('UPDATE notify_rules SET enabled = ? WHERE rule_id = ?', [enabled ? 1 : 0, ruleId]);
}

/** 删除规则 */
export async function deleteNotifyRule(db: DbAdapter, ruleId: number): Promise<void> {
  await db.execute('DELETE FROM notify_rules WHERE rule_id = ?', [ruleId]);
}

/** 记录一次成功发送（供冷却期判定） */
export async function markNotifyRuleFired(
  db: DbAdapter,
  ruleId: number,
  atIso: string,
): Promise<void> {
  await db.execute('UPDATE notify_rules SET last_fired_at = ? WHERE rule_id = ?', [atIso, ruleId]);
}

/** 本地小时是否落在静默时段（支持跨夜，如 22 → 8） */
export function isQuietHour(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 是否仍在冷却期内（`lastFiredAt` 非法时视为未触发） */
export function isCoolingDown(
  lastFiredAt: string | null,
  nowMs: number,
  cooldownMinutes: number = NOTIFY_COOLDOWN_MINUTES,
): boolean {
  if (lastFiredAt === null) return false;
  const last = Date.parse(lastFiredAt);
  if (!Number.isFinite(last)) return false;
  return nowMs - last < cooldownMinutes * 60_000;
}

/** Undercut 命中：我的卖单被压价 */
export interface NotifyUndercutHit {
  ruleId: number;
  kind: 'undercut';
  characterId: number;
  orderId: number;
  typeId: number;
  typeName: string;
  regionId: number;
  regionName: string;
  /** 我的挂单价 */
  myPrice: number;
  /** 市场参照价 */
  referencePrice: number;
  /** 实际采用的参照价口径（回退后可能与规则配置不同） */
  basis: ValuationBasis;
  /** 差额（ISK）= 我的价 − 参照价 */
  deltaIsk: number;
  /** 差额（%）= deltaIsk ÷ 参照价 × 100 */
  deltaPercent: number;
}

/** 价格带命中 */
export interface NotifyWatchPriceHit {
  ruleId: number;
  kind: 'watch_price';
  watchId: number;
  typeId: number;
  typeName: string;
  regionId: number;
  regionName: string;
  bestSell: number;
  minPrice: number | null;
  maxPrice: number | null;
  /** `below_min` 跌破下限（可能是买入机会）/ `above_max` 突破上限（可能是卖出机会） */
  direction: 'below_min' | 'above_max';
}

export type NotifyHit = NotifyUndercutHit | NotifyWatchPriceHit;

export interface NotifyEvaluation {
  evaluatedAt: string;
  /** 命中且应发送的提醒（已排除静默 / 冷却） */
  hits: NotifyHit[];
  /** 命中但因静默时段被压下的条数 */
  quietSuppressed: number;
  /** 命中但因冷却期被压下的条数 */
  cooldownSuppressed: number;
  /** 因缺参照价 / 缺报价而跳过的条数 */
  missingPrice: number;
  /** 参与评估的已启用规则数 */
  enabledRuleCount: number;
}

export interface EvaluateNotifyOptions {
  nowMs?: number;
  cooldownMinutes?: number;
}

interface UndercutRow {
  characterId: number;
  orderId: number;
  typeId: number;
  typeName: string;
  regionId: number;
  regionName: string;
  myPrice: number;
  bestSell: number | null;
  p5Sell: number | null;
  wavgSell: number | null;
  w5Sell: number | null;
}

interface WatchPriceRow {
  ruleId: number;
  watchId: number;
  typeId: number;
  typeName: string;
  regionId: number;
  regionName: string;
  bestSell: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

/**
 * 参照价：按**估值引擎同一套回退链**（`basisFallbackChain`）取第一个可用值。
 * 复用链定义而非在此另写一套，避免口径两处分叉。
 */
function pickReference(
  row: {
    bestSell: number | null;
    p5Sell: number | null;
    wavgSell: number | null;
    w5Sell: number | null;
  },
  basis: ValuationBasis,
): { price: number; basis: ValuationBasis } | null {
  for (const candidate of basisFallbackChain(basis)) {
    const value =
      candidate === 'p5_sell'
        ? row.p5Sell
        : candidate === 'best_sell'
          ? row.bestSell
          : candidate === 'wavg_sell'
            ? row.wavgSell
            : row.w5Sell;
    if (value !== null && Number.isFinite(value) && value > 0) {
      return { price: value, basis: candidate };
    }
  }
  return null;
}

/**
 * 评估全部已启用规则，返回**应发送**的提醒与压制统计。
 *
 * 本函数**不改库**：`last_fired_at` 由调用方在发送成功后写（`markNotifyRuleFired`）。
 */
export async function evaluateNotifyRules(
  db: DbAdapter,
  options: EvaluateNotifyOptions = {},
): Promise<NotifyEvaluation> {
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMinutes = options.cooldownMinutes ?? NOTIFY_COOLDOWN_MINUTES;
  const evaluatedAt = new Date(nowMs).toISOString();
  const localHour = new Date(nowMs).getHours();

  const rules = (await listNotifyRules(db)).filter((rule) => rule.enabled);
  const result: NotifyEvaluation = {
    evaluatedAt,
    hits: [],
    quietSuppressed: 0,
    cooldownSuppressed: 0,
    missingPrice: 0,
    enabledRuleCount: rules.length,
  };
  if (rules.length === 0) return result;

  const admit = (rule: NotifyRule, hit: NotifyHit): void => {
    if (isQuietHour(localHour, rule.quietStartHour, rule.quietEndHour)) {
      result.quietSuppressed += 1;
      return;
    }
    if (isCoolingDown(rule.lastFiredAt, nowMs, cooldownMinutes)) {
      result.cooldownSuppressed += 1;
      return;
    }
    result.hits.push(hit);
  };

  // ── Undercut ──
  const undercut = rules.find((rule) => rule.kind === 'undercut');
  if (undercut !== undefined) {
    const filters = ['COALESCE(o.is_buy_order, 0) = 0'];
    const params: unknown[] = [];
    if (undercut.regionId !== null) {
      filters.push('o.region_id = ?');
      params.push(undercut.regionId);
    }
    const rows = await db.select<UndercutRow>(
      `SELECT o.character_id AS characterId,
              o.order_id     AS orderId,
              o.type_id      AS typeId,
              COALESCE(t.name_zh, t.name_en, 'typeID ' || o.type_id) AS typeName,
              o.region_id    AS regionId,
              COALESCE(r.name_zh, r.name_en, 'region ' || o.region_id) AS regionName,
              o.price        AS myPrice,
              s.best_sell    AS bestSell,
              s.p5_sell      AS p5Sell,
              s.wavg_sell    AS wavgSell,
              s.w5_sell      AS w5Sell
         FROM my_orders o
         LEFT JOIN market_stats s ON s.region_id = o.region_id AND s.type_id = o.type_id
         LEFT JOIN sde_types t    ON t.type_id = o.type_id
         LEFT JOIN sde_regions r  ON r.region_id = o.region_id
        WHERE ${filters.join(' AND ')}`,
      params,
    );

    const thresholdPercent = undercut.thresholdPercent ?? DEFAULT_UNDERCUT_THRESHOLD_PERCENT;
    const thresholdIsk = undercut.thresholdIsk ?? 0;
    const ruleBasis = undercut.basis ?? DEFAULT_UNDERCUT_BASIS;

    for (const row of rows) {
      const reference = pickReference(row, ruleBasis);
      if (reference === null) {
        result.missingPrice += 1;
        continue;
      }
      const deltaIsk = row.myPrice - reference.price;
      const deltaPercent = (deltaIsk / reference.price) * 100;
      if (deltaPercent <= thresholdPercent || deltaIsk < thresholdIsk) continue;
      admit(undercut, {
        ruleId: undercut.ruleId,
        kind: 'undercut',
        characterId: row.characterId,
        orderId: row.orderId,
        typeId: row.typeId,
        typeName: row.typeName,
        regionId: row.regionId,
        regionName: row.regionName,
        myPrice: row.myPrice,
        referencePrice: reference.price,
        basis: reference.basis,
        deltaIsk,
        deltaPercent,
      });
    }
  }

  // ── 监视列表价格带（用 best_sell：对齐「现在能买到的最低价」这一事实量） ──
  for (const rule of rules) {
    if (rule.kind !== 'watch_price' || rule.watchId === null) continue;
    const rows = await db.select<WatchPriceRow>(
      `SELECT r.rule_id   AS ruleId,
              w.watch_id  AS watchId,
              w.type_id   AS typeId,
              COALESCE(t.name_zh, t.name_en, 'typeID ' || w.type_id) AS typeName,
              w.region_id AS regionId,
              COALESCE(g.name_zh, g.name_en, 'region ' || w.region_id) AS regionName,
              s.best_sell AS bestSell,
              r.min_price AS minPrice,
              r.max_price AS maxPrice
         FROM notify_rules r
         JOIN watchlist_items w ON w.watch_id = r.watch_id
         LEFT JOIN market_stats s ON s.region_id = w.region_id AND s.type_id = w.type_id
         LEFT JOIN sde_types t    ON t.type_id = w.type_id
         LEFT JOIN sde_regions g  ON g.region_id = w.region_id
        WHERE r.rule_id = ?`,
      [rule.ruleId],
    );
    const row = rows[0];
    if (row === undefined) continue;
    if (row.bestSell === null || !Number.isFinite(row.bestSell) || row.bestSell <= 0) {
      result.missingPrice += 1;
      continue;
    }
    if (row.minPrice !== null && row.bestSell < row.minPrice) {
      admit(rule, { ...row, bestSell: row.bestSell, kind: 'watch_price', direction: 'below_min' });
    } else if (row.maxPrice !== null && row.bestSell > row.maxPrice) {
      admit(rule, { ...row, bestSell: row.bestSell, kind: 'watch_price', direction: 'above_max' });
    }
  }

  return result;
}

/** Webhook 通道配置（存 `settings` 键 `notify.webhook`） */
export interface WebhookConfig {
  enabled: boolean;
  kind: 'dingtalk' | 'wecom' | 'feishu' | 'custom';
  url: string;
  /** 钉钉加签密钥（`SEC...`）；仅 `kind = 'dingtalk'` 时使用 */
  secret: string;
  /** 是否 @所有人（钉钉 / 企业微信） */
  mentionAll: boolean;
}

export const WEBHOOK_SETTING_KEY = 'notify.webhook';

const EMPTY_WEBHOOK: WebhookConfig = {
  enabled: false,
  kind: 'dingtalk',
  url: '',
  secret: '',
  mentionAll: false,
};

/** 读取 Webhook 配置（未配置时返回默认值） */
export async function readWebhookConfig(db: DbAdapter): Promise<WebhookConfig> {
  const raw = await readSetting(db, WEBHOOK_SETTING_KEY);
  if (raw === null) return { ...EMPTY_WEBHOOK };
  try {
    const parsed = JSON.parse(raw) as Partial<WebhookConfig>;
    const kind = parsed.kind;
    return {
      enabled: parsed.enabled === true,
      kind: kind === 'wecom' || kind === 'feishu' || kind === 'custom' ? kind : 'dingtalk',
      url: typeof parsed.url === 'string' ? parsed.url : '',
      secret: typeof parsed.secret === 'string' ? parsed.secret : '',
      mentionAll: parsed.mentionAll === true,
    };
  } catch {
    return { ...EMPTY_WEBHOOK };
  }
}

/** 写入 Webhook 配置 */
export async function writeWebhookConfig(db: DbAdapter, config: WebhookConfig): Promise<void> {
  await writeSetting(db, WEBHOOK_SETTING_KEY, JSON.stringify(config));
}
