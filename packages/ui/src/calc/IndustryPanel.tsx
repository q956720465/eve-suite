import {
  DEFAULT_VALUATION_BASIS,
  MAX_MATERIAL_EFFICIENCY,
  TRADE_HUBS,
  computeIndustryReconciliation,
  getTypeNames,
  listCharacters,
  type BlueprintActivity,
  type CharacterSummary,
  type IndustryActivitySummary,
  type IndustryJobReconciliation,
  type IndustryReconciliationResult,
  type TypeNameEntry,
  type ValuationBasis,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 活动中文名（与「库存缺口」面板同口径；未识别的 activity_id 由调用方兜底展示） */
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
};

const HUB_NAMES = new Map(TRADE_HUBS.map((hub) => [hub.regionId, hub.nameEn]));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 带正负号（偏差列） */
function formatDelta(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** ISO 时间 → `YYYY-MM-DD HH:mm`（UTC，与库内存储一致） */
function formatDateTime(iso: string | null): string {
  if (iso === null || iso.length === 0) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

function activityLabel(activity: BlueprintActivity | null, activityId: number): string {
  return activity === null ? `活动 ${activityId}` : ACTIVITY_LABELS[activity];
}

/**
 * 工业成本闭环（P5-6 引擎 + 界面）。
 *
 * 任务（P3 同步的 `industry_jobs`）× 钱包流水（`context_id_type = 'industry_job_id'`）两段对账：
 * - **安装费**：预算 = ESI `cost`，实际 = 关联流水支出 → 偏差
 * - **材料**：BOM × 假设 ME × 估值单价（ESI 不返回 ME，按假设值计算）
 * - **闭环**：产出估值 − 材料预算 − 安装费实际 = 毛利
 *
 * 全部本地计算，**零 ESI 请求**。
 */
export default function IndustryPanel() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [scope, setScope] = useState<'all' | number>('all');
  const [meInput, setMeInput] = useState('0');
  const [basis, setBasis] = useState<ValuationBasis>(DEFAULT_VALUATION_BASIS);
  const [regionId, setRegionId] = useState<number>(TRADE_HUBS[0].regionId);

  const [result, setResult] = useState<IndustryReconciliationResult | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        setCharacters(await listCharacters(db));
      } catch (error) {
        setMessage(`读取角色清单失败：${describeError(error)}`);
      }
    })();
  }, []);

  const me = useMemo(() => {
    const parsed = Number.parseFloat(meInput);
    return Number.isFinite(parsed) ? Math.min(MAX_MATERIAL_EFFICIENCY, Math.max(0, parsed)) : 0;
  }, [meInput]);

  const scopeIds = useMemo(
    () =>
      scope === 'all'
        ? characters.map((item) => item.characterId)
        : characters.some((item) => item.characterId === scope)
          ? [scope]
          : [],
    [characters, scope],
  );

  const regionLabel = HUB_NAMES.get(regionId) ?? `区域 ${regionId}`;

  const compute = useCallback(async () => {
    if (scopeIds.length === 0) {
      setResult(null);
      return;
    }
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const outcome = await computeIndustryReconciliation(db, scopeIds, { me, regionId, basis });

      const typeIds = new Set<number>();
      for (const job of [...outcome.jobs, ...outcome.unfinishedJobs]) {
        typeIds.add(job.blueprintTypeId);
        if (job.productTypeId !== null) typeIds.add(job.productTypeId);
        for (const material of job.materials) typeIds.add(material.typeId);
      }
      for (const typeId of outcome.missingTypeIds) typeIds.add(typeId);
      setNames(await getTypeNames(db, [...typeIds]));
      setResult(outcome);
      setMessage('');
    } catch (error) {
      setMessage(`工业对账失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [scopeIds, me, regionId, basis]);

  useEffect(() => {
    void compute();
  }, [compute]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      return entry === undefined ? `typeID ${typeId}` : entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  /** 任务的「备注」：缺价与无关联流水 */
  const remarkOf = useCallback((job: IndustryJobReconciliation): string => {
    const notes: string[] = [];
    if (job.missingMaterialTypeIds.length > 0) notes.push(`材料缺价 ${job.missingMaterialTypeIds.length} 种`);
    if (job.productTypeId !== null && job.productQuantity !== null && job.productUnitPrice === null) {
      notes.push('产出无报价');
    }
    if (job.isCompleted && !job.hasLedgerLink) notes.push('无关联流水');
    if (job.activity === null) notes.push('活动未识别');
    return notes.length === 0 ? '—' : notes.join(' · ');
  }, []);

  const completed = result?.jobs ?? [];
  const unfinished = result?.unfinishedJobs ?? [];

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>工业成本闭环 · 对账（{regionLabel}）</h2>
          <span className="hint">
            任务 × 钱包流水（industry_job_id）两段对账；ESI <strong>不返回 ME</strong>，材料预算按下方假设值计算
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
            材料效率假设（%）
            <input
              value={meInput}
              placeholder="0"
              onChange={(event) => setMeInput(event.target.value)}
            />
          </label>
          <label>
            价格口径
            <select value={basis} onChange={(event) => setBasis(event.target.value as ValuationBasis)}>
              {(Object.keys(BASIS_LABELS) as ValuationBasis[]).map((key) => (
                <option key={key} value={key}>
                  {BASIS_LABELS[key]}
                </option>
              ))}
            </select>
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
          <button type="button" onClick={() => void compute()} disabled={busy}>
            {busy ? '计算中…' : '重新计算'}
          </button>
        </div>

        <p className="hint">
          材料预算按<strong>假设 ME {me}%</strong>（默认 0 = 材料成本上限）计算；ESI 的工业任务
          <strong>不返回 ME / TE</strong>，故此处无法还原真实效率。材料「实际采购额」不做——
          钱包流水里买材料的记录（market_transaction）<strong>无法反查物品</strong>，不臆造。
        </p>

        {characters.length === 0 ? (
          <p className="hint">尚无角色。请先在「资产」页完成授权与同步。</p>
        ) : result === null ? (
          <p className="hint">{busy ? '计算中…' : '暂无数据。'}</p>
        ) : result.completedCount === 0 && result.unfinishedCount === 0 ? (
          <p className="hint">
            该范围内<strong>没有工业任务记录</strong>（industry_jobs 由 P3 同步：
            请先在游戏内开工，再到「资产」页同步个人数据）。
          </p>
        ) : (
          <>
            <table className="result">
              <thead>
                <tr>
                  <th>已完工任务</th>
                  <th>材料预算</th>
                  <th>安装费预算</th>
                  <th>安装费实际</th>
                  <th>安装费偏差</th>
                  <th>产出估值</th>
                  <th>毛利（闭环）</th>
                  <th>无关联流水</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{result.completedCount} 条</td>
                  <td>{formatIsk(result.materialBudget)}</td>
                  <td>{formatIsk(result.installationFeeBudget)}</td>
                  <td>{formatIsk(result.installationFeeActual)}</td>
                  <td className="sell">{formatDelta(result.installationFeeDelta)}</td>
                  <td>{formatIsk(result.productValue)}</td>
                  <td className="sell">{formatIsk(result.grossProfit)}</td>
                  <td>{result.unlinkedCount} 条</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              毛利 = 产出估值 − 材料预算 − 安装费实际（仅统计可算毛利的任务，
              目前 <strong>{result.profitIncompleteCount}</strong> 条因「产出无报价 / 无法解析 BOM」未计入）。
              安装费偏差 = 实际 − 预算（仅统计两者都有的任务）；无关联流水的任务偏差显示「—」。
            </p>
          </>
        )}

        {result !== null && result.activitySummaries.length > 0 && (
          <table className="result">
            <thead>
              <tr>
                <th>活动</th>
                <th>任务数</th>
                <th>材料预算</th>
                <th>安装费预算</th>
                <th>安装费实际</th>
                <th>产出估值</th>
                <th>毛利</th>
              </tr>
            </thead>
            <tbody>
              {result.activitySummaries.map((summary: IndustryActivitySummary) => (
                <tr key={summary.activityId}>
                  <td>{activityLabel(summary.activity, summary.activityId)}</td>
                  <td>{summary.jobCount}</td>
                  <td>{formatIsk(summary.materialBudget)}</td>
                  <td>{formatIsk(summary.installationFeeBudget)}</td>
                  <td>{formatIsk(summary.installationFeeActual)}</td>
                  <td>{formatIsk(summary.productValue)}</td>
                  <td className="sell">{formatIsk(summary.grossProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {completed.length > 0 && (
        <div className="panel">
          <h2>已完工任务（预算 vs 实际）</h2>
          <table className="result">
            <thead>
              <tr>
                <th>任务</th>
                <th>蓝图 / 产出</th>
                <th>活动</th>
                <th>完成时间</th>
                <th>runs</th>
                <th>材料预算</th>
                <th>安装费预算</th>
                <th>安装费实际</th>
                <th>偏差</th>
                <th>产出估值</th>
                <th>毛利</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {completed.map((job) => (
                <tr key={`${job.characterId}:${job.jobId}`}>
                  <td>{job.jobId}</td>
                  <td>
                    {nameOf(job.blueprintTypeId)}
                    {job.productTypeId === null ? '' : ` → ${nameOf(job.productTypeId)}`}
                  </td>
                  <td>{activityLabel(job.activity, job.activityId)}</td>
                  <td>{formatDateTime(job.completedDate ?? job.endDate)}</td>
                  <td>{job.runs}</td>
                  <td>{formatIsk(job.materialBudget)}</td>
                  <td>{formatIsk(job.installationFeeBudget)}</td>
                  <td>{formatIsk(job.installationFeeActual)}</td>
                  <td className="sell">{formatDelta(job.installationFeeDelta)}</td>
                  <td>{formatIsk(job.productValue)}</td>
                  <td className="sell">{formatIsk(job.grossProfit)}</td>
                  <td>{remarkOf(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            按完成时间降序。产出估值 = 单流程产出 × 成功流程数 × 单价；BPC 类产物（发明 / 复制）无市场报价 → 显示「—」。
          </p>
        </div>
      )}

      {unfinished.length > 0 && (
        <div className="panel">
          <h2>未完工任务（不计入汇总）</h2>
          <table className="result">
            <thead>
              <tr>
                <th>任务</th>
                <th>蓝图 / 产出</th>
                <th>活动</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>runs</th>
                <th>材料预算（估算）</th>
                <th>安装费预算</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {unfinished.map((job) => (
                <tr key={`${job.characterId}:${job.jobId}`}>
                  <td>{job.jobId}</td>
                  <td>
                    {nameOf(job.blueprintTypeId)}
                    {job.productTypeId === null ? '' : ` → ${nameOf(job.productTypeId)}`}
                  </td>
                  <td>{activityLabel(job.activity, job.activityId)}</td>
                  <td>{job.status}</td>
                  <td>{formatDateTime(job.startDate)}</td>
                  <td>{job.runs}</td>
                  <td>{formatIsk(job.materialBudget)}</td>
                  <td>{formatIsk(job.installationFeeBudget)}</td>
                  <td>{remarkOf(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result !== null && result.missingTypeIds.length > 0 && (
        <div className="panel">
          <h2>缺价物品（{result.missingTypeIds.length} 种）</h2>
          <p className="hint">
            {result.missingTypeIds.map((typeId) => nameOf(typeId)).join('、')}
            {' '}—— 请先在「行情」页采集对应枢纽数据（缺价按 0 计入预算，会使毛利偏高）。
          </p>
        </div>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
