/**
 * MAYogu LoadTest Tool — Worker process entry (child_process.fork target).
 * Nhận lệnh `run` từ coordinator → WorkerRuntime → gửi tick/IPC về parent.
 */

import { WorkerRuntime } from './socket-farm';
import { getEnv } from './config';
import type { WorkerCommand } from './types';
import { ltLog, setVerbose } from './util';

const env = getEnv();
setVerbose(env.debug || process.env.LOADTEST_DEBUG === '1');

const workerId = Number(process.env.LOADTEST_WORKER_ID ?? 0);
const runtime = new WorkerRuntime(workerId, env);

runtime.onMessage = (msg) => {
  if (process.send) process.send(msg);
};

process.on('message', (msg: WorkerCommand) => {
  switch (msg.type) {
    case 'run': {
      runtime.start(msg.config, msg.accounts);
      if (process.send) process.send({ type: 'ready', workerId, pid: process.pid });
      break;
    }
    case 'stop': {
      void runtime.stop(msg.reason, msg.force).then(() => {
        // sau khi gửi done — thoát
        setTimeout(() => process.exit(0), 500);
      });
      break;
    }
    case 'pause':
      runtime.pause();
      break;
    case 'resume':
      runtime.resume();
      break;
    case 'query-users': {
      const { rows, total, phaseCounts } = runtime.queryUsers(
        msg.offset,
        msg.limit,
        msg.filter,
        msg.phase,
        msg.sortBy,
        msg.sortDir,
      );
      if (process.send) process.send({ type: 'users-response', requestId: msg.requestId, rows, total, phaseCounts });
      break;
    }
    case 'ping':
      if (process.send) process.send({ type: 'ready', workerId, pid: process.pid });
      break;
  }
});

process.on('uncaughtException', (err) => {
  ltLog.error(`worker#${workerId} uncaught: ${err.message}\n${err.stack}`, { workerId });
  if (process.send) process.send({ type: 'fatal', error: err.message });
});

process.on('SIGTERM', () => {
  void runtime.stop('SIGTERM', true).then(() => process.exit(0));
});
process.on('SIGINT', () => {
  void runtime.stop('SIGINT', true).then(() => process.exit(0));
});

ltLog.info(`worker#${workerId} ready (pid ${process.pid})`, { workerId });
