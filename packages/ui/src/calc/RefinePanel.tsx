import {
  REFINE_YIELD_PRESETS,
  getTypeNames,
  listRefinableOres,
  refineOre,
  type RefinableOre,
  type RefineOreResult,
  type TypeNameEntry,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 默认矿石：凡晶石（真实 SDE typeID，可精炼矿石清单里必有） */
const DEFAULT_ORE_TYPE_ID = 1230;

/** 「自定义产出率」在预设下拉中的伪 id */
const CUSTOM_PRESET_ID = 'custom';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/** 矿石精炼值计算器（P4-4 引擎 + P4-5 界面） */
export default function RefinePanel() {
  const [ores, setOres] = useState<RefinableOre[]>([]);
  const [oreFilter, setOreFilter] = useState('');
  const [oreTypeId, setOreTypeId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1000');
  const [presetId, setPresetId] = useState<string>(REFINE_YIELD_PRESETS[0].id);
  const [customYield, setCustomYield] = useState('50');
  const [taxPercent, setTaxPercent] = useState('0');

  const [result, setResult] = useState<RefineOreResult | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  /** 载入可精炼矿石清单（SDE 已有映射的矿石/冰/月矿） */
  useEffect(() => {
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const list = await listRefinableOres(db);
        setOres(list);
        setOreTypeId(
          (previous) =>
            previous ??
            list.find((ore) => ore.typeId === DEFAULT_ORE_TYPE_ID)?.typeId ??
            list[0]?.typeId ??
            null,
        );
      } catch (error) {
        setMessage(`读取可精炼矿石失败：${describeError(error)}`);
      }
    })();
  }, []);

  const yieldRate = useMemo(() => {
    if (presetId === CUSTOM_PRESET_ID) {
      const parsed = Number.parseFloat(customYield);
      // 非法输入交回引擎按默认处理（undefined → 默认产出率）
      return Number.isFinite(parsed) ? parsed / 100 : undefined;
    }
    return REFINE_YIELD_PRESETS.find((preset) => preset.id === presetId)?.yieldRate;
  }, [presetId, customYield]);

  const taxRate = useMemo(() => {
    const parsed = Number.parseFloat(taxPercent);
    return Number.isFinite(parsed) ? parsed / 100 : 0;
  }, [taxPercent]);

  const compute = useCallback(async () => {
    if (oreTypeId === null) return;
    setBusy(true);
    try {
      const { db } = await initCoreRuntime();
      const parsedQuantity = Number.parseInt(quantity, 10);
      const outcome = await refineOre(db, {
        oreTypeId,
        quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : 0,
        yieldRate,
        taxRate,
      });
      setNames(await getTypeNames(db, outcome.materials.map((line) => line.typeId)));
      setResult(outcome);
      setMessage('');
    } catch (error) {
      setMessage(`计算失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [oreTypeId, quantity, yieldRate, taxRate]);

  // 参数变化即重算（本地计算，无网络请求）
  useEffect(() => {
    void compute();
  }, [compute]);

  const visibleOres = useMemo(() => {
    const keyword = oreFilter.trim().toLowerCase();
    if (keyword.length === 0) return ores;
    return ores.filter((ore) =>
      `${ore.nameZh ?? ''} ${ore.nameEn}`.toLowerCase().includes(keyword),
    );
  }, [ores, oreFilter]);

  /** 筛掉的当前选中项要补回，避免下拉显示空白 */
  const oreOptions = useMemo(() => {
    if (oreTypeId === null) return visibleOres;
    if (visibleOres.some((ore) => ore.typeId === oreTypeId)) return visibleOres;
    const selected = ores.find((ore) => ore.typeId === oreTypeId);
    return selected === undefined ? visibleOres : [selected, ...visibleOres];
  }, [visibleOres, ores, oreTypeId]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      if (entry === undefined) return `typeID ${typeId}`;
      return entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>矿石精炼值（单价口径：吉他 5% 分位）</h2>
          <span className="hint">精炼按整份进行，不足一份的余数不参与</span>
        </div>

        <div className="params">
          <label>
            筛选矿石
            <input
              className="search"
              value={oreFilter}
              placeholder="中英文关键词，如 凡晶 / Veld"
              onChange={(event) => setOreFilter(event.target.value)}
            />
          </label>
          <label>
            矿石（{oreOptions.length} / {ores.length}）
            <select
              value={oreTypeId ?? ''}
              onChange={(event) => setOreTypeId(Number(event.target.value))}
            >
              {oreOptions.map((ore) => (
                <option key={ore.typeId} value={ore.typeId}>
                  {ore.nameZh ?? ore.nameEn}（{ore.portionSize} 单位/份）
                </option>
              ))}
            </select>
          </label>
          <label>
            数量（单位）
            <input value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label>
            产出率
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {REFINE_YIELD_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.labelZh}
                </option>
              ))}
              <option value={CUSTOM_PRESET_ID}>自定义（%）</option>
            </select>
          </label>
          {presetId === CUSTOM_PRESET_ID && (
            <label>
              自定义产出率（%）
              <input
                value={customYield}
                onChange={(event) => setCustomYield(event.target.value)}
              />
            </label>
          )}
          <label>
            税率（%）
            <input value={taxPercent} onChange={(event) => setTaxPercent(event.target.value)} />
          </label>
          <button type="button" onClick={() => void compute()} disabled={busy}>
            {busy ? '计算中…' : '重新计算'}
          </button>
        </div>

        <p className="hint">
          产出率预设均为 NPC 站口径（不含玩家建筑与建筑税）：50% → 57.5% → 63.25% → 69.575% → 72.358%（含
          RX-804 植入体）。植入体与建筑加成未接入，可选用「自定义」手填。税按产值扣减，不减少产物数量。
        </p>
        {ores.length === 0 && (
          <p className="hint">
            可精炼矿石清单为空：请先在「数据」页执行 SDE 同步（会导入矿石→矿物映射），再回到本页。
          </p>
        )}
      </div>

      {result === null ? (
        <div className="panel">
          <p className="hint">选择矿石后自动计算。</p>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>精炼结果</h2>
              <span className="hint">
                {result.quantity.toLocaleString()} 单位 ÷ {result.portionSize} ={' '}
                {result.portions.toLocaleString()} 份
                {result.leftoverUnits > 0 ? `，余 ${result.leftoverUnits.toLocaleString()} 单位不计` : ''}
              </span>
            </div>
            <table className="result">
              <thead>
                <tr>
                  <th>份数</th>
                  <th>产出率</th>
                  <th>税率</th>
                  <th>产物估值</th>
                  <th>净产值</th>
                  <th>每单位</th>
                  <th>每 m³</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{result.portions.toLocaleString()}</td>
                  <td>{formatPercent(result.yieldRate)}</td>
                  <td>{formatPercent(result.taxRate)}</td>
                  <td>{formatIsk(result.outputValue)}</td>
                  <td className="sell">{formatIsk(result.netValue)}</td>
                  <td>{formatIsk(result.valuePerUnit)}</td>
                  <td>{result.valuePerCubicMeter === null ? '—' : formatIsk(result.valuePerCubicMeter)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>产物清单</h2>
            {result.unmapped ? (
              <p className="hint">该矿石在 SDE 无精炼映射（未入库或不是可精炼物品）。</p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>产物</th>
                    <th>基础量（每 {result.portionSize} 单位）</th>
                    <th>实际产出</th>
                    <th>单价（5% 分位）</th>
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
                {result.missingTypeIds.length} 种产物无报价（已按 0 计，产值偏低）：{' '}
                {result.missingTypeIds.map((typeId) => nameOf(typeId)).join('、')}
                ——请先在「行情」页采集枢纽数据。
              </p>
            )}
          </div>
        </>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
