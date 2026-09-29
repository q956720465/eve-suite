import {
  EVE_DOWNTIME_UTC_HOUR,
  REFINE_YIELD_PRESETS,
  TRADE_HUBS,
  computeMiningLedger,
  computeMiningRate,
  eveDayOf,
  getSystemNames,
  getTypeNames,
  listCharacters,
  listRefinableOres,
  type CharacterSummary,
  type MiningLedgerResult,
  type MiningRateResult,
  type RefinableOre,
  type SystemNameEntry,
  type TypeNameEntry,
  type ValuationOptions,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 默认矿石：凡晶石（真实 SDE typeID，可精炼矿石清单里必有） */
const DEFAULT_ORE_TYPE_ID = 1230;

/** 「自定义产出率」在预设下拉中的伪 id */
const CUSTOM_PRESET_ID = 'custom';

/** 时间范围（以 EVE 日计：右端点 = 上一个已结束的 EVE 日） */
type RangeKey = '7' | '30' | 'all';

const RANGE_LABELS: Record<RangeKey, string> = {
  '7': '近 7 个 EVE 日',
  '30': '近 30 个 EVE 日',
  all: '全部',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCount(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString();
}

/** 小时数保留两位（体积 ÷ 速率通常不是整数） */
function formatHours(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function parsePositive(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 采矿时薪（P5-5 引擎 + 界面）。
 *
 * 上：**时薪测算器** —— `ISK/h = 采矿速率(m³/h) × 每 m³ 净精炼产值`（附原矿直卖对照）
 * 下：**账簿复盘** —— 真实采矿账簿按 EVE 日（停机 11:00 UTC 为界）聚合的收益 / 体积 / 时薪
 * 全部本地计算，**零 ESI 请求**。
 */
export default function MiningPanel() {
  const [ores, setOres] = useState<RefinableOre[]>([]);
  const [oreFilter, setOreFilter] = useState('');
  const [oreTypeId, setOreTypeId] = useState<number | null>(null);
  /** 采矿速率（m³/小时）：唯一时间基准，默认留空（不编造数字） */
  const [rateInput, setRateInput] = useState('');
  const [presetId, setPresetId] = useState<string>(REFINE_YIELD_PRESETS[0].id);
  const [customYield, setCustomYield] = useState('50');
  const [taxPercent, setTaxPercent] = useState('0');
  const [regionId, setRegionId] = useState<number>(TRADE_HUBS[0].regionId);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [scope, setScope] = useState<'all' | number>('all');
  const [range, setRange] = useState<RangeKey>('30');

  const [rate, setRate] = useState<MiningRateResult | null>(null);
  const [ledger, setLedger] = useState<MiningLedgerResult | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [systems, setSystems] = useState<Map<number, SystemNameEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  /** 载入可精炼矿石清单 + 角色清单 */
  useEffect(() => {
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const [oreList, characterList] = await Promise.all([listRefinableOres(db), listCharacters(db)]);
        setOres(oreList);
        setOreTypeId(
          (previous) =>
            previous ??
            oreList.find((ore) => ore.typeId === DEFAULT_ORE_TYPE_ID)?.typeId ??
            oreList[0]?.typeId ??
            null,
        );
        setCharacters(characterList);
      } catch (error) {
        setMessage(`读取矿石 / 角色清单失败：${describeError(error)}`);
      }
    })();
  }, []);

  const yieldRate = useMemo(() => {
    if (presetId === CUSTOM_PRESET_ID) {
      const parsed = Number.parseFloat(customYield);
      return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed / 100)) : REFINE_YIELD_PRESETS[0].yieldRate;
    }
    return REFINE_YIELD_PRESETS.find((preset) => preset.id === presetId)?.yieldRate ?? REFINE_YIELD_PRESETS[0].yieldRate;
  }, [presetId, customYield]);

  const taxRate = useMemo(() => {
    const parsed = Number.parseFloat(taxPercent);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed / 100)) : 0;
  }, [taxPercent]);

  const valuation = useMemo<ValuationOptions>(() => ({ regionId }), [regionId]);
  const cubicMetersPerHour = useMemo(() => parsePositive(rateInput), [rateInput]);

  const regionLabel = TRADE_HUBS.find((hub) => hub.regionId === regionId)?.nameEn ?? String(regionId);
  const todayEveDay = eveDayOf(Date.now());
  const lastFinishedDay = eveDayOf(Date.now() - 24 * 3_600_000);

  const scopeIds = useMemo(
    () =>
      scope === 'all'
        ? characters.map((item) => item.characterId)
        : characters.some((item) => item.characterId === scope)
          ? [scope]
          : [],
    [characters, scope],
  );

  const fromDate = useMemo(() => {
    if (range === 'all') return undefined;
    const days = Number.parseInt(range, 10);
    return eveDayOf(Date.now() - days * 24 * 3_600_000);
  }, [range]);

  /** 时薪测算器 */
  const computeRate = useCallback(async () => {
    if (oreTypeId === null) return;
    try {
      const { db } = await initCoreRuntime();
      const outcome = await computeMiningRate(db, {
        oreTypeId,
        cubicMetersPerHour: cubicMetersPerHour ?? 0,
        yieldRate,
        taxRate,
        valuation,
      });
      const nameMap = await getTypeNames(db, [oreTypeId, ...outcome.missingTypeIds]);
      setNames((previous) => new Map([...previous, ...nameMap]));
      setRate(outcome);
    } catch (error) {
      setMessage(`测算时薪失败：${describeError(error)}`);
    }
  }, [oreTypeId, cubicMetersPerHour, yieldRate, taxRate, valuation]);

  /** 账簿复盘 */
  const computeLedger = useCallback(async () => {
    if (scopeIds.length === 0) {
      setLedger(null);
      return;
    }
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const outcome = await computeMiningLedger(db, scopeIds, {
        yieldRate,
        taxRate,
        valuation,
        ...(cubicMetersPerHour === null ? {} : { cubicMetersPerHour }),
        ...(fromDate === undefined ? {} : { fromDate }),
      });
      const typeIds = [...outcome.ores.map((line) => line.typeId), ...outcome.missingTypeIds];
      const [nameMap, systemMap] = await Promise.all([
        getTypeNames(db, typeIds),
        getSystemNames(db, outcome.systems.map((line) => line.solarSystemId)),
      ]);
      setNames((previous) => new Map([...previous, ...nameMap]));
      setSystems(systemMap);
      setLedger(outcome);
      setMessage('');
    } catch (error) {
      setMessage(`读取采矿账簿失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [scopeIds, yieldRate, taxRate, valuation, cubicMetersPerHour, fromDate]);

  useEffect(() => {
    void computeRate();
  }, [computeRate]);

  useEffect(() => {
    void computeLedger();
  }, [computeLedger]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      return entry === undefined ? `typeID ${typeId}` : entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  const systemOf = useCallback(
    (systemId: number): string => {
      const entry = systems.get(systemId);
      return entry === undefined ? `星系 ${systemId}` : entry.nameZh ?? entry.nameEn;
    },
    [systems],
  );

  const filteredOres = useMemo(() => {
    const keyword = oreFilter.trim().toLowerCase();
    if (keyword.length === 0) return ores;
    return ores.filter(
      (ore) =>
        ore.nameEn.toLowerCase().includes(keyword) ||
        (ore.nameZh ?? '').toLowerCase().includes(keyword),
    );
  }, [ores, oreFilter]);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>采矿时薪 · 测算器</h2>
          <span className="hint">
            时薪 = 采矿速率(m³/小时) × 每 m³ 净精炼产值（全本地计算，零 ESI 请求）
          </span>
        </div>

        <div className="params">
          <label>
            搜索矿石
            <input
              className="search"
              value={oreFilter}
              placeholder="中英文关键词，如 凡晶 / Veldspar"
              onChange={(event) => setOreFilter(event.target.value)}
            />
          </label>
          <label>
            矿石（{filteredOres.length}）
            <select
              value={oreTypeId ?? ''}
              onChange={(event) => setOreTypeId(Number(event.target.value))}
            >
              {filteredOres.map((ore) => (
                <option key={ore.typeId} value={ore.typeId}>
                  {ore.nameZh ?? ore.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label>
            采矿速率（m³/小时）
            <input
              value={rateInput}
              placeholder="按你的船 / 装备填写"
              onChange={(event) => setRateInput(event.target.value)}
            />
          </label>
          <label>
            精炼产出率
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {REFINE_YIELD_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.labelZh}
                </option>
              ))}
              <option value={CUSTOM_PRESET_ID}>自定义</option>
            </select>
          </label>
          {presetId === CUSTOM_PRESET_ID && (
            <label>
              自定义产出率（%）
              <input value={customYield} onChange={(event) => setCustomYield(event.target.value)} />
            </label>
          )}
          <label>
            税率（%）
            <input value={taxPercent} onChange={(event) => setTaxPercent(event.target.value)} />
          </label>
          <label>
            基准区域
            <select value={regionId} onChange={(event) => setRegionId(Number(event.target.value))}>
              {TRADE_HUBS.map((hub) => (
                <option key={hub.regionId} value={hub.regionId}>
                  {hub.nameEn}
                </option>
              ))}
            </select>
          </label>
        </div>

        {cubicMetersPerHour === null && (
          <p className="hint">
            填写「采矿速率」后即出<strong>每小时收益</strong>；未填写时仍可看每单位 / 每 m³ 净产值（速率因船与装备而异，本工具不替你猜）。
          </p>
        )}

        {rate === null ? (
          <p className="hint">选择矿石后自动测算。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>矿石</th>
                <th>每小时收益</th>
                <th>每 m³ 净产值</th>
                <th>每单位净产值</th>
                <th>每小时采矿量</th>
                <th>原矿直卖（对照）</th>
                <th>精炼 vs 直卖</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{nameOf(rate.oreTypeId)}</td>
                <td className="sell">
                  {cubicMetersPerHour === null
                    ? '—（需填速率）'
                    : rate.iskPerHour === null
                      ? '—（缺体积）'
                      : formatIsk(rate.iskPerHour)}
                  {cubicMetersPerHour !== null && rate.basis === 'raw' && rate.iskPerHour !== null
                    ? '（按原矿直卖）'
                    : ''}
                </td>
                <td>{rate.valuePerCubicMeter === null ? '—' : formatIsk(rate.valuePerCubicMeter)}</td>
                <td>{rate.unmapped ? '—（无精炼映射）' : formatIsk(rate.valuePerUnit)}</td>
                <td>
                  {cubicMetersPerHour === null || rate.unitsPerHour === null
                    ? '—'
                    : `${formatCount(rate.unitsPerHour)} 单位`}
                </td>
                <td>
                  {cubicMetersPerHour === null || rate.rawIskPerHour === null
                    ? '—'
                    : formatIsk(rate.rawIskPerHour)}
                  {rate.rawUnitPrice === null ? '（无报价）' : `（${formatIsk(rate.rawUnitPrice)}/单位）`}
                </td>
                <td>
                  {rate.refineGainFactor === null
                    ? '—'
                    : rate.refineGainFactor >= 1
                      ? `精炼更优 ×${rate.refineGainFactor.toFixed(2)}`
                      : `不如直卖 ×${rate.refineGainFactor.toFixed(2)}`}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {rate !== null && rate.unmapped && (
          <p className="hint">
            该矿石在 SDE <strong>无精炼映射</strong>（冰 / 月矿等），已按<strong>原矿直卖价</strong>兜底。
          </p>
        )}
        {rate !== null && rate.missingTypeIds.length > 0 && (
          <p className="hint">
            精炼产物缺报价（{rate.missingTypeIds.length} 种）：请先在「行情」页采集枢纽数据。
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>采矿账簿复盘（{regionLabel} · {RANGE_LABELS[range]}）</h2>
          <span className="hint">
            日界 = 每日停机 {EVE_DOWNTIME_UTC_HOUR}:00 UTC（北京 {EVE_DOWNTIME_UTC_HOUR + 8}:00）；
            <strong>未结束的当天不计入统计</strong>
          </span>
        </div>

        <div className="params">
          <label>
            角色范围
            <select
              value={scope === 'all' ? 'all' : String(scope)}
              onChange={(event) =>
                setScope(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
            >
              <option value="all">全账号合计（{characters.length}）</option>
              {characters.map((character) => (
                <option key={character.characterId} value={character.characterId}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            时间范围
            <select value={range} onChange={(event) => setRange(event.target.value as RangeKey)}>
              {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
                <option key={key} value={key}>
                  {RANGE_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">
            已结束的最新 EVE 日：<strong>{lastFinishedDay}</strong>（当前进行中：{todayEveDay}）
          </span>
        </div>

        {characters.length === 0 ? (
          <p className="hint">尚无角色。请先在「资产」页完成授权与同步。</p>
        ) : ledger === null ? (
          <p className="hint">{busy ? '读取中…' : '暂无数据。'}</p>
        ) : (
          <>
            {ledger.activeDays === 0 ? (
              <p className="hint">
                该范围内<strong>没有已结束的 EVE 日采矿记录</strong>（采矿账簿由 P3 同步，
                也可用上方测算器估算时薪）。
              </p>
            ) : (
              <>
                <table className="result">
                  <thead>
                    <tr>
                      <th>净收益</th>
                      <th>原矿直卖（对照）</th>
                      <th>采矿总量</th>
                      <th>总体积</th>
                      <th>有效天数</th>
                      <th>总时长</th>
                      <th>时薪</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="sell">{formatIsk(ledger.netValue)}</td>
                      <td>{formatIsk(ledger.rawValue)}</td>
                      <td>{formatCount(ledger.quantity)} 单位</td>
                      <td>{ledger.volume === null ? '—（体积不全）' : `${ledger.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`}</td>
                      <td>{ledger.activeDays} 天</td>
                      <td>{formatHours(ledger.hours)} 小时</td>
                      <td className="sell">{formatIsk(ledger.iskPerHour)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="hint">
                  时薪需填「采矿速率」才能推算（时长 = 体积 ÷ 速率）；未填时只显示收益与体积。
                </p>
              </>
            )}

            {ledger.unfinishedDay !== null && (
              <p className="hint">
                进行中的 EVE 日（{ledger.unfinishedDay.date}，<strong>未计入统计</strong>）：
                {formatCount(ledger.unfinishedDay.quantity)} 单位
                {ledger.unfinishedDay.volume === null
                  ? ''
                  : `、${ledger.unfinishedDay.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`}
                —— 该日到下次停机才结束。
              </p>
            )}

            {ledger.unmappedTypeIds.length > 0 && (
              <p className="hint">
                无精炼映射、已按原矿直卖兜底：{ledger.unmappedTypeIds.map((typeId) => nameOf(typeId)).join('、')}
              </p>
            )}
            {ledger.missingTypeIds.length > 0 && (
              <p className="hint">
                精炼产物 / 原矿缺报价（{ledger.missingTypeIds.length} 种），已按 0 计 —— 收益偏低。
              </p>
            )}
          </>
        )}
      </div>

      {ledger !== null && ledger.days.length > 0 && (
        <>
          <div className="panel">
            <h2>按 EVE 日</h2>
            <table className="result">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>数量</th>
                  <th>体积 (m³)</th>
                  <th>时长 (h)</th>
                  <th>收益</th>
                  <th>时薪</th>
                  <th>星系</th>
                  <th>矿石</th>
                </tr>
              </thead>
              <tbody>
                {ledger.days.map((day) => (
                  <tr key={day.date}>
                    <td>{day.date}</td>
                    <td>{formatCount(day.quantity)}</td>
                    <td>{day.volume === null ? '—' : day.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td>{formatHours(day.hours)}</td>
                    <td className="sell">{formatIsk(day.netValue)}</td>
                    <td>{formatIsk(day.iskPerHour)}</td>
                    <td>{day.systems}</td>
                    <td>{day.ores}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>按月</h2>
            <table className="result">
              <thead>
                <tr>
                  <th>月份</th>
                  <th>有效天数</th>
                  <th>数量</th>
                  <th>体积 (m³)</th>
                  <th>时长 (h)</th>
                  <th>收益</th>
                  <th>时薪</th>
                </tr>
              </thead>
              <tbody>
                {ledger.months.map((month) => (
                  <tr key={month.month}>
                    <td>{month.month}</td>
                    <td>{month.days}</td>
                    <td>{formatCount(month.quantity)}</td>
                    <td>{month.volume === null ? '—' : month.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td>{formatHours(month.hours)}</td>
                    <td className="sell">{formatIsk(month.netValue)}</td>
                    <td>{formatIsk(month.iskPerHour)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>按矿石</h2>
            <table className="result">
              <thead>
                <tr>
                  <th>矿石</th>
                  <th>数量</th>
                  <th>体积 (m³)</th>
                  <th>收益</th>
                  <th>原矿直卖（对照）</th>
                  <th>标注</th>
                </tr>
              </thead>
              <tbody>
                {ledger.ores.map((ore) => (
                  <tr key={ore.typeId}>
                    <td>{nameOf(ore.typeId)}</td>
                    <td>{formatCount(ore.quantity)}</td>
                    <td>{ore.volume === null ? '—' : ore.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="sell">{formatIsk(ore.netValue)}</td>
                    <td>{formatIsk(ore.rawValue)}</td>
                    <td>{ore.fallbackToRaw ? '无精炼映射 · 按原矿直卖' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>按星系</h2>
            <table className="result">
              <thead>
                <tr>
                  <th>星系</th>
                  <th>数量</th>
                  <th>体积 (m³)</th>
                  <th>收益（按体积分摊）</th>
                </tr>
              </thead>
              <tbody>
                {ledger.systems.map((system) => (
                  <tr key={system.solarSystemId}>
                    <td>{systemOf(system.solarSystemId)}</td>
                    <td>{formatCount(system.quantity)}</td>
                    <td>{system.volume === null ? '—' : system.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="sell">{formatIsk(system.netValueAllocated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              收益按各星系体积占比分摊（合计严格等于总收益）；星系比「日期 + 矿石」更细，
              无法复用主口径的整份取整结果，故用分摊而非独立精炼。
            </p>
          </div>
        </>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
