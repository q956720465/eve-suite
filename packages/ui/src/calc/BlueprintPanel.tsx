import {
  DEFAULT_BLUEPRINT_ACTIVITY,
  MAX_MATERIAL_EFFICIENCY,
  MAX_TIME_EFFICIENCY,
  TRADE_HUBS,
  computeBlueprintCost,
  getBlueprintActivities,
  getTypeNames,
  searchTypes,
  type BlueprintActivity,
  type BlueprintActivityInfo,
  type BlueprintCostResult,
  type TypeNameEntry,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 默认蓝图：妄想级蓝图（Covetor Blueprint，真实 SDE typeID），首屏即可复核 */
const DEFAULT_BLUEPRINT_TYPE_ID = 17477;

/** 蓝图物品的 SDE 分类英文名——用于把 searchTypes 结果过滤到蓝图 */
const BLUEPRINT_CATEGORY_EN = 'Blueprint';

/** 搜索条数上限：蓝图在 SDE 中约 5 千条，放大上限避免被高排名的同名词物品挤掉 */
const BLUEPRINT_SEARCH_LIMIT = 200;

/** 活动中文标签 */
const ACTIVITY_LABELS: Record<BlueprintActivity, string> = {
  manufacturing: '制造',
  research_material: '材料效率研究（ME）',
  research_time: '时间效率研究（TE）',
  copying: '复制',
  invention: '发明',
  reaction: '反应',
};

/** 搜索结果命中行（仅取面板需要的字段） */
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

/** 空串 / 非数字 → undefined（交给引擎按默认值归一） */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} 秒`);
  return `${parts.join(' ')}（${total.toLocaleString()} 秒）`;
}

/** 蓝图成本计算器（P4-2 引擎 + P4-5-2 界面） */
export default function BlueprintPanel() {
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<BlueprintHit[]>([]);
  const [blueprintTypeId, setBlueprintTypeId] = useState<number | null>(DEFAULT_BLUEPRINT_TYPE_ID);
  const [activities, setActivities] = useState<BlueprintActivityInfo[]>([]);
  const [activity, setActivity] = useState<BlueprintActivity>(DEFAULT_BLUEPRINT_ACTIVITY);
  const [runs, setRuns] = useState('1');
  const [me, setMe] = useState('0');
  const [te, setTe] = useState('0');
  const [includeBlueprintPrice, setIncludeBlueprintPrice] = useState(false);
  const [regionId, setRegionId] = useState<number>(TRADE_HUBS[0].regionId);

  const [result, setResult] = useState<BlueprintCostResult | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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

  /** 切换蓝图：载入活动清单（顺带回显选中蓝图名，默认选中项不在搜索结果里） */
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
  const parsedTe = useMemo(() => parseOptionalNumber(te), [te]);

  const compute = useCallback(async () => {
    if (blueprintTypeId === null) return;
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const outcome = await computeBlueprintCost(db, blueprintTypeId, {
        activity,
        runs: parsedRuns,
        me: parsedMe,
        te: parsedTe,
        includeBlueprintPrice,
        regionId,
      });
      const typeIds = outcome.materials.map((line) => line.typeId);
      if (outcome.product !== null) typeIds.push(outcome.product.typeId);
      const nameMap = await getTypeNames(db, typeIds);
      setNames((previous) => new Map([...previous, ...nameMap]));
      setResult(outcome);
      setMessage('');
    } catch (error) {
      setMessage(`计算失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [blueprintTypeId, activity, parsedRuns, parsedMe, parsedTe, includeBlueprintPrice, regionId]);

  // 参数变化即重算（本地计算，无网络请求）
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

  const blueprintName =
    blueprintTypeId === null ? '—' : nameOf(blueprintTypeId);

  /** 下拉选项：搜索结果 + 补回当前选中项（避免筛掉后显示空白） */
  const blueprintOptions = useMemo(() => {
    const base = hits.map((hit) => ({ typeId: hit.typeId, label: hit.nameZh ?? hit.nameEn }));
    if (blueprintTypeId === null) return base;
    if (base.some((option) => option.typeId === blueprintTypeId)) return base;
    return [{ typeId: blueprintTypeId, label: blueprintName }, ...base];
  }, [hits, blueprintTypeId, blueprintName]);

  const regionName = TRADE_HUBS.find((hub) => hub.regionId === regionId)?.nameEn ?? '';

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>蓝图成本（单价口径：{regionName} 5% 分位）</h2>
          <span className="hint">材料 × 折后价 +（可选）蓝图价；ME/TE 折扣按官方公式</span>
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
            TE（%，上限 {MAX_TIME_EFFICIENCY}）
            <input value={te} onChange={(event) => setTe(event.target.value)} />
          </label>
          <label>
            价格区域
            <select value={regionId} onChange={(event) => setRegionId(Number(event.target.value))}>
              {TRADE_HUBS.map((hub) => (
                <option key={hub.regionId} value={hub.regionId}>
                  {hub.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={includeBlueprintPrice}
              onChange={(event) => setIncludeBlueprintPrice(event.target.checked)}
            />
            计入蓝图价（BPO）
          </label>
          <button type="button" onClick={() => void compute()} disabled={busy}>
            {busy ? '计算中…' : '重新计算'}
          </button>
        </div>

        <p className="hint">
          当前蓝图：{blueprintName} · typeID {blueprintTypeId ?? '—'} —— ME 上限{' '}
          {MAX_MATERIAL_EFFICIENCY}% / TE 上限 {MAX_TIME_EFFICIENCY}%（NPC 站口径，不含建筑与团队系数）；
          安装费、递归展开到基础原料、发明成功率留 P5。缺价材料按 0 计入并单独标注。
        </p>
      </div>

      {result === null ? (
        <div className="panel">
          <p className="hint">选择蓝图后自动计算。</p>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>成本汇总</h2>
              <span className="hint">
                活动「{ACTIVITY_LABELS[result.activity]}」· runs {result.runs} · ME {result.me} · TE{' '}
                {result.te}
                {result.maxProductionLimit !== null
                  ? ` · run 上限 ${result.maxProductionLimit}`
                  : ' · run 上限未知'}
              </span>
            </div>
            <table className="result">
              <thead>
                <tr>
                  <th>材料成本</th>
                  <th>蓝图价</th>
                  <th>总成本</th>
                  <th>单位成本</th>
                  <th>任务时长</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{formatIsk(result.materialCost)}</td>
                  <td>
                    {result.blueprintPrice === null ? '未计入' : formatIsk(result.blueprintPrice)}
                  </td>
                  <td className="sell">{formatIsk(result.totalCost)}</td>
                  <td className="sell">{formatIsk(result.costPerUnit)}</td>
                  <td>{formatDuration(result.jobSeconds)}</td>
                </tr>
              </tbody>
            </table>
            {result.product === null ? (
              <p className="hint">
                {result.activity === 'manufacturing'
                  ? '该蓝图在 SDE 无产出行（制造活动，属已知 23 个），无法计算单位成本。'
                  : '该活动在 SDE 无产出行，无法计算单位成本。'}
                材料与时长仍按该活动给出。
              </p>
            ) : (
              <p className="hint">
                产出：{nameOf(result.product.typeId)} × {result.product.quantityPerRun}（单流程）×{' '}
                {result.runs} runs = 合计 {result.product.totalQuantity.toLocaleString()} 件
              </p>
            )}
          </div>

          <div className="panel">
            <h2>材料清单</h2>
            {result.materials.length === 0 ? (
              <p className="hint">
                该活动在 SDE 无材料行（可能此蓝图不含「{ACTIVITY_LABELS[result.activity]}」活动）。
              </p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>材料</th>
                    <th>基础量（ME 0 / 单流程）</th>
                    <th>折后需求</th>
                    <th>单价（{regionName} 5% 分位）</th>
                    <th>小计</th>
                  </tr>
                </thead>
                <tbody>
                  {result.materials.map((line) => (
                    <tr key={line.typeId}>
                      <td>{nameOf(line.typeId)}</td>
                      <td>{line.baseQuantity.toLocaleString()}</td>
                      <td>{line.quantity.toLocaleString()}</td>
                      <td>{line.unitPrice === null ? '无报价' : formatIsk(line.unitPrice)}</td>
                      <td className="sell">{formatIsk(line.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.missingTypeIds.length > 0 && (
              <p className="hint">
                {result.missingTypeIds.length} 种材料无报价（已按 0 计，成本偏低）：{' '}
                {result.missingTypeIds.map((typeId) => nameOf(typeId)).join('、')}
                ——请先在「行情」页采集该区域枢纽数据。
              </p>
            )}
          </div>
        </>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
