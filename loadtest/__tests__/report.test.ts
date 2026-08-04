/**
 * Unit tests — Report (RE-1..RE-3): buildReport + bottleneck detector (AC6.2).
 */
import { describe, it, expect } from 'vitest';
import { buildReport, detectBottlenecks } from '../report';
import { ActionHistograms, BucketedHistogram } from '../metrics';
import type { LoadTestTick, RunConfig } from '../types';

function fakeConfig(over: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: 'lt-test1',
    targetUsers: 10_000,
    rampRate: 200,
    rampMode: 'rate',
    durationMin: 10,
    durationSec: 600,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl: 'http://localhost:3000',
    workerCount: 4,
    socketsPerWorker: 2500,
    registerRamp: 100,
    useExistingAccounts: false,
    freshAccounts: false,
    seed: 42,
    createdAt: Date.now(),
    ...over,
  };
}

function fakeTick(ts: number, over: Partial<LoadTestTick['counters']> = {}, latencyP95 = 100): LoadTestTick {
  const base: LoadTestTick = {
    type: 'tick',
    runId: 'lt-test1',
    ts,
    phase: 'steady',
    elapsedSec: Math.round((ts - 1_700_000_000_000) / 1000),
    counters: {
      usersCreated: 10_000, usersConnected: 10_000, usersActive: 9_500,
      usersQueued: 100, usersInRoom: 8_000, actionsTotal: 100_000,
      successTotal: 99_000, failTotal: 1_000, echoOk: 950, echoSent: 1_000,
      queueCount: 200, roomCount: 1_333, droppedOutbox: 0, reconnectCount: 5,
      rateLimitedNoEcho: 50,
    },
    rates: { successRate: 99, echoRate: 95 },
    actionsPerSec: { chat: 400, read: 300 },
    latency: { p50: 40, p95: latencyP95, p99: 300 },
    errors: [{ code: 'HTTP_429', count: 10 }],
    server: { wsConnections: 10_000, wsMessagesEmitted: 1_000_000, wsMessagesPerSec: 5_000 },
    workers: { alive: 4, total: 4, cpuAvg: 50 },
  };
  return { ...base, counters: { ...base.counters, ...over } };
}

describe('buildReport', () => {
  it('per-action success rate dùng ok/fail thật theo action (AC6.1)', () => {
    const hist = new ActionHistograms();
    const h = new BucketedHistogram();
    for (let i = 0; i < 100; i++) h.add(120);
    hist.mergeFrom('chat', h.buckets);
    const history = [fakeTick(1_700_000_000_000), fakeTick(1_700_000_001_000)];
    const report = buildReport({
      runId: 'lt-test1',
      status: 'finished',
      startAt: 1_700_000_000_000,
      endAt: 1_700_000_001_000,
      config: fakeConfig(),
      tickHistory: history,
      perActionHistograms: hist,
      actionOk: { chat: 90 },
      actionFail: { chat: 10 },
      maxConnected: 10_000,
      maxActive: 9_500,
      maxQueue: 300,
      peakActionsPerSec: 900,
      provisioned: 10_000,
    });
    const chat = report.perAction.find((a) => a.action === 'chat');
    expect(chat?.success).toBe(90);
    expect(chat?.fail).toBe(10);
    expect(chat?.successRate).toBeCloseTo(90, 1);
    // count khớp histogram (không phóng đại — AC6.4)
    expect(chat?.count).toBe(100);
  });

  it('summary throughput avg/peak + echo rate', () => {
    const history = [fakeTick(1_700_000_000_000), fakeTick(1_700_000_001_000)];
    const report = buildReport({
      runId: 'lt-test1',
      status: 'finished',
      startAt: 1_700_000_000_000,
      endAt: 1_700_000_002_000,
      config: fakeConfig(),
      tickHistory: history,
      perActionHistograms: new ActionHistograms(),
      actionOk: {},
      actionFail: {},
      maxConnected: 10_000,
      maxActive: 9_500,
      maxQueue: 300,
      peakActionsPerSec: 900,
      provisioned: 10_000,
    });
    expect(report.summary.throughputPeak).toBe(900);
    expect(report.summary.echoRate).toBe(95);
    expect(report.summary.successRate).toBe(99);
  });
});

describe('detectBottlenecks (AC6.2)', () => {
  const base = (ts: number, over: Partial<LoadTestTick['counters']> = {}, p95 = 100): LoadTestTick =>
    fakeTick(ts, over, p95);

  it('queue-count tăng liên tục > 5 phút → nghi ngờ matching trần 100/s', () => {
    // 360 ticks, mỗi giây queue tăng 10
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 360; i++) {
      history.push(base(1_700_000_000_000 + i * 1000, { queueCount: 100 + i * 10 }));
    }
    const out = detectBottlenecks({ history, echoOk: 950, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    const queueB = out.find((b) => b.title.includes('Queue-count'));
    expect(queueB).toBeDefined();
    expect(queueB?.evidence.length).toBeGreaterThan(0);
  });

  it('echo rate < 95% → bottleneck chat', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 10; i++) history.push(base(1_700_000_000_000 + i * 1000));
    const out = detectBottlenecks({ history, echoOk: 800, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(out.some((b) => b.title.includes('echo rate'))).toBe(true);
  });

  it('P95 tăng > 2× so với 5 phút đầu → bottleneck latency', () => {
    const history: LoadTestTick[] = [];
    // 5 phút đầu khỏe ~100ms, sau đó thoái hóa 400ms — tổng 10 phút
    for (let i = 0; i < 300; i++) history.push(base(1_700_000_000_000 + i * 1000, {}, 100));
    for (let i = 300; i < 600; i++) history.push(base(1_700_000_000_000 + i * 1000, {}, 400));
    const out = detectBottlenecks({ history, echoOk: 950, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(out.some((b) => b.title.includes('P95 tăng'))).toBe(true);
  });

  it('worker CPU > 85% → cảnh báo tool-side', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 40; i++) history.push(base(1_700_000_000_000 + i * 1000));
    const out = detectBottlenecks({ history, echoOk: 950, echoSent: 1000, config: fakeConfig(), workerCpu: 92 });
    expect(out.some((b) => b.title.includes('Worker CPU'))).toBe(true);
  });

  it('hệ thống khỏe → không có bottleneck', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 40; i++) {
      history.push(base(1_700_000_000_000 + i * 1000, { queueCount: 50 }, 60));
    }
    const out = detectBottlenecks({ history, echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 40 });
    expect(out.length).toBe(0);
  });

  it('ít hơn 5 tick → không chạy detector', () => {
    const out = detectBottlenecks({ history: [base(1)], echoOk: 0, echoSent: 0, config: fakeConfig(), workerCpu: 0 });
    expect(out.length).toBe(0);
  });
});
