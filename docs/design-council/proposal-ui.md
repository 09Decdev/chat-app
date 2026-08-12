# Đề xuất UI — T6: KPI "Connect fail %" + card breakdown (LiveDashboard Màn 2)

**Vai trò**: UI Designer (design council — autobuild, feature fix bug E2 connect-fail)
**Nguồn**: `docs/PRD-loadtest-e2-connect-fail.md` (M6, AC-5, AC-6) · `docs/PLAN-loadtest-e2-connect-fail.md` (T1 contract, T6 task)
**Đọc code**: `src/pages/loadtest/LiveDashboardPage.tsx` · `src/components/ui/stat-card.tsx` · `src/components/loadtest/{chart-card,phase-donut,user-phases,chart-theme}.tsx` · `src/components/ui/alert-banner.tsx` · `src/store/loadtest.store.ts` · `src/pages/loadtest/UsersPage.tsx` · `src/index.css` (tokens dark theme)
**Trạng thái**: Đề xuất — chờ phản biện trong design council. CHỈ đề xuất, không code.

---

## 1. Tóm tắt quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | KPI tile **"Connect fail"** — tile thứ **9 (cuối)** của KPI grid, không chen vào giữa | Grid `xl:grid-cols-9` giữ tất cả tile cùng 1 hàng trên desktop; span full-width trên mobile/tablet tránh ô mồ côi (xem §3.1) |
| D2 | Card **"CONNECT FAIL BREAKDOWN"** đặt trong cột phải Hàng 3 (ngay dưới "TOP ERRORS"), bọc `space-y-4` đúng pattern cột phải Hàng 2 | Gộp toàn bộ "phân tích lỗi" 1 cột; thay đổi layout tối thiểu — không thêm hàng mới, không xê dịch chart nào |
| D3 | Tỉ lệ hiển thị = `rates.connectFailRate` (cửa sổ 60s); attempts/fails/breakdown/usersFailed hiển thị = **lũy kế toàn run** (contract T1) — ghi nhãn rõ ràng, KHÔNG trộn lẫn | Backend chỉ gửi 1 con số window rate; counter by-type chỉ có dạng cumulative (T1). Nhãn "lũy kế" chống hiểu nhầm |
| D4 | Trạng thái KPI: `≥ 30 → error`, `≥ 5 → warning`, `< 5 → success`, chưa có attempts → `--` (default) | Bám AC-5 (< 5% healthy) + ngưỡng auto-stop E2 (> 30%) |
| D5 | Cảnh báo "auto-stop E2 sắp kích hoạt" = strip AlertBanner `warning` bên trong card breakdown, chỉ hiển thị khi `rate ≥ 30` VÀ phase `ramping`/`steady` | Auto-stop chỉ evaluate trong ramping/steady (T5); khi run đã dừng thì banner đỏ đầu trang đã nói rồi — không lặp |
| D6 | Breakdown = **stacked bar 1 hàng (4 segment, flex div — không cần recharts)** + legend list (chấm màu + nhãn + count + %) | 4 mục thì bar gộp đọc "phần đóng góp" tốt hơn 4 thanh rời; legend có chữ → màu không phải kênh duy nhất; đúng pattern `DonutLegend` của PhaseDonut |
| D7 | Sửa `slicesFromTick`: thêm slice `failed` từ `counters.usersFailed`, trừ usersFailed khỏi phần "provisioned" (chưa kết nối) — donut không đếm trùng, tổng vẫn = usersCreated | User failed chưa bao giờ connected → đang nằm trong `notConnected`; giữ nguyên tổng |
| D8 | Không thêm polling mới — tile + card đọc `lastTick`/`ticks` từ store (poll 1s sẵn có) | Refresh theo tick hiện có, đúng phạm vi |

---

## 2. Dữ liệu đầu vào (contract T1 — frontend KHÔNG tự đặt tên)

Mirror vào `src/types/loadtest.ts`:

```ts
counters: {
  // ...field cũ giữ nguyên
  connectAttempts: number;          // lũy kế toàn run
  connectFails: number;             // lũy kế toàn run
  connectFailsByType: { timeout: number; transport: number; reject: number; other: number };
  usersFailed: number;              // user ở phase 'failed'
};
rates: { successRate: number; echoRate: number; connectFailRate: number }; // connectFailRate = window 60s
```

