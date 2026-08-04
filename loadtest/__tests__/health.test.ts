/**
 * T-07 — health endpoint (US-OBS-1): DB down → degraded, không 500, không 'ok' giả.
 */
import { describe, it, expect } from 'vitest';
import { buildHealth, createHealthProbe, LOADTEST_VERSION, type HealthDeps } from '../health';

function baseDeps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    store: { enabled: () => true, probe: async () => true },
    coordinator: { phase: 'idle', workerAlive: 0 },
    redis: { configured: () => true, ping: async () => true },
    version: LOADTEST_VERSION,
    startedAt: Date.now() - 10_000,
    ...over,
  };
}

describe('buildHealth (T-07)', () => {
  it('db down → status degraded, db down, workers idle, không ok giả', async () => {
    const report = await buildHealth(
      baseDeps({ store: { enabled: () => false, probe: async () => false } }),
    );
    expect(report.status).toBe('degraded');
    expect(report.db).toBe('down');
    expect(report.redis).toBe('up');
    expect(report.workers).toBe('idle');
    expect(report.version).toBe(LOADTEST_VERSION);
    expect(report.uptimeSec).toBeGreaterThanOrEqual(10);
    expect(report.timestamp).toBeGreaterThan(0);
  });

  it('store undefined → db down → degraded', async () => {
    const report = await buildHealth(baseDeps({ store: undefined }));
    expect(report.status).toBe('degraded');
    expect(report.db).toBe('down');
  });

  it('probe throw → db down → degraded', async () => {
    const report = await buildHealth(
      baseDeps({ store: { enabled: () => true, probe: async () => { throw new Error('boom'); } } }),
    );
    expect(report.status).toBe('degraded');
    expect(report.db).toBe('down');
  });

  it('db up + redis up → ok; run đang chạy → workers running', async () => {
    const report = await buildHealth(
      baseDeps({ coordinator: { phase: 'steady', workerAlive: 4 } }),
    );
    expect(report.status).toBe('ok');
    expect(report.db).toBe('up');
    expect(report.redis).toBe('up');
    expect(report.workers).toBe('running');
  });

  it('redis down → degraded (redis down), db up', async () => {
    const report = await buildHealth(
      baseDeps({ redis: { configured: () => true, ping: async () => { throw new Error('conn refused'); } } }),
    );
    expect(report.status).toBe('degraded');
    expect(report.db).toBe('up');
    expect(report.redis).toBe('down');
  });

  it('FIX-2: workers là down khi run active nhưng 0 worker alive', async () => {
    const report = await buildHealth(
      baseDeps({ coordinator: { phase: 'steady', workerAlive: 0 } }),
    );
    expect(report.workers).toBe('down');
    expect(report.status).toBe('degraded');
  });

  it('FIX-2: workers là running khi run active + ≥1 worker alive', async () => {
    const report = await buildHealth(
      baseDeps({ coordinator: { phase: 'ramping', workerAlive: 2 } }),
    );
    expect(report.workers).toBe('running');
  });

  it('FIX-2: redis không cấu hình → disabled, không tính vào status', async () => {
    const report = await buildHealth(
      baseDeps({ redis: { configured: () => false, ping: async () => { throw new Error('should not be called'); } } }),
    );
    expect(report.redis).toBe('disabled');
    expect(report.status).toBe('ok');
  });

  it('FIX-2: status down khi DB bắt buộc (required) và down', async () => {
    const report = await buildHealth(
      baseDeps({
        store: { enabled: () => false, probe: async () => false, required: () => true },
        redis: { configured: () => false, ping: async () => true },
      }),
    );
    expect(report.status).toBe('down');
    expect(report.db).toBe('down');
  });

  it('FIX-2: status down khi cả db + redis cùng down', async () => {
    const report = await buildHealth(
      baseDeps({
        store: { enabled: () => true, probe: async () => false }, // không required
        redis: { configured: () => true, ping: async () => { throw new Error('down'); } },
      }),
    );
    expect(report.status).toBe('down');
    expect(report.db).toBe('down');
    expect(report.redis).toBe('down');
  });

  it('FIX-2: workers down khi run active + 0 worker → status degraded (1 trong 3 down)', async () => {
    const report = await buildHealth(
      baseDeps({ coordinator: { phase: 'cooldown', workerAlive: 0 } }),
    );
    expect(report.workers).toBe('down');
    expect(report.status).toBe('degraded');
  });
});

describe('createHealthProbe (T-07 — cache 10s)', () => {
  it('cache probe db/redis, workers/uptime luôn mới', async () => {
    let dbUp = true;
    const deps = () =>
      baseDeps({
        store: { enabled: () => true, probe: async () => dbUp },
        coordinator: { phase: 'idle', workerAlive: 0 },
      });
    const probe = createHealthProbe(deps, 10_000);
    const r1 = await probe();
    expect(r1.status).toBe('ok');
    // DB đổi thành down nhưng trong TTL → cache giữ 'up'
    dbUp = false;
    const r2 = await probe();
    expect(r2.db).toBe('up');
    // Hết TTL → probe lại
    dbUp = true;
    const probe2 = createHealthProbe(deps, 0);
    dbUp = false;
    const r3 = await probe2();
    expect(r3.db).toBe('down');
    expect(r3.status).toBe('degraded');
  });
});