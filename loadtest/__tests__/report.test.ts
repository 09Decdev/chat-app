/**
 * Unit tests — Report (RE-1..RE-3): buildReport + bottleneck detector (AC6.2).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReport, detectBottlenecks, reportToMarkdown, ticksToCsv, saveReportFiles } from '../report';
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
    createdAt: 1_700_000_000_000, // cố định — snapshot markdown phải deterministic
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
      connectAttempts: 10_000, connectFails: 30,
      connectFailsByType: { timeout: 20, transport: 5, reject: 3, other: 2 },
      usersFailed: 0,
      reconcileCount: 0, reconnectTotalMs: 15_000, reconnectMaxMs: 8_000, usersLost: 3,
    },
    rates: { successRate: 99, echoRate: 95, connectFailRate: 0 },
    actionsPerSec: { chat: 400, read: 300 },
    latency: { p50: 40, p95: latencyP95, p99: 300 },
    errors: [{ code: 'HTTP_429', count: 10 }],
    errorsByStage: {},
    server: { wsConnections: 10_000, wsMessagesEmitted: 1_000_000, wsMessagesPerSec: 5_000 },
    workers: { alive: 4, total: 4, cpuAvg: 50, rssAvgMb: 800 },
    hasConnectData: true,
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

describe('reportToMarkdown — NO_POST_FIXTURE (T-07/S-12)', () => {
  it('báo rõ section "Không có post fixture" khi feed trống', () => {
    const tick: LoadTestTick = {
      ...fakeTick(1_700_000_000_000),
      errors: [{ code: 'NO_POST_FIXTURE', count: 123 }],
    };
    const report = buildReport({
      runId: 'lt-test1',
      status: 'finished',
      startAt: 1_700_000_000_000,
      endAt: 1_700_000_001_000,
      config: fakeConfig(),
      tickHistory: [tick],
      perActionHistograms: new ActionHistograms(),
      actionOk: {},
      actionFail: {},
      maxConnected: 10_000,
      maxActive: 9_500,
      maxQueue: 300,
      peakActionsPerSec: 900,
      provisioned: 10_000,
    });
    expect(report.noPostFixtureSkipped).toBe(123);
    const md = reportToMarkdown(report);
    expect(md).toContain('Không có post fixture — bỏ qua bước đọc feed');
    expect(md).toContain('NO_POST_FIXTURE');
  });

  it('không có NO_POST_FIXTURE → không thêm section', () => {
    const report = buildReport({
      runId: 'lt-test1',
      status: 'finished',
      startAt: 1_700_000_000_000,
      endAt: 1_700_000_001_000,
      config: fakeConfig(),
      tickHistory: [fakeTick(1_700_000_000_000)],
      perActionHistograms: new ActionHistograms(),
      actionOk: {},
      actionFail: {},
      maxConnected: 10_000,
      maxActive: 9_500,
      maxQueue: 300,
      peakActionsPerSec: 900,
      provisioned: 10_000,
    });
    expect(report.noPostFixtureSkipped).toBe(0);
    expect(reportToMarkdown(report)).not.toContain('Không có post fixture');
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

  it('echoSent < 100 → KHÔNG cảnh báo echo dù echoOk = 0 (ngưỡng sample)', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 10; i++) history.push(base(1_700_000_000_000 + i * 1000));
    const out = detectBottlenecks({ history, echoOk: 0, echoSent: 99, config: fakeConfig(), workerCpu: 30 });
    expect(out.some((b) => b.title.includes('echo rate'))).toBe(false);
  });

  it('echo rate 95% → KHÔNG bottleneck; 94.9% → có (biên)', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 10; i++) history.push(base(1_700_000_000_000 + i * 1000));
    const ok = detectBottlenecks({ history, echoOk: 95, echoSent: 100, config: fakeConfig(), workerCpu: 30 });
    expect(ok.some((b) => b.title.includes('echo rate'))).toBe(false);
    const bad = detectBottlenecks({ history, echoOk: 94.9, echoSent: 100, config: fakeConfig(), workerCpu: 30 });
    expect(bad.some((b) => b.title.includes('echo rate'))).toBe(true);
  });

  it('echo bottleneck: level High khi < 90%, Med khi 90-95%, evidence rate CHÍNH XÁC', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 10; i++) history.push(base(1_700_000_000_000 + i * 1000, { echoOk: 800, echoSent: 1000 }));
    const high = detectBottlenecks({ history, echoOk: 800, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    const bHigh = high.find((b) => b.title.includes('echo rate'));
    expect(bHigh?.level).toBe('High');
    expect(bHigh?.evidence.length).toBe(10); // slice(-120) giữ 10 tick
    expect(bHigh?.evidence[0].value).toBe(80); // (800/1000)*100 — diệt mutant *1000, /100, *
    const medHistory: LoadTestTick[] = [];
    for (let i = 0; i < 10; i++) medHistory.push(base(1_700_000_000_000 + i * 1000, { echoOk: 940, echoSent: 1000 }));
    const med = detectBottlenecks({ history: medHistory, echoOk: 940, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(med.find((b) => b.title.includes('echo rate'))?.level).toBe('Med'); // 94% → Med (diệt >= 90)
  });

  it('queue bottleneck: growth biên 50 → KHÔNG; 51 → Med; 600s → High', () => {
    const mk = (n: number, baseVal: number, plateau: number, splitAt: number): LoadTestTick[] => {
      const out: LoadTestTick[] = [];
      for (let i = 0; i < n; i++) {
        out.push(base(1_700_000_000_000 + i * 1000, { queueCount: i < splitAt ? baseVal : plateau }));
      }
      return out;
    };
    // growth CHÍNH XÁC 50 (base 10 → 60): longest run 300s, growth 50 → KHÔNG bottleneck
    const at50 = detectBottlenecks({ history: mk(300, 10, 60, 50), echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(at50.some((b) => b.title.includes('Queue-count'))).toBe(false);
    // growth 51 (base 10 → 61): 300s → Med
    const at51 = detectBottlenecks({ history: mk(300, 10, 61, 50), echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    const b51 = at51.find((b) => b.title.includes('Queue-count'));
    expect(b51?.level).toBe('Med');
    // 600s → High (biên >= 600)
    const at600 = detectBottlenecks({ history: mk(600, 10, 61, 100), echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(at600.find((b) => b.title.includes('Queue-count'))?.level).toBe('High');
  });

  it('worker CPU biên: 85 → KHÔNG; 85.1 → Med; history < 30 tick → KHÔNG', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 40; i++) history.push(base(1_700_000_000_000 + i * 1000));
    const at85 = detectBottlenecks({ history, echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 85 });
    expect(at85.some((b) => b.title.includes('Worker CPU'))).toBe(false);
    const over85 = detectBottlenecks({ history, echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 85.1 });
    expect(over85.find((b) => b.title.includes('Worker CPU'))?.level).toBe('Med');
    const short = detectBottlenecks({ history: history.slice(0, 29), echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 92 });
    expect(short.some((b) => b.title.includes('Worker CPU'))).toBe(false);
  });

  it('P95: first5 đúng biên 30 tick → vẫn chạy detector (diệt > 30)', () => {
    const history: LoadTestTick[] = [];
    for (let i = 0; i < 30; i++) history.push(base(1_700_000_000_000 + i * 1000, {}, 100)); // 0..29s — first5
    for (let i = 0; i < 30; i++) history.push(base(1_700_000_000_000 + 301_000 + i * 1000, {}, 400)); // sau 5 phút — last5
    const out = detectBottlenecks({ history, echoOk: 990, echoSent: 1000, config: fakeConfig(), workerCpu: 30 });
    expect(out.some((b) => b.title.includes('P95 tăng'))).toBe(true);
  });
});

// ─── T-11 (G-2): test mở rộng diệt mutant report.ts ────────────────────────

function fullReportInput(over: Partial<Parameters<typeof buildReport>[0]> = {}) {
  const hist = new ActionHistograms();
  const h = new BucketedHistogram();
  for (let i = 0; i < 100; i++) h.add(120);
  hist.mergeFrom('chat', h.buckets);
  return {
    runId: 'lt-test1',
    status: 'finished' as const,
    startAt: 1_700_000_000_000,
    endAt: 1_700_000_002_000,
    config: fakeConfig(),
    tickHistory: [fakeTick(1_700_000_000_000), fakeTick(1_700_000_001_000)],
    perActionHistograms: hist,
    actionOk: { chat: 90 },
    actionFail: { chat: 10 },
    maxConnected: 10_000,
    maxActive: 9_500,
    maxQueue: 300,
    peakActionsPerSec: 900,
    provisioned: 10_000,
    ...over,
  };
}

describe('buildReport — nhánh sâu (T-11)', () => {
  it('tickHistory rỗng → counters default, không crash, successRate 100', () => {
    const report = buildReport({ ...fullReportInput(), tickHistory: [] });
    expect(report.summary.actionsTotal).toBe(0);
    expect(report.summary.successRate).toBe(100);
    expect(report.summary.echoRate).toBe(100);
    expect(report.summary.throughputAvg).toBe(0);
    expect(report.summary.usersCreated).toBe(10_000); // từ provisioned
    expect(report.durationSec).toBe(2);
  });

  it('status stopped/error + stopReason passthrough', () => {
    const stopped = buildReport(fullReportInput({ status: 'stopped', stopReason: 'kill-switch' }));
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('kill-switch');
    const errored = buildReport(fullReportInput({ status: 'error', stopReason: 'E1' }));
    expect(errored.status).toBe('error');
    expect(errored.stopReason).toBe('E1');
  });

  it('perAction sort theo count giảm dần', () => {
    const hist = new ActionHistograms();
    const hChat = new BucketedHistogram();
    const hRead = new BucketedHistogram();
    for (let i = 0; i < 50; i++) hChat.add(10);
    for (let i = 0; i < 200; i++) hRead.add(20);
    hist.mergeFrom('chat', hChat.buckets);
    hist.mergeFrom('read', hRead.buckets);
    const report = buildReport(fullReportInput({ perActionHistograms: hist }));
    expect(report.perAction[0].action).toBe('read');
    expect(report.perAction[1].action).toBe('chat');
  });

  it('noPostFixtureSkipped suy từ history errors khi input không cung cấp', () => {
    const tick: LoadTestTick = {
      ...fakeTick(1_700_000_000_000),
      errors: [{ code: 'NO_POST_FIXTURE', count: 7 }],
    };
    const report = buildReport(fullReportInput({ tickHistory: [tick], noPostFixtureSkipped: undefined }));
    expect(report.noPostFixtureSkipped).toBe(7);
  });

  it('actionsTotal/success/fail truyền thẳng vào summary', () => {
    const report = buildReport(fullReportInput());
    expect(report.summary.actionsTotal).toBe(100_000);
    expect(report.summary.successTotal).toBe(99_000);
    expect(report.summary.failTotal).toBe(1_000);
    expect(report.summary.echoOk).toBe(950);
    expect(report.summary.queueCountPeak).toBe(300);
    expect(report.summary.throughputAvg).toBe(100_000); // 100k actions / span tick đầu action → tick cuối = 1s (không tính provisioning)
  });

  it('successRate/echoRate CHÍNH XÁC 50/50 (diệt mutant làm tròn + bỏ /10)', () => {
    const history = [fakeTick(1_700_000_000_000, { successTotal: 50, failTotal: 50, echoOk: 50, echoSent: 100 })];
    const report = buildReport(fullReportInput({ tickHistory: history }));
    expect(report.summary.successRate).toBe(50); // (50/100)*1000/10
    expect(report.summary.echoRate).toBe(50);
  });

  it('perAction successRate CHÍNH XÁC 50 khi ok/fail cân bằng; 100 khi không có action', () => {
    const hist = new ActionHistograms();
    const h = new BucketedHistogram();
    for (let i = 0; i < 10; i++) h.add(100);
    hist.mergeFrom('chat', h.buckets);
    const report = buildReport(
      fullReportInput({ perActionHistograms: hist, actionOk: { chat: 50 }, actionFail: { chat: 50 } }),
    );
    const chat = report.perAction.find((a) => a.action === 'chat');
    expect(chat?.successRate).toBe(50);
    const zero = buildReport(
      fullReportInput({ perActionHistograms: new ActionHistograms(), actionOk: {}, actionFail: {} }),
    );
    expect(zero.perAction).toEqual([]); // không action → perAction rỗng
  });
});

describe('reportToMarkdown — snapshot toàn bộ output (diệt string mutant)', () => {
  it('markdown đầy đủ ổn định (snapshot)', () => {
    const report = buildReport(fullReportInput());
    expect(reportToMarkdown(report)).toMatchSnapshot();
  });

  it('markdown với status error + stopReason + bottleneck + NO_POST_FIXTURE (snapshot)', () => {
    const tick: LoadTestTick = { ...fakeTick(1_700_000_000_000), errors: [{ code: 'NO_POST_FIXTURE', count: 5 }] };
    const report = buildReport(fullReportInput({ status: 'error', stopReason: 'E1: register fail 60% > 50%', tickHistory: [tick] }));
    expect(reportToMarkdown(report)).toMatchSnapshot();
  });

  it('formatMs: < 1s → ms; ≥ 1s → s (2 chữ số thập phân)', () => {
    const hist = new ActionHistograms();
    const h = new BucketedHistogram();
    for (let i = 0; i < 50; i++) h.add(500); // < 1s
    for (let i = 0; i < 50; i++) h.add(2500); // 2.5s
    hist.mergeFrom('chat', h.buckets);
    const report = buildReport(fullReportInput({ perActionHistograms: hist }));
    const md = reportToMarkdown(report);
    expect(md).toContain('| chat |'); // dòng action
    expect(md).toMatch(/\| chat \| \d+(ms|\.\d+s)/);
  });
});

describe('ticksToCsv — snapshot (T-11)', () => {
  it('CSV đầy đủ header + row ổn định (snapshot)', () => {
    const csv = ticksToCsv('lt-test1', [fakeTick(1_700_000_000_000)]);
    expect(csv).toMatchSnapshot();
  });
});

describe('saveReportFiles (RE-3, T-11)', () => {
  it('ghi JSON + MD + CSV vào dir/{runId}/, trả về dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-report-save-'));
    const report = buildReport(fullReportInput());
    const ticks = [fakeTick(1_700_000_000_000), fakeTick(1_700_000_001_000)];
    const saved = saveReportFiles(report, ticks, dir);
    expect(saved).toBe(path.join(dir, report.runId));
    expect(fs.existsSync(path.join(dir, report.runId, `report-${report.runId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, report.runId, `report-${report.runId}.md`))).toBe(true);
    expect(fs.existsSync(path.join(dir, report.runId, `metrics-${report.runId}.csv`))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(dir, report.runId, `report-${report.runId}.json`), 'utf8')) as { runId?: string; summary?: { usersCreated?: number } };
    expect(json.runId).toBe(report.runId);
    expect(json.summary?.usersCreated).toBe(10_000);
  });

  it('thư mục không ghi được (path là FILE) → trả về "" (không throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-report-fail-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const report = buildReport(fullReportInput());
    expect(saveReportFiles(report, [], blocker)).toBe('');
  });
});
