import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseLoadtestPrefs,
  loadPrefs,
  savePrefs,
  DEFAULT_PREFS,
  PREFS_KEY,
} from '@/store/loadtest-prefs';

describe('parseLoadtestPrefs (L-7 schema validation)', () => {
  it('prefs hợp lệ — boolean đúng kiểu', () => {
    expect(parseLoadtestPrefs('{"requireEnvConfirm":false}')).toEqual({ requireEnvConfirm: false });
    expect(parseLoadtestPrefs('{"requireEnvConfirm":true}')).toEqual({ requireEnvConfirm: true });
  });

  it('null / empty → default', () => {
    expect(parseLoadtestPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('')).toEqual(DEFAULT_PREFS);
  });

  it('JSON hỏng → default im lặng', () => {
    expect(parseLoadtestPrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('{')).toEqual(DEFAULT_PREFS);
  });

  it('sai kiểu field (string) → default (fix L-7: "false" string truthy)', () => {
    expect(parseLoadtestPrefs('{"requireEnvConfirm":"false"}')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('{"requireEnvConfirm":"true"}')).toEqual(DEFAULT_PREFS);
  });

  it('sai kiểu field (number) → default', () => {
    expect(parseLoadtestPrefs('{"requireEnvConfirm":1}')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('{"requireEnvConfirm":0}')).toEqual(DEFAULT_PREFS);
  });

  it('thiếu field → default', () => {
    expect(parseLoadtestPrefs('{}')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('{"other":1}')).toEqual(DEFAULT_PREFS);
  });

  it('non-object (array / null / primitive) → default', () => {
    expect(parseLoadtestPrefs('[]')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('null')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('"str"')).toEqual(DEFAULT_PREFS);
    expect(parseLoadtestPrefs('42')).toEqual(DEFAULT_PREFS);
  });
});

describe('loadPrefs / savePrefs (localStorage roundtrip)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('không có key → default', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('save → load roundtrip', () => {
    savePrefs({ requireEnvConfirm: false });
    expect(loadPrefs()).toEqual({ requireEnvConfirm: false });
    expect(localStorage.getItem(PREFS_KEY)).toBe(JSON.stringify({ requireEnvConfirm: false }));
  });

  it('loadPrefs với JSON hỏng trong localStorage → default (không throw)', () => {
    localStorage.setItem(PREFS_KEY, '{broken');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('loadPrefs với sai kiểu → default', () => {
    localStorage.setItem(PREFS_KEY, '{"requireEnvConfirm":"false"}');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});