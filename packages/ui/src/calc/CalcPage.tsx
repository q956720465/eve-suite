import { useState } from 'react';

import type { LpStoreSyncHandle } from '../lp/useLpStoreSync';

import BlueprintPanel from './BlueprintPanel';
import CalcCasePanel from './CalcCasePanel';
import LpPanel from './LpPanel';
import RefinePanel from './RefinePanel';

type CalcTab = 'blueprint' | 'lp' | 'refine' | 'case';

const CALC_TABS: readonly { id: CalcTab; label: string }[] = [
  { id: 'blueprint', label: '蓝图成本' },
  { id: 'lp', label: 'LP 比价' },
  { id: 'refine', label: '矿石精炼值' },
  { id: 'case', label: '算例对照' },
];

/** 计算器页：三大计算器（蓝图成本 / LP 比价 / 矿石精炼值）+ 算例对照 */
export default function CalcPage({ lpStore }: { lpStore: LpStoreSyncHandle }) {
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
      {tab === 'blueprint' && <BlueprintPanel />}
      {tab === 'lp' && <LpPanel lpStore={lpStore} />}
      {tab === 'case' && <CalcCasePanel />}
    </section>
  );
}
