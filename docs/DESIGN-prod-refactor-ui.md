# DESIGN — Prod-refactor UI delta: ErrorBoundary, CSP, session notice, prefs validation, frontend tests

**Phiên bản**: 0.1 — 2026-08-04
**Tác giả**: UX Architect + UI Designer (design council)
**Nguồn chuẩn**: `docs/PRD-prod-refactor.md` (APPROVED), `docs/PLAN-prod-refactor.md` (APPROVED — T-08, T-09, T-12), `docs/UI-SPEC-loadtest-tool.md`, `docs/UX-FLOW-loadtest-tool.md`.
**Tính chất**: **DESIGN PROPOSAL — không viết code.** Đây là **delta layer** — mọi thứ trong doc này là **additive** (error boundary, CSP, thông báo session, validate prefs, test) và **KHÔNG đổi hành vi** dashboard loadtest (PRD §2.2 OUT OF SCOPE: "Không đổi UI/UX của dashboard loadtest").

---

## 0. Tóm tắt quyết định (TL;DR)

| # | Delta | Quyết định |
|---|---|---|
| D-1 | ErrorBoundary | 1 component dùng chung `src/components/ErrorBoundary.tsx`, mount **2 lớp**: app-level (bọc `<Routes/>` trong `App.tsx`) + route-level loadtest (bọc `<Outlet/>` trong `app-shell.tsx`, reset theo `location.pathname`). Fallback: panel centered, `role="alert"`, nút "Tải lại trang" autofocus, **không render `error.message`/stack** (chống PII leak). |
| D-2 | CSP | Meta CSP **chỉ inject vào bản build** qua Vite plugin `transformIndexHtml` (`apply: 'build'`) — `index.html` nguồn **sạch, không meta** → dev không bị Vite preamble/HMR chặn. Prod: `script-src 'self'` (không `unsafe-inline`), `style-src 'self' 'unsafe-inline'` (bắt buộc — recharts/framer-motion/sonner dùng inline style), `connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com`. |
| D-3 | Session notice (T-09 L-6) | Banner `AlertBanner variant="warning"` **dismissible**, hiện khi `expiresAt - now ≤ 30 phút`, đặt trong AppShell phía trên `<main>` (cạnh banner reconnecting sẵn có). **Text tĩnh, không đếm ngược live** (chống spam screen-reader qua `role="alert"`). KHÔNG refresh, KHÔNG chặn hành vi — chỉ thông báo. |
| D-4 | loadPrefs validation (T-09 L-7) | Tách pure function `parseLoadtestPrefs` (module mới `src/store/loadtest-prefs.ts`): sai shape/JSON → **default im lặng** (giữ hành vi hiện tại `loadtest.store.ts:29-37`), **không toast** (store-creation-time ngoài cây React + pref self-controlled). |
| D-5 | Frontend test (T-09) | `vitest.workspace.ts` (2 projects: `loadtest/` node + `src/` jsdom), deps dev mới: `jsdom`, `@testing-library/react` + `@testing-library/dom`, `@testing-library/jest-dom`, `@vitest/coverage-v8`. Test tối thiểu: format helpers, prefs validator, store selectors, env defaults, api unwrap/toApiError, auth-storage, ErrorBoundary. |
| D-6 | A11y/UX regressions | Không regress: reuse `AlertBanner` (role="alert" — `alert-banner.tsx:44`), Radix Dialog focus trap (`dialog.tsx:32`), touch ≥ 44px/48px, token màu có sẵn, không animation mới. Chi tiết Mục 7. |

