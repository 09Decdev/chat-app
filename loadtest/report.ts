/**
 * MAYogu LoadTest Tool — Report (RE-1..RE-3): summary + latency P50/P95/P99 theo action
 * + bottleneck detector (AC6.2) + export JSON/Markdown/CSV.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoadTestTick, RunConfig, RunPhase } from './types';
import type { ActionHistograms } from './metrics';
import type { RunReport, ActionReport, BottleneckCandidate } from './types';
import { ltLog } from './util';

export interface ReportInput {
  runId: string;
  status: 'finished' | 'stopped' | 'error';
  startAt: number;
  endAt: number;
  config: RunConfig;
  tickHistory: LoadTestTick[];
  perActionHistograms: ActionHistograms;
  /** ok/fail theo action (cumulative) — per-action success rate thật (AC6.1). */
  actionOk: Record<string, number>;
  actionFail: Record<string, number>;
  maxConnected: number;
  maxActive: number;
  maxQueue: number;
  peakActionsPerSec: number;
  provisioned: number;
  stopReason?: string;
  /** Số lần NO_POST_FIXTURE — coordinator đếm từ raw worker errors (T-07/S-12). */
  noPostFixtureSkipped?: number;
}

export function buildReport(input: ReportInput): RunReport {
  const history = input.tickHistory;
  const last = history[history.length - 1];
  const c = last?.counters ?? {
    usersCreated: 0, usersConnected: 0, usersActive: 0, actionsTotal: 0,
    successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0, queueCount: 0,
  };
  const durationSec = Math.max(1, Math.round((input.endAt - input.startAt) / 1000));
  const successTotal = c.successTotal + c.failTotal;

  // Per-action từ histogram cumulative + per-action ok/fail thật
  const perAction: ActionReport[] = [];
  for (const action of input.perActionHistograms.keys()) {
    const h = input.perActionHistograms.get(action)!;
    const q = h.quantiles();
    const ok = input.actionOk[action] ?? 0;
    const fail = input.actionFail[action] ?? 0;
    const actionTotal = ok + fail;
    perAction.push({
      action: action as ActionReport['action'],
      count: h.getCount(),
      success: ok,
      fail,
      successRate: actionTotal > 0 ? Math.round((ok / actionTotal) * 1000) / 10 : 100,
      avgMs: q.avg,
      p50Ms: q.p50,
      p95Ms: q.p95,
      p99Ms: q.p99,
    });
  }
  perAction.sort((a, b) => b.count - a.count);

  const errorsMap = new Map<string, number>();
  for (const t of history) {
    for (const e of t.errors) errorsMap.set(e.code, (errorsMap.get(e.code) ?? 0) + e.count);
  }
  const errors = [...errorsMap.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // T-07/S-12: NO_POST_FIXTURE — feed trống, không phải lỗi hệ thống; báo rõ trong report.
  const noPostFixtureSkipped =
    input.noPostFixtureSkipped ??
    history.reduce(
      (acc, t) => acc + t.errors.filter((e) => e.code === 'NO_POST_FIXTURE').reduce((a, e) => a + e.count, 0),
      0,
    );

  const bottleneckInput = {
    history,
    echoOk: c.echoOk,
    echoSent: c.echoSent,
    config: input.config,
    workerCpu: history.slice(-60).reduce((a, t) => a + t.workers.cpuAvg, 0) / Math.max(1, history.slice(-60).length),
  };
  const bottlenecks = detectBottlenecks(bottleneckInput);

  return {
    runId: input.runId,
    status: input.status,
    startAt: input.startAt,
    endAt: input.endAt,
    durationSec,
    config: input.config,
    summary: {
      usersCreated: input.provisioned,
      usersConnectedMax: input.maxConnected,
      usersActiveMax: input.maxActive,
      actionsTotal: c.actionsTotal,
      successTotal: c.successTotal,
      failTotal: c.failTotal,
      successRate: successTotal > 0 ? Math.round((c.successTotal / successTotal) * 1000) / 10 : 100,
      echoOk: c.echoOk,
      echoSent: c.echoSent,
      echoRate: c.echoSent > 0 ? Math.round((c.echoOk / c.echoSent) * 1000) / 10 : 100,
      throughputAvg: Math.round(c.actionsTotal / durationSec),
      throughputPeak: input.peakActionsPerSec,
      queueCountPeak: input.maxQueue,
    },
    perAction,
    errors,
    bottlenecks,
    stopReason: input.stopReason,
    noPostFixtureSkipped,
  };
}

// ─── Bottleneck detector (AC6.2) ───────────────────────────────────────────

interface BottleneckInput {
  history: LoadTestTick[];
  echoOk: number;
  echoSent: number;
  config: RunConfig;
  workerCpu: number;
}

export function detectBottlenecks(input: BottleneckInput): BottleneckCandidate[] {
  const out: BottleneckCandidate[] = [];
  const h = input.history;
  if (h.length < 5) return out;

  const seriesOf = (pick: (t: LoadTestTick) => number): { ts: number; value: number }[] =>
    h.map((t) => ({ ts: t.ts, value: pick(t) }));

  // 1. Chat echo rate < 95%
  if (input.echoSent >= 100) {
    const echoRate = (input.echoOk / input.echoSent) * 100;
    if (echoRate < 95) {
      out.push({
        level: echoRate < 90 ? 'High' : 'Med',
        title: `Chat echo rate ${echoRate.toFixed(1)}% (< 95% dự kiến)`,
        detail: 'Nghi ngờ rate-limit chat (1 msg/2s silent drop) hoặc pipeline Kafka chậm — PRD §5.3 tách rate-limited khỏi lỗi thật.',
        evidence: seriesOf((t) => (t.counters.echoSent > 0 ? (t.counters.echoOk / t.counters.echoSent) * 100 : 100)).slice(-120),
      });
    }
  }

  // 2. Queue-count tăng liên tục > 5 phút → matching trần ~100 user/s
  const queueSeries = seriesOf((t) => t.counters.queueCount);
  const longestRun = longestNonDecreasingRun(queueSeries);
  if (longestRun.seconds >= 300 && longestRun.growth > 50) {
    out.push({
      level: longestRun.seconds >= 600 ? 'High' : 'Med',
      title: `Queue-count tăng liên tục ${Math.round(longestRun.seconds / 60)} phút (${Math.round(longestRun.growth)} user)`,
      detail: 'Matching engine trần ~100 user/s (MAX_POP=200/tick 2s) — user vào phòng chậm hơn ramp.',
      evidence: queueSeries.slice(-600),
    });
  }

  // 3. P95 tăng > 2× so với 5 phút đầu (nghi DB/Kafka)
  const p95Series = seriesOf((t) => t.latency.p95);
  const first5 = p95Series.filter((p) => p.ts - h[0].ts <= 300_000);
  const last5 = p95Series.slice(-300);
  if (first5.length >= 30 && last5.length >= 30) {
    const avg = (arr: { value: number }[]) => arr.reduce((a, p) => a + p.value, 0) / arr.length;
    const f = avg(first5);
    const l = avg(last5);
    if (f > 50 && l > f * 2) {
      out.push({
        level: 'Med',
        title: `Latency P95 tăng ${(l / Math.max(1, f)).toFixed(1)}× so với 5 phút đầu (${Math.round(f)}ms → ${Math.round(l)}ms)`,
        detail: 'Nghi ngờ DB/Kafka tích tụ dưới tải — xem chart latency để xác định vùng.',
        evidence: p95Series.slice(-600),
      });
    }
  }

  // 4. Worker CPU > 85% (tool-side bottleneck)
  if (input.workerCpu > 85 && input.history.length >= 30) {
    out.push({
      level: 'Med',
      title: `Worker CPU trung bình ${Math.round(input.workerCpu)}% (> 85%)`,
      detail: 'Tool-side quá tải — giảm socket/worker hoặc tăng worker count. Số liệu có thể thiếu chính xác.',
      evidence: seriesOf((t) => t.workers.cpuAvg).slice(-120),
    });
  }

  return out;
}

/** Tìm đoạn dài nhất không giảm (cho phép nhiễu ±1) — queue tăng liên tục. */
function longestNonDecreasingRun(series: { value: number }[]): { seconds: number; growth: number } {
  let bestLen = 0, bestGrowth = 0;
  let start = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].value < series[i - 1].value - 1) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestGrowth = series[i - 1].value - series[start].value;
      }
      start = i;
    }
  }
  const len = series.length - start;
  if (len > bestLen) {
    bestLen = len;
    bestGrowth = series[series.length - 1].value - series[start].value;
  }
  return { seconds: bestLen, growth: bestGrowth };
}

