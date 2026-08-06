/**
 * MAYogu LoadTest Tool — Worker Farm (SF-1): fork child processes, heartbeat,
 * restart khi crash, kill-switch ≤ 5s (SD-3).
 *
 * Chọn child_process.fork (thay vì worker_threads / in-process) vì:
 * - Mỗi worker = 1 event loop riêng → 10k+ socket/worker không bão hòa chung (PRD §5.1).
 * - Crash/OOM 1 worker không kéo sập coordinator (E3 — tự restart).
 * - Cách ly metrics + IPC message JSON đơn giản.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunConfig, TestAccount, WorkerCommand, WorkerMessage } from './types';
import { ltLog } from './util';
import { toolMetrics } from './tool-metrics';

const WORKER_ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url));

/**
 * T-07 FIX-3: env cho child process — ghi đè LOGTEST_LOG_FILE='' để worker KHÔNG ghi JSONL sink.
 * Forked worker mỗi process giữ rotation counter riêng → append/rotate race trên cùng file nếu kế thừa.
 */
export function workerEnv(workerId: number): NodeJS.ProcessEnv {
  return { ...process.env, LOADTEST_WORKER_ID: String(workerId), LOGTEST_LOG_FILE: '' };
}

export interface WorkerHandle {
  id: number;
  pid: number;
  child: ChildProcess;
  alive: boolean;
  crashed: boolean;
  lastTickAt: number;
  accounts: TestAccount[];
  restartCount: number;
  /** Đã nhận lệnh `run` — chống broadcast trùng (F2). */
  runSent: boolean;
}

export interface FarmEvents {
  onTick: (workerId: number, msg: WorkerMessage) => void;
  onWorkerDied: (workerId: number, crashed: boolean) => void;
  onWorkerRestarted: (workerId: number) => void;
}

