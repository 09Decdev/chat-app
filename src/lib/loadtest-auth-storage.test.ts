import { describe, it, expect, beforeEach } from 'vitest';
import { loadtestAuthStorage } from '@/lib/loadtest-auth-storage';

const KEY = 'loadtest.auth';

const validUser = { id: 1, username: 'admin', email: 'a@b.c', displayName: 'Admin', role: 'admin' };

describe('loadtest-auth-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('save → load roundtrip đầy đủ snapshot', () => {
    loadtestAuthStorage.save({ token: 'tok.123', expiresAt: 123456, user: validUser });
    expect(loadtestAuthStorage.load()).toEqual({ token: 'tok.123', expiresAt: 123456, user: validUser });
  });

  it('load khi không có key → null', () => {
    expect(loadtestAuthStorage.load()).toBeNull();
  });

  it('load với JSON hỏng → null (không throw)', () => {
    localStorage.setItem(KEY, '{broken');
    expect(loadtestAuthStorage.load()).toBeNull();
  });

  it('load với token không phải string → null', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 123, expiresAt: 1, user: validUser }));
    expect(loadtestAuthStorage.load()).toBeNull();
  });

  it('load với token rỗng → null', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: '', expiresAt: 1, user: validUser }));
    expect(loadtestAuthStorage.load()).toBeNull();
  });

  it('load với expiresAt thiếu → 0', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok', user: validUser }));
    expect(loadtestAuthStorage.load()).toEqual({ token: 'tok', expiresAt: 0, user: validUser });
  });

  it('load với user thiếu → user default rỗng', () => {
    localStorage.setItem(KEY, JSON.stringify({ token: 'tok', expiresAt: 5 }));
    const loaded = loadtestAuthStorage.load();
    expect(loaded?.token).toBe('tok');
    expect(loaded?.user).toEqual({ id: 0, username: '', email: '', displayName: '', role: 'admin' });
  });

  it('clear → load null', () => {
    loadtestAuthStorage.save({ token: 'tok', expiresAt: 1, user: validUser });
    loadtestAuthStorage.clear();
    expect(loadtestAuthStorage.load()).toBeNull();
  });
});