**Quan hệ dữ liệu bắt buộc cho UI** (đảm bảo đúng khi render):
- `counters.connectFails === timeout + transport + reject + other` (về lý thuyết — UI nên lấy tổng = sum 4 loại, không lấy `connectFails` trực tiếp khi tính % từng loại, tránh lệch do dữ liệu cũ/replay).
- `rates.connectFailRate` = 0 khi window chưa đủ 50 attempts (T2/T5) — frontend **không thể** phân biệt "thật 0%" với "chưa đủ mẫu" → xử lý bằng hint text (§4), không chế thêm trạng thái giả.
- DB replay (`toMetricTick`, R1) trả 0/0% → UI phải hiển thị bình thường, không crash (§7).

---

## 3. Bố cục — 2 thay đổi DUY NHẤT trên LiveDashboardPage

### 3.1 KPI grid: 8 → 9 tiles

**Hiện tại** (`LiveDashboardPage.tsx:200`):
```jsx
<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
```

**Sau**:
```jsx
<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-9">
  {/* 8 tile cũ giữ nguyên thứ tự */}
  <StatCard title="Connect" ... />
  <StatCard title="Active" ... />
  {/* ... Actions/s, Success, Echo, Queue, Rooms, ws_server */}
  <StatCard title="Connect fail" className="col-span-2 md:col-span-4 xl:col-span-1" ... />
</div>
```

- Tile "Connect fail" đặt **cuối grid** (vị trí 9), không chen giữa.
- Breakpoint math: mobile 2 cột → 8 tile = 4 hàng đầy + 1 tile full-width (hàng 5); tablet 4 cột → 2 hàng đầy + 1 full-width (hàng 3); xl 9 cột → **1 hàng 9 tile**, tile mới ở mép phải — vị trí "sentinel" (cảnh báo ở rìa phải, dễ nhìn khi quét ngang).
- **Phương án bị loại**: chen vào vị trí 2 (cạnh "Connect") — với `col-span-2/4` sẽ tạo lỗ trống mid-grid ở mobile/tablet (item span phải là item cuối mới đẹp); không span thì mồ côi 1/2-1/4 ô ở hàng cuối, trông như bug. Vị trí 9 giữ toán grid sạch ở mọi breakpoint (bằng chứng Playwright 1280px: tile vẫn visible → AC-6 không đổi).

### 3.2 Hàng 3: bọc cột phải `space-y-4`, thêm card breakdown

**Hiện tại** (`LiveDashboardPage.tsx:287-322`) — cột phải là 1 Card "TOP ERRORS":
```jsx
<div className="grid gap-4 lg:grid-cols-12">
  <ChartCard ... lg:col-span-7>ACTIONS/S THEO LOẠI</ChartCard>
  <Card className="p-4 lg:col-span-5">TOP ERRORS ...</Card>
</div>
```

**Sau** — đúng pattern cột phải Hàng 2 (`space-y-4 lg:col-span-4`, LiveDashboardPage.tsx:264):
```jsx
<div className="grid gap-4 lg:grid-cols-12">
  <ChartCard ... lg:col-span-7>ACTIONS/S THEO LOẠI</ChartCard>
  <div className="space-y-4 lg:col-span-5">
    <Card className="p-4">TOP ERRORS ... (giữ nguyên)</Card>
    <Card className="p-4">CONNECT FAIL BREAKDOWN ... (mới, §5)</Card>
  </div>
</div>
```

- Cột phải = "trục phân tích lỗi": TOP ERRORS (mã lỗi chung) + CONNECT FAIL BREAKDOWN (riêng connect) — đọc liền mạch.
- KHÔNG đổi: Hàng 1 (KPI), Hàng 2, Hàng 4 (server-side), banner, dialog. Không thêm hàng mới → không xô chart xuống.

---

## 4. KPI tile "Connect fail"

Component: `StatCard` (giữ nguyên, tận dụng variant/hint/tooltip/sparkline sẵn có — KHÔNG tạo component mới).

