import type { NotifyHit, WebhookConfig } from './rules';

/**
 * 提醒通道 —— 通用 Webhook（方案 §7.1）。
 *
 * 设计（P5-7 定稿）：
 * - **一套代码覆盖钉钉 / 企业微信 / 飞书 / 自定义**：差异只在报文格式与签名方式
 * - **钉钉加签**（可选）：`sign = urlEncode(base64(HMAC-SHA256(secret, timestamp + "\n" + secret)))`，
 *   拼到 URL 的 `&timestamp=…&sign=…`
 * - **同轮合并为一条消息**（方案红线：钉钉群机器人 20 条/分钟限频）
 * - 只构造请求，**实际发送由宿主（Rust 命令 `notify_webhook_post`）执行** ——
 *   机器人接口无 CORS 头，渲染进程 fetch 必被预检拦截
 * - 本模块**只用 WebCrypto**（`crypto.subtle`），浏览器与 Node 测试环境通用
 */

/** 钉钉加签密钥前缀（钉钉文档要求 `SEC` 开头） */
export const DINGTALK_SECRET_PREFIX = 'SEC';

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NotifyMessage {
  title: string;
  /** Markdown 正文 */
  text: string;
}

/** ISK 千分位（最多两位小数） */
function formatIsk(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 单条命中的一行人类可读文本 */
export function describeHit(hit: NotifyHit): string {
  if (hit.kind === 'undercut') {
    return `${hit.typeName} @ ${hit.regionName}：我的 ${formatIsk(hit.myPrice)} vs 参照 ${formatIsk(
      hit.referencePrice,
    )}（+${hit.deltaPercent.toFixed(2)}%，${hit.basis}）`;
  }
  const bound =
    hit.direction === 'below_min'
      ? `跌破下限 ${formatIsk(hit.minPrice ?? 0)}`
      : `突破上限 ${formatIsk(hit.maxPrice ?? 0)}`;
  return `${hit.typeName} @ ${hit.regionName}：最低卖价 ${formatIsk(hit.bestSell)}，${bound}`;
}

/** 把一轮命中的多条提醒合并为**一条**消息（方案红线：本地合并去重） */
export function buildNotifyMessage(hits: readonly NotifyHit[], nowMs: number = Date.now()): NotifyMessage {
  const undercut = hits.filter((hit) => hit.kind === 'undercut');
  const watchPrice = hits.filter((hit) => hit.kind === 'watch_price');
  const title = `EVE Suite 提醒（${hits.length} 条）`;

  const lines: string[] = [`### ${title}`];
  if (undercut.length > 0) {
    lines.push('', `**⚠️ 被压价（${undercut.length} 条）**`);
    for (const hit of undercut) lines.push(`- ${describeHit(hit)}`);
  }
  if (watchPrice.length > 0) {
    lines.push('', `**💰 监视价格带（${watchPrice.length} 条）**`);
    for (const hit of watchPrice) lines.push(`- ${describeHit(hit)}`);
  }
  lines.push('', `> ${new Date(nowMs).toISOString()}`);

  return { title, text: lines.join('\n') };
}

/** Markdown → 纯文本（企业微信 / 飞书的 text 类型不做 Markdown 渲染） */
export function toPlainText(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^###\s*/, '').replace(/^>\s*/, ''))
    .join('\n')
    .replace(/\*\*/g, '');
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** HMAC-SHA256 → base64（WebCrypto，异步） */
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64FromBytes(new Uint8Array(signature));
}

/** 钉钉加签 URL：`{url}&timestamp={ms}&sign={urlEncode(base64)}` */
export async function signDingtalkUrl(url: string, secret: string, timestampMs: number): Promise<string> {
  const stringToSign = `${timestampMs}\n${secret}`;
  const sign = encodeURIComponent(await hmacSha256Base64(secret, stringToSign));
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}timestamp=${timestampMs}&sign=${sign}`;
}

/**
 * 构造发送请求（含加签）。
 *
 * @example
 * const request = await buildWebhookRequest(config, buildNotifyMessage(hits));
 * await invoke('notify_webhook_post', request);
 */
export async function buildWebhookRequest(
  config: WebhookConfig,
  message: NotifyMessage,
  nowMs: number = Date.now(),
): Promise<WebhookRequest> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url = config.url;

  let payload: unknown;
  switch (config.kind) {
    case 'dingtalk': {
      payload = {
        msgtype: 'markdown',
        markdown: { title: message.title, text: message.text },
        at: { isAtAll: config.mentionAll },
      };
      if (config.secret.length > 0) {
        url = await signDingtalkUrl(url, config.secret, nowMs);
      }
      break;
    }
    case 'wecom': {
      payload = {
        msgtype: 'text',
        text: {
          content: toPlainText(message.text),
          ...(config.mentionAll ? { mentioned_list: ['@all'] } : {}),
        },
      };
      break;
    }
    case 'feishu': {
      payload = { msg_type: 'text', content: { text: toPlainText(message.text) } };
      break;
    }
    default: {
      payload = { title: message.title, text: message.text };
      break;
    }
  }

  return { url, headers, body: JSON.stringify(payload) };
}
