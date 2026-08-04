/**
 * Luu token + thong tin thiet bi vao localStorage.
 * - installationId: uuid v4 sinh 1 lan, dung vinh vien tren device.
 * - deviceFingerprint: 64-char hex (CHAT_API.md muc 2 - deviceInfo.deviceFingerprint).
 * - tokens: accessToken / refreshToken de goi REST + socket.
 *
 * Trong CHAT_API.md, auth dung Bearer token nen luu client la phu hop cho SPA doc lap.
 */

const KEYS = {
  installationId: 'chat.installationId',
  deviceFingerprint: 'chat.deviceFingerprint',
  accessToken: 'chat.accessToken',
  refreshToken: 'chat.refreshToken',
  wasMatching: 'chat.wasMatching',
} as const;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * UUID v4 khong phu thuoc secure-context (crypto.randomUUID chi co o https/localhost).
 * Dung crypto.getRandomValues (co o moi context) + fallback Math.random.
 */
function uuid(): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  if (g && typeof g.getRandomValues === 'function') {
    const b = g.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = (n: number) => n.toString(16).padStart(2, '0');
    return (
      h(b[0]) + h(b[1]) + h(b[2]) + h(b[3]) + '-' +
      h(b[4]) + h(b[5]) + '-' + h(b[6]) + h(b[7]) + '-' +
      h(b[8]) + h(b[9]) + '-' + h(b[10]) + h(b[11]) + h(b[12]) + h(b[13]) + h(b[14]) + h(b[15])
    );
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getOrCreate(key: string, factory: () => string): string {
  let v = localStorage.getItem(key);
  if (!v) {
    v = factory();
    localStorage.setItem(key, v);
  }
  return v;
}

export const deviceStorage = {
  getInstallationId(): string {
    return getOrCreate(KEYS.installationId, uuid);
  },
  getDeviceFingerprint(): string {
    return getOrCreate(KEYS.deviceFingerprint, () => randomHex(32)); // 64-char hex
  },
  getDeviceInfo(platform: 'web' = 'web') {
    return {
      installationId: this.getInstallationId(),
      deviceFingerprint: this.getDeviceFingerprint(),
      platform,
      deviceName: navigator.userAgent,
    };
  },
};

export const tokenStorage = {
  get access(): string | null {
    return localStorage.getItem(KEYS.accessToken);
  },
  get refresh(): string | null {
    return localStorage.getItem(KEYS.refreshToken);
  },
  set(access: string, refresh?: string) {
    localStorage.setItem(KEYS.accessToken, access);
    if (refresh) localStorage.setItem(KEYS.refreshToken, refresh);
  },
  clear() {
    localStorage.removeItem(KEYS.accessToken);
    localStorage.removeItem(KEYS.refreshToken);
  },
};

export const matchingFlag = {
  get(): boolean {
    return localStorage.getItem(KEYS.wasMatching) === '1';
  },
  set(v: boolean) {
    if (v) localStorage.setItem(KEYS.wasMatching, '1');
    else localStorage.removeItem(KEYS.wasMatching);
  },
};

/**
 * Draft topic o man xep hang (StartScreen) — bền qua F5 (sessionStorage),
 * khong bền qua đóng tab (tranh gợi ý chéo phiên). Clear khi matching thanh cong.
 */
const TOPIC_DRAFT_KEY = 'chat.topicDraft';
export const topicDraft = {
  get(): string {
    return sessionStorage.getItem(TOPIC_DRAFT_KEY) ?? '';
  },
  set(v: string) {
    if (v) sessionStorage.setItem(TOPIC_DRAFT_KEY, v);
    else sessionStorage.removeItem(TOPIC_DRAFT_KEY);
  },
  clear() {
    sessionStorage.removeItem(TOPIC_DRAFT_KEY);
  },
};