| Thuộc tính | Giá trị |
|---|---|
| `title` | `"Connect fail"` (đồng bộ style title tiếng Anh ngắn: Connect, Echo, Queue...) |
| `value` | `r ? r.connectFailRate.toFixed(1) : '--'` — hiển thị `--` khi `!lastTick` HOẶC `c.connectAttempts === 0` (chưa có dữ liệu); ngoài ra luôn số |
| `unit` | `"%"` |
| `variant` | `connectAttempts === 0` → `default` · `rate >= 30` → `error` · `rate >= 5` → `warning` · else `success` (helper `connectFailVariant(v, attempts)` — đặt gần `rateVariant` LiveDashboardPage.tsx:41) |
| `hint` (tooltip) | `"Tỉ lệ fail/attempt trong cửa sổ 60s. Auto-stop E2: > 30% và window ≥ 50 attempts. < 5% = healthy (AC-5). 0% khi window chưa đủ 50 attempts."` — hint giải thích luôn case "0% nhưng chưa đủ mẫu" (§2) |
| `sparkline` | **Có, khuyến nghị**: helper `useRateSpark()` đọc `rates.connectFailRate` của 60 tick cuối (giống `useSpark` LiveDashboardPage.tsx:33-39 nhưng map `t => t.rates.connectFailRate`). Giá trị mặc định: `undefined` khi chưa có tick nào (StatCard bỏ qua sparkline). Trend hướng tới ngưỡng 30% là câu hỏi chính người dùng đặt — rẻ (60 số) và không đổi layout |

Lưu ý: `variant` chỉ đổi màu **chữ số** (cơ chế sẵn có của StatCard — `text-destructive/warning/success`, StatCard.tsx:22-28) — không thêm viền nền; giữ nhịp thị giác đồng đều của 9 tile.

---

## 5. Card "CONNECT FAIL BREAKDOWN"

Plain `Card p-4` — **parity với card TOP ERRORS** (không dùng ChartCard skeleton; không dùng recharts cho stacked bar — 4 segment là flex div, rẻ hơn và không cần animation).

```
┌──────────────────────────────────────────────┐
│ CONNECT FAIL BREAKDOWN            [lũy kế]  │  ← h3 text-base font-medium + Badge secondary
│ attempts 12.4k · fails 1.2k · usersFailed 42 │  ← dòng tóm tắt (font-mono tabular-nums, text-xs)
│ ┌─ AlertBanner warning (CHỈ khi rate ≥ 30    │
│ │ và phase ramping/steady) ─────────────────┐│
│ │ ⚠ Tỉ lệ ≥ 30% trong cửa sổ 60s —         ││
│ │   auto-stop E2 sắp kích hoạt              ││
│ │   (khi window đủ ≥ 50 attempts)           ││
│ └───────────────────────────────────────────┘│
│ ███████████░░░░░░░░░░░░░░░░░                │  ← stacked bar 1 hàng, 4 segment
│ ● timeout   750 (61%)                       │
│ ● transport 340 (28%)                       │  ← legend: chấm màu + nhãn + count + %
│ ● reject     12 (1%)                        │     (luôn có chữ — màu không phải kênh duy nhất)
│ ● other       5 (<1%)                       │
└──────────────────────────────────────────────┘
```

Chi tiết từng phần:

### 5.1 Header + summary line
- Header: `<h3 className="text-base font-medium">CONNECT FAIL BREAKDOWN</h3>` (đồng bộ "TOP ERRORS", LiveDashboardPage.tsx:294) + `<Badge variant="secondary">lũy kế</Badge>` — nhãn này là bắt buộc (D3): người xem phân biệt ngay "rate = window 60s (ở tile) còn số đếm = từ đầu run".
- Summary: `attempts {fmtCompact(c.connectAttempts)} · fails {fmtCompact(c.connectFails)} · usersFailed {fmtCompact(c.usersFailed)}` — font-mono text-xs tabular-nums text-muted-foreground (đồng bộ số liệu toàn dashboard).
- `usersFailed` hiển thị kèm chú thích `"(lọc Phase = Lỗi tại Virtual Users)"` — KHÔNG làm link (bộ lọc UsersPage là state client-side, không deep-link được).

### 5.2 Danger strip — "auto-stop E2 sắp kích hoạt"
- Điều kiện hiển thị: `rate >= 30 && (phase === 'ramping' || phase === 'steady')`.
- Component: `AlertBanner variant="warning"` (có sẵn `role="alert"` — banner hiện lên là thông báo assertive đúng mức; nội dung không đổi mỗi tick → không spam screen reader).
- Text: title `"Tỉ lệ connect fail ≥ 30% trong cửa sổ 60s — auto-stop E2 sắp kích hoạt"`, description `"Run sẽ tự dừng khi window đủ ≥ 50 attempts và rate > 30%. Xem breakdown bên dưới để tìm nguyên nhân."`
- KHÔNG hiển thị khi run đã dừng (phase `error`/`finished`) — banner đỏ "Run tự dừng: register/connect fail vượt ngưỡng (E1/E2)" ở đầu trang (LiveDashboardPage.tsx:179-190) đã phủ case đó; tránh lặp.

