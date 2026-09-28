import { useState } from 'react';

import RefinePanel from './RefinePanel';

type CalcTab = 'blueprint' | 'lp' | 'refine';

const CALC_TABS: readonly { id: CalcTab; label: string }[] = [
  { id: 'blueprint', label: '蓝图成本' },
  { id: 'lp', label: 'LP 比价' },
  { id: 'refine', label: '矿石精炼值' },
];

/** 计算器页：三大计算器（本轮已实现矿石精炼值，蓝图/LP 面板在后续子阶段接入） */
export default function CalcPage() {
  const [tab, setTab] = useState<CalcTab>('refine');

  return (
    <section className="calc">
      <div className="tabs">
        {CALC_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'refine' && <RefinePanel />}
      {tab === 'blueprint' && (
        <div className="panel">
          <h2>蓝图成本</h2>
          <p className="hint">
            引擎（P4-2：BOM × 引擎价 + ME/TE 折扣）已就绪并验收；面板界面在下一子阶段实现。
          </p>
        </div>
      )}
      {tab === 'lp' && (
        <div className="panel">
          <h2>LP 比价</h2>
          <p className="hint">
            引擎（P4-3：ISK/LP 排名 + LP 组合）已就绪并验收；面板界面在下一子阶段实现。
          </p>
        </div>
      )}
    </section>
  );
}
