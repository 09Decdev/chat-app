/**
 * MAYogu LoadTest Tool — bootstrap server (PRD §8.1: Node server process trong chat-app).
 * Chạy: npm run loadtest:server
 * HTTP API: http://localhost:{LOADTEST_PORT}/api/loadtest (xem api-server.ts).
 */

import { getEnv, validateEnv } from './config';
import { LoadTestCoordinator } from './coordinator';
import { ApiServer } from './api-server';
import { LoadtestStore } from './db/store';
import { DbWriter } from './db/writer';
import { ltLog, setVerbose, redactUrl } from './util';

async function main() {
  const env = getEnv();

  // T-03: env fail-fast (production hoặc DB required) — fail TRƯỚC khi mở service,
  // không im lặng "chạy nhưng không ghi history".
  const problems = validateEnv(env);
  const envErrors = problems.filter((p) => p.severity === 'error');
  if (envErrors.length > 0) {
    ltLog.error(`[env] Cấu hình env thiếu/sai — ${envErrors.length} lỗi cần sửa:`);
    for (const p of envErrors) ltLog.error(`[env]   ${p.key}: ${p.message}`);
    process.exit(1);
  }
  for (const p of problems) if (p.severity === 'warning') ltLog.warn(`[env] ${p.key}: ${p.message}`);

  setVerbose(env.debug || process.env.LOADTEST_DEBUG === '1');

  ltLog.info('=== MAYogu LoadTest Tool server ===');
  ltLog.info(`gateway=${env.gatewayUrl}`);
  ltLog.info(`allowlist=${env.allowlist.join(', ')}`);
  ltLog.info(`redis=${redactUrl(env.redisUrl)} | otpSecret=${env.otpSecret ? '***' : '(THIẾU — register sẽ fail, cần loadtest/.env)'}`);
  ltLog.info(`maxTarget=${env.maxTarget} | maxDuration=${env.maxDurationMin}m | maxRegisterRamp=${env.maxRegisterRamp}/s`);
  ltLog.info(`reportsDir=${env.reportsDir} | dataDir=${env.dataDir}`);

  // DB: mở Postgres + startup (crash-detect + import legacy pool).
  // T-03: dbRequired=true (Q-2) — T-05 sẽ throw nếu connect fail (fail-fast server).
  const store = new LoadtestStore(env.databaseUrl, env.dbRequired);
  await store.connect();
  const dbWriter = new DbWriter(store, env.dataDir);
  await dbWriter.startup();

  const coordinator = new LoadTestCoordinator(
    env,
    {
      onPhaseChange: (phase) => ltLog.info(`phase → ${phase}`),
    },
    dbWriter,
  );
  const api = new ApiServer(env, coordinator, store);
  await api.listen();

  const shutdown = (signal: string) => {
    ltLog.info(`Nhận ${signal} — dừng run nếu đang chạy...`);
    void coordinator.stop(true).finally(async () => {
      await dbWriter.shutdown();
      await api.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[lt][FATAL]', err);
  process.exit(1);
});
