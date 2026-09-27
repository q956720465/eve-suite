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
