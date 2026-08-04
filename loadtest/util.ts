/**
 * MAYogu LoadTest Tool — helpers dùng chung (logger, random, time).
 * Logger: prefix `[lt]` theo convention chat-app (`[lt]` = loadtest namespace, SD-2).
 */

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

/** Ring buffer log gần đây (GET /api/loadtest/logs — dashboard). */
export const logHistory: { ts: number; level: 'info' | 'warn' | 'error'; msg: string }[] = [];
const LOG_HISTORY_LIMIT = 500;

/** Subscriber nhận log raw (dùng cho DB persistence — ghi log_events theo runId). */
export type LogSubscriber = (level: 'info' | 'warn' | 'error', msg: string) => void;
const logSubscribers: LogSubscriber[] = [];

export function subscribeLog(fn: LogSubscriber): () => void {
  logSubscribers.push(fn);
  return () => {
    const i = logSubscribers.indexOf(fn);
    if (i >= 0) logSubscribers.splice(i, 1);
  };
}

export function log(level: 'info' | 'warn' | 'error', msg: string, ...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[lt][${level.toUpperCase()}][${ts}] ${msg}`;
  logHistory.push({ ts: Date.now(), level, msg: line });
  if (logHistory.length > LOG_HISTORY_LIMIT) logHistory.shift();
  for (const fn of logSubscribers) {
    try {
      fn(level, msg);
    } catch {
      // subscriber không được làm hỏng log
    }
  }
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else if (verbose) console.log(line, ...args);
}

export const ltLog = {
  info: (msg: string, ...a: unknown[]) => log('info', msg, ...a),
  warn: (msg: string, ...a: unknown[]) => log('warn', msg, ...a),
  error: (msg: string, ...a: unknown[]) => log('error', msg, ...a),
};

// ─── Random generators (deviceInfo đúng contract gateway-auth-service deviceInfo.dto.ts) ───

const HEX = '0123456789abcdef';

export function randomHex(bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes * 2; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

/** UUID v4 — khớp regex deviceInfo.dto.ts (version 4, variant 8/9/a/b). */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return (
    h(b[0]) + h(b[1]) + h(b[2]) + h(b[3]) + '-' +
    h(b[4]) + h(b[5]) + '-' + h(b[6]) + h(b[7]) + '-' +
    h(b[8]) + h(b[9]) + '-' + h(b[10]) + h(b[11]) + h(b[12]) + h(b[13]) + h(b[14]) + h(b[15])
  );
}

/** Password đạt isValidPassword (auth.util.ts:7-17): ≥8 ký tự, ≥3/4 nhóm. */
export function genPassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const pick = (s: string, n: number) => {
    let out = '';
    for (let i = 0; i < n; i++) out += s[Math.floor(Math.random() * s.length)];
    return out;
  };
  // đảm bảo 3 nhóm: thường + hoa + số, thêm 1 ký tự đặc biệt cho chắc
  const base = `${pick(lower, 4)}${pick(upper, 2)}${pick(digits, 2)}${pick(special, 1)}`;
  return base;
}

/** dateOfBirth ≥16 tuổi, ngẫu nhiên trong 1995-2004 (isAtLeast16 — auth.util.ts:23-37). */
export function genDateOfBirth(): string {
  const year = 1995 + Math.floor(Math.random() * 10); // 1995..2004
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** SĐT VN hợp lệ (VN_PHONE_REGEX: 0 + 3|5|7|8|9 + 8 số) — unique theo seed+index (register bắt buộc phone-verified). */
export function genPhone(index: number, seed: number): string {
  const prefix = ['3', '5', '7', '8', '9'][index % 5];
  const n = 10_000_000 + ((seed % 1_000_000) + index) % 80_000_000;
  return `0${prefix}${String(n).slice(0, 8)}`;
}

/** deviceInfo riêng mỗi user — tránh bị Adaptive 2FA "new device" nghi ngờ. */
export function genDeviceInfo(runId: string, index: number) {
  return {
    installationId: uuidV4(),
    deviceFingerprint: randomHex(32), // 64-hex, khớp SHA256_REGEX deviceInfo.dto.ts:33
    platform: 'web' as const,
    deviceName: `[lt] loadtest ${runId.slice(0, 6)} #${index}`,
  };
}

/** Nội dung test sạch profanity (RD-3): prefix [lt], không từ nhạy cảm. */
const CHAT_LINES = [
  'Chào mọi người, hôm nay thế nào?',
  'Bài viết này hay quá, cảm ơn tác giả!',
  'Mình cũng nghĩ vậy, đồng ý với bạn.',
  'Cuối tuần này có ai đi chơi không?',
  'Chia sẻ thêm vài hình ảnh nữa nhé!',
  'Topic hôm nay thú vị đấy.',
  'Chúc cả phòng một ngày vui vẻ.',
  'Mình mới vào phòng, chào mọi người.',
];
const COMMENT_LINES = [
  'Bài viết rất hữu ích, cảm ơn tác giả.',
  'Mình đồng ý với quan điểm trong bài.',
  'Chủ đề này đang được quan tâm lắm.',
  'Cảm ơn đã chia sẻ, đọc rất vui.',
  'Mình học được nhiều điều từ bài này.',
];

export function genChatContent(index: number): string {
  const line = CHAT_LINES[index % CHAT_LINES.length];
  return `[lt] ${line} #${index}`;
}

export function genCommentContent(index: number): string {
  const line = COMMENT_LINES[index % COMMENT_LINES.length];
  return `[lt] ${line} #${index}`;
}

export function genTopicTitle(index: number): string {
  return `[lt] chủ đề ${index % 50}`;
}

// ─── Misc ───

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Jitter: value * (1 ± jitterPct) — pacing ngẫu nhiên tránh thải sóng. */
export function jitter(valueMs: number, jitterPct = 0.25): number {
  const f = 1 + (Math.random() * 2 - 1) * jitterPct;
  return Math.max(1, Math.round(valueMs * f));
}

/** Normalize ws:// → http:// và bỏ trailing slash (so allowlist). */
export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.startsWith('ws://')) u = 'http://' + u.slice(5);
  else if (u.startsWith('wss://')) u = 'https://' + u.slice(6);
  return u;
}

export function parseBool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
