import type { LocalizedText } from './types';

/** 取英文字段（SDE 的英文为必填语言）；缺失或空串返回 null */
export function pickEn(text: LocalizedText | undefined): string | null {
  const value = text?.en;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 取中文字段；缺失或空串返回 null */
export function pickZh(text: LocalizedText | undefined): string | null {
  const value = text?.zh;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const ROMAN_TABLE: readonly (readonly [number, string])[] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** 阿拉伯数字转罗马数字（站名中的行星序号使用）；超出 1-3999 原样返回 */
export function toRoman(value: number): string {
  if (!Number.isFinite(value)) return '';
  let n = Math.floor(value);
  if (n <= 0 || n >= 4000) return String(n);
  let out = '';
  for (const [num, symbol] of ROMAN_TABLE) {
    while (n >= num) {
      out += symbol;
      n -= num;
    }
  }
  return out;
}

export interface StationNameParts {
  systemEn: string;
  systemZh: string | null;
  /** 拥有者军团名 */
  corpEn: string;
  corpZh: string | null;
  /** useOperationName 时传 operationName，否则传空间站类型名 */
  labelEn: string;
  labelZh: string | null;
  celestialIndex?: number | null;
  orbitIndex?: number | null;
}

/**
 * 合成空间站展示名。
 * SDE 的 npcStations.jsonl 不含站名，EVE 命名规则为：
 *   {星系} {行星罗马序号} - Moon {卫星序号} - {拥有者军团} {作业/类型名}
 * 例：Jita IV - Moon 4 - Caldari Navy Assembly Plant
 * 星系名置于最前，保证按星系/星域搜索可命中。
 */
export function buildStationName(parts: StationNameParts): { en: string; zh: string | null } {
  const roman =
    typeof parts.celestialIndex === 'number' && parts.celestialIndex > 0
      ? ` ${toRoman(parts.celestialIndex)}`
      : '';
  const hasOrbit = typeof parts.orbitIndex === 'number' && parts.orbitIndex > 0;
  const moonEn = hasOrbit ? ` - Moon ${parts.orbitIndex}` : '';
  const moonZh = hasOrbit ? ` - 卫星 ${parts.orbitIndex}` : '';

  const en = `${parts.systemEn}${roman}${moonEn} - ${parts.corpEn} ${parts.labelEn}`.trim();
  const zh = parts.systemZh
    ? `${parts.systemZh}${roman}${moonZh} - ${parts.corpZh ?? parts.corpEn} ${
        parts.labelZh ?? parts.labelEn
      }`.trim()
    : null;

  return { en, zh };
}