### 5.3 Stacked bar + legend
- Dữ liệu: 4 mục từ `counters.connectFailsByType`, **sort desc theo count**, tổng `totalFails = timeout + transport + reject + other` (không dùng `connectFails` trực tiếp cho % từng loại — §2).
- Bar: `<div role="img" aria-label="Phân bố connect fail theo loại: ...">` bọc `flex h-2 w-full overflow-hidden rounded-full bg-muted`; mỗi segment `<div style={{ width: pct + '%' }} className="h-2" />` màu theo loại (bảng dưới) — **không animation** (toàn bộ chart trong codebase đều `isAnimationActive={false}`).
- Legend: `<ul aria-label="Phân bố connect fail theo loại">` — chấm màu `h-2 w-2 rounded-full` (aria-hidden) + nhãn + `count` (font-mono tabular-nums) + `(pct%)` — **đúng pattern `DonutLegend` PhaseDonut.tsx:18-34**.
- Định dạng %: `pct >= 10 ? Math.round(pct) : pct.toFixed(1)` (tránh "0%" cho mục nhỏ; mục 0 count → bỏ hẳn khỏi legend).
- **Màu cố định theo loại** (ổn định giữa các run/screen — không sort theo màu):

| Loại | Màu | Lý do |
|---|---|---|
| `timeout` | `hsl(var(--chart-4))` (vàng 48 96% 58%) | "chờ quá lâu" — vàng; khác biệt rõ với các loại còn lại |
| `transport` | `hsl(var(--chart-2))` (xanh da trời 199 89% 60%) | đường truyền — xanh |
| `reject` | `hsl(var(--chart-6))` (đỏ 14 85% 60%) | server chủ động từ chối — đỏ (tín hiệu mạnh nhất) |
| `other` | `hsl(var(--chart-8))` (tím nhạt 258 80% 75%) | chưa rõ — trung tính |

Bốn màu vàng/xanh/đỏ/tím phân biệt được cả với CVD thông thường (deuteranopia/protanopia) VÀ legend luôn có nhãn chữ + số → màu chỉ là kênh phụ. Dùng token `--chart-N` (không hardcode hex — đúng chart-theme.ts).

### 5.4 Empty states (thứ tự ưu tiên)
1. `!lastTick` → `"Đang chờ tick đầu tiên..."` (text-sm text-muted-foreground, centered — parity "Không có lỗi" của TOP ERRORS).
2. `lastTick && c.connectAttempts === 0` → `"Chưa có dữ liệu connect — đang chờ user connect đầu tiên..."`.
3. `totalFails === 0` (attempts > 0) → `"Không có connect fail trong run này"` (kèm hint tooltip ở tile giải thích "0% khi window chưa đủ mẫu").
4. Run kết thúc (frozen) → giữ nguyên giá trị cuối (lastTick được store giữ), KHÔNG xóa — banner "Run đã kết thúc" đầu trang đã đủ ngữ cảnh.

---

## 6. PhaseDonut — đảm bảo slice 'failed' hiển thị

`slicesFromTick` (user-phases.ts:65-81) hiện chỉ dựng 4 phần: `in_room / queued / connected(idle) / provisioned(notConnected)` — user failed nằm lẫn trong `notConnected` (failed chưa bao giờ connected) và KHÔNG có slice riêng.

Sửa logic (T6, PLAN mục PhaseDonut):

```ts
const connectedIdle = Math.max(0, c.usersConnected - c.usersInRoom - c.usersQueued);
const notConnected = Math.max(0, total - c.usersConnected - (c.usersFailed ?? 0)); // trừ failed — tránh đếm trùng
const parts = [
  { key: 'in_room', value: c.usersInRoom },
  { key: 'queued', value: c.usersQueued },
  { key: 'connected', value: connectedIdle },
  { key: 'provisioned', value: notConnected },
  ...((c.usersFailed ?? 0) > 0 ? [{ key: 'failed' as const, value: c.usersFailed }] : []),
];
```

