import { createVitest } from 'vitest/node';
import fs from 'node:fs';
process.env.NODE_ENV = 'test';
const sandbox = process.argv[2];
process.chdir(sandbox);
const setupFile = `${sandbox}/stryker-setup-0.js`;
fs.copyFileSync('C:/MAYogu_VIASG/chat-app/node_modules/@stryker-mutator/vitest-runner/dist/src/stryker-setup.js', setupFile);
const v = await createVitest('test', {
  config: 'loadtest/vitest.mutation.e2.config.ts',
  threads: true,
  pool: 'threads',
  coverage: { enabled: false },
  poolOptions: { threads: { maxThreads: 1, minThreads: 1 } },
  maxWorkers: 1,
  singleThread: false,
  maxConcurrency: 1,
  watch: false,
  bail: 1,
  onConsoleLog: () => false,
});
v.provide('globalNamespace', '__stryker__');
v.provide('isGreaterThanVitest4Point1', false);
v.provide('mode', 'dry-run');
v.config.related = [
  `${sandbox}/loadtest/coordinator-state.ts`,
  `${sandbox}/loadtest/sanitize.ts`,
  `${sandbox}/loadtest/socket-farm.ts`,
];
v.projects.forEach((p) => {
  p.config.setupFiles = [setupFile, ...p.config.setupFiles];
});
try {
  await v.start();
} catch (e) {
  console.log('start ERROR:', (e.code || e.message).split('\n')[0]);
}
const files = v.state.getFiles();
console.log('FILES:', files.length);
for (const f of files) console.log(' -', f.filepath.replace(/\\/g, '/'));
await v.close();
process.exit(0);