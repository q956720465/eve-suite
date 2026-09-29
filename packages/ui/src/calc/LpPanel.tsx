import {
  TRADE_HUBS,
  buildLpPortfolio,
  getTypeNames,
  listCharacters,
  listLpBalances,
  listLpStoreStates,
  rankLpOffers,
  type CharacterSummary,
  type LpBalance,
  type LpOfferRanking,
  type LpOfferValuation,
  type LpPortfolioEntry,
  type LpStoreState,
  type TypeNameEntry,
} from '@eve-suite/core';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { initCoreRuntime } from '../core/runtime';
import type { LpStoreSyncHandle } from '../lp/useLpStoreSync';

/** 排名表默认条数上限 */
const DEFAULT_RANK_LIMIT = '20';

/** 军团没有名称来源（SDE 的 npcCorporations 只用于合成站名、未落表），统一以 id 呈现 */
function corpLabel(corporationId: number): string {
  return `军团 ${corporationId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** LP 为整数；无效值返回 0（用于合计展示） */
function formatLp(value: number | null): string {
  if (value === null) return '—';
  return Math.round(value).toLocaleString();
}

function formatTime(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

/** 空串 / 非法 → undefined（交回引擎按默认处理） */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 蓝图类产出估值（P7-4）的假设参数：`runs` 缺省取该 offer 的 `quantity`、`ME` 缺省 0，
 * 与 Fuzzwork 同口径（ESI/SDE 都不返回 LP 商店 BPC 的授权 run 数，故必须可覆盖）。
 */
const DEFAULT_BLUEPRINT_RUNS_HINT = '默认=报价数量';
const DEFAULT_BLUEPRINT_ME_HINT = '默认 0';

/**
 * 蓝图估算标记：写明假设参数，避免估算值被误读为实测价。
 * `estimation === null`（非蓝图产出，或产物无报价而未估算）时不渲染。
 */
function estimateBadge(estimation: LpOfferValuation['estimation']): ReactNode {
  if (estimation === null) return null;
  const totalProduct = estimation.productQuantityPerRun * estimation.runs;
  return (
    <span
      className="hint"
      title={`蓝图估算：产物 ${estimation.productTypeId} × ${totalProduct}（runs ${estimation.runs} · ME ${estimation.me}%）`}
    >
      {' （估算）'}
    </span>
  );
}

/** LP 比价计算器（P4-3 引擎 + P4-5-3 界面） */
export default function LpPanel({ lpStore }: { lpStore: LpStoreSyncHandle }) {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [characterId, setCharacterId] = useState<number | null>(null);

  const [balances, setBalances] = useState<LpBalance[]>([]);
  const [states, setStates] = useState<LpStoreState[]>([]);
  const [corporationId, setCorporationId] = useState<number | null>(null);

  const [portfolio, setPortfolio] = useState<LpPortfolioEntry[] | null>(null);
  const [ranking, setRanking] = useState<LpOfferRanking | null>(null);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());

  const [regionId, setRegionId] = useState<number>(TRADE_HUBS[0].regionId);
  const [limitInput, setLimitInput] = useState(DEFAULT_RANK_LIMIT);
  const [minIskPerLpInput, setMinIskPerLpInput] = useState('');
  const [includeAk, setIncludeAk] = useState(false);
  /** 蓝图类产出估算的假设（留空 = 引擎默认：runs 取该报价的数量、ME 0） */
  const [blueprintRunsInput, setBlueprintRunsInput] = useState('');
  const [blueprintMeInput, setBlueprintMeInput] = useState('');

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const limit = useMemo(() => parseOptionalNumber(limitInput), [limitInput]);
  const minIskPerLp = useMemo(() => parseOptionalNumber(minIskPerLpInput), [minIskPerLpInput]);
  const blueprintRuns = useMemo(() => parseOptionalNumber(blueprintRunsInput), [blueprintRunsInput]);
  const blueprintMe = useMemo(() => parseOptionalNumber(blueprintMeInput), [blueprintMeInput]);
  const regionName = TRADE_HUBS.find((hub) => hub.regionId === regionId)?.nameEn ?? '';

  /** 载入已授权角色（无角色时面板只提示授权） */
  useEffect(() => {
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const list = await listCharacters(db);
        setCharacters(list);
        setCharacterId((previous) => previous ?? list[0]?.characterId ?? null);
      } catch (error) {
        setMessage(`读取已授权角色失败：${describeError(error)}`);
      }
    })();
  }, []);

  // 报价同步完成后（lastSummary 变化）也需要重载：LP 报价可能已更新
  const summaryKey = lpStore.lastSummary === null ? '' : String(lpStore.lastSummary.results.length);

  /** 角色切换 / 报价更新 → 载入该角色的 LP 余额与各军团抓取水位 */
  useEffect(() => {
    if (characterId === null) {
      setBalances([]);
      setStates([]);
      setCorporationId(null);
      return;
    }
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const [balanceRows, stateRows] = await Promise.all([
          listLpBalances(db, characterId),
          listLpStoreStates(db),
        ]);
        setBalances(balanceRows);
        setStates(stateRows);
        setCorporationId((previous) =>
          previous !== null && balanceRows.some((row) => row.corporationId === previous)
            ? previous
            : (balanceRows[0]?.corporationId ?? null),
        );
      } catch (error) {
        setMessage(`读取 LP 余额失败：${describeError(error)}`);
      }
    })();
  }, [characterId, summaryKey, lpStore.lastSummary]);

  /** 一次解析面板用到的全部物品名 */
  const resolveNames = useCallback(async (typeIds: number[]): Promise<void> => {
    if (typeIds.length === 0) return;
    const { db } = await initCoreRuntime();
    const nameMap = await getTypeNames(db, typeIds);
    setNames((previous) => new Map([...previous, ...nameMap]));
  }, []);

  /** LP 组合：每军团可用 LP × 最优 ISK/LP */
  useEffect(() => {
    if (characterId === null) {
      setPortfolio(null);
      return;
    }
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const entries = await buildLpPortfolio(db, characterId, {
          regionId,
          limit,
          minIskPerLp,
          includeAkOffers: includeAk,
          blueprintRuns,
          blueprintMe,
        });
        setPortfolio(entries);
        await resolveNames(
          entries.flatMap((entry) => [
            ...(entry.bestOffer === null ? [] : [entry.bestOffer.typeId]),
            ...entry.alternatives.map((offer) => offer.typeId),
          ]),
        );
      } catch (error) {
        setMessage(`LP 组合计算失败：${describeError(error)}`);
      }
    })();
  }, [characterId, regionId, limit, minIskPerLp, includeAk, blueprintRuns, blueprintMe, summaryKey, lpStore.lastSummary, resolveNames]);

  /** 单军团 ISK/LP 排名 */
  useEffect(() => {
    if (corporationId === null) {
      setRanking(null);
      return;
    }
    void (async () => {
      setLoading(true);
      try {
        const { db } = await initCoreRuntime();
        const result = await rankLpOffers(db, corporationId, {
          regionId,
          limit,
          minIskPerLp,
          includeAkOffers: includeAk,
          blueprintRuns,
          blueprintMe,
        });
        setRanking(result);
        await resolveNames(
          result.offers.flatMap((offer) => [
            offer.typeId,
            ...offer.requiredItems.map((item) => item.typeId),
            ...(offer.estimation === null
              ? []
              : [offer.estimation.productTypeId, ...offer.estimation.missingTypeIds]),
          ]),
        );
        setMessage('');
      } catch (error) {
        setMessage(`LP 排名计算失败：${describeError(error)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [corporationId, regionId, limit, minIskPerLp, includeAk, blueprintRuns, blueprintMe, summaryKey, lpStore.lastSummary, resolveNames]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      if (entry === undefined) return `typeID ${typeId}`;
      return entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedState = states.find((state) => state.corporationId === corporationId) ?? null;

  const portfolioTotal = useMemo(
    () => (portfolio === null ? 0 : portfolio.reduce((sum, entry) => sum + entry.totalNetIsk, 0)),
    [portfolio],
  );

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>LP 比价（单价口径：{regionName} 5% 分位）</h2>
          <span className="hint">数据源：ESI 公共端点（无需授权）；24h 内不回源，到期靠 ETag 复校</span>
        </div>

        <div className="params">
          <label>
            角色
            <select
              value={characterId ?? ''}
              onChange={(event) => setCharacterId(Number(event.target.value))}
            >
              {characters.length === 0 ? (
                <option value="">（无已授权角色）</option>
              ) : (
                characters.map((character) => (
                  <option key={character.characterId} value={character.characterId}>
                    {character.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            军团（{balances.length}）
            <select
              value={corporationId ?? ''}
              onChange={(event) => setCorporationId(Number(event.target.value))}
            >
              {balances.length === 0 ? (
                <option value="">（无 LP 余额）</option>
              ) : (
                balances.map((balance) => (
                  <option key={balance.corporationId} value={balance.corporationId}>
                    {corpLabel(balance.corporationId)} · {formatLp(balance.loyaltyPoints)} LP
                  </option>
                ))
              )}
            </select>
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
          <label>
            排名条数上限
            <input value={limitInput} onChange={(event) => setLimitInput(event.target.value)} />
          </label>
          <label>
            最小 ISK/LP
            <input
              value={minIskPerLpInput}
              placeholder="留空为不限制"
              onChange={(event) => setMinIskPerLpInput(event.target.value)}
            />
          </label>
          <label>
            蓝图假设 ME %
            <input
              value={blueprintMeInput}
              placeholder={DEFAULT_BLUEPRINT_ME_HINT}
              onChange={(event) => setBlueprintMeInput(event.target.value)}
            />
          </label>
          <label>
            蓝图假设 runs
            <input
              value={blueprintRunsInput}
              placeholder={DEFAULT_BLUEPRINT_RUNS_HINT}
              onChange={(event) => setBlueprintRunsInput(event.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={includeAk}
              onChange={(event) => setIncludeAk(event.target.checked)}
            />
            纳入 CONCORD LP 报价（ak_cost &gt; 0）
          </label>
          <button type="button" onClick={() => void lpStore.refresh()} disabled={lpStore.syncing}>
            {lpStore.syncing ? '刷新中…' : '刷新报价'}
          </button>
        </div>

        <p className="hint">
          军团无中文名来源（SDE 未落表），统一显示编号。ISK/LP = （产出估值 − 材料成本 − ISK 支出）÷
          LP 成本；产出<strong>无市场报价</strong>时为「—」，不虚构值。`ak_cost &gt; 0` 的报价默认跳过。
        </p>
        <p className="hint">
          产出为<strong>蓝图</strong>的报价（LP 商店共 133 条）按 Fuzzwork 同口径估算：产出估值 =
          产物单价 ×（产物单次产量 × runs）− 蓝图制造材料成本，其中
          <strong>runs 默认取该报价的数量、ME 默认 0</strong>
          （ESI/SDE 都不返回 BPC 授权 run 数，故可在上方覆盖）；表内以「（估算）」标注。制造材料缺价按 0
          计入并在悬浮提示中列出。
        </p>
        {characters.length === 0 && (
          <p className="hint">尚无已授权角色：请先在「资产」页完成授权，LP 余额随个人数据同步写入。</p>
        )}
        {characters.length > 0 && balances.length === 0 && (
          <p className="hint">该角色暂无 LP 余额（或尚未同步个人数据）。</p>
        )}
        {lpStore.message.length > 0 && <p className="hint">{lpStore.message}</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>报价新鲜度</h2>
          <span className="hint">「刷新报价」为强制回源；24h 内自动轮次直接复用缓存</span>
        </div>
        {balances.length === 0 ? (
          <p className="hint">尚无该角色的 LP 余额记录。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>军团</th>
                <th>可用 LP</th>
                <th>报价条数</th>
                <th>最近成功</th>
                <th>缓存到期</th>
                <th>最近错误</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((balance) => {
                const state =
                  states.find((item) => item.corporationId === balance.corporationId) ?? null;
                return (
                  <tr key={balance.corporationId}>
                    <td>{corpLabel(balance.corporationId)}</td>
                    <td>{formatLp(balance.loyaltyPoints)}</td>
                    <td>{state === null ? '未抓取' : state.offersWritten.toLocaleString()}</td>
                    <td>{state === null ? '—' : formatTime(state.lastOkAt)}</td>
                    <td>{state === null ? '—' : formatTime(state.expiresAt)}</td>
                    <td>{state === null || state.lastError === null ? '—' : state.lastError}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>LP 组合（每军团换什么、共值多少）</h2>
          <span className="hint">点行展开次优备选</span>
        </div>
        {portfolio === null || portfolio.length === 0 ? (
          <p className="hint">暂无可计算的 LP 组合（无 LP 余额或无可用报价）。</p>
        ) : (
          <>
            <table className="result">
              <thead>
                <tr>
                  <th>军团</th>
                  <th>可用 LP</th>
                  <th>最优产出物</th>
                  <th>ISK/LP</th>
                  <th>全部 LP 净收益</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.map((entry) => {
                  const key = `portfolio-${entry.corporationId}`;
                  const open = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className={open ? 'selected' : ''} onClick={() => toggle(key)}>
                        <td>{corpLabel(entry.corporationId)}</td>
                        <td>{formatLp(entry.loyaltyPoints)}</td>
                        <td>
                          {entry.bestOffer === null ? (
                            '无可比价报价'
                          ) : (
                            <>
                              {`${nameOf(entry.bestOffer.typeId)} × ${entry.bestOffer.quantity.toLocaleString()}`}
                              {estimateBadge(entry.bestOffer.estimation)}
                            </>
                          )}
                        </td>
                        <td>{formatIsk(entry.bestOffer?.iskPerLp ?? null)}</td>
                        <td className="sell">{formatIsk(entry.totalNetIsk)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5}>
                            <p className="hint">
                              参与排名 {entry.offersRanked.toLocaleString()} 条 · 跳过 ak{' '}
                              {entry.skippedAkOffers} 条 · 产出无报价 {entry.unpricedOutputOffers} 条
                            </p>
                            {entry.alternatives.length === 0 ? (
                              <p className="hint">无次优备选。</p>
                            ) : (
                              <table className="result">
                                <thead>
                                  <tr>
                                    <th>次优</th>
                                    <th>产出物</th>
                                    <th>LP 成本</th>
                                    <th>ISK/LP</th>
                                    <th>净收益</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entry.alternatives.map((offer, index) => (
                                    <tr key={offer.offerId}>
                                      <td>{index + 2}</td>
                                      <td>
                                        {nameOf(offer.typeId)} × {offer.quantity.toLocaleString()}
                                        {estimateBadge(offer.estimation)}
                                      </td>
                                      <td>{formatLp(offer.lpCost)}</td>
                                      <td>{formatIsk(offer.iskPerLp)}</td>
                                      <td className="sell">{formatIsk(offer.netIsk)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>合计净收益</td>
                  <td className="sell">{formatIsk(portfolioTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>ISK/LP 排名</h2>
          <span className="hint">
            {corporationId === null ? '未选择军团' : corpLabel(corporationId)}
            {ranking === null
              ? ''
              : ` · 参与 ${ranking.offers.length.toLocaleString()} 条 · 跳过 ak ${ranking.skippedAkOffers} 条 · 产出无报价 ${ranking.unpricedOutputOffers} 条`}
          </span>
        </div>
        {corporationId !== null && selectedState !== null && (
          <p className="hint">
            最近成功：{formatTime(selectedState.lastOkAt)} · 缓存到期：
            {formatTime(selectedState.expiresAt)}
            {selectedState.lastError === null ? '' : ` · 最近错误：${selectedState.lastError}`}
          </p>
        )}
        {ranking === null || ranking.offers.length === 0 ? (
          <p className="hint">
            {corporationId === null
              ? '请先选择军团。'
              : loading
                ? '计算中…'
                : '无符合条件（或尚未抓取）的报价——可点上方「刷新报价」。'}
          </p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>#</th>
                <th>产出物</th>
                <th>数量</th>
                <th>LP 成本</th>
                <th>ISK 支出</th>
                <th>产出估值</th>
                <th>材料成本</th>
                <th>净收益</th>
                <th>ISK/LP</th>
              </tr>
            </thead>
            <tbody>
              {ranking.offers.map((offer: LpOfferValuation, index) => {
                const key = `offer-${offer.offerId}`;
                const open = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <tr className={open ? 'selected' : ''} onClick={() => toggle(key)}>
                      <td>{index + 1}</td>
                      <td>
                        {nameOf(offer.typeId)}
                        {estimateBadge(offer.estimation)}
                      </td>
                      <td>{offer.quantity.toLocaleString()}</td>
                      <td>{formatLp(offer.lpCost)}</td>
                      <td>{formatIsk(offer.iskCost)}</td>
                      <td>{formatIsk(offer.outputValue)}</td>
                      <td>{formatIsk(offer.inputCost)}</td>
                      <td>{formatIsk(offer.netIsk)}</td>
                      <td className="sell">{formatIsk(offer.iskPerLp)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={9}>
                          {offer.requiredItems.length === 0 ? (
                            <p className="hint">该报价无需材料。</p>
                          ) : (
                            <table className="result">
                              <thead>
                                <tr>
                                  <th>所需材料</th>
                                  <th>数量</th>
                                  <th>单价</th>
                                  <th>小计</th>
                                </tr>
                              </thead>
                              <tbody>
                                {offer.requiredItems.map((item) => (
                                  <tr key={item.typeId}>
                                    <td>{nameOf(item.typeId)}</td>
                                    <td>{item.quantity.toLocaleString()}</td>
                                    <td>
                                      {item.unitPrice === null ? '无报价' : formatIsk(item.unitPrice)}
                                    </td>
                                    <td className="sell">{formatIsk(item.value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {offer.estimation !== null && (
                            <p className="hint">
                              蓝图估算（runs {offer.estimation.runs} · ME {offer.estimation.me}%）：产物{' '}
                              {nameOf(offer.estimation.productTypeId)} ×{' '}
                              {(offer.estimation.productQuantityPerRun * offer.estimation.runs).toLocaleString()}{' '}
                              = {formatIsk(offer.estimation.productValue)}，制造材料{' '}
                              {formatIsk(offer.estimation.buildMaterialCost)} → 产出估值{' '}
                              {formatIsk(offer.estimation.productValue - offer.estimation.buildMaterialCost)}
                            </p>
                          )}
                          {offer.iskPerLp === null && (
                            <p className="hint">产出无市场报价 → 无法计算 ISK/LP（不虚构估算值）。</p>
                          )}
                          {offer.missingTypeIds.length > 0 && (
                            <p className="hint">
                              {offer.missingTypeIds.length} 种物品无报价（已按 0 计）：
                              {offer.missingTypeIds.map((typeId) => nameOf(typeId)).join('、')}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {message.length > 0 && <p className="message">{message}</p>}
    </>
  );
}
