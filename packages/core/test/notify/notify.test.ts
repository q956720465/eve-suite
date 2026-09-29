import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import {
  DEFAULT_UNDERCUT_THRESHOLD_PERCENT,
  deleteNotifyRule,
  evaluateNotifyRules,
  getUndercutRule,
  isCoolingDown,
  isQuietHour,
  listNotifyRules,
  markNotifyRuleFired,
  readWebhookConfig,
  saveUndercutRule,
  saveWatchPriceRule,
  setNotifyRuleEnabled,
  writeWebhookConfig,
  type NotifyHit,
} from '../../src/notify/rules';
import {
  buildNotifyMessage,
  buildWebhookRequest,
  describeHit,
  signDingtalkUrl,
  toPlainText,
} from '../../src/notify/webhook';
import { addWatchItem } from '../../src/market/watchlist';
import { createMigratedDb } from '../helpers/db';
import { JITA, insertStats } from '../engines/fixtures';

const CHAR = 2114553827;
const TRITANIUM = 34;
const VELDSPAR = 1230;

/** 固定时刻：东八区 12:00（本地小时 = 12），让静默时段判定不随真实时间漂移 */
const NOW = Date.parse('2026-09-29T04:00:00Z');

async function insertSellOrder(
  db: DbAdapter,
  input: {
    orderId: number;
    typeId: number;
    price: number;
    regionId?: number;
    isBuyOrder?: boolean;
    characterId?: number;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO my_orders (character_id, order_id, type_id, region_id, location_id, price,
                            volume_total, volume_remain, is_corporation, duration, issued, range,
                            is_buy_order, fetched_at)
     VALUES (?, ?, ?, ?, 60003760, ?, 100, 100, 0, 90, '2026-09-01T00:00:00Z', 'station', ?, '2026-09-27T00:00:00Z')`,
    [
      input.characterId ?? CHAR,
      input.orderId,
      input.typeId,
      input.regionId ?? JITA,
      input.price,
      input.isBuyOrder === true ? 1 : 0,
    ],
  );
}

async function insertRegionName(db: DbAdapter, regionId: number, nameZh: string): Promise<void> {
  await db.execute('INSERT INTO sde_regions (region_id, name_en, name_zh) VALUES (?, ?, ?)', [
    regionId,
    'The Forge',
    nameZh,
  ]);
}

/** 默认 Undercut 规则：阈值 5%、无绝对下限、全部区域、p5_sell */
async function seedUndercutRule(
  db: DbAdapter,
  patch: Partial<Parameters<typeof saveUndercutRule>[1]> = {},
): Promise<number> {
  return saveUndercutRule(
    db,
    {
      enabled: true,
      thresholdPercent: DEFAULT_UNDERCUT_THRESHOLD_PERCENT,
      thresholdIsk: 0,
      regionId: null,
      basis: 'p5_sell',
      quietStartHour: null,
      quietEndHour: null,
      ...patch,
    },
    NOW,
  );
}

describe('isQuietHour（静默时段，含跨夜）', () => {
  it('未配置 / 起止相同 → 永不静默', () => {
    expect(isQuietHour(12, null, null)).toBe(false);
    expect(isQuietHour(12, 9, null)).toBe(false);
    expect(isQuietHour(12, 12, 12)).toBe(false);
  });

  it('同日区间：左闭右开', () => {
    expect(isQuietHour(9, 9, 18)).toBe(true);
    expect(isQuietHour(17, 9, 18)).toBe(true);
    expect(isQuietHour(18, 9, 18)).toBe(false);
    expect(isQuietHour(8, 9, 18)).toBe(false);
  });

  it('跨夜区间（22 → 8）：覆盖两端', () => {
    expect(isQuietHour(23, 22, 8)).toBe(true);
    expect(isQuietHour(2, 22, 8)).toBe(true);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(8, 22, 8)).toBe(false);
    expect(isQuietHour(12, 22, 8)).toBe(false);
  });
});

describe('isCoolingDown（冷却期）', () => {
  it('未触发 → 不在冷却；非法时间同样视为未触发', () => {
    expect(isCoolingDown(null, NOW)).toBe(false);
    expect(isCoolingDown('not-a-date', NOW)).toBe(false);
  });

  it('冷却期内 → true；超过冷却期 → false', () => {
    expect(isCoolingDown(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe(true);
    expect(isCoolingDown(new Date(NOW - 7 * 60 * 60_000).toISOString(), NOW)).toBe(false);
  });
});

describe('规则读写', () => {
  it('Undercut 规则幂等：重复保存只有一条，且字段被更新', async () => {
    const db = await createMigratedDb();
    const first = await seedUndercutRule(db);
    const second = await saveUndercutRule(
      db,
      {
        enabled: false,
        thresholdPercent: 8,
        thresholdIsk: 1000,
        regionId: JITA,
        basis: 'best_sell',
        quietStartHour: 22,
        quietEndHour: 8,
      },
      NOW,
    );
    expect(second).toBe(first);

    const rules = await listNotifyRules(db);
    expect(rules).toHaveLength(1);
    const rule = await getUndercutRule(db);
    expect(rule?.enabled).toBe(false);
    expect(rule?.thresholdPercent).toBe(8);
    expect(rule?.basis).toBe('best_sell');
    expect(rule?.quietStartHour).toBe(22);
  });

  it('价格带规则按 watchId 覆盖（不新增第二条）', async () => {
    const db = await createMigratedDb();
    const watchId = await addWatchItem(db, TRITANIUM, JITA, null, NOW);
    const first = await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: 3, maxPrice: null, quietStartHour: null, quietEndHour: null },
      NOW,
    );
    const second = await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: 4, maxPrice: 6, quietStartHour: null, quietEndHour: null },
      NOW,
    );
    expect(second).toBe(first);

    const rules = await listNotifyRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].minPrice).toBe(4);
    expect(rules[0].maxPrice).toBe(6);
  });

  it('启停与删除', async () => {
    const db = await createMigratedDb();
    const ruleId = await seedUndercutRule(db);
    await setNotifyRuleEnabled(db, ruleId, false);
    expect((await getUndercutRule(db))?.enabled).toBe(false);
    await deleteNotifyRule(db, ruleId);
    expect(await listNotifyRules(db)).toHaveLength(0);
  });
});

describe('evaluateNotifyRules — Undercut', () => {
  it('高于参照价且超阈值 → 命中，字段完整', async () => {
    const db = await createMigratedDb();
    await insertRegionName(db, JITA, '铸炉');
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 });
    await seedUndercutRule(db);

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit.kind).toBe('undercut');
    if (hit.kind !== 'undercut') throw new Error('类型收窄失败');
    expect(hit.typeName).toBe('typeID 34'); // 未插 sde_types → 回退占位名
    expect(hit.regionName).toBe('铸炉');
    expect(hit.myPrice).toBe(100);
    expect(hit.referencePrice).toBe(80);
    expect(hit.basis).toBe('p5_sell');
    expect(hit.deltaIsk).toBe(20);
    expect(hit.deltaPercent).toBeCloseTo(25);
    expect(result.enabledRuleCount).toBe(1);
  });

  it('未超阈值 → 不命中', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 81 }); // +1.25%
    await seedUndercutRule(db);

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(result.hits).toHaveLength(0);
    expect(result.quietSuppressed).toBe(0);
    expect(result.cooldownSuppressed).toBe(0);
  });

  it('买单向不参与（只盯我的卖单）', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 200, isBuyOrder: true });
    await seedUndercutRule(db);

    expect((await evaluateNotifyRules(db, { nowMs: NOW })).hits).toHaveLength(0);
  });

  it('缺参照价 → 计入 missingPrice，不命中', async () => {
    const db = await createMigratedDb();
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 }); // 无 market_stats
    await seedUndercutRule(db);

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(result.hits).toHaveLength(0);
    expect(result.missingPrice).toBe(1);
  });

  it('basis=best_sell 且 best_sell 缺失 → 回退 p5_sell 并标注实际口径', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80, bestSell: null });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 });
    await seedUndercutRule(db, { basis: 'best_sell' });

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    const hit = result.hits[0];
    expect(hit.kind).toBe('undercut');
    if (hit.kind !== 'undercut') throw new Error('类型收窄失败');
    expect(hit.referencePrice).toBe(80);
    expect(hit.basis).toBe('p5_sell');
  });

  it('绝对下限（threshold_isk）拦截小额差额', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 }); // 差额 20 ISK
    await seedUndercutRule(db, { thresholdIsk: 25 });

    expect((await evaluateNotifyRules(db, { nowMs: NOW })).hits).toHaveLength(0);
  });

  it('region_id 限定：其它区域的挂单不参与', async () => {
    const db = await createMigratedDb();
    const OTHER = 10000043;
    await insertStats(db, { regionId: OTHER, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100, regionId: OTHER });
    await seedUndercutRule(db, { regionId: JITA });

    expect((await evaluateNotifyRules(db, { nowMs: NOW })).hits).toHaveLength(0);
  });
});

describe('evaluateNotifyRules — 静默与冷却', () => {
  it('静默时段内命中 → 计入 quietSuppressed 且不发送', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 });
    await seedUndercutRule(db, { quietStartHour: 12, quietEndHour: 13 }); // NOW = 本地 12 点

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(result.hits).toHaveLength(0);
    expect(result.quietSuppressed).toBe(1);
    expect(result.cooldownSuppressed).toBe(0);
  });

  it('冷却期内命中 → 计入 cooldownSuppressed；冷却超期后恢复发送', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, p5Sell: 80 });
    await insertSellOrder(db, { orderId: 1, typeId: TRITANIUM, price: 100 });
    const ruleId = await seedUndercutRule(db);
    await markNotifyRuleFired(db, ruleId, new Date(NOW - 60 * 60_000).toISOString());

    const cooling = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(cooling.hits).toHaveLength(0);
    expect(cooling.cooldownSuppressed).toBe(1);

    await markNotifyRuleFired(db, ruleId, new Date(NOW - 7 * 60 * 60_000).toISOString());
    expect((await evaluateNotifyRules(db, { nowMs: NOW })).hits).toHaveLength(1);
  });
});

describe('evaluateNotifyRules — 监视价格带', () => {
  it('跌破下限 / 突破上限各自命中，区间内不触发', async () => {
    const db = await createMigratedDb();
    const watchId = await addWatchItem(db, TRITANIUM, JITA, null, NOW);
    await insertStats(db, { regionId: JITA, typeId: TRITANIUM, bestSell: 5 });
    await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: 10, maxPrice: null, quietStartHour: null, quietEndHour: null },
      NOW,
    );

    const below = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(below.hits).toHaveLength(1);
    const hit = below.hits[0];
    expect(hit.kind).toBe('watch_price');
    if (hit.kind !== 'watch_price') throw new Error('类型收窄失败');
    expect(hit.direction).toBe('below_min');
    expect(hit.bestSell).toBe(5);

    // 区间内（3 ≤ 5 ≤ 12）→ 不触发
    await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: 3, maxPrice: 12, quietStartHour: null, quietEndHour: null },
      NOW,
    );
    expect((await evaluateNotifyRules(db, { nowMs: NOW })).hits).toHaveLength(0);

    // 突破上限
    await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: null, maxPrice: 4, quietStartHour: null, quietEndHour: null },
      NOW,
    );
    const above = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(above.hits).toHaveLength(1);
    expect((above.hits[0] as { direction: string }).direction).toBe('above_max');
  });

  it('监视条目无报价 → 计入 missingPrice', async () => {
    const db = await createMigratedDb();
    const watchId = await addWatchItem(db, VELDSPAR, JITA, null, NOW);
    await saveWatchPriceRule(
      db,
      { watchId, enabled: true, minPrice: 10, maxPrice: null, quietStartHour: null, quietEndHour: null },
      NOW,
    );

    const result = await evaluateNotifyRules(db, { nowMs: NOW });
    expect(result.hits).toHaveLength(0);
    expect(result.missingPrice).toBe(1);
  });
});

describe('Webhook 报文与加签', () => {
  it('钉钉加签与 node:crypto 独立实现完全一致', async () => {
    const secret = 'SECabcdef0123456789';
    const url = 'https://oapi.dingtalk.com/robot/send?access_token=tok123';
    const signed = await signDingtalkUrl(url, secret, NOW);

    const expectedSign = encodeURIComponent(
      createHmac('sha256', secret).update(`${NOW}\n${secret}`).digest('base64'),
    );
    expect(signed).toBe(`${url}&timestamp=${NOW}&sign=${expectedSign}`);
  });

  it('钉钉报文：markdown + at；带密钥时 URL 追加 timestamp/sign', async () => {
    const message = { title: 'EVE Suite 提醒（1 条）', text: '### 标题\n- 内容' };
    const withSecret = await buildWebhookRequest(
      {
        enabled: true,
        kind: 'dingtalk',
        url: 'https://oapi.dingtalk.com/robot/send?access_token=tok',
        secret: 'SECxyz',
        mentionAll: true,
      },
      message,
      NOW,
    );
    expect(withSecret.url).toContain(`timestamp=${NOW}`);
    expect(withSecret.url).toContain('&sign=');
    expect(withSecret.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(withSecret.body) as {
      msgtype: string;
      markdown: { title: string; text: string };
      at: { isAtAll: boolean };
    };
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.title).toBe(message.title);
    expect(body.markdown.text).toBe(message.text);
    expect(body.at.isAtAll).toBe(true);
  });

  it('钉钉无密钥时不加签', async () => {
    const request = await buildWebhookRequest(
      { enabled: true, kind: 'dingtalk', url: 'https://example.com/hook', secret: '', mentionAll: false },
      { title: 't', text: 'x' },
      NOW,
    );
    expect(request.url).toBe('https://example.com/hook');
  });

  it('企业微信：text + mentioned_list；飞书：msg_type=text；自定义：title/text 对象', async () => {
    const message = { title: 'EVE Suite 提醒（1 条）', text: '### 标题\n**粗体**\n- 行' };

    const wecom = await buildWebhookRequest(
      { enabled: true, kind: 'wecom', url: 'https://example.com/wecom', secret: '', mentionAll: true },
      message,
      NOW,
    );
    const wecomBody = JSON.parse(wecom.body) as {
      msgtype: string;
      text: { content: string; mentioned_list?: string[] };
    };
    expect(wecomBody.msgtype).toBe('text');
    expect(wecomBody.text.content).not.toContain('###');
    expect(wecomBody.text.content).not.toContain('**');
    expect(wecomBody.text.mentioned_list).toEqual(['@all']);

    const feishu = await buildWebhookRequest(
      { enabled: true, kind: 'feishu', url: 'https://example.com/feishu', secret: '', mentionAll: false },
      message,
      NOW,
    );
    expect(JSON.parse(feishu.body)).toEqual({ msg_type: 'text', content: { text: toPlainText(message.text) } });

    const custom = await buildWebhookRequest(
      { enabled: true, kind: 'custom', url: 'https://example.com/custom', secret: '', mentionAll: false },
      message,
      NOW,
    );
    expect(JSON.parse(custom.body)).toEqual({ title: message.title, text: message.text });
  });

  it('buildNotifyMessage 把同轮命中合并成一条（分组 + 逐行描述）', async () => {
    const hits: NotifyHit[] = [
      {
        ruleId: 1,
        kind: 'undercut',
        characterId: CHAR,
        orderId: 1,
        typeId: TRITANIUM,
        typeName: '三钛合金',
        regionId: JITA,
        regionName: '铸炉',
        myPrice: 100,
        referencePrice: 80,
        basis: 'p5_sell',
        deltaIsk: 20,
        deltaPercent: 25,
      },
      {
        ruleId: 2,
        kind: 'watch_price',
        watchId: 1,
        typeId: VELDSPAR,
        typeName: '凡晶石',
        regionId: JITA,
        regionName: '铸炉',
        bestSell: 9,
        minPrice: 10,
        maxPrice: null,
        direction: 'below_min',
      },
    ];

    const message = buildNotifyMessage(hits, NOW);
    expect(message.title).toBe('EVE Suite 提醒（2 条）');
    expect(message.text).toContain('**⚠️ 被压价（1 条）**');
    expect(message.text).toContain('**💰 监视价格带（1 条）**');
    expect(message.text).toContain('三钛合金 @ 铸炉：我的 100 vs 参照 80（+25.00%，p5_sell）');
    expect(message.text).toContain('凡晶石 @ 铸炉：最低卖价 9，跌破下限 10');
    expect(describeHit(hits[1])).toContain('跌破下限');
  });
});

describe('Webhook 配置读写', () => {
  it('往返一致；未配置 / 非法 JSON → 回退默认值', async () => {
    const db = await createMigratedDb();
    expect(await readWebhookConfig(db)).toEqual({
      enabled: false,
      kind: 'dingtalk',
      url: '',
      secret: '',
      mentionAll: false,
    });

    await writeWebhookConfig(db, {
      enabled: true,
      kind: 'feishu',
      url: 'https://example.com/hook',
      secret: '',
      mentionAll: true,
    });
    const loaded = await readWebhookConfig(db);
    expect(loaded.kind).toBe('feishu');
    expect(loaded.enabled).toBe(true);
    expect(loaded.mentionAll).toBe(true);

    await db.execute("UPDATE settings SET value = '{bad json' WHERE key = 'notify.webhook'");
    expect((await readWebhookConfig(db)).url).toBe('');
  });
});
