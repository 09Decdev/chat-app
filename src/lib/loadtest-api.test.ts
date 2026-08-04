import { describe, it, expect } from 'vitest';
import { toApiError, type LoadtestApiError } from '@/lib/loadtest-api';

interface FakeResponse {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

function fakeAxiosError(partial: { response?: FakeResponse; request?: unknown; message?: string }) {
  return { config: {}, isAxiosError: true, toJSON: () => ({}), ...partial };
}

describe('loadtest-api toApiError (D-11, D-18)', () => {
  it('response lỗi → statusCode/message/errors/warnings từ envelope', () => {
    const err = fakeAxiosError({
      response: {
        status: 400,
        headers: {},
        data: {
          statusCode: 400,
          message: 'JSON body không hợp lệ',
          errors: ['a', 'b'],
          warnings: ['w'],
        },
      },
    });
    const e: LoadtestApiError = toApiError(err);
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('JSON body không hợp lệ');
    expect(e.errors).toEqual(['a', 'b']);
    expect(e.warnings).toEqual(['w']);
    expect(e.kind).toBe('http');
  });

  it('statusCode fallback = response.status khi body không có field', () => {
    const err = fakeAxiosError({ response: { status: 500, headers: {}, data: {} } });
    const e = toApiError(err);
    expect(e.statusCode).toBe(500);
    expect(e.message).toBe('Không kết nối được đến loadtest server (port 3401). Chạy: npm run loadtest:server');
  });

  it('429 → retryAfterSec từ envelope body (D-11 — contract bắt buộc)', () => {
    const err = fakeAxiosError({
      response: {
        status: 429,
        headers: {},
        data: { statusCode: 429, message: 'Rate limited', retryAfterSec: 30 },
      },
    });
    const e = toApiError(err);
    expect(e.retryAfterSec).toBe(30);
    expect(e.kind).toBe('http');
  });

  it('429 → retryAfterSec từ Retry-After header (fallback khi body thiếu)', () => {
    const err = fakeAxiosError({
      response: {
        status: 429,
        headers: { 'retry-after': '15' },
        data: { statusCode: 429, message: 'Rate limited' },
      },
    });
    const e = toApiError(err);
    expect(e.retryAfterSec).toBe(15);
  });

  it('429 retryAfterSec = 0/header thiếu → undefined (không gắn 0)', () => {
    const err = fakeAxiosError({
      response: { status: 429, headers: {}, data: { statusCode: 429, message: 'x' } },
    });
    const e = toApiError(err);
    expect(e.retryAfterSec).toBeUndefined();
  });

  it('network error (không response) → statusCode 0 + kind network + message CORS (D-18)', () => {
    const err = fakeAxiosError({ request: {} });
    const e = toApiError(err);
    expect(e.statusCode).toBe(0);
    expect(e.kind).toBe('network');
    expect(e.message).toContain('LOADTEST_CORS_ORIGIN');
    expect(e.message).toContain('3401');
  });

  it('message fallback khi envelope không có message', () => {
    const err = fakeAxiosError({ response: { status: 502, headers: {}, data: { statusCode: 502 } } });
    const e = toApiError(err);
    expect(e.statusCode).toBe(502);
    expect(e.message).toBe('Không kết nối được đến loadtest server (port 3401). Chạy: npm run loadtest:server');
  });
});