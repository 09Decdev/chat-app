/**
 * Unit tests — seed account parser (loadtest/db/seed-accounts.ts parseAccountList).
 * Pure function — KHÔNG cần Postgres: JSON hợp lệ/không hợp lệ, CSV header, file lạ.
 */
import { describe, it, expect } from 'vitest';
import { parseAccountList } from '../db/seed-accounts';

describe('seed-accounts — parseAccountList (JSON)', () => {
  it('JSON hợp lệ → mảng account đầy đủ (kèm optional fields)', () => {
    const list = parseAccountList(
      JSON.stringify([
        { email: 'a@mayogu.test', password: 'SeedPass123!', displayName: 'A', userId: 'u-a', dateOfBirth: '2000-01-01', country: 'VN' },
        { email: 'b@mayogu.test', password: 'OtherPass456!' },
      ]),
      'accounts.json',
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      email: 'a@mayogu.test', password: 'SeedPass123!', displayName: 'A', userId: 'u-a',
      dateOfBirth: '2000-01-01', country: 'VN',
    });
    expect(list[1]).toEqual({ email: 'b@mayogu.test', password: 'OtherPass456!' });
  });

  it('JSON không hợp lệ (syntax) → throw', () => {
    expect(() => parseAccountList('{not-json', 'accounts.json')).toThrow(/JSON không hợp lệ/);
  });

  it('JSON không phải mảng → throw', () => {
    expect(() => parseAccountList('{"a":1}', 'accounts.json')).toThrow(/phải là mảng account/);
  });

  it('JSON thiếu email/password → throw (kèm index)', () => {
    expect(() => parseAccountList('[{"password":"x"}]', 'accounts.json')).toThrow(/Account #1: email bắt buộc/);
    expect(() => parseAccountList('[{"email":"a@mayogu.test"}]', 'accounts.json')).toThrow(/Account #1: password bắt buộc/);
    expect(() => parseAccountList('[{"email":"ok@mayogu.test","password":"x"},42]', 'accounts.json')).toThrow(/Account #2 không phải object/);
  });
});

describe('seed-accounts — parseAccountList (CSV)', () => {
  it('header email,password,displayName + rows → account (kèm CRLF)', () => {
    const list = parseAccountList(
      'email,password,displayName\r\na@mayogu.test,SeedPass123!,A\r\nb@mayogu.test,OtherPass456!,\r\n',
      'accounts.csv',
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ email: 'a@mayogu.test', password: 'SeedPass123!', displayName: 'A' });
    expect(list[1].email).toBe('b@mayogu.test');
    expect(list[1].displayName).toBeUndefined(); // ô trống
  });

  it('header chỉ email,password → không có displayName', () => {
    const list = parseAccountList('email,password\na@mayogu.test,SeedPass123!', 'accounts.csv');
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBeUndefined();
  });

  it('thiếu header email/password → throw', () => {
    expect(() => parseAccountList('user,pass\na@x,1', 'accounts.csv')).toThrow(/header phải chứa 'email' và 'password'/);
  });

  it('dòng dữ liệu thiếu email → throw (kèm số dòng)', () => {
    expect(() => parseAccountList('email,password\n,pass', 'accounts.csv')).toThrow(/dòng 2: email rỗng/);
    expect(() => parseAccountList('email,password\na@x,', 'accounts.csv')).toThrow(/dòng 2: password rỗng/);
  });

  it('CSV rỗng → throw', () => {
    expect(() => parseAccountList('', 'accounts.csv')).toThrow(/CSV rỗng/);
  });
});

describe('seed-accounts — parseAccountList (extension)', () => {
  it('extension lạ → throw', () => {
    expect(() => parseAccountList('a', 'accounts.txt')).toThrow(/chỉ .json hoặc .csv/);
    expect(() => parseAccountList('a', 'accounts')).toThrow(/chỉ .json hoặc .csv/);
  });
});