**Điểm cần chốt với doc khác (xung đột tiềm ẩn)** — xem Mục 8:
1. T-12 `docker/nginx.conf` dự kiến set "CSP header" — nếu **cả** meta CSP (T-08) **và** header CSP cùng tồn tại với giá trị khác nhau → cả 2 cùng áp dụng (intersection), dễ chặn oan. **Chốt: 1 nguồn duy nhất = meta inject ở build**; nginx KHÔNG set CSP (hoặc set đúng y hệt chuỗi — phải comment "giữ đồng bộ").
2. `frame-ancestors` chỉ hoạt động ở **header**, không hoạt động ở meta — nếu cần chống clickjacking, phải đưa vào nginx (mâu thuẫn với chốt #1 → đề xuất bỏ qua cho MVP nội bộ, ghi vào THREAT-MODEL).
3. T-08 viết "CSP trong `index.html` (meta)" — làm rõ: meta chỉ xuất hiện trong **dist/index.html** (build output); source `index.html` giữ sạch để dev chạy.

---

## 1. ErrorBoundary (T-08 / F-9) — `src/components/ErrorBoundary.tsx`

### 1.1 Hiện trạng & vấn đề

- `App.tsx:46-77` — không có boundary nào; 1 lỗi render trong bất kỳ component nào → React unmount toàn cây → **trắng trang** (F-9, `PRD-prod-refactor.md:86`).
- Các "boundary-ish" hiện có chỉ là guard điều hướng (`ProtectedRoute.tsx:10-18`, `require-auth.tsx:22-33`) — không bắt lỗi render, chỉ redirect khi chưa auth.
- Yêu cầu kế thừa: PRD F-9 "Component render lỗi → ErrorBoundary hiện fallback, không trắng trang" + G-6 "không đổi hành vi UI".

### 1.2 Component design

```
src/components/ErrorBoundary.tsx   (class component — bắt buộc, React yêu cầu class cho error boundary)

Props:
  resetKey?: string | number      // đổi giá trị → reset trạng thái lỗi (dùng cho route-level theo pathname)
  homePath?: string               // đường "Về trang chủ" (app-level: routes.chat; loadtest: routes.loadtest)
  onError?: (error: Error, info: { componentStack?: string }) => void   // hook report (console prod-sanitized)

State: { hasError: boolean; error: Error | null }

Render:
  - Bình thường → children.
  - Lỗi → <div role="alert" tabIndex={-1} ref={focusRef} class="min-h-[70vh] flex items-center justify-center p-4">
      <Card class="max-w-md w-full border-destructive/40 bg-destructive/10 text-destructive p-6 space-y-4">
        <h1 class="text-base font-semibold">Đã xảy ra lỗi không mong muốn</h1>
        <p class="text-sm opacity-90">
          Ứng dụng vừa gặp sự cố khi hiển thị trang này. Dữ liệu run được giữ trên server —
          bạn có thể tải lại trang để tiếp tục.
        </p>
        <div class="flex flex-wrap gap-3">
          <Button class="min-h-11" onClick={() => window.location.reload()}>Tải lại trang</Button>
          {homePath && <Button variant="outline" class="min-h-11" onClick={→ navigate(homePath)}>Về trang chủ</Button>}
        </div>
        {import.meta.env.DEV && error && (
          <details class="text-xs opacity-80">
            <summary>Chi tiết kỹ thuật (dev)</summary>
            <pre class="font-mono whitespace-pre-wrap break-all">{error.message}</pre>
          </details>
        )}
      </Card>
    </div>
```

**Quyết định cụ thể:**

1. **Class component** với `static getDerivedStateFromError` + `componentDidCatch` (gọi `onError`). StrictMode (`main.tsx:10`) không ảnh hưởng.
2. **Focus management (WCAG 2.4.3/2.4.7)**: khi `hasError` chuyển `false→true` trong `componentDidUpdate`, gọi `focusRef.current?.focus()`; container có `tabIndex={-1}` để nhận focus. Nút "Tải lại trang" nhận focus đầu tiên (thứ tự DOM: nút default đứng trước).
3. **PII policy — HARD RULE**: fallback **không bao giờ render `error.message` / `error.stack` / componentStack** ở prod. Lý do: `error.message` có thể chứa URL/query/token (vd lỗi từ `ApiError` — `api.ts:24-35`). Prod chỉ log sanitized `{ name, code? }` qua `console.error` (hoặc `onError`). `import.meta.env.DEV` mới hiện message trong `<details>`.
4. **Reset**: `componentDidUpdate(prevProps)` — nếu `resetKey` thay đổi và `hasError` → reset. Route-level truyền `resetKey={location.pathname}` → chuyển trang tự reset (vẫn giữ nguyên reload thủ công).
5. **Fallback tự bảo vệ**: render fallback trong `try/catch`; nếu chính fallback throw → trả `<div>` text tĩnh thuần (không component, không phụ thuộc design system).
6. **Không đụng auth state**: boundary chỉ render fallback, không gọi `logout`/`clearSession`. Auth logout vẫn do luồng 401 hiện có (`api.ts:87-89`, `loadtest-api.ts:62-70`).

### 1.3 Mounting — 2 lớp, không trùng lặp

**Lớp 1 — App-level** (`App.tsx`, bọc trong `<BrowserRouter>` nhưng ngoài `<TooltipProvider/>`):

```
<BrowserRouter>
  <ErrorBoundary homePath={routes.chat}>        // bắt mọi thứ còn lại: AuthGate, guard, router crash
    <TooltipProvider>
      <AuthGate />
      <Routes>…(giữ nguyên cây route hiện tại)…</Routes>
      <Toaster />
    </TooltipProvider>
  </ErrorBoundary>
</BrowserRouter>
```

- Đặt **trong** `BrowserRouter` để fallback dùng được `useNavigate` cho "Về trang chủ" (nếu đặt ngoài, chỉ còn `location.reload`).
- **KHÔNG** `resetKey={pathname}` ở lớp này — crash-loop nguy hiểm (page lỗi → navigate → reset → crash lại vô hạn). Lớp app-level chỉ có reload thủ công.

**Lớp 2 — Route-level loadtest** (`app-shell.tsx`, bọc `<Outlet/>` trong `<main>`):

```
<main class="…">
  <ErrorBoundary resetKey={location.pathname} homePath={routes.loadtest}>
    <Outlet />
  </ErrorBoundary>
</main>
```

- `app-shell.tsx:280-282` là `<main>` chứa `<Outlet/>` — bọc ngay tại đó.
- Lý do route-level cho loadtest: (a) tool là khu vực tự chứa, crash 1 trang không nên nuke toàn app; (b) shell + nav + poll 1s (`app-shell.tsx:241-253`) sống sót → user vẫn nhìn thấy thanh điều hướng, run vẫn được poll; (c) reset theo pathname → user tự thoát bằng điều hướng.
- **Tương tác với guards** (câu hỏi bắt buộc): boundary **bọc NGOÀI** `RequireLoadtestAuth` (lớp 1) và **bọc TRONG** guard (lớp 2 — vì `RequireLoadtestAuth` trả `<Outlet/>` và `<AppShell/>` nằm trong outlet của nó, `App.tsx:59-70`). Hệ quả đúng thiết kế:
  - Guard redirect (`<Navigate to={routes.loadtestLogin}/>`, `require-auth.tsx:30`) trả element null → không bao giờ crash → boundary không bao giờ chặn luồng redirect login. ✅
  - Crash trong `RequireLoadtestAuth`/`AuthGate` → lớp 1 bắt. Crash trong 1 page loadtest → lớp 2 bắt, guard vẫn nguyên. ✅
  - Không có sự "giữ chân" nào: boundary không render UI trong lúc auth đang check (`authReady=false` hiện spinner — giữ nguyên, `require-auth.tsx:22-28`).

**KHÔNG làm**: không tạo boundary riêng cho từng page (`ControlPanelPage`…`RunDetailPage`) — 1 boundary route-level đủ (reset theo pathname), tránh 10 file lặp lại.

### 1.4 A11y của fallback

| Yêu cầu | Cách đáp ứng |
|---|---|
| `role="alert"` | container fallback (aria-live assertive — thông báo ngay khi crash) |
| Focus management | container `tabIndex={-1}` + focus khi mount (Mục 1.2.2); nút reload autofocus |
| Touch target | nút `min-h-11` (44px) theo UI-SPEC §5.1 |
| Contrast | dùng token `--destructive` sẵn có (`index.css:31-36`, ~6.9:1 — UI-SPEC §1.1) |
| Không màu đơn thuần | icon `CircleAlert` + title text — icon+chữ (AlertBanner pattern, `alert-banner.tsx:17-34`) |
| Reduced motion | không animation trong fallback |

---

## 2. CSP + index.html (T-08 / F-10, SEC-4)

### 2.1 Audit `index.html` hiện tại — kết quả: SẠCH, strict CSP khả thi

| Dòng | Nội dung | Ảnh hưởng CSP |
|---|---|---|
| `index.html:8` | `<link rel="icon" … href="/favicon.svg">` | `img-src 'self'` ✅ |
| `index.html:10-11` | `<link rel="preconnect" href="https://fonts.googleapis.com">` + `fonts.gstatic.com` | **preconnect bị CSP `connect-src` quản lý** (Chrome enforce) → phải thêm cả 2 origin vào `connect-src` |
| `index.html:12-15` | `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?…">` | `style-src` phải chứa `https://fonts.googleapis.com` |
| `index.html:18-19` | `<div id="root">` + `<script type="module" src="/src/main.tsx">` | **script duy nhất là external module** → `script-src 'self'` không cần `unsafe-inline`/`unsafe-eval` ở prod ✅ |
| — | **KHÔNG có** inline `<script>`, inline `<style>`, attribute `style=`, inline event handler | kiểm tra trực tiếp toàn file — không tồn tại |

Kết luận: chặn được `script-src 'self'` (không `unsafe-inline`) ở prod — chính là control chính cho threat "XSS → token theft" (SEC-4, Q-4).

### 2.2 CSP prod — bản chính thức (chỉ trong build output)

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com;
img-src 'self' data:;
connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com;
object-src 'none';
base-uri 'self';
form-action 'self'
```

Lý do từng directive (khác/đúng với bản nháp T-08):

1. **`script-src 'self'`** — bỏ `'unsafe-inline'` ở prod (Vite build output là external module scripts; React prod build + socket.io-client + zustand không dùng eval). Đây là điểm mạnh nhất của CSP.
2. **`style-src 'self' 'unsafe-inline'`** — **BẮT BUỘC giữ `'unsafe-inline'`**: recharts (`package.json:40` — chart theo UI-SPEC §1/§4), framer-motion (`package.json:33`), sonner toast (`package.json:42`) đều set `element.style.*` = inline style attribute, thuộc phạm vi `style-src` chứ không phải `script-src`. Không thể bỏ — đây là giới hạn chấp nhận được (style injection rủi ro thấp hơn script).
3. **`connect-src 'self' ws: wss:`** — socket.io chat kết nối `env.gatewayUrl` (`socket.ts:84-94`) — dev `http://localhost:3000`, prod `wss://…` → `ws:/wss:` wildcard phủ. Vite proxy `/api/loadtest` là same-origin → `'self'` phủ. **Deploy note**: nếu prod deploy gateway ở origin riêng, phải thêm origin đó vào `connect-src`.
4. **`connect-src` thêm CẢ `fonts.googleapis.com` + `fonts.gstatic.com`** — bản nháp T-08 chỉ có googleapis; thiếu gstatic sẽ chặn `preconnect` (`index.html:11`) — **đã sửa**.
5. **`img-src 'self' data:`** — favicon + avatar data-URI (không có `blob:` — report export dùng `URL.createObjectURL` cho download (`loadtest-api.ts:170-177`), không phải `<img>`).
6. **`object-src 'none'; base-uri 'self'; form-action 'self'`** — best-practice; không ảnh hưởng app.
7. **KHÔNG có `frame-ancestors`** — directive này **không hoạt động trong meta tag** (chỉ header). Xem Mục 8 #2.
8. **KHÔNG có `upgrade-insecure-requests`** — sẽ chặn http local dev; để nginx/ingress lo.

### 2.3 Dev/prod split — cách Vite dev không bị chặn

**Vấn đề**: `@vitejs/plugin-react` (v4, `vite.config.ts:6`) inject **inline module script preamble** react-refresh vào HTML dev server. Nếu source `index.html` chứa meta CSP với `script-src 'self'` → dev **chết ngay**: preamble bị chặn, HMR hỏng, app không render. (`PLAN-prod-refactor.md:186, 484` — R-7.)

**Giải pháp (chốt): meta CSP chỉ tồn tại trong build output.**

1. `index.html` **nguồn giữ nguyên KHÔNG có CSP meta** (file hiện tại đã sạch — giữ nguyên, không sửa gì).
2. `vite.config.ts` thêm 1 plugin inline ~15 dòng:

```ts
// vite.config.ts — inject CSP meta chỉ khi BUILD (apply: 'build')
const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'";

function injectCspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP }, injectTo: 'head-prepend' }],
      };
    },
  };
}
```

3. Kết quả:
   - `npm run dev` → không meta CSP → preamble react-refresh + HMR ws (`ws://localhost:5173`) + proxy đều chạy bình thường. **Zero thay đổi dev experience.**
   - `npm run build` → `dist/index.html` chứa meta CSP strict. `vite preview` cũng phục vụ bản strict.
   - **Verify thủ công (T-08 AC)**: `grep Content-Security-Policy dist/index.html` có mặt; `npm run dev` mở console không có lỗi CSP; load font Google + socket.io + chart OK.

4. **Phương án thay thế (KHÔNG khuyến nghị — ghi để biết)**: nếu đội muốn CSP ngay cả trong dev, đặt meta trong source `index.html` với bản dev nới lỏng: `script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173 ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com` — nhưng rủi ro drift 2 chuỗi + dev/prod khác nhau trên cùng 1 file. Chốt: không làm.

### 2.4 Phối hợp T-12 (nginx) — TRÁNH DOUBLE-CSP

Nếu nginx.conf (T-12) set header CSP **khác** meta CSP → cả 2 cùng enforce (intersection) → dễ chặn oan (vd nginx thiếu `fonts.gstatic.com` trong connect-src → preconnect bị chặn). Chốt:
- **Canonical = meta inject ở build** (đã có sẵn trong tệp HTML, sống với mọi static host, dễ test bằng `vite preview`).
- nginx.conf **KHÔNG set header CSP** (hoặc nếu bắt buộc set, phải set **đúng y hệt** chuỗi trên + comment "GIỮ ĐỒNG BỘ với PROD_CSP trong vite.config.ts"). Đây là thay đổi so với wording T-12 "nginx.conf (CSP header…)" — cần chốt ở GATE review.

---

## 3. Session expiry notice (T-09 / L-6) — delta UX tối thiểu

### 3.1 Bối cảnh

- Server: `SESSION_TTL_MS = 12h` (`loadtest/auth.ts:15`) — **không refresh token** (PRD A2, MVP).
- Client: `loadtest-auth.store.ts:15, 42-47` — `expiresAt` lưu trong store; hết hạn → `initialize` xoá session; giữa chừng hết hạn → request 401 → `onLoadtestAuthFailure` → `clearSession` (`loadtest-auth.store.ts:94-95`) → guard redirect login.
- L-6 (`PRD-prod-refactor.md:99`): "thiếu thông báo 'phiên sắp hết hạn'… Chấp nhận cho MVP nhưng cần documented" — plan T-09: "nếu trống) thông báo 'phiên sắp hết hạn' trên dashboard — **không thêm refresh server-side**".
- **Ràng buộc thiết kế**: additive, không đổi hành vi (không refresh, không chặn, không đếm ngược chặn tương tác).

### 3.2 Thiết kế

**Nguồn dữ liệu**: `useLoadtestAuthStore((s) => s.expiresAt)` — **không hardcode 12h** ở client (tránh lệch với server; `expiresAt` là sự thật duy nhất). Khi `expiresAt` = `0`/null (session không có expiry hợp lệ — `loadtest-auth-storage.ts:25`) → không hiện banner.

**Logic (pure, testable — module mới `src/lib/loadtest-session.ts`):**

```ts
export const SESSION_WARN_BEFORE_MS = 30 * 60 * 1000; // cảnh báo trước 30 phút
export function sessionRemainingMs(expiresAt: number, now = Date.now()): number {
  return expiresAt - now;
}
export function shouldWarnSession(expiresAt: number | null, now = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  const rem = sessionRemainingMs(expiresAt, now);
  return rem > 0 && rem <= SESSION_WARN_BEFORE_MS;
}
```

**Hook `useSessionExpiryNotice()`** (`src/components/loadtest/session-expiry-banner.tsx`):
- Subscribe `expiresAt`; `setInterval` 60s (dừng khi unmount) để re-check — `expiresAt` từ `authMe` (`loadtest-auth.store.ts:49-51`) không thay đổi khi verify, nhưng thời gian trôi nên cần tick.
- Trả `{ visible, remainingMin }`; `visible = shouldWarnSession(expiresAt)`.

**Component `SessionExpiryBanner`** — render trong `app-shell.tsx`, **ngay trên `<main>` cạnh banner reconnecting sẵn có** (`app-shell.tsx:273-279` — cùng slot `px-4 pt-3`, xếp chồng):

```
<AlertBanner
  variant="warning"
  title="Phiên đăng nhập sắp hết hạn"
  description="Phiên loadtest hết hạn sau 12 giờ kể từ khi đăng nhập. Hãy lưu dữ liệu cần thiết — sau khi hết hạn bạn phải đăng nhập lại."
  dismissible
  onDismiss={...}
/>
```

**Quyết định chi tiết:**

1. **Ngưỡng 30 phút** — 12h session, cảnh báo sớm 30 phút vừa đủ để kịp lưu report/export (`loadtest-api.ts:165-178`) mà không thành tiếng ồn thường trực.
2. **Text tĩnh, KHÔNG đếm ngược live** — chủ ý: `AlertBanner` có `role="alert"` (`alert-banner.tsx:44`) = live region assertive; nếu render số phút thay đổi mỗi 60s bên trong → screen reader **re-announce cả banner mỗi phút** (spam 30 lần). Chốt: không nhúng số động; nếu muốn hiện số, đặt ngoài vùng `role="alert"` (ví dụ con số bên trong description là **static snapshot tại thời điểm hiện banner** — nhưng đơn giản nhất là không số). Đây là quyết định a11y có chủ đích (bổ sung vào UI-SPEC §5.3.5).
3. **Dismissal**: dismiss per **tab session** (`useState` trong component) — **KHÔNG persist** vào `loadtest.prefs` (hết hạn là logout, persist vô nghĩa; và tránh phình schema prefs). Mỗi lần mở lại tab → banner hiện lại nếu còn trong cửa sổ 30 phút.
4. **KHÔNG refresh, KHÔNG chặn**: khi hết hạn thật sự, luồng 401 hiện có tự xử lý (`loadtest-api.ts:62-70` → `clearSession` → redirect login). Banner chỉ thông báo. **Không** thêm nút "Gia hạn" — không có refresh server-side (constraint).
5. **Chỉ hiện khi đã đăng nhập**: banner nằm trong `AppShell` (sau guard `RequireLoadtestAuth`, `App.tsx:59`) → login/register page không bao giờ thấy banner. ✅
6. **Không đổi UI-SPEC**: banner nằm ngoài 7 wireframe màn; các màn giữ nguyên bố cục (banner là overlay additive dismissible).

---

## 4. loadPrefs schema validation (T-09 / L-7)

### 4.1 Hiện trạng & failure modes

`loadtest.store.ts:29-37`:

```ts
function loadPrefs(): LoadtestPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { requireEnvConfirm: true, ...(JSON.parse(raw) as Partial<LoadtestPrefs>) };
  } catch { /* ignore */ }
  return { requireEnvConfirm: true };
}
```

| Input `localStorage["loadtest.prefs"]` | Hành vi hiện tại | Vấn đề |
|---|---|---|
| `'{"requireEnvConfirm": false}'` | `false` ✅ | đúng |
| `'{"requireEnvConfirm": "false"}'` (string) | `"false"` truthy → **confirm dialog LUÔN hiện** | lệch hành vi — người dùng tắt "bắt buộc xác nhận" ở Settings (`SettingsPage` Switch) nhưng vẫn bị hỏi |
| `'{"requireEnvConfirm": null}'` | `null` falsy → dialog không hiện | lệch — tắt confirm ngoài ý muốn |
| `'{"requireEnvConfirm": 1}'` | `1` truthy | lệch |
| `'"nonsense"'` (JSON string) | spread no-op → default | vô hại |
| JSON hỏng | catch → default | ✅ đúng |

→ Chỉ cần **shape check boolean**, fallback default im lặng (giữ nguyên triết lý hiện tại: catch → default, `loadtest.store.ts:33-36`).

### 4.2 Thiết kế — pure function, KHÔNG toast

**Module mới `src/store/loadtest-prefs.ts`** (tách khỏi store để test không import zustand/axios chain):

```ts
export interface LoadtestPrefs { requireEnvConfirm: boolean }
export const DEFAULT_PREFS: LoadtestPrefs = { requireEnvConfirm: true };
export const PREFS_KEY = 'loadtest.prefs';

/** Parse + validate shape — sai shape/JSON → default (im lặng, giữ hành vi hiện tại). */
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
export function savePrefs(p: LoadtestPrefs): void { /* giữ nguyên try/catch hiện tại (loadtest.store.ts:39-45) */ }
```

**Thay đổi tại `loadtest.store.ts`**: xoá `loadPrefs/savePrefs/PREFS_KEY` local (`:27-45`), import từ module mới. `requireEnvConfirm: loadPrefs().requireEnvConfirm` (`:103`) và `setRequireEnvConfirm` (`:104-107`) giữ nguyên gọi.

**Quyết định "silent default, không toast"** — lý do:
1. `loadPrefs()` được gọi **tại store creation** (`loadtest.store.ts:103`), ngoài cây React — toast sonner cần component context (`sonner.tsx`), import vào store tạo cycle nguy hiểm.
2. Pref self-controlled nội bộ (L-7 ghi rõ "ok vì self-controlled") — lỗi chỉ do localStorage bị sửa tay/cũ; toast mỗi lần load là tiếng ồn, không có hành động nào user cần làm (default `requireEnvConfirm: true` là an toàn nhất — confirm vẫn bật).
3. G-6 "không đổi hành vi" — hành vi hiện tại đã là silent fallback; chỉ sửa để fallback **đúng kiểu boolean** thay vì truthy lỏng lẻo.

---

## 5. Frontend test setup (T-09 / F-11, L-5, T-2)

### 5.1 Cấu hình — vitest workspace (2 projects)

**Vấn đề**: `loadtest/vitest.config.ts:6-8` chỉ include `loadtest/__tests__/**` + `environment: 'node'`. Frontend test cần **jsdom**; server test cần **node** (pg, http server). Một config không thể phủ cả 2 đúng cách. T-09 AC: "`npm run test` chạy cả loadtest + frontend tests, xanh".

**Giải pháp (chốt): `vitest.workspace.ts` ở root** (vitest 2.1.8 hỗ trợ — `package.json:59`):

```ts
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';
export default defineWorkspace([
  './loadtest/vitest.config.ts',  // project 1: node env — KHÔNG đổi file này
  './vitest.config.ts',           // project 2: frontend src — jsdom
]);
```

**`vitest.config.ts` (root, mới — KHÔNG đụng `loadtest/vitest.config.ts`):**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    globals: false,            // test import { describe, it, expect } từ 'vitest' tường minh — đúng style loadtest
    coverage: {
      provider: 'v8',
      include: ['src/lib/loadtest-format.ts', 'src/store/loadtest.store.ts'],  // G-1 W3: ≥70% format helpers + selectors
    },
  },
});
```

**`src/test/setup.ts` (mới)** — polyfill jsdom thiếu (Radix/recharts dùng khi mount component):

```ts
import '@testing-library/jest-dom/vitest';
// jsdom chưa có: matchMedia, ResizeObserver, scrollIntoView — stub tối thiểu (chỉ khi test component)
```

**package.json scripts + devDeps:**

```jsonc
"scripts": {
  "test": "vitest run",                    // workspace: loadtest + frontend (T-09 AC)
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
"devDependencies": { /* thêm (đều là devDep — zero-dep runtime giữ nguyên) */
  "jsdom": "^25",
  "@testing-library/react": "^16",
  "@testing-library/dom": "^10",
  "@testing-library/jest-dom": "^6",
  "@vitest/coverage-v8": "^2.1.8"
}
```

**Fallback nếu workspace có vấn đề version**: `"test": "vitest run --config loadtest/vitest.config.ts && vitest run --config vitest.config.ts"` (chain tuần tự) — kết quả tương đương, CI không đổi (`loadtest:test` giữ nguyên script cũ).

**Lưu ý tsconfig**: test file nằm trong `src/` (`tsconfig.json:24` include `src`) → `npm run typecheck` tự kiểm tra test; không cần sửa tsconfig (test dùng import tường minh, không globals).

### 5.2 Danh sách test tối thiểu (map T-09 file:line)

| # | File test | Mục tiêu | Dẫn chứng code |
|---|---|---|---|
| 1 | `src/lib/loadtest-format.test.ts` | `fmtNum`, `fmtCompact`, `fmtMs`, `fmtClock`, `fmtTickTime`, `fmtDateTime`, `fmtRange` — giá trị thường + edge (NaN, âm, 0, ≥1000) | `loadtest-format.ts:6-64` |
| 2 | `src/store/loadtest-prefs.test.ts` | `parseLoadtestPrefs`: valid boolean, string `"false"`/`null`/`1`, JSON hỏng, JSON không object, null raw → **default**; `loadPrefs` với localStorage mock | module mới (Mục 4.2) |
| 3 | `src/store/loadtest.store.test.ts` | `selectTicks` trả `state.ticks`; `RING_CAPACITY=3600`; `DEFAULT_PROFILE`; `setRequireEnvConfirm` roundtrip qua localStorage (jsdom) | `loadtest.store.ts:20-21, 100-107, 215-218` |
| 4 | `src/lib/env.test.ts` | Defaults khi `import.meta.env` trống: `vi.stubEnv` + `vi.resetModules()` + dynamic `import('@/lib/env')` → `gatewayUrl=http://localhost:3000`, `refreshEndpoint=/auth/refresh-token` (regression F-6), routes map | `env.ts:6-45` |
| 5 | `src/lib/api.test.ts` | `toApiError`: response/network/CLIENT; `unwrap`: có envelope (lấy `.data`) / không envelope; **contract refresh**: `env.refreshEndpoint === '/auth/refresh-token'` + `doRefresh` gửi `{ refreshToken }` (mock axios — regression F-6, G-3) | `api.ts:24-35, 57-72, 94-123` |
| 6 | `src/lib/loadtest-api.test.ts` | `toApiError` (statusCode/message/errors/warnings, default message port 3401) | `loadtest-api.ts:29-45` |
| 7 | `src/lib/loadtest-auth-storage.test.ts` | `load`: valid/không key/JSON hỏng/token không string → null; `save`/`clear` roundtrip; expiresAt default 0 | `loadtest-auth-storage.ts:16-46` |
| 8 | `src/lib/loadtest-session.test.ts` | `shouldWarnSession`: null/0/expired/trong cửa sổ 30p/ngoài cửa sổ; `sessionRemainingMs` | module mới (Mục 3.2) |
| 9 | `src/store/auth.store.test.ts` | `hydrate`: không token / token hết hạn (`decodeJwt` mock) / token hợp lệ; `login` success/fail với `vi.mock('@/lib/api')` | `auth.store.ts:23-86` (đã sạch debug log — T-08) |
| 10 | `src/store/loadtest-auth.store.test.ts` | `initialize`: không session / hết hạn (clear) / hợp lệ + `authMe` mock; `clearSession` | `loadtest-auth.store.ts:34-55, 87-91` |
| 11 | `src/components/ErrorBoundary.test.tsx` | Render child bình thường; child throw → fallback xuất hiện (role=alert, nút "Tải lại trang"); resetKey đổi → reset | component mới (Mục 1) |

**KHÔNG test (giữ tối thiểu)**: chart component (recharts + ResizeObserver — phức tạp, không thuộc G-1 W3), socket (`src/lib/socket.ts` — cần mock io, đã có loadtest E2E phủ), `loadtest-api` full (axios real — contract test server đã phủ T-11).

**Coverage gate (G-1/W3)**: `test:coverage` chỉ đếm `loadtest-format.ts` + `loadtest.store.ts` (2 file theo PRD §8 G-1 "format helpers, store selectors") — không mở rộng để tránh ngưỡng ảo kéo thêm test ngoài scope.

---

## 6. Session notice + prefs — file map

| File | Trạng thái | Nội dung |
|---|---|---|
| `src/components/ErrorBoundary.tsx` | **mới** | Mục 1.2 |
| `src/App.tsx` | sửa | bọc `<Routes/>` bằng `<ErrorBoundary homePath={routes.chat}>` (`:51-73`) |
| `src/components/loadtest/app-shell.tsx` | sửa | bọc `<Outlet/>` (`:280-282`) bằng `<ErrorBoundary resetKey={location.pathname} homePath={routes.loadtest}>`; thêm `<SessionExpiryBanner/>` trên `<main>` (`:273-279` slot) |
| `src/components/loadtest/session-expiry-banner.tsx` | **mới** | Mục 3.2 |
| `src/lib/loadtest-session.ts` | **mới** | pure logic Mục 3.2 |
| `src/store/loadtest-prefs.ts` | **mới** | Mục 4.2 |
| `src/store/loadtest.store.ts` | sửa | xoá `loadPrefs/savePrefs/PREFS_KEY` (`:27-45`) → import từ `loadtest-prefs.ts` |
| `vite.config.ts` | sửa | plugin `injectCspMeta` (`apply: 'build'`) Mục 2.3 |
| `index.html` | **KHÔNG sửa** | giữ sạch — CSP chỉ trong build output |
| `vitest.workspace.ts` | **mới** | Mục 5.1 |
| `vitest.config.ts` (root) | **mới** | Mục 5.1 |
| `src/test/setup.ts` | **mới** | Mục 5.1 |
| `package.json` | sửa | scripts `test/test:watch/test:coverage` + 5 devDeps (Mục 5.1) |
| `docker/nginx.conf` (T-12) | sửa | **KHÔNG** set CSP header (tránh double-CSP) — hoặc set y hệt + comment đồng bộ (Mục 2.4) |

---

## 7. Accessibility / UX regression checklist (cross-cutting)

Mục này liệt kê **những gì T-08/T-09 PHẢI GIỮ NGUYÊN** — không làm hỏng trong lúc thêm delta:

| # | Điểm a11y/UX | Hiện trạng (dẫn chứng) | Ràng buộc khi thêm delta |
|---|---|---|---|
| 1 | Banner = `role="alert"` | `AlertBanner` có sẵn `role="alert"` (`alert-banner.tsx:44`); banner reconnecting đã dùng (`app-shell.tsx:275`) | Session banner + ErrorBoundary fallback **bắt buộc reuse AlertBanner/pattern** — không tự dựng div khác |
| 2 | Dialog focus trap | Radix Dialog focus trap (`dialog.tsx:32` `DialogPrimitive.Content`); `StopRunConfirmDialog` role=alertdialog + countdown 5s (UI-SPEC §5.2, `confirm-dialogs.tsx`) | Không đổi; boundary không render bên trong dialog; không bọc dialog bằng boundary route-level (dialog nằm trong page → đã được bọc tự nhiên) |
| 3 | Touch target | CTA thumb-zone 48px `min-h-12`, icon nút 44px `h-11 w-11` (UI-SPEC §5.1; `app-shell.tsx:96`) | Nút fallback `min-h-11`; session banner dismiss nút X ≥ 32px như `alert-banner.tsx:68` (giữ nguyên component) |
| 4 | Contrast ≥ 4.5:1 | token `--warning` ~10.5:1, `--destructive` ~6.9:1 trên nền tối (UI-SPEC §1.1; `index.css:31-36`) | **KHÔNG thêm màu mới** — chỉ dùng token có sẵn |
| 5 | Không màu đơn thuần | gauge có text trạng thái, P-series dash pattern, step có icon+text (UI-SPEC §5.3.6) | Session banner: icon `TriangleAlert` + title/description chữ; fallback: icon + chữ |
| 6 | focus-visible ring | chuẩn `focus-visible:ring-2 ring-ring ring-offset-2` (UI-SPEC §5.3.3) | Nút fallback dùng `Button` sẵn có (đã có ring) |
| 7 | Live region discipline | KPI `aria-live="off"`; chỉ `role="alert"` khi phase/bottleneck/auto-stop (UI-SPEC §5.3.5) | **Session banner: text tĩnh, không đếm ngược trong vùng alert** (Mục 3.2.2) — nếu cần số phút, đặt ngoài `role="alert"` |
| 8 | prefers-reduced-motion | LIVE badge pulse gated; cấm animation chart (UI-SPEC §1/§4.8) | Delta không thêm animation; banner/fallback tĩnh |
| 9 | aria-label icon buttons | pause/stop/log/eye/xóa URL đều có aria-label (UI-SPEC §5.3.4) | Nút mới nào cũng có aria-label (vd dismiss của AlertBanner đã có "Đóng cảnh báo" — `alert-banner.tsx:67`) |
| 10 | Form label/aria-describedby | mọi Input có Label liên kết + error text (UI-SPEC §5.3.9) | Không đụng form; prefs validation không đổi form Settings |
| 11 | Không toast cho lỗi ảnh hưởng run | UI-SPEC §5.3.2: lỗi ảnh hưởng run phải banner dính, không toast thoáng qua | ErrorBoundary fallback là banner dính (không toast); prefs invalid là silent default (không phải lỗi run) |
| 12 | Layout màn không đổi | 7 wireframe + desktop grid (UI-SPEC §3) | Session banner là overlay additive dismissible phía trên content; ErrorBoundary chỉ render khi crash — không đổi layout lúc bình thường |
| 13 | Điều hướng/URL không đổi | routes giữ nguyên (`env.ts:31-45`) | Boundary không thêm route, không redirect; CSP không chặn `navigate` (history API) |
| 14 | Render perf dashboard | `React.memo` + selector slice + cấm subscribe toàn store (UI-SPEC §4.8) | Session hook subscribe đúng 1 field `expiresAt` (slice selector) — không gây re-render tick 1s |
| 15 | Data binding không đổi | store slices, poll 1s, ring buffer (UI-SPEC §4.1) | Delta chỉ đọc `expiresAt` + localStorage prefs — không thêm action vào store |

---

## 8. Xung đột / điểm cần chốt với doc khác (cho design council review)

| # | Vấn đề | Doc nguồn | Đề xuất của design này | Mức |
|---|---|---|---|---|
| 1 | **Double-CSP**: T-12 nginx set "CSP header" + T-08 meta CSP → intersection, dễ chặn oan (vd nginx thiếu `fonts.gstatic.com` trong connect-src sẽ chặn preconnect `index.html:11`) | `PLAN-prod-refactor.md:186, 252` | **1 nguồn duy nhất = meta CSP ở build output** (Mục 2.4); nginx không set CSP; nếu bắt buộc → set y hệt chuỗi + comment giữ đồng bộ | 🔴 cần chốt với T-12 |
| 2 | `frame-ancestors` không hoạt động trong meta CSP (chỉ header) — T-12 muốn chống clickjacking qua header; mâu thuẫn #1 | PRD §5.1 / T-12 | Bỏ qua MVP (tool nội bộ, Bearer auth, `base-uri 'self'`), ghi limitation vào `docs/THREAT-MODEL.md` (T-12) | 🟠 |
| 3 | T-08 wording "CSP trong `index.html` (meta)" — nếu hiểu là sửa source `index.html` sẽ làm chết Vite dev (react-refresh inline preamble, R-7) | `PLAN-prod-refactor.md:186, 484` | Làm rõ: meta **chỉ trong `dist/index.html`** qua plugin `apply:'build'`; source index.html sạch (Mục 2.3) | 🟠 |
| 4 | UI-SPEC không có "session expiry notice" / "error boundary" — đây là UI mới ngoài 7 wireframe | `UI-SPEC-loadtest-tool.md` | Đúng phạm vi PRD L-6/F-9; additive + dismissible + không đổi hành vi; đã align đúng AlertBanner/design system — **không mâu thuẫn nội dung UI-SPEC**, chỉ mở rộng | 🟢 |
| 5 | `npm run test` mới (workspace) có thể ảnh hưởng `loadtest:test` cũ | T-09 AC "test chạy cả 2" | `loadtest:test` giữ nguyên script/config; workspace chỉ phủ `vitest run` mặc định; CI (T-10) dùng cả 2 script rõ ràng | 🟢 |
| 6 | `@vitest/coverage-v8` + jsdom + testing-library = 5 devDeps mới — vi phạm "không thêm dependency"? | PLAN §1.3 (zero-dep **runtime**) | Tất cả là **devDependencies** — đúng ngoại lệ plan (PRD §5.6 cho phép @testing-library/react) | 🟢 |

---

## 9. Acceptance checklist (map T-08/T-09)

- [ ] `src/components/ErrorBoundary.tsx` tồn tại; component throw → fallback hiện (role=alert, nút "Tải lại trang" autofocus), **không** render `error.message` ở prod; không trắng trang (F-9, T-08 AC).
- [ ] Redirect login khi chưa auth vẫn hoạt động bình thường (boundary không chặn guard — `require-auth.tsx:30`).
- [ ] `npm run build` → `dist/index.html` chứa meta CSP; `grep -c "Content-Security-Policy" dist/index.html` = 1; `npm run dev` không có lỗi CSP console (font, ws, HMR, proxy).
- [ ] Session banner hiện khi ≤ 30 phút còn lại (mock `expiresAt`), dismissible, không refresh; hết hạn → vẫn logout qua 401 như cũ.
- [ ] `loadPrefs` với `'{"requireEnvConfirm":"false"}'` → `false` mặc định đúng kiểu (không còn truthy-string); JSON hỏng → default im lặng.
- [ ] `npm run test` xanh (workspace: loadtest + frontend); `npm run test:coverage` ≥ 70% cho `loadtest-format.ts` + `loadtest.store.ts` (G-1 W3).
- [ ] Không diff nào đổi route/URL/layout dashboard; G-6 review xác nhận không đổi hành vi UI.

---

## Phụ lục — Chỉ dẫn triển khai tóm tắt (cho Frontend Developer, T-08/T-09)

Thứ tự đề xuất: (1) `loadtest-prefs.ts` + test → (2) `loadtest-session.ts` + `session-expiry-banner.tsx` + mount AppShell → (3) `ErrorBoundary.tsx` + 2 lớp mount → (4) vite CSP plugin + verify build/dev → (5) vitest workspace + setup + các test còn lại → (6) phối hợp T-12 về nginx/double-CSP + THREAT-MODEL ghi nhận limitation `frame-ancestors`.

---

## Cross-refutation by UX/UI Designer (2026-08-04)

> Vòng phản biện chéo của design council. Đối chiếu thiết kế Backend + Security với đúng code frontend hiện tại; mọi `file:line` đã mở và đọc trực tiếp. Verdict: **CONFIRMED** = khẳng định lỗi/thiếu thật; **REFUTED** = lo ngại bị bác bằng code; **PLAUSIBLE** = đúng một phần / phụ thuộc cấu hình.

### Bảng findings

| # | Mức | Target | Claim / lo ngại | Verdict | Bằng chứng code | Fix cụ thể |
|---|---|---|---|---|---|---|
| F-1 | ⚠️ Minor | Backend | Đổi envelope (thêm `timestamp` + `error` code) làm vỡ `ApiError`/`unwrap` | **REFUTED** — an toàn | `loadtest-api.ts:36-45` (`toApiError` chỉ đọc `statusCode/message/errors/warnings`); `loadtest-api.ts:73-77` (`unwrap` trả `obj.data` khi `'data' in obj` — success vẫn giữ `data`); `api.ts:94-115` (chat client đọc `statusCode/error/message/traceId` — thêm field không đổi) | Không cần sửa UI. Chỉ giữ đúng 2 field bắt buộc: `statusCode` + `message` (frontend fallback khi thiếu ra `status` HTTP / text mặc định). |
| F-2 | ⚠️ Minor | Backend | `readBody` 400 `INVALID_JSON` — UI có hiện raw envelope? | **REFUTED** — không chạm UI | axios luôn gửi JSON hợp lệ (`start`/`stop`/`saveAllowlist`/`cleanup` đều body object); 400 chỉ tới từ curl bên ngoài. Không có đường nào trong UI sinh malformed JSON | Không cần sửa. Ghi chú: nếu sau này thêm form gửi raw text → mới cần xử lý. |
| F-3 | 🟠 Major | Backend | Thêm rate-limit (`/start` 1/10s, login/register 5 fail/60s) — UI có nuốt 429 im lặng? | **PLAUSIBLE** — start/login hiện lỗi đúng nhưng **không có retry-after/countdown**; header sticky **stop im lặng** | `ControlPanelPage.tsx:134-139` (start → banner + toast, có message 429); `LoginPage.tsx:46,98` (banner); `app-shell.tsx:43-47` (sticky stop → `console.warn` DUY NHẤT, không toast); `loadtest-api.ts:36-45` — `retryAfterSec` bị bỏ qua, nút `BẮT ĐẦU` re-enable ngay → user spam 429 | T-09 thêm: (a) `toApiError` giữ `retryAfterSec`; (b) ControlPanel 429 → disable nút + "Thử lại sau Ns" (đếm từ `Retry-After`); (c) sticky header stop lỗi → toast như `ControlPanelPage` (2 nút stop hiện hành vi lệch nhau). |
| F-4 | ⚠️ Minor | Backend | Tách route thành modules làm đổi path → vỡ `loadtest-api.ts` | **REFUTED** — path khớp | Toàn bộ path frontend gọi (`/auth/*`, `/runs*`, `/metrics`, `/start`, `/stop`, `/kill`, `/report/export`, `/allowlist`, `/pools`, `/cleanup`, `/health`) nằm trong route table backend giữ nguyên; tool-metrics mới ở `/metrics` NGOÀI prefix → không đụng `/api/loadtest/metrics` tick-history | Không cần sửa. Sửa doc: Backend §5.1 "Nằm ngoài prefix loadtest **như /health**" — sai vì `/health` ĐANG ở `/api/loadtest/health` (`api-server.ts:141`). |
| F-5 | ⚠️ Minor | Backend | Health đổi shape → frontend đọc `{status:'ok'}` vỡ | **REFUTED** — không ai đọc | `loadtest-api.ts:120-123` định nghĩa `health()` nhưng **grep toàn `src/` = 0 call site**; thêm `db/redis/workers/version/uptime` là additive, `status` vẫn còn | Không cần sửa. Lưu ý Docker healthcheck (`/api/loadtest/health`) sẽ đổi ngữ nghĩa: `status:'degraded'` khi DB down — đúng ý định US-OBS-1 nhưng healthcheck cần chấp nhận `degraded` nếu muốn container sống. |
| F-6 | ⚠️ Minor | Backend | History route trả 503 (DB fail) thay vì `[]` — UI vỡ? | **REFUTED** — đã có UI lỗi | `HistoryPage.tsx:44-46,114-121` (catch → `toApiError(e).message` → AlertBanner + nút "Thử lại"); `RunDetailPage`/`CleanupPage` cùng pattern | Không cần sửa. Đây là cải thiện UX (bỏ "no rows" giả gây hiểu nhầm). |
| F-7 | 🟠 Major | Security | Register gate (403) — RegisterPage crash hay hiện lỗi? | **PLAUSIBLE** — không crash, hiện message rõ; nhưng **cổng đăng ký là dead-end** trong config mặc định | `RegisterPage.tsx:57,138` (`setError(res.error)` → `AlertBanner` destructive, message server "Đăng ký đã bị tắt..."); `LoginPage.tsx:110-113` luôn hiện CTA "Chưa có tài khoản? Đăng ký" → user bấm vào form 403 mãi; cộng thêm Backend §10.4: **403 REGISTER_DISABLED tính là 1 fail** của fail-window → 5 lần thử = 429 | Security/Backend nên chốt: khi `LOADTEST_ALLOW_REGISTER=false`, UI nên ẩn route `/loadtest/register` + CTA Login (hoặc hiện notice "Đăng ký đã tắt — set `LOADTEST_ALLOW_REGISTER=true` trong `loadtest/.env`"). Đơn giản nhất: frontend đọc `config`/env không có cờ → dùng 403 message hiện tại là đủ, nhưng ẩn CTA là bắt buộc để tránh dead-end. |
| F-8 | 🟠 Major | Security | "retryAfterSec để frontend render countdown" — hiện tại UI có làm không? | **CONFIRMED** — thiếu hoàn toàn | Security §4.2 giả định frontend render countdown; nhưng `toApiError` (`loadtest-api.ts:36-45`) **bỏ `retryAfterSec`**, không design nào (cả UI T-09 lẫn Backend) thêm UX 429: nút start re-enable ngay, không disable, không countdown | Thêm vào T-09 (đã ghi F-3). Security nên ghi rõ field `retryAfterSec` là **contract bắt buộc** trong envelope 429 (không phải "để frontend render" kiểu gợi ý). |
| F-9 | ⚠️ Minor | Security | CORS allowlist chặn port khác (5174 vs 5173) → API fail im lặng, cần UX? | **REFUTED** cho luồng proxy chuẩn; **PLAUSIBLE** cho cross-origin trực tiếp | Vite proxy (`vite.config.ts:15-21`) = same-origin → browser **không enforce CORS** (không preflight vì cùng origin, dù `Authorization` header), nên dashboard chạy đúng trên mọi port; allowlist chỉ chặn truy cập cross-origin trực tiếp (bỏ qua proxy). Khi bị chặn thật, `toApiError` trả default `"Không kết nối được đến loadtest server (port 3401)"` (`loadtest-api.ts:41`) — **message gây hiểu nhầm** (không phải server down) | Minor: T-09 thêm phân biệt network/CORS trong `toApiError` (khi `error.response === undefined` và có `Origin`) → hiện "CORS/network — kiểm tra `LOADTEST_CORS_ORIGIN`". Không cần banner config riêng. |
| F-10 | ⚠️ Minor | Security | Validate runId format + AES pool password — đổi hành vi user-visible? | **REFUTED** — không đổi UX | Frontend chỉ hiển thị runId (`HistoryPage.tsx:165`) + `encodeURIComponent` (`loadtest-api.ts:104,108,112,116`); runId mới `lt…` vẫn lowercase alnum → regex `/^[a-z0-9-]{1,64}$/i` không chặn; AES deferred v1.1 — không đổi UI | Không cần sửa. Ghi chú: T-11 nên test regex mới với runId thật chứa `pidPart`. |
| F-11 | 🟠 Major | Security ↔ UI | **Xung đột CSP 2 nguồn**: Security §5.2 "nginx `add_header` **VÀ** meta (belt-and-suspenders)" vs UI §2.4 "1 nguồn duy nhất = meta, nginx KHÔNG set". Chuỗi CSP cũng khác nhau (Security có `frame-ancestors 'none'`, thiếu font origins trong `connect-src`) | **CONFIRMED** — 2 design mâu thuẫn nhau | Security §5.2 CSP `connect-src 'self' ws: wss:` (thiếu `fonts.googleapis.com/gstatic.com`); UI §2.2 CSP `connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com`. Nếu ship cả 2 → **intersection** = bản Security → `<link rel="preconnect" href="https://fonts.googleapis.com">` (`index.html:10-11`) bị chặn (preconnect thuộc `connect-src`) → warning console + font chậm | Council chốt 1 nguồn. UI đề xuất: meta inject ở build (UI §2.3) là canonical; nếu giữ nginx header thì phải copy **đúng y hệt** chuỗi UI (không `frame-ancestors` trong meta — ghi vào THREAT-MODEL). |
| F-12 | ⚠️ Minor | Security | T-09 phải thêm regression test "socket options không chứa `query.token`" | **CONFIRMED** — nằm ngoài scope test hiện tại của UI | `socket.ts:87` + `socket-farm.ts:97` hiện gửi `query: { token }`; UI §5.2 danh sách 11 test **không có** test này | Bổ sung vào UI §5.2: test `socket.ts` options object → `query.token === undefined` (sau T-08 bỏ query). |

### Self-critique — thiếu sót CONFIRMED trong chính design UI

| # | Mức | Flaw | Bằng chứng | Fix |
|---|---|---|---|---|
| S-1 | ⚠️ Minor | **Session banner text hardcode "12 giờ"** trong khi logic đọc `expiresAt` động | UI §3.2: `shouldWarnSession` thuần theo `expiresAt` (đúng), nhưng description text ghi "sau **12 giờ** kể từ khi đăng nhập" — nếu server đổi `SESSION_TTL_MS` (`loadtest/auth.ts:15`) text lệch | Render số giờ từ `expiresAt` (vd `Math.round(rem/3600000)`), hoặc bỏ con số — giữ nguyên nguyên tắc "không hardcode 12h" đã nêu ở §3.2. |
| S-2 | 🟠 Major | **Không có UX 429 retry-after** và **không phân biệt CORS/network error** trong T-09 | `loadtest-api.ts:36-45` bỏ `retryAfterSec`; `toApiError` default message "port 3401" gây hiểu nhầm khi CORS chặn (xem F-3/F-9) | Thêm 2 item vào T-09 scope (giữ phiên `toApiError` + `retryAfterSec`; ControlPanel disable + countdown; sticky stop toast). |
| S-3 | ⚠️ Minor | **Không test socket-token regression** (Security yêu cầu) | UI §5.2 test list thiếu mục bảo vệ T-08 bỏ `query.token` | Bổ sung test (xem F-12). |
| S-4 | 🟠 Major | **CSP delivery mâu thuẫn với Security design** — chưa chốt 1 nguồn | UI §2.4 đã chốt meta-only; Security §5.2 đòi nginx header + meta (xem F-11) | Đưa lên council: chọn canonical (đề xuất meta-only). Đây là **điểm chốt bắt buộc** trước khi T-08/T-12 triển khai để tránh double-CSP chặn font/preconnect. |

### Kết luận cho council

- **Backend**: không có lỗi phá frontend nào CONFIRMED — envelope/path/health/503 đều an toàn (F-1, F-2, F-4, F-5, F-6). Điểm cần bổ sung ở frontend: **UX 429 retry-after + sticky stop không im lặng** (F-3, F-8).
- **Security**: 2 finding CONFIRMED cần hành động: **(F-8) không có countdown 429 dù §4.2 giả định có**; **(F-11) CSP 2 nguồn mâu thuẫn với UI design** — phải chốt trước khi ship. F-7 (register gate) handled nhưng nên ẩn CTA khi gate off.
- **UI (self)**: 4 flaw CONFIRMED (S-1..S-4) — quan trọng nhất là S-2 (thiếu UX 429) và S-4 (xung đột CSP cần chốt).
