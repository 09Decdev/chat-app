/**
 * Phase 4 council regression tests — DbWriter (KHÔNG cần Postgres thật — mock store):
 * - FIX-3 (F-1): DB log write fail → reentrancy guard + suppress window → KHÔNG loop tự khuếch đại
 *   (log fail → warn → subscriber → insert mới → fail → ... vô hạn khi DB down).
 * - FIX-8 (C-5): final flush AWAIT timer flush đang in-flight (trước đây skip → pool.end() mất ticks).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DbWriter } from '../db/writer';
import type { LoadtestStore } from '../db/store';
import { subscribeLog, ltLog } from '../util';
import type { RunConfig, LoadTestTick } from '../types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lt-writer-'));
}

function runConfig(): RunConfig {
  return {
    runId: 'lt-writer-test', targetUsers: 1000, rampRate: 100, rampMode: 'rate',
    durationMin: 1, durationSec: 60,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl: 'http://localhost:3000', workerCount: 1, socketsPerWorker: 1000,
    registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
  };
}

function tick(ts: number): LoadTestTick {
  return {
    type: 'tick', runId: 'lt-writer-test', ts, phase: 'steady', elapsedSec: 1,
    counters: {
      usersCreated: 0, usersConnected: 0, usersActive: 0, usersQueued: 0, usersInRoom: 0,
      actionsTotal: 0, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0,
      queueCount: 0, roomCount: 0, droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 0,
      connectAttempts: 0, connectFails: 0,
      connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
      usersFailed: 0,
    },
    rates: { successRate: 100, echoRate: 100, connectFailRate: 0 },
    actionsPerSec: {},
    latency: { p50: 0, p95: 0, p99: 0 },
    errors: [],
    server: { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0 },
    workers: { alive: 1, total: 1, cpuAvg: 0 },
    hasConnectData: true,
  };
}

// ─── FIX-3 (F-1): log self-amplification loop trên DB outage ─────────────────

describe('writer — FIX-3: log write fail → bounded (không loop vô hạn)', () => {
  it('insertLogEvent fail → warn → subscriber re-enter bị chặn; sau đó suppress window 5s; thử lại sau window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const insertLogEvent = vi.fn(async () => {
      // Mô phỏng store THẬT: query fail → ltLog.warn (chính warn này là nguồn loop)
      ltLog.warn('[test] insertLogEvent fail (DB down)');
      return { ok: false, error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED', context: 'write' } };
    });
    const store = {
      insertRun: vi.fn(async () => ({ ok: true, rows: [] })),
      insertLogEvent,
      insertMetricSamples: vi.fn(async () => ({ ok: true, rows: [] })),
      disconnect: vi.fn(async () => {}),
    } as unknown as LoadtestStore;

    const writer = new DbWriter(store, tmpDir());
    // Wiring y hệt DbWriter.startup(): subscribeLog → writeLog
    const unsub = subscribeLog((level, msg) => {
      void writer.writeLog(level, msg);
    });
    try {
      await writer.writeRunStart(runConfig()); // currentRunId set (run đang chạy)

      // Lần 1: fail → warn → subscriber re-enter (isWritingLog=true) → bị chặn → KHÔNG insert lần 2
      await writer.writeLog('info', 'log 1');
      expect(insertLogEvent).toHaveBeenCalledTimes(1);

      // Trong window 5s: mọi log khác bị suppress (đếm, không chạm DB) — KHÔNG loop
      await writer.writeLog('warn', 'log 2');
      await writer.writeLog('error', 'log 3');
      expect(insertLogEvent).toHaveBeenCalledTimes(1);

      // Hết window → thử lại 1 lần (fail 1 lần nữa — dbWriteFail đếm đúng 1 lần/window)
      vi.advanceTimersByTime(5000);
      await writer.writeLog('info', 'log 4');
      expect(insertLogEvent).toHaveBeenCalledTimes(2);
    } finally {
      unsub();
      await writer.shutdown();
      vi.useRealTimers();
    }
  });
});

// ─── FIX-8 (C-5): final flush vs timer flush in-flight ───────────────────────

describe('writer — FIX-8: final flush AWAIT flush in-flight (không mất ticks)', () => {
  it('flushTicks lần 2 khi flush 1 đang in-flight → chờ xong rồi flush tiếp (2 batch, không drop)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const insertMetricSamples = vi.fn(async (_batch: unknown[]) => {
      await gate;
      return { ok: true, rows: [] };
    });
    const store = {
      insertRun: vi.fn(async () => ({ ok: true, rows: [] })),
      insertLogEvent: vi.fn(async () => ({ ok: true, rows: [] })),
      insertMetricSamples,
      disconnect: vi.fn(async () => {}),
    } as unknown as LoadtestStore;

    const writer = new DbWriter(store, tmpDir());
    await writer.writeRunStart(runConfig());
    writer.pushTick(tick(1));
    writer.pushTick(tick(2));

    const p1 = writer.flushTicks(); // timer flush in-flight (chờ gate)
    writer.pushTick(tick(3)); // tick mới đến trong lúc flush đang bay

    let p2Done = false;
    const p2 = writer.flushTicks().then(() => {
      p2Done = true;
    }); // final flush (doWriteRunFinish/shutdown)
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Done).toBe(false); // FIX-8: final flush PHẢI chờ flush đang bay (trước đây skip → mất tick 3)

    release();
    await p1;
    await p2;
    expect(insertMetricSamples).toHaveBeenCalledTimes(2); // batch [1,2] + batch [3] — không mất tick
    const batches = insertMetricSamples.mock.calls.map((call) => call[0] as unknown as { runId: string }[]);
    expect(batches[0].map((s) => s.runId)).toEqual(['lt-writer-test', 'lt-writer-test']);
    expect(batches[1]).toHaveLength(1);

    await writer.shutdown();
  });
});
