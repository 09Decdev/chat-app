/**
 * T-07 — logger structured JSON + ring buffer compat (dashboard) + JSONL sink + redaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureLogger, ltLog, logHistory, subscribeLog, redactSensitiveFields, redactMsg, createJsonlSink } from '../logger';

describe('logger — JSONL sink (T-07)', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-log-')), 'loadtest.jsonl');
  });

  afterEach(() => {
    configureLogger({ logFile: null });
  });

  it('JSONL entry có ts/level/msg + runId/requestId/context khi cung cấp', () => {
    configureLogger({ logFile: tmpFile });
    ltLog.info('run started', { runId: 'lt-abc', requestId: 'req-123', context: { target: 1000 } });
    ltLog.warn('db slow', { runId: 'lt-abc' });
    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as {
      ts: string;
      level: string;
      msg: string;
      runId?: string;
      requestId?: string;
      context?: { target?: number };
    };
    expect(first.ts).toBeTruthy();
    expect(first.level).toBe('info');
    expect(first.msg).toBe('run started');
    expect(first.runId).toBe('lt-abc');
    expect(first.requestId).toBe('req-123');
    expect(first.context?.target).toBe(1000);
    const second = JSON.parse(lines[1]) as { level: string; msg: string; runId?: string };
    expect(second.level).toBe('warn');
    expect(second.runId).toBe('lt-abc');
  });

  it('ring buffer vẫn giữ format text [lt][LEVEL][ts] (dashboard compat)', () => {
    logHistory.length = 0;
    ltLog.info('hello');
    const entry = logHistory[logHistory.length - 1];
    expect(entry.msg).toMatch(/^\[lt\]\[INFO\]\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello$/);
    expect(entry.level).toBe('info');
  });

  it('subscribeLog nhận (level, msg) raw — writer.ts không vỡ', () => {
    const seen: string[] = [];
    const unsub = subscribeLog((level, msg) => seen.push(`${level}:${msg}`));
    ltLog.info('raw msg');
    unsub();
    expect(seen).toEqual(['info:raw msg']);
  });

  it('redactSensitiveFields chặn password/token/secret + redactUrl chuỗi', () => {
    const out = redactSensitiveFields({
      password: 'supersecret',
      token: 'abc',
      authSecret: 'x',
      username: 'admin',
      url: 'postgresql://appuser:s3cret@localhost/db',
      nested: { passwordHash: 'scrypt$z', ok: 1 },
    });
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.authSecret).toBe('[REDACTED]');
    expect(out.username).toBe('admin');
    expect(out.url).toBe('postgresql://appuser:***@localhost/db');
    expect((out.nested as Record<string, unknown>).passwordHash).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it('JSONL entry KHÔNG chứa password/token trong context (B-1)', () => {
    configureLogger({ logFile: tmpFile });
    ltLog.info('login attempt', { context: { username: 'admin', password: 'TopSecret!', token: 'jwt' } });
    const entry = JSON.parse(fs.readFileSync(tmpFile, 'utf8').trim()) as { context?: Record<string, unknown> };
    expect(entry.context?.password).toBe('[REDACTED]');
    expect(entry.context?.token).toBe('[REDACTED]');
    expect(entry.context?.username).toBe('admin');
  });

  it('FIX-4: msg chứa password/token string cũng bị redact (B-1 mọi sink)', () => {
    configureLogger({ logFile: tmpFile });
    logHistory.length = 0;
    ltLog.info('login fail: password=SuperSecret1 token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    const entry = JSON.parse(fs.readFileSync(tmpFile, 'utf8').trim()) as { msg: string };
    expect(entry.msg).toContain('password=[REDACTED]');
    expect(entry.msg).toContain('token=[REDACTED]');
    expect(entry.msg).not.toContain('SuperSecret1');
    expect(entry.msg).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    // ring buffer cũng redact
    const ring = logHistory[logHistory.length - 1];
    expect(ring.msg).toContain('password=[REDACTED]');
    expect(ring.msg).not.toContain('SuperSecret1');
  });

  it('F-3: redactMsg strip control chars — msg chứa \n không tạo dòng log giả (DESIGN §3)', () => {
    const out = redactMsg('connect_error: xhr poll error\n[lt][ERROR] forged line\r\nsecret=abc');
    expect(out).not.toMatch(/\n/); // 1 dòng duy nhất — injection bị vô hiệu
    expect(out).toContain('secret=[REDACTED]');
    expect(out).not.toContain('abc');
  });

  it('ST-10: redactMsg với JWT trần (không kèm key) → [REDACTED], không lọt vào sink', () => {
    configureLogger({ logFile: tmpFile });
    logHistory.length = 0;
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    ltLog.error(`verbose raw err: ${jwt}`);
    const ring = logHistory[logHistory.length - 1];
    expect(ring.msg).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(ring.msg).toContain('[REDACTED]');
    expect(ring.msg).not.toMatch(/\n/);
  });

  it('rotation size-based: tạo suffix .1/.2, giữ content gần nhất (retention window)', () => {
    configureLogger({ logFile: tmpFile, maxBytes: 120, maxFiles: 2 });
    for (let i = 0; i < 60; i++) ltLog.info(`line ${i}`);
    expect(fs.existsSync(`${tmpFile}.1`)).toBe(true);
    expect(fs.existsSync(`${tmpFile}.2`)).toBe(true);
    // Content mới nhất (cuối rotation window) vẫn được giữ trong .1/.2
    const rotated =
      (fs.existsSync(`${tmpFile}.1`) ? fs.readFileSync(`${tmpFile}.1`, 'utf8') : '') +
      (fs.existsSync(`${tmpFile}.2`) ? fs.readFileSync(`${tmpFile}.2`, 'utf8') : '') +
      (fs.existsSync(tmpFile) ? fs.readFileSync(tmpFile, 'utf8') : '');
    expect(rotated).toContain('line 59');
    expect(rotated).toContain('line 58');
  });

  it('configureLogger({ logFile: null }) → không ghi file (mặc định không sink)', () => {
    configureLogger({ logFile: null });
    ltLog.info('no file');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('createJsonlSink đứng riêng — write/close/rotation', () => {
    const sink = createJsonlSink(tmpFile, { maxBytes: 100, maxFiles: 1 });
    for (let i = 0; i < 20; i++) sink.write({ ts: new Date().toISOString(), level: 'info', msg: `m${i}` });
    sink.close();
    expect(fs.existsSync(`${tmpFile}.1`)).toBe(true);
  });
});