// ─── Export (RE-3) ─────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  return Math.round(ms) + 'ms';
}

export function reportToMarkdown(r: RunReport): string {
  const s = r.summary;
  const lines: string[] = [
    `# MAYogu LoadTest Report — ${r.runId}`,
    '',
    `**Status**: ${r.status}${r.stopReason ? ` — ${r.stopReason}` : ''}`,
    `**Thời gian**: ${new Date(r.startAt).toISOString()} → ${new Date(r.endAt).toISOString()} (thực tế ${Math.round(r.durationSec / 60)}m ${r.durationSec % 60}s)`,
    '',
    '## Summary',
    '',
    `| Metric | Giá trị |`,
    `|---|---|`,
    `| User đã tạo | ${s.usersCreated.toLocaleString()} |`,
    `| Connect max | ${s.usersConnectedMax.toLocaleString()} |`,
    `| Active max | ${s.usersActiveMax.toLocaleString()} |`,
    `| Actions | ${s.actionsTotal.toLocaleString()} |`,
    `| Success rate | ${s.successRate}% |`,
    `| Throughput avg / peak | ${s.throughputAvg}/s · ${s.throughputPeak}/s |`,
    `| Chat echo rate | ${s.echoRate}% (${s.echoOk}/${s.echoSent}) |`,
    `| Queue peak | ${s.queueCountPeak} |`,
    '',
    ...(r.noPostFixtureSkipped && r.noPostFixtureSkipped > 0
      ? [
          '## Không có post fixture — bỏ qua bước đọc feed',
          '',
          `- \`NO_POST_FIXTURE\`: ${r.noPostFixtureSkipped.toLocaleString()} lần — feed trống/chưa có post, các action \`read\`/\`view\`/\`comment\`/\`like\` bị bỏ qua. Seed nội dung trước khi chạy run.`,
          '',
        ]
      : []),
    '## Latency theo action',
    '',
    '| action | p50 | p95 | p99 | count |',
    '|---|---|---|---|---|',
    ...r.perAction.map(
      (a) => `| ${a.action} | ${formatMs(a.p50Ms)} | ${formatMs(a.p95Ms)} | ${formatMs(a.p99Ms)} | ${a.count.toLocaleString()} |`,
    ),
    '',
    '## Bottleneck candidates',
    '',
    ...(r.bottlenecks.length
      ? r.bottlenecks.map((b, i) => `${i + 1}. **[${b.level}]** ${b.title}\n   ${b.detail}`)
      : ['Không phát hiện bottleneck vượt ngưỡng.']),
    '',
    '## Top errors',
    '',
    ...(r.errors.length ? r.errors.map((e) => `- \`${e.code}\`: ${e.count.toLocaleString()}`) : ['Không có lỗi.']),
    '',
    '## Cấu hình run',
    '',
    '```json',
    JSON.stringify(r.config, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/** CSV raw metrics 1s — cần history, build riêng. */
export function ticksToCsv(runId: string, ticks: LoadTestTick[]): string {
  const header = 'ts,phase,elapsedSec,usersCreated,usersConnected,usersActive,usersQueued,usersInRoom,actionsTotal,successTotal,failTotal,echoOk,echoSent,queueCount,roomCount,successRate,echoRate,p50Ms,p95Ms,p99Ms,aliveWorkers,cpuAvg,wsConnections\n';
  const rows = ticks.map((t) =>
    [
      t.ts, t.phase, t.elapsedSec,
      t.counters.usersCreated, t.counters.usersConnected, t.counters.usersActive,
      t.counters.usersQueued, t.counters.usersInRoom,
      t.counters.actionsTotal, t.counters.successTotal, t.counters.failTotal,
      t.counters.echoOk, t.counters.echoSent,
      t.counters.queueCount, t.counters.roomCount,
      t.rates.successRate, t.rates.echoRate,
      t.latency.p50, t.latency.p95, t.latency.p99,
      t.workers.alive, t.workers.cpuAvg,
      t.server.wsConnections,
    ].join(','),
  );
  return header + rows.join('\n');
}

/** Lưu report ra docs/loadtest-reports/{runId}/ — JSON auto, MD/CSV khi export. */
export function saveReportFiles(r: RunReport, ticks: LoadTestTick[], dir: string): string {
  try {
    const d = path.join(dir, r.runId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `report-${r.runId}.json`), JSON.stringify(r, null, 2), 'utf8');
    fs.writeFileSync(path.join(d, `report-${r.runId}.md`), reportToMarkdown(r), 'utf8');
    fs.writeFileSync(path.join(d, `metrics-${r.runId}.csv`), ticksToCsv(r.runId, ticks), 'utf8');
    ltLog.info(`report saved: ${d}`);
    return d;
  } catch (e) {
    ltLog.warn(`Không lưu được report: ${String(e)}`);
    return '';
  }
}

export type { RunPhase };