export class WorkerFarm {
  private workers = new Map<number, WorkerHandle>();
  private requestSeq = 0;
  private pendingUsers: Map<
    number,
    {
      resolve: (v: { rows: unknown[]; total: number; phaseCounts?: Record<string, number> }) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private runConfig: RunConfig | null = null;

  constructor(private events: FarmEvents) {}

  get alive(): number {
    let n = 0;
    for (const w of this.workers.values()) if (w.alive) n++;
    return n;
  }

  get total(): number {
    return this.workers.size;
  }

  spawn(workerId: number, accounts: TestAccount[]): WorkerHandle {
    // C-1: spawn đè worker id cũ (start mới khi run cũ chưa teardown xong) → kill handle cũ NGAY,
    // không để orphan child tiếp tục chạy + không để exit event của nó trigger restart nhầm.
    const prev = this.workers.get(workerId);
    if (prev) {
      try {
        if (prev.alive) prev.child.kill('SIGKILL');
      } catch {
        // đã chết
      }
      prev.alive = false;
    }
    // Parent chạy qua tsx (npm run loadtest:server) → execArgv đã có tsx loader, con kế thừa.
    // Nếu chạy node thuần → thêm --import tsx cho con.
    const hasTsxLoader = process.execArgv.some((a) => a.includes('tsx'));
    const child = fork(WORKER_ENTRY, [], {
      execArgv: hasTsxLoader ? undefined : ['--import', 'tsx'],
      env: workerEnv(workerId), // T-07 FIX-3: workers không kế thừa LOGTEST_LOG_FILE (JSONL sink single-process)
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      cwd: fileURLToPath(new URL('..', import.meta.url)), // chat-app/
    });
    const handle: WorkerHandle = {
      id: workerId,
      pid: child.pid ?? 0,
      child,
      alive: true,
      crashed: false,
      lastTickAt: Date.now(),
      accounts,
      restartCount: 0,
      runSent: false,
    };
    this.workers.set(workerId, handle);

    child.on('message', (msg: WorkerMessage) => {
      if (msg && typeof msg === 'object' && (msg as { type: string }).type === 'tick') {
        handle.lastTickAt = Date.now();
      }
      this.events.onTick(workerId, msg);
    });

    child.on('exit', (code, signal) => {
      // C-1: exit của handle đã bị thay thế (spawnAll mới) → BỎ QUA — không trigger onWorkerDied
      // (nếu không, exit worker CŨ sẽ restart nhầm worker MỚI của run sau — chaos).
      if (this.workers.get(workerId) !== handle) return;
      handle.alive = false;
      handle.crashed = true;
      this.events.onWorkerDied(workerId, true);
      ltLog.warn(`worker#${workerId} exit (code=${code} signal=${signal}) — coordinator sẽ quyết định restart`);
    });

    child.on('error', (err) => {
      ltLog.error(`worker#${workerId} process error: ${err.message}`);
    });

    return handle;
  }

  /** Fork toàn bộ workers với slice account riêng. */
  spawnAll(count: number, accounts: TestAccount[]): WorkerHandle[] {
    const out: WorkerHandle[] = [];
    const perWorker = Math.ceil(accounts.length / count);
    for (let i = 0; i < count; i++) {
      const slice = accounts.slice(i * perWorker, (i + 1) * perWorker);
      out.push(this.spawn(i, slice));
    }
    return out;
  }

  get(id: number): WorkerHandle | undefined {
    return this.workers.get(id);
  }

  send(id: number, cmd: WorkerCommand) {
    const w = this.workers.get(id);
    if (w?.alive && w.child.connected) w.child.send(cmd);
  }

  broadcast(cmd: WorkerCommand) {
    for (const w of this.workers.values()) {
      if (w.alive && w.child.connected) w.child.send(cmd);
    }
  }

  /** Kill-switch: SIGKILL mọi worker (≤ 5s — SD-3). */
  killAll() {
    for (const w of this.workers.values()) {
      try {
        if (w.alive) w.child.kill('SIGKILL');
      } catch {
        // đã chết
      }
      w.alive = false;
    }
  }

  /** Kiểm tra heartbeat; trả về danh sách worker "chết im lặng" (không tick > 5s mà vẫn alive). */
  checkHeartbeats(staleMs = 5000): number[] {
    const now = Date.now();
    const stale: number[] = [];
    for (const w of this.workers.values()) {
      if (w.alive && now - w.lastTickAt > staleMs) {
        stale.push(w.id);
        // ping để phân biệt "treo" vs "chỉ im lặng"
        this.send(w.id, { type: 'ping' });
      }
    }
    return stale;
  }

  /** Restart 1 worker (E3 — backoff 2s) với cùng accounts + gửi run ngay sau spawn.
   *  Không chờ 'ready' (worker chỉ gửi ready SAU khi xử lý run — chờ sẽ treo vô hạn). */
  async restart(id: number, backoffMs = 2000): Promise<WorkerHandle | null> {
    const old = this.workers.get(id);
    if (!old) return null;
    this.workers.delete(id);
    await new Promise((r) => setTimeout(r, backoffMs));
    const fresh = this.spawn(id, old.accounts);
    fresh.restartCount = old.restartCount + 1;
    if (this.runConfig) {
      this.send(id, { type: 'run', config: this.runConfig, accounts: old.accounts, workerIndex: id });
      fresh.runSent = true;
    }
    this.events.onWorkerRestarted(id);
    toolMetrics.inc('workerRestarts'); // T-07: đếm workerRestarts (G-10)
    return fresh;
  }

  /** Hỏi 1 worker danh sách user (virtualized table). */
  queryUsers(
    id: number,
    offset: number,
    limit: number,
    filter?: string,
    phase?: string,
    sortBy?: string,
    sortDir?: string,
  ): Promise<{ rows: unknown[]; total: number; phaseCounts?: Record<string, number> }> {
    const requestId = ++this.requestSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUsers.delete(requestId);
        resolve({ rows: [], total: 0 });
      }, 3000);
      this.pendingUsers.set(requestId, { resolve, timer });
      this.send(id, { type: 'query-users', requestId, offset, limit, filter, phase, sortBy, sortDir });
    });
  }

  /** Gọi từ coordinator khi nhận users-response. */
  resolveUsers(requestId: number, rows: unknown[], total: number, phaseCounts?: Record<string, number>) {
    const p = this.pendingUsers.get(requestId);
    if (p) {
      clearTimeout(p.timer);
      this.pendingUsers.delete(requestId);
      p.resolve({ rows, total, phaseCounts });
    }
  }

  setRunConfig(config: RunConfig) {
    this.runConfig = config;
  }

  dispose() {
    this.killAll();
    this.workers.clear();
  }
}
