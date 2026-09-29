import {
  DEFAULT_BLUEPRINT_ACTIVITY,
  DEFAULT_VALUATION_BASIS,
  HUB_MAIN_STATIONS,
  MAX_MATERIAL_EFFICIENCY,
  TRADE_HUBS,
  computeInventoryGap,
  getBlueprintActivities,
  getStationNames,
  getTypeNames,
  searchTypes,
  type BlueprintActivity,
  type BlueprintActivityInfo,
  type InventoryGapResult,
  type StationNameEntry,
  type TypeNameEntry,
  type ValuationBasis,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 默认蓝图：妄想级蓝图（Covetor Blueprint，真实 SDE typeID），首屏即可复核 */
const DEFAULT_BLUEPRINT_TYPE_ID = 17477;

/** 蓝图物品的 SDE 分类英文名——用于把 searchTypes 结果过滤到蓝图 */
const BLUEPRINT_CATEGORY_EN = 'Blueprint';

/** 搜索条数上限：蓝图在 SDE 中约 5 千条，放大上限避免被高排名的同名词物品挤掉 */
const BLUEPRINT_SEARCH_LIMIT = 200;

const ACTIVITY_LABELS: Record<BlueprintActivity, string> = {
  manufacturing: '制造',
  research_material: '材料效率研究（ME）',
  research_time: '时间效率研究（TE）',
  copying: '复制',
  invention: '发明',
  reaction: '反应',
};

const BASIS_LABELS: Record<ValuationBasis, string> = {
  p5_sell: '5% 分位（默认，抗钓鱼单）',
  best_sell: '最低卖价',
  wavg_sell: '挂单量加权均价（尾部敏感）',
  w5_sell: '挂单量加权 5% 分位',
};

/** 比价粒度（P10-1）：区域级 = 五大枢纽区域；站点级 = 五大枢纽主站 */
type PriceGranularity = 'region' | 'station';

const GRANULARITY_LABELS: Record<PriceGranularity, string> = {
  region: '区域级（五大枢纽）',
  station: '站点级（五大枢纽主站）',
};

const HUB_NAMES = new Map(TRADE_HUBS.map((hub) => [hub.regionId, hub.nameEn]));

interface BlueprintHit {
  typeId: number;
  nameZh: string | null;
  nameEn: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function hubName(regionId: number | null): string {
  if (regionId === null) return '—';
  return HUB_NAMES.get(regionId) ?? `区域 ${regionId}`;
}

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 库存缺口分析（P5-3 引擎 + 界面）。
 *
 * 蓝图 BOM × 全账号（全部已授权角色）资产 → 缺口清单 → 按各枢纽最低卖价
 * 给出采购清单、总价与建议购买枢纽。全部本地计算，零 ESI 请求。
 */
export default function InventoryPanel() {
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<BlueprintHit[]>([]);
  const [blueprintTypeId, setBlueprintTypeId] = useState<number | null>(DEFAULT_BLUEPRINT_TYPE_ID);
  const [activities, setActivities] = useState<BlueprintActivityInfo[]>([]);
  const [activity, setActivity] = useState<BlueprintActivity>(DEFAULT_BLUEPRINT_ACTIVITY);
  const [runs, setRuns] = useState('1');
  const [me, setMe] = useState('0');
  const [basis, setBasis] = useState<ValuationBasis>(DEFAULT_VALUATION_BASIS);
  const [granularity, setGranularity] = useState<PriceGranularity>('region');

  const [result, setResult] = useState<InventoryGapResult | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [stationNames, setStationNames] = useState<Map<number, StationNameEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  /** 站点级比价才需要站名（区域级只用区域名，不查站表） */
  useEffect(() => {
    if (granularity !== 'station') return;
    let cancelled = false;
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const map = await getStationNames(
          db,
          HUB_MAIN_STATIONS.map((station) => station.stationId),
        );
        if (!cancelled) setStationNames(map);
      } catch (error) {
        if (!cancelled) setMessage(`载入站名失败：${describeError(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [granularity]);

  /** 地点显示名：区域级取区域名，站点级取站名（缺失回退站点 id） */
  const locationLabel = useCallback(
    (regionId: number, stationId: number | null): string => {
      if (stationId === null) return hubName(regionId);
      const entry = stationNames.get(stationId);
      return entry === undefined ? `站点 ${stationId}` : (entry.nameZh ?? entry.nameEn);
    },
    [stationNames],
  );

  /** 搜索蓝图：searchTypes 后按 SDE「Blueprint」分类过滤（带 200ms 防抖） */
  useEffect(() => {
    const keyword = search.trim();
    if (keyword.length === 0) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { db } = await initCoreRuntime();
          const rows = await searchTypes(db, keyword, BLUEPRINT_SEARCH_LIMIT);
          if (cancelled) return;
          setHits(
            rows
              .filter((row) => row.categoryNameEn === BLUEPRINT_CATEGORY_EN)
              .map((row) => ({ typeId: row.typeId, nameZh: row.nameZh, nameEn: row.nameEn })),
          );
        } catch (error) {
          if (!cancelled) setMessage(`搜索蓝图失败：${describeError(error)}`);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  /** 切换蓝图：载入活动清单 + 回显名称 */
  useEffect(() => {
    if (blueprintTypeId === null) return;
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const list = await getBlueprintActivities(db, blueprintTypeId);
        setActivities(list);
        setActivity((previous) => {
          if (list.some((item) => item.activity === previous)) return previous;
          const preferred = list.find((item) => item.activity === DEFAULT_BLUEPRINT_ACTIVITY);
          return preferred?.activity ?? list[0]?.activity ?? DEFAULT_BLUEPRINT_ACTIVITY;
        });
        const nameMap = await getTypeNames(db, [blueprintTypeId]);
        setNames((previous) => new Map([...previous, ...nameMap]));
      } catch (error) {
        setMessage(`载入蓝图活动失败：${describeError(error)}`);
      }
    })();
  }, [blueprintTypeId]);

  const parsedRuns = useMemo(() => parseOptionalNumber(runs), [runs]);
  const parsedMe = useMemo(() => parseOptionalNumber(me), [me]);

  const compute = useCallback(async () => {
    if (blueprintTypeId === null) return;
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const outcome = await computeInventoryGap(db, blueprintTypeId, {
        activity,
        runs: parsedRuns,
        me: parsedMe,
        basis,
        // 站点级：在五大枢纽主站之间比价（P10-1）；区域级走既有默认路径（行为不变）
        ...(granularity === 'station' ? { locations: HUB_MAIN_STATIONS } : {}),
      });
      const typeIds = outcome.lines.map((line) => line.typeId);
      if (outcome.product !== null) typeIds.push(outcome.product.typeId);
      typeIds.push(blueprintTypeId);
      const nameMap = await getTypeNames(db, typeIds);
      setNames((previous) => new Map([...previous, ...nameMap]));
      setResult(outcome);
      setMessage('');
    } catch (error) {
      setMessage(`生成缺口失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [blueprintTypeId, activity, parsedRuns, parsedMe, basis, granularity]);

  // 参数变化即重算（纯本地计算，无网络请求）
  useEffect(() => {
    void compute();
  }, [compute]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      if (entry === undefined) return `typeID ${typeId}`;
      return entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  const blueprintName = blueprintTypeId === null ? '—' : nameOf(blueprintTypeId);

  /**
   * 结果自身的比价粒度（从 `result.locations` 推导，而非当前下拉值）：
   * 重算期间面板会短暂保留上一次结果，用结果自述粒度可避免「标签是本层设置、数据是上一层」的不一致。
   */
  const resultGranularity: PriceGranularity =
    result !== null && result.locations.some((location) => location.stationId !== null)
      ? 'station'
      : 'region';

  const blueprintOptions = useMemo(() => {
    const base = hits.map((hit) => ({ typeId: hit.typeId, label: hit.nameZh ?? hit.nameEn }));
    if (blueprintTypeId === null) return base;
    if (base.some((option) => option.typeId === blueprintTypeId)) return base;
    return [{ typeId: blueprintTypeId, label: blueprintName }, ...base];
  }, [hits, blueprintTypeId, blueprintName]);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>库存缺口分析</h2>
          <span className="hint">蓝图 BOM × 全账号资产 → 缺口清单与采购总价（全本地计算，零 ESI 请求）</span>
        </div>

        <div className="params">
          <label>
            搜索蓝图
            <input
              className="search"
              value={search}
              placeholder="中英文关键词，如 妄想 / Covetor"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            蓝图（{blueprintOptions.length}）
            <select
              value={blueprintTypeId ?? ''}
              onChange={(event) => setBlueprintTypeId(Number(event.target.value))}
            >
              {blueprintOptions.map((option) => (
                <option key={option.typeId} value={option.typeId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            活动
            <select
              value={activity}
              onChange={(event) => setActivity(event.target.value as BlueprintActivity)}
            >
              {activities.length === 0 ? (
                <option value={activity}>{ACTIVITY_LABELS[activity]}</option>
              ) : (
                activities.map((item) => (
                  <option key={item.activity} value={item.activity}>
                    {ACTIVITY_LABELS[item.activity]}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            流程数（runs）
            <input value={runs} onChange={(event) => setRuns(event.target.value)} />
          </label>
          <label>
            ME（%，上限 {MAX_MATERIAL_EFFICIENCY}）
            <input value={me} onChange={(event) => setMe(event.target.value)} />
          </label>
          <label>
            价格口径
            <select
              value={basis}
              onChange={(event) => setBasis(event.target.value as ValuationBasis)}
            >
              {(Object.keys(BASIS_LABELS) as ValuationBasis[]).map((key) => (
                <option key={key} value={key}>
                  {BASIS_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            比价粒度
            <select
              value={granularity}
              onChange={(event) => setGranularity(event.target.value as PriceGranularity)}
            >
              {(Object.keys(GRANULARITY_LABELS) as PriceGranularity[]).map((key) => (
                <option key={key} value={key}>
                  {GRANULARITY_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void compute()} disabled={busy}>
            {busy ? '生成中…' : '生成缺口'}
          </button>
        </div>

        <p className="hint">
          当前蓝图：{blueprintName} · typeID {blueprintTypeId ?? '—'}；需求按 P4-2 已验收的
          runs/ME 口径折算；已有量 = <strong>全部已授权角色</strong>资产之和（不含公司资产）；
          比价范围 = {GRANULARITY_LABELS[granularity]}；缺价物品单列且不计入总价。
          {granularity === 'station' && (
            <>
              <br />
              站点级口径：单价按<strong>该站在架订单簿</strong>算分位（样本比区域级少，冷门物品会
              更抖）；该站无卖单即计缺价，<strong>不会</strong>回退到区域聚合价。
            </>
          )}
        </p>
      </div>

      {result === null ? (
        <div className="panel">
          <p className="hint">选择蓝图后自动生成缺口。</p>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>缺口汇总</h2>
              <span className="hint">
                活动「{ACTIVITY_LABELS[result.activity]}」· runs {result.runs} · ME {result.me}
                {result.maxProductionLimit !== null
                  ? ` · run 上限 ${result.maxProductionLimit}`
                  : ' · run 上限未知'}
                {` · 比价 ${GRANULARITY_LABELS[resultGranularity]}`}
              </span>
            </div>
            <table className="result">
              <thead>
                <tr>
                  <th>需采购物品种数</th>
                  <th>建议购买地点</th>
                  <th>采购总价</th>
                  <th>理论下限（逐项最低）</th>
                  <th>缺价物品</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {result.gapTypeCount} / {result.materialTypeCount}
                  </td>
                  <td>
                    {result.gapTypeCount === 0 || result.suggestedRegionId === null
                      ? '—（无需采购）'
                      : locationLabel(result.suggestedRegionId, result.suggestedStationId)}
                  </td>
                  <td className="sell">{formatIsk(result.totalCost)}</td>
                  <td>{formatIsk(result.floorCost)}</td>
                  <td>{result.missingTypeIds.length}</td>
                </tr>
              </tbody>
            </table>

            {result.runsExceedsLimit && (
              <p className="message">
                注意：runs {result.runs} 超过单次任务上限 {result.maxProductionLimit}
                （BPC 限制），实际需分多次任务执行 —— 不影响材料总量计算。
              </p>
            )}

            {result.product === null ? (
              <p className="hint">该活动在 SDE 无产出行（不影响材料缺口计算）。</p>
            ) : (
              <p className="hint">
                产出：{nameOf(result.product.typeId)} × {result.product.quantityPerRun}（单流程）×{' '}
                {result.runs} runs = 合计 {result.product.totalQuantity.toLocaleString()} 件
              </p>
            )}

            {result.gapTypeCount === 0 && (
              <p className="hint">资产已满足该 BOM，无需采购。</p>
            )}

            {result.missingTypeIds.length > 0 && (
              <p className="hint">
                以下物品在<strong>所有地点均无报价</strong>（不计入总价，请先在「行情」页采集）：
                {result.missingTypeIds.map((typeId) => nameOf(typeId)).join('、')}
              </p>
            )}
          </div>

          <div className="panel">
            <h2>采购清单（按小计降序）</h2>
            {result.lines.length === 0 ? (
              <p className="hint">没有需要采购的物品。</p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>物品</th>
                    <th>需求</th>
                    <th>已有</th>
                    <th>缺口</th>
                    <th>建议地点单价</th>
                    <th>小计</th>
                    <th>最便宜地点</th>
                    <th>各地点单价</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((line) => (
                    <tr key={line.typeId}>
                      <td>{nameOf(line.typeId)}</td>
                      <td>{line.required.toLocaleString()}</td>
                      <td>{line.owned.toLocaleString()}</td>
                      <td className="sell">{line.gap.toLocaleString()}</td>
                      <td>{line.unitPrice === null ? '无报价' : formatIsk(line.unitPrice)}</td>
                      <td className="sell">{formatIsk(line.subtotal)}</td>
                      <td>
                        {line.cheapestRegionId === null
                          ? '—'
                          : locationLabel(line.cheapestRegionId, line.cheapestStationId)}
                      </td>
                      <td>
                        {line.prices
                          .map(
                            (entry) =>
                              `${locationLabel(entry.regionId, entry.stationId)} ${
                                entry.price === null ? '无报价' : formatIsk(entry.price)
                              }`,
                          )
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>地点对照（换地点买）</h2>
            <table className="result">
              <thead>
                <tr>
                  <th>地点</th>
                  <th>采购总价</th>
                  <th>缺价种数</th>
                </tr>
              </thead>
              <tbody>
                {result.hubSummaries.map((hub) => (
                  <tr key={hub.stationId ?? hub.regionId}>
                    <td>{locationLabel(hub.regionId, hub.stationId)}</td>
                    <td className="sell">{formatIsk(hub.totalCost)}</td>
                    <td>{hub.missingCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              建议购买地点先比「能否一次买齐」（缺价种数少者优先），再比总价 —— 避免选到「因缺数据而显得便宜」的地点。
              实际采购还需自行考虑运费与货舱。
            </p>
          </div>
        </>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
