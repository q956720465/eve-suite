import {
  TRADE_HUBS,
  computeBlueprintCost,
  computeOfferValue,
  getTypeNames,
  listLpOffers,
  refineOre,
  type BlueprintCostResult,
  type LpOfferValuation,
  type RefineOreResult,
} from '@eve-suite/core';
import { useCallback, useEffect, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/**
 * 算例对照（P4-5-4）：把 P4-2 / P4-3 / P4-4 已实测的**第三方零误差算例**
 * 固化成卡片，用**当前本地库**一键复算并逐项比对。
 *
 * 判定口径：
 * - **静态量**（蓝图基础量/产物/时长/上限、矿石产出量）与行情无关 → 要求**零误差**
 * - **价格类量**（LP 产出估值、ISK/LP）必然随行情漂移 → 只展示差值并标注，
 *   **不判通过/失败**（第三方常量是「核对当时」的快照）
 */

/** 算例 1：Fuzzwork 蓝图 API（原始响应见 DEV_STATUS「P4-2 实测记录」） */
const BLUEPRINT_CASE = {
  blueprintTypeId: 17477,
  source: 'Fuzzwork 蓝图 API · blueprint.php?typeid=17477（制造活动基础量）',
  /** 类型 id → 基础量（ME 0、单流程） */
  materials: [
    { typeId: 34, quantity: 1_600_000 },
    { typeId: 35, quantity: 300_000 },
    { typeId: 36, quantity: 75_000 },
    { typeId: 37, quantity: 40_000 },
    { typeId: 38, quantity: 15_000 },
    { typeId: 39, quantity: 2_500 },
    { typeId: 40, quantity: 1_400 },
  ],
  productTypeId: 17476,
  productQuantity: 1,
  jobSeconds: 12_000,
  maxProductionLimit: 10,
} as const;

/** 算例 2：Fuzzwork LP 计算页（Jita 5% 分位）+ 手算校核 */
const LP_CASE = {
  corporationId: 1000035,
  offerId: 4180,
  source: 'Fuzzwork LP 计算页（Jita 5% 分位）+ 手算：(产出估值 − 375,000) ÷ 375',
  lpCost: 375,
  iskCost: 375_000,
  requiredItemCount: 0,
  /** 核对当时的第三方产出估值（价格类，会漂移） */
  outputValue: 1_649_550,
  /** = (1,649,550 − 375,000) ÷ 375 */
  iskPerLp: 3_398.8,
} as const;

/** 算例 3：EVE University wiki「Reprocessing」实机算例 */
const ORE_CASE = {
  oreTypeId: 18,
  quantity: 120_000,
  yieldRate: 0.69575,
  source: 'EVE University wiki · Reprocessing（120,000 单位 Plagioclase @ 69.575%）',
  outputs: [
    { typeId: 34, quantity: 146_107 },
    { typeId: 36, quantity: 58_443 },
  ],
} as const;

type Verdict = 'ok' | 'drift' | 'fail';

interface CaseRow {
  label: string;
  expected: string;
  actual: string;
  delta: string;
  verdict: Verdict;
}

interface CaseResult {
  id: string;
  title: string;
  source: string;
  rows: CaseRow[];
  level: Verdict;
  note: string;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: '零误差',
  drift: '行情漂移',
  fail: '不一致',
};

/** 复算结果：成功带值，失败带原因（单个算例失败不影响其余） */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatNumber(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 静态量比对：数值相同即零误差 */
function compareNumber(label: string, expected: number, actual: number | null): CaseRow {
  return {
    label,
    expected: formatNumber(expected),
    actual: formatNumber(actual),
    delta: actual === null ? '—' : formatNumber(actual - expected),
    verdict: actual !== null && Math.abs(actual - expected) < 1e-6 ? 'ok' : 'fail',
  };
}

/** 价格类比对：只展示差值，不判失败 */
function comparePrice(label: string, expected: number, actual: number | null): CaseRow {
  return {
    label,
    expected: formatNumber(expected),
    actual: formatNumber(actual),
    delta: actual === null ? '—' : formatNumber(actual - expected),
    verdict: actual !== null && Math.abs(actual - expected) < 1e-6 ? 'ok' : 'drift',
  };
}

function levelOf(rows: readonly CaseRow[]): Verdict {
  if (rows.some((row) => row.verdict === 'fail')) return 'fail';
  if (rows.some((row) => row.verdict === 'drift')) return 'drift';
  return 'ok';
}

function failedCase(id: string, title: string, source: string, error: string): CaseResult {
  return { id, title, source, rows: [], level: 'fail', note: `复算失败：${error}` };
}

/** 算例对照面板（P4-5-4） */
export default function CalcCasePanel() {
  const [cases, setCases] = useState<CaseResult[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const regionId = TRADE_HUBS[0].regionId;

      // 阶段 1：三个算例各自独立复算（互不影响）
      const blueprintOutcome = await attempt(() =>
        computeBlueprintCost(db, BLUEPRINT_CASE.blueprintTypeId, {
          activity: 'manufacturing',
          runs: 1,
          me: 0,
          te: 0,
          regionId,
        }),
      );
      const lpOutcome = await attempt<LpOfferValuation | null>(async () => {
        const offers = await listLpOffers(db, LP_CASE.corporationId);
        const offer = offers.find((item) => item.offerId === LP_CASE.offerId) ?? null;
        return offer === null ? null : await computeOfferValue(db, offer, { regionId });
      });
      const oreOutcome = await attempt(() =>
        refineOre(db, {
          oreTypeId: ORE_CASE.oreTypeId,
          quantity: ORE_CASE.quantity,
          yieldRate: ORE_CASE.yieldRate,
          taxRate: 0,
        }),
      );

      // 阶段 2：一次性解析名称（再组装文案，避免把名称依赖带进 Hook 依赖链）
      const typeIds = [
        BLUEPRINT_CASE.blueprintTypeId,
        BLUEPRINT_CASE.productTypeId,
        ...BLUEPRINT_CASE.materials.map((item) => item.typeId),
        ORE_CASE.oreTypeId,
        ...ORE_CASE.outputs.map((item) => item.typeId),
        ...(lpOutcome.ok && lpOutcome.value !== null ? [lpOutcome.value.typeId] : []),
      ];
      const nameMap = await getTypeNames(db, typeIds);
      const nameOf = (typeId: number): string => {
        const entry = nameMap.get(typeId);
        if (entry === undefined) return `typeID ${typeId}`;
        return entry.nameZh ?? entry.nameEn;
      };

      // 阶段 3：组装三张对照卡
      const results: CaseResult[] = [];

      if (!blueprintOutcome.ok) {
        results.push(
          failedCase('blueprint', '蓝图算例', BLUEPRINT_CASE.source, blueprintOutcome.error),
        );
      } else {
        const cost: BlueprintCostResult = blueprintOutcome.value;
        const baseByType = new Map(cost.materials.map((line) => [line.typeId, line.baseQuantity]));
        const rows: CaseRow[] = [
          compareNumber('材料种数', BLUEPRINT_CASE.materials.length, cost.materials.length),
          ...BLUEPRINT_CASE.materials.map((item) =>
            compareNumber(
              `基础量 · ${nameOf(item.typeId)}`,
              item.quantity,
              baseByType.get(item.typeId) ?? null,
            ),
          ),
          {
            label: `产物 · ${nameOf(BLUEPRINT_CASE.productTypeId)}`,
            expected: `${BLUEPRINT_CASE.productTypeId} × ${BLUEPRINT_CASE.productQuantity}`,
            actual:
              cost.product === null
                ? '无产出行'
                : `${cost.product.typeId} × ${cost.product.quantityPerRun}`,
            delta: '—',
            verdict:
              cost.product !== null &&
              cost.product.typeId === BLUEPRINT_CASE.productTypeId &&
              cost.product.quantityPerRun === BLUEPRINT_CASE.productQuantity
                ? 'ok'
                : 'fail',
          },
          compareNumber('制造时长（秒）', BLUEPRINT_CASE.jobSeconds, cost.jobSeconds),
          compareNumber('run 上限', BLUEPRINT_CASE.maxProductionLimit, cost.maxProductionLimit),
        ];
        results.push({
          id: 'blueprint',
          title: `蓝图 ${BLUEPRINT_CASE.blueprintTypeId}（${nameOf(BLUEPRINT_CASE.blueprintTypeId)}）`,
          source: BLUEPRINT_CASE.source,
          rows,
          level: levelOf(rows),
          note: '基础量 / 产物 / 时长 / run 上限均为静态量，与行情无关，要求零误差',
        });
      }

      if (!lpOutcome.ok) {
        results.push(failedCase('lp', 'LP 算例', LP_CASE.source, lpOutcome.error));
      } else if (lpOutcome.value === null) {
        results.push({
          id: 'lp',
          title: `LP offer ${LP_CASE.offerId}（军团 ${LP_CASE.corporationId}）`,
          source: LP_CASE.source,
          rows: [],
          level: 'fail',
          note: `本地库暂无可比对的该报价（军团 ${LP_CASE.corporationId} / offer ${LP_CASE.offerId}）——请先在「LP 比价」页点「刷新报价」`,
        });
      } else {
        const valued: LpOfferValuation = lpOutcome.value;
        const rows: CaseRow[] = [
          compareNumber('LP 成本', LP_CASE.lpCost, valued.lpCost),
          compareNumber('ISK 支出', LP_CASE.iskCost, valued.iskCost),
          compareNumber('需求材料种数', LP_CASE.requiredItemCount, valued.requiredItems.length),
          comparePrice('产出估值（价格类）', LP_CASE.outputValue, valued.outputValue),
          comparePrice('ISK/LP（价格类）', LP_CASE.iskPerLp, valued.iskPerLp),
        ];
        results.push({
          id: 'lp',
          title: `LP offer ${LP_CASE.offerId}（${nameOf(valued.typeId)} × ${valued.quantity.toLocaleString()}）`,
          source: LP_CASE.source,
          rows,
          level: levelOf(rows),
          note: 'LP 成本 / ISK 支出 / 材料数为固定量（要求零误差）；产出估值与 ISK/LP 随枢纽行情漂移，只标注差值',
        });
      }

      if (!oreOutcome.ok) {
        results.push(failedCase('ore', '矿石算例', ORE_CASE.source, oreOutcome.error));
      } else {
        const refined: RefineOreResult = oreOutcome.value;
        const outByType = new Map(refined.materials.map((line) => [line.typeId, line.quantity]));
        const rows: CaseRow[] = [
          compareNumber('份数', Math.floor(ORE_CASE.quantity / refined.portionSize), refined.portions),
          ...ORE_CASE.outputs.map((item) =>
            compareNumber(
              `产出量 · ${nameOf(item.typeId)}`,
              item.quantity,
              outByType.get(item.typeId) ?? null,
            ),
          ),
        ];
        results.push({
          id: 'ore',
          title: `矿石 ${ORE_CASE.oreTypeId}（${nameOf(ORE_CASE.oreTypeId)}）`,
          source: ORE_CASE.source,
          rows,
          level: levelOf(rows),
          note: '产出量 = floor(基础量 × 份数 × 产出率)，与行情无关，要求零误差',
        });
      }

      setCases(results);
      setMessage('');
    } catch (error) {
      setCases([]);
      setMessage(`算例复算失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const passed = cases.filter((item) => item.level === 'ok').length;
  const drifted = cases.filter((item) => item.level === 'drift').length;
  const failed = cases.filter((item) => item.level === 'fail').length;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>算例对照（第三方零误差算例 · 用当前本地库一键复算）</h2>
          <span className="hint">
            {cases.length === 0
              ? '尚未复算'
              : `${cases.length} 项中 ${passed} 项零误差${drifted > 0 ? `、${drifted} 项仅行情漂移` : ''}${failed > 0 ? `、${failed} 项不一致` : ''}`}
          </span>
        </div>
        <div className="params">
          <button type="button" onClick={() => void run()} disabled={busy}>
            {busy ? '复算中…' : '一键复算'}
          </button>
        </div>
        <p className="hint">
          静态量（基础量 / 产物 / 时长 / run 上限 / 矿石产出量）要求零误差；价格类量（LP
          产出估值、ISK/LP）随枢纽行情漂移，只展示差值并标注，不判通过与否——第三方常量是核对当时的快照。
        </p>
      </div>

      {cases.map((item) => (
        <div className="panel" key={item.id}>
          <div className="panel-head">
            <h2>{item.title}</h2>
            <span className="hint">判定：{VERDICT_LABEL[item.level]}</span>
          </div>
          <p className="hint">来源：{item.source}</p>
          {item.rows.length === 0 ? (
            <p className="message">{item.note}</p>
          ) : (
            <table className="result">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>第三方期望</th>
                  <th>本地结果</th>
                  <th>差值</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {item.rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.expected}</td>
                    <td>{row.actual}</td>
                    <td>{row.delta}</td>
                    <td className={row.verdict === 'ok' ? 'sell' : ''}>
                      {VERDICT_LABEL[row.verdict]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">{item.note}</p>
        </div>
      ))}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
