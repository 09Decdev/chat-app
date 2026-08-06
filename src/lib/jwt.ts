/**
 * Decode JWT (KHONG verify - chi doc payload) de lay userId (sub).
 * Server la thuc the dang quyen; client chi decode de biet message nao la cua minh.
 */

export interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  try {
    return decodeURIComponent(
      Array.from(bin, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    );
  } catch {
    return bin;
  }
}

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}