- `failed` ở CUỐI (khớp `USER_PHASE_ORDER`), label "Lỗi", màu `PHASE_COLORS.failed` (`hsl(14 85% 44%)` — đã darkened, đạt WCAG AA với chữ trắng, chart-theme.ts:32) — trùng tone đỏ với segment `reject` ở card breakdown nhưng nằm 2 card khác nhau có nhãn rõ, chấp nhận.
- Bất biến: tổng donut vẫn = `usersCreated` (không đếm trùng, không thiếu) — Data Visualization critic có thể verify số học này.
- UsersPage dùng `slicesFromPhaseCounts` (API `phaseCounts` đã có `failed`) — không đổi.

---

## 7. Trạng thái run/refresh

| Tình huống | Hành vi |
|---|---|
| Chưa có run (`idle` + 0 tick) | Page early-return sẵn có (LiveDashboardPage.tsx:159-168) — không đổi |
| Run live | Tile + card đọc `lastTick` từ store — poll 1s sẵn có (`pollOnce`, store) — **không thêm polling/interval mới** |
| Run kết thúc (frozen) | Giữ giá trị cuối; card breakdown plain như TOP ERRORS (không thêm ring frozen — parity); banner đầu trang lo việc báo trạng thái |
| Replay lịch sử (R1 — `toMetricTick` trả 0/0%) | Tile hiện `--` (attempts = 0) hoặc `0.0%`; card empty state #2/#3 — không crash, đúng R1 |

---

## 8. Accessibility (WCAG AA)

1. **Màu không phải kênh duy nhất**: tile — chữ số màu variant + giá trị số + đơn vị; bar/legend — mỗi loại có nhãn chữ + count + % (legend list, không chỉ chấm màu). Segment bar `role="img"` + `aria-label` tóm tắt counts (đúng pattern PhaseDonut).
2. **Contrast**: tất cả màu dùng token sẵn trên nền dark card (`--destructive` 0 72% 56%, `--warning` 38 92% 58%, `--success` 152 62% 55% — các token này đang dùng khắp dashboard với `rateVariant`); chữ phụ = `text-muted-foreground` (250 12% 64%). Không giới thiệu màu mới, không hardcode hex.
3. **Screen reader**: tiêu đề card là `<h3>`; summary line là text thuần (không aria-live mỗi tick — tránh spam; chỉ danger strip dùng `role="alert"` qua AlertBanner, nội dung ổn định khi hiện).
4. **Bàn phím/focus**: không thêm element tương tác mới ngoài tooltip hint của StatCard (pattern sẵn có, có `aria-label`, focus-visible ring sẵn). AlertBanner không phải nút.
5. **Motion**: không animation mới (bar tĩnh; sparkline recharts sẵn `isAnimationActive={false}` — StatCard.tsx:98).
6. **Touch target**: không nút mới.

---

## 9. ASCII mockup (1 khối — KPI grid hàng xl + card mới)

```
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Connect      │ Active       │ Actions/s    │ Success      │ Echo         │ Queue        │ Rooms        │ ws_server    │ Connect fail │
│ 9.8k         │ 9.5k         │ 1.2k/s       │ 97.2 %       │ 96.1 %       │ 320          │ 1.1k         │ 11.3k        │ 32.4 %   ▸   │
│ ▁▂▃▃▅▆▇▆▇█  │ ▂▃▄▅▆▆▇▇█    │ ▃▄▅▆▅▆▇▇█    │ ▇▇▆▆▇▇▆▆▇▇ │ ▇▆▇▇▇▆▆▇▇█  │ ▁▁▁▂▂▃▃▃▃▂  │ ▁▂▂▂▃▃▃▃▄▃  │ ▇▇▇▇▇▇▆▇▇▇ │ ▂▃▃▅▆█▆▅▆▇█ │
│              │              │              │              │              │              │              │              │ (đỏ — ≥30%)  │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

   (Hàng 3 — cột phải lg:col-span-5, bọc space-y-4)

┌─ ACTIONS/S THEO LOẠI ─────────────┐   ┌─ TOP ERRORS ─────────────────────────────┐
│ ██ ██ ██ ██ (giữ nguyên)          │   │ Mã lỗi                 Tần suất          │
└───────────────────────────────────┘   │ CONNECT_TIMEOUT         1.1k             │
                                         │ CHAT_RATE_LIMIT         430              │
                                         │ ... (giữ nguyên)                          │
                                         └──────────────────────────────────────────┘
                                         ┌─ CONNECT FAIL BREAKDOWN          [lũy kế] ┐
                                         │ attempts 12.4k · fails 1.2k · usersFailed │
                                         │ ⚠ ≥ 30% trong cửa sổ 60s — auto-stop E2  │
                                         │   sắp kích hoạt (window ≥ 50 attempts)    │
                                         │ ███████████░░░░░░░░░░░░░░░░  bar 4 loại   │
                                         │ ● timeout   750 (61%)                     │
                                         │ ● transport 340 (28%)                     │
                                         │ ● reject     12 (1%)                      │
                                         │ ● other       5 (<1%)                     │
                                         └───────────────────────────────────────────┘
```

