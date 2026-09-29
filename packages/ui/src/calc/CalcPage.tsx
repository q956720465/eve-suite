import { useState } from 'react';

import type { LpStoreSyncHandle } from '../lp/useLpStoreSync';

import BlueprintPanel from './BlueprintPanel';
import CalcCasePanel from './CalcCasePanel';
import IndustryPanel from './IndustryPanel';
import InventoryPanel from './InventoryPanel';
import LpPanel from './LpPanel';
import MiningPanel from './MiningPanel';
import RefinePanel from './RefinePanel';

type CalcTab = 'blueprint' | 'lp' | 'refine' | 'mining' | 'industry' | 'case' | 'inventory';

const CALC_TABS: readonly { id: CalcTab; label: string }[] = [
  { id: 'blueprint', label: '蓝图成本' },
  { id: 'inventory', label: '库存缺口' },
  { id: 'lp', label: 'LP 比价' },
  { id: 'refine', label: '矿石精炼值' },
  { id: 'mining', label: '采矿时薪' },
  { id: 'industry', label: '工业对账' },
  { id: 'case', label: '算例对照' },
];

/** 计算器页：三大计算器（蓝图成本 / LP 比价 / 矿石精炼值）+ 库存缺口 + 采矿时薪 + 工业对账 + 算例对照 */
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
      {tab === 'inventory' && <InventoryPanel />}
      {tab === 'mining' && <MiningPanel />}
      {tab === 'industry' && <IndustryPanel />}
      {tab === 'lp' && <LpPanel lpStore={lpStore} />}
      {tab === 'case' && <CalcCasePanel />}
    </section>
  );
}
