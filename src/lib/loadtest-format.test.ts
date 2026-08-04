import { describe, it, expect } from 'vitest';
import {
  fmtNum,
  fmtCompact,
  fmtMs,
  fmtClock,
  fmtTickTime,
  fmtDateTime,
  fmtRange,
  CONFIRM_PHRASE,
} from '@/lib/loadtest-format';

describe('fmtNum', () => {
  it('grouping hàng nghìn', () => {
    expect(fmtNum(11982)).toBe('11,982');
    expect(fmtNum(1000)).toBe('1,000');
  });
  it('0', () => {
    expect(fmtNum(0)).toBe('0');
  });
  it('âm', () => {
    expect(fmtNum(-1234)).toBe('-1,234');
  });
  it('NaN giữ nguyên hành vi hiện tại (toLocaleString → "NaN")', () => {
    expect(fmtNum(NaN)).toBe('NaN');
  });
  it('undefined/null → 0 (n ?? 0)', () => {
    expect(fmtNum(undefined as unknown as number)).toBe('0');
    expect(fmtNum(null as unknown as number)).toBe('0');
  });
  it('giá trị lớn', () => {
    expect(fmtNum(123456789)).toBe('123,456,789');
  });
});

describe('fmtCompact', () => {
  it('k', () => {
    expect(fmtCompact(11900)).toBe('11.9k');
    expect(fmtCompact(1000)).toBe('1k');
    expect(fmtCompact(999)).toBe('999');
  });
  it('M', () => {
    expect(fmtCompact(8_200_000)).toBe('8.2M');
    expect(fmtCompact(1_000_000)).toBe('1M');
  });
  it('0', () => {
    expect(fmtCompact(0)).toBe('0');
  });
  it('âm', () => {
    expect(fmtCompact(-5000)).toBe('-5k');
  });
  it('NaN / Infinity → "--"', () => {
    expect(fmtCompact(NaN)).toBe('--');
    expect(fmtCompact(Infinity)).toBe('--');
    expect(fmtCompact(-Infinity)).toBe('--');
  });
});

describe('fmtMs', () => {
  it('ms thường', () => {
    expect(fmtMs(120)).toBe('120ms');
    expect(fmtMs(0)).toBe('0ms');
    expect(fmtMs(999)).toBe('999ms');
  });
  it('≥ 1000 → giây', () => {
    expect(fmtMs(1000)).toBe('1.0s');
    expect(fmtMs(1500)).toBe('1.5s');
  });
  it('âm / NaN / Infinity → "--"', () => {
    expect(fmtMs(-1)).toBe('--');
    expect(fmtMs(NaN)).toBe('--');
    expect(fmtMs(Infinity)).toBe('--');
  });
});

describe('fmtClock', () => {
  it('HH:MM:SS khi ≥ 1h', () => {
    expect(fmtClock(4523)).toBe('01:15:23');
    expect(fmtClock(3600)).toBe('01:00:00');
    expect(fmtClock(86399)).toBe('23:59:59');
  });
  it('MM:SS khi < 1h', () => {
    expect(fmtClock(0)).toBe('00:00');
    expect(fmtClock(59)).toBe('00:59');
    expect(fmtClock(3599)).toBe('59:59');
  });
  it('âm / NaN → clamp 0', () => {
    expect(fmtClock(-5)).toBe('00:00');
    expect(fmtClock(NaN)).toBe('00:00');
  });
});

describe('fmtTickTime', () => {
  it('epoch ms → HH:MM:SS (local time)', () => {
    const ts = new Date(2026, 0, 1, 13, 5, 9).getTime();
    expect(fmtTickTime(ts)).toBe('13:05:09');
  });
  it('pad giờ/phút/giây', () => {
    const ts = new Date(2026, 5, 15, 3, 4, 5).getTime();
    expect(fmtTickTime(ts)).toBe('03:04:05');
  });
});

describe('fmtDateTime', () => {
  it('epoch ms → "YYYY-MM-DD HH:MM"', () => {
    const ts = new Date(2026, 0, 1, 13, 5).getTime();
    expect(fmtDateTime(ts)).toBe('2026-01-01 13:05');
  });
  it('pad tháng/ngày', () => {
    const ts = new Date(2026, 10, 3, 9, 30).getTime();
    expect(fmtDateTime(ts)).toBe('2026-11-03 09:30');
  });
});

describe('fmtRange', () => {
  it('"HH:MM–HH:MM" (en dash)', () => {
    const start = new Date(2026, 0, 1, 9, 30).getTime();
    const end = new Date(2026, 0, 1, 10, 45).getTime();
    expect(fmtRange(start, end)).toBe('09:30–10:45');
  });
  it('pad giờ', () => {
    const start = new Date(2026, 0, 1, 0, 5).getTime();
    const end = new Date(2026, 0, 1, 23, 59).getTime();
    expect(fmtRange(start, end)).toBe('00:05–23:59');
  });
});

describe('CONFIRM_PHRASE', () => {
  it('chuỗi xác nhận chặn cứng (SD-1)', () => {
    expect(CONFIRM_PHRASE).toBe('TÔI XÁC NHẬN');
  });
});