---

## 10. Component test (T6 — `LiveDashboardPage.test.tsx`, pattern UsersPage.test.tsx)

1. Mock tick: `rates.connectFailRate = 12.4`, `counters.connectAttempts = 12400`, `connectFails = 1200`, `connectFailsByType = { timeout: 750, transport: 340, reject: 12, other: 5 }`, `usersFailed = 42` → assert: tile hiển thị `12.4` + unit `%`; card hiển thị `attempts 12.4k`, `usersFailed 42`; legend đủ 4 loại theo thứ tự giảm dần (timeout trước), text `(61%)`; **không** hiển thị danger strip (12.4 < 30).
2. Tick 2: `connectFailRate = 32`, phase `steady` → danger strip text `"auto-stop E2 sắp kích hoạt"` visible.
3. Tick 3: `connectAttempts = 0` → tile `--`.
4. `totalFails = 0` → empty text `"Không có connect fail trong run này"`.
5. Donut: tick có `usersFailed = 42`, `usersConnected` bao gồm phần không failed → slice "Lỗi" xuất hiện VÀ tổng phần trăm = usersCreated (không đếm trùng).

---

## 11. Điểm dễ bị chỉ trích trong đề xuất này

1. **Vị trí tile ở cuối grid (D1) đánh đổi sự gần kề ngữ nghĩa**: "Connect fail" không nằm cạnh "Connect" trên desktop (xl) — người xem phải nhìn 2 đầu hàng. Phương án chen vị trí 2 tạo ô mồ côi ở mobile/tablet nên bị loại, nhưng reviewer có thể cho rằng nên chấp nhận mồ côi để giữ nhóm ngữ nghĩa — cần trọng tài.
2. **Tỉ lệ (window 60s) vs số đếm (lũy kế) hiển thị chung 1 ngữ cảnh**: người dùng có thể đọc nhầm "61% timeout" (lũy kế) với "32.4% connect fail" (window) vì 2 con số khác mẫu số. Đã chống bằng nhãn "lũy kế" + hint, nhưng về lâu dài breakdown theo window 60s mới là số liệu đúng để đối chiếu — contract T1 không có (chỉ cumulative byType), đây là lỗ hổng dữ liệu, không phải UI tự sửa được; đề xuất này chỉ ghi nhãn, không đòi thêm field (ngoài phạm vi T6).
3. **"0% khi window chưa đủ 50 attempts" dễ hiểu nhầm là healthy**: backend ép rate = 0 khi thiếu mẫu (T2/T5) → tile xanh "0.0%" trong khi thực tế chưa đủ dữ liệu. Đề xuất xử lý bằng hint tooltip + empty text, nhưng không phân biệt được bằng trạng thái trực quan — một số người dùng sẽ đòi trạng thái "insufficient data" riêng (cần thêm field `connectWindowAttempts` — ngoài contract T1).
4. **Màu `reject` (đỏ chart-6) trùng họ màu slice `failed` (PHASE_COLORS.failed)** dù ở 2 card khác nhau: đỏ 2 nơi có thể gây gán nhầm "reject = user failed". Chấp nhận vì cả 2 đều là "tín hiệu đỏ" và có nhãn chữ, nhưng có thể bị chỉ trích là không đủ phân biệt — phương án thay `reject` bằng chart-7 (tím) đã cân nhắc nhưng giảm ý nghĩa "nguy hiểm nhất".
5. **Thay đổi `slicesFromTick` đụng vào donut dùng chung (cả dashboard + tiềm năng tương lai)**: trừ `usersFailed` khỏi `notConnected` là sửa số học hiện có — nếu backend có user failed mà ĐÃ TỪNG connected (không đúng spec M3 hiện tại nhưng v1.1 có thể thay đổi) thì số liệu donut lệch. Test #5 trong §10 phải khóa bất biến "tổng = usersCreated" để bắt lệch này.
