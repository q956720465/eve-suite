/**
 * 交易枢纽定义（方案文档 §1：吉他 / 艾玛 / 赫克 / 伦斯 / 多迪谢）。
 * 只固化区域 ID 与英文名；中文名从已入库的 SDE 星域表读取，避免硬编码翻译。
 */
export interface TradeHub {
  regionId: number;
  nameEn: string;
}

export const TRADE_HUBS: readonly TradeHub[] = [
  { regionId: 10000002, nameEn: 'The Forge' }, // 吉他 Jita
  { regionId: 10000043, nameEn: 'Domain' }, // 艾玛 Amarr
  { regionId: 10000042, nameEn: 'Metropolis' }, // 赫克 Hek
  { regionId: 10000030, nameEn: 'Heimatar' }, // 伦斯 Rens
  { regionId: 10000032, nameEn: 'Sinq Laison' }, // 多迪谢 Dodixie
];

/** 枢纽层采集周期：5 分钟（与 ESI 端点缓存节奏对齐） */
export const HUB_COLLECT_INTERVAL_MS = 5 * 60_000;

/** 单区域分页上限保护：异常情况下避免无节制拉取 */
export const MAX_PAGES_PER_REGION = 1500;

export function isTradeHub(regionId: number): boolean {
  return TRADE_HUBS.some((hub) => hub.regionId === regionId);
}

export function findTradeHub(regionId: number): TradeHub | null {
  return TRADE_HUBS.find((hub) => hub.regionId === regionId) ?? null;
}

/** 枢纽的主交易站（只固化 id，站名从 SDE 站名表读取） */
export interface HubMainStation {
  regionId: number;
  stationId: number;
}

/**
 * 五大枢纽的**主交易站**。
 *
 * 口径（P10-1 定稿）：取「SDE 收录的 NPC 站里订单量最大者」。2026-09-29 真实库实测，
 * 全局 NPC 站订单量前 5 名**恰好就是这 5 个**（325,455 / 122,331 / 66,221 / 38,146 / 31,050），
 * 第 6 名 NPC 站只有 5,373 单（差 5.8 倍）—— 这就是「只比最大的几个站点」的自然断点。
 *
 * **顺序 = 库内订单量降序**（吉他 > 艾玛 > 多迪谢 > 赫克 > 伦斯），
 * 该顺序同时充当「站点级比价」的并列 tie-break 顺序。
 *
 * ⚠️ 只取 SDE 收录的 NPC 站：区域订单端点**也包含玩家建筑单**（实测 121 个地点 / 69,572 单 / 占 4.5%），
 * 但建筑**没有可显示的站名**，故不纳入候选。
 */
export const HUB_MAIN_STATIONS: readonly HubMainStation[] = [
  { regionId: 10000002, stationId: 60003760 }, // 吉他 4-4 · 加达里海军 组装车间
  { regionId: 10000043, stationId: 60008494 }, // 艾玛 · 皇室专署集团 学院
  { regionId: 10000032, stationId: 60011866 }, // 多迪谢 · 联邦海军 组装车间
  { regionId: 10000042, stationId: 60005686 }, // 赫克 · 无限创造 工厂
  { regionId: 10000030, stationId: 60004588 }, // 伦斯 · 布鲁特部族 财政部
];
