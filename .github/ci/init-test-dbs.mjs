// T-10 CI helper — tạo 3 database test cho loadtest integration suites bên
// trong Postgres 16 container (ubuntu leg của CI).
//
// Postgres official image chỉ auto-create 1 DB (POSTGRES_DB=postgres), nhưng:
//   - loadtest/__tests__/store.test.ts   → db `loadtest_test`
//   - loadtest/__tests__/migrate.test.ts → db `loadtest_test_migrate`
//   - loadtest/__tests__/api-server.test.ts → db `loadtest_test_api`
// Script này connect bằng `pg` (dependency có sẵn trong node_modules — chạy
// SAU `npm ci`) và tạo cả 3 DB idempotently.
//
// Usage: node .github/ci/init-test-dbs.mjs
// Env:   LOADTEST_TEST_ADMIN_URL (default: postgresql://appuser:secret@localhost:5432/postgres)
import pg from 'pg';

const adminUrl =
  process.env.LOADTEST_TEST_ADMIN_URL ||
  'postgresql://appuser:secret@localhost:5432/postgres';
const databases = ['loadtest_test', 'loadtest_test_migrate', 'loadtest_test_api'];

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  for (const db of databases) {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if (exists.rowCount === 0) {
      // CREATE DATABASE không chạy được trong transaction — pg tự commit từng statement.
      await client.query(`CREATE DATABASE "${db}"`);
      console.log(`created database: ${db}`);
    } else {
      console.log(`database already exists: ${db}`);
    }
  }
} finally {
  await client.end();
}
