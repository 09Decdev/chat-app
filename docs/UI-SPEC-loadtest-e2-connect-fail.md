# UI-SPEC — KPI "Connect fail" + card breakdown (Màn 2 Live Dashboard) — CHÍNH THỨC

**Nguồn**: `docs/DESIGN-loadtest-e2-connect-fail.md` (contract T1 + phán quyết UI-1/UI-2/UI-3, PF2, F-8) · proposal-ui.md (nền) · PRD M6/AC-6.
**Vai trò**: UI Designer + Backend Architect (adjudicator) — file này thay proposal-ui làm source of truth cho T6.
**Bám CHÍNH XÁC field DESIGN §2** — không tự đặt tên field (R7).

---

## 1. Tóm tắt quyết định

| # | Quyết định | Thay đổi so với proposal-ui |
|---|---|---|
| D1 | Tile "Connect fail" = tile 9 (cuối) KPI grid `xl:grid-cols-9` | giữ |
| D2 | Card "CONNECT FAIL BREAKDOWN" trong cột phải Hàng 3 (`space-y-4 lg:col-span-5`), dưới TOP ERRORS | giữ |
| D3 | Rate (tile) = window 60s; số đếm (card) = cumulative per-worker — nhãn "lũy kế" + chú thích giảm khi worker restart (BE-2) | nhãn đổi chú thích |
| D4 | Tile `--` khi `!lastTick` HOẶC `lastTick.hasConnectData === false` (UI-3) — KHÔNG dùng `connectAttempts === 0` làm điều kiện `--` | **đổi** (UI-3) |
| D5 | Danger strip khi `rate >= 30 && phase ramping/steady` | giữ |
| D6 | Breakdown = stacked bar flex-div + legend (tổng = **sum(byType)**) | mockup sửa số (UI-2) |
| D7 | Donut slice `failed` từ `usersFailed` (trừ khỏi notConnected) | giữ |
| D8 | Sparkline tile mới = **SVG polyline thủ công** + guard `?? 0` (PF2) | **đổi** (không recharts) |
| D9 | Empty state replay phân biệt qua `hasConnectData` (UI-1) | **thêm** |

---

## 2. Dữ liệu đầu vào (contract DESIGN §2.1 — mirror `src/types/loadtest.ts:123-152`)

```ts
counters: {
  // …field cũ giữ nguyên
  connectAttempts: number;          // cumulative per-worker, sum tick mới nhất
  connectFails: number;             // cùng semantics
  connectFailsByType: { timeout: number; transport: number; reject: number; other: number };
  usersFailed: number;              // user phase 'failed'
};
rates: { successRate: number; echoRate: number; connectFailRate: number }; // connectFailRate = window 60s
hasConnectData?: boolean;           // live: true · replay (toMetricTick): false
```

**Quan hệ dữ liệu bắt buộc khi render**:
- `totalFails = timeout + transport + reject + other` (**sum(byType)**, KHÔNG dùng `connectFails` trực tiếp cho % từng loại — UI-2; live run 2 tổng bằng nhau vì mỗi connect_error tăng cả 2).
- `connectFailRate` = 0 khi window < 50 attempts (DESIGN §4) — frontend không phân biệt "thật 0" vs "chưa đủ mẫu" → xử lý bằng hint (F-8 MVP); phân biệt replay bằng `hasConnectData === false`.
- `connectAttempts/connectFails/usersFailed` **có thể giảm giữa run** khi worker restart (BE-2 — semantics chính thức) → UI nhãn chú thích, không coi là lỗi.

---

## 3. KPI tile "Connect fail"

`StatCard` giữ nguyên (variant/hint/tooltip) — KHÔNG component mới.

| Thuộc tính | Giá trị |
|---|---|
| `title` | `"Connect fail"` |
| `value` | `r ? r.connectFailRate.toFixed(1) : '--'` — `--` khi `!lastTick` HOẶC `lastTick.hasConnectData === false` (D4/UI-3: replay hoặc chưa tick — KHÔNG dùng cumulative attempts nên không tái xuất `--` giữa run sau restart) |
| `unit` | `"%"` |
| `variant` | `!lastTick || lastTick.hasConnectData === false || c.connectAttempts === 0` → `default` · `rate >= 30` → `error` · `rate >= 5` → `warning` · else `success` (helper `connectFailVariant(tick)` — cạnh `rateVariant` LiveDashboardPage.tsx:41) |
| `hint` | `"Tỉ lệ fail/attempt trong cửa sổ 60s. Auto-stop E2: > 30% và window ≥ 50 attempts. < 5% = healthy (AC-5). 0% khi window chưa đủ 50 attempts."` |
| `sparkline` | **SVG polyline thủ công** (D8/PF2): helper `useRateSpark()` map `t.rates.connectFailRate ?? 0` của 60 tick cuối; KHÔNG dùng recharts (tránh chart thứ 5 re-render 1Hz trên máy đang chạy load gen); replay (hasConnectData false) → sparkline bỏ qua (điểm cuối = 0, không vẽ đoạn sai) |

Lưu ý variant chỉ đổi màu chữ số (StatCard.tsx:22-28) — không viền/nền mới.

---

## 4. Card "CONNECT FAIL BREAKDOWN"

Plain `Card p-4` (parity TOP ERRORS — LiveDashboardPage.tsx:294). Bọc trong `div.space-y-4.lg:col-span-5` cùng TOP ERRORS (pattern :264).

### 4.1 Header + summary line
- `<h3 className="text-base font-medium">CONNECT FAIL BREAKDOWN</h3>` + `<Badge variant="secondary">lũy kế</Badge>`.
- Summary: `attempts {fmtCompact(c.connectAttempts)} · fails {fmtCompact(totalFails)} · usersFailed {fmtCompact(c.usersFailed)}` — **`fails` = sum(byType)** (UI-2); chú thích tooltip: `"(per worker từ đầu run — có thể giảm khi worker restart)"` (BE-2).
- `usersFailed` kèm chú thích `"(lọc Phase = Lỗi tại Virtual Users)"` — không link (bộ lọc UsersPage client-side).

### 4.2 Danger strip
- Điều kiện: `rate >= 30 && (phase === 'ramping' || phase === 'steady')` — AlertBanner `warning` (có `role="alert"`), title `"Tỉ lệ connect fail ≥ 30% trong cửa sổ 60s — auto-stop E2 sắp kích hoạt"`, description `"Run sẽ tự dừng khi window đủ ≥ 50 attempts và rate > 30%. Xem breakdown bên dưới để tìm nguyên nhân."`
- KHÔNG hiển thị khi run đã dừng — banner đỏ đầu trang (LiveDashboardPage.tsx:179-190) đã phủ.

### 4.3 Stacked bar + legend
- 4 mục từ `connectFailsByType`, sort desc, `totalFails = sum(byType)`; mục 0 → bỏ khỏi legend.
- Bar: `<div role="img" aria-label="Phân bố connect fail theo loại: …">` + `flex h-2 w-full overflow-hidden rounded-full bg-muted`; segment `style={{ width: pct + '%' }}` — không animation.
- Legend: `<ul aria-label="…">` — chấm màu + nhãn + count + `(pct%)` (pattern DonutLegend PhaseDonut.tsx:18-34); format `pct >= 10 ? Math.round(pct) : pct.toFixed(1)`.
- Màu (token `--chart-N`, chart-theme.ts):

| Loại | Màu |
|---|---|
| `timeout` | `hsl(var(--chart-4))` (vàng 48 96% 58%) |
| `transport` | `hsl(var(--chart-2))` (xanh da trời 199 89% 60%) |
| `reject` | `hsl(var(--chart-6))` (đỏ 14 85% 60%) |
| `other` | `hsl(var(--chart-8))` (tím nhạt 258 80% 75%) |

### 4.4 Empty states (thứ tự ưu tiên — D9/UI-1)
1. `!lastTick` → `"Đang chờ tick đầu tiên..."`.
2. `lastTick.hasConnectData === false` → `"Run lịch sử (trước bản fix) không lưu dữ liệu connect — hiển thị 0"` — **KHÔNG dùng text "đang chờ"** cho run đã đóng băng (UI-1).
3. `lastTick && c.connectAttempts === 0` → `"Chưa có dữ liệu connect — đang chờ user connect đầu tiên..."`.
4. `totalFails === 0` (attempts > 0) → `"Không có connect fail trong run này"`.
5. Run kết thúc (frozen) → giữ giá trị cuối; banner đầu trang lo ngữ cảnh.

---

## 5. Donut slice `failed` (D7)

`slicesFromTick` (user-phases.ts:65-81): thêm slice `failed` từ `c.usersFailed` + trừ khỏi `notConnected`:

```ts
const connectedIdle = Math.max(0, c.usersConnected - c.usersInRoom - c.usersQueued);
const notConnected = Math.max(0, total - c.usersConnected - (c.usersFailed ?? 0));
const parts = [
  { key: 'in_room', value: c.usersInRoom },
  { key: 'queued', value: c.usersQueued },
  { key: 'connected', value: connectedIdle },
  { key: 'provisioned', value: notConnected },
  ...((c.usersFailed ?? 0) > 0 ? [{ key: 'failed' as const, value: c.usersFailed }] : []),
];
```
- `failed` cuối (khớp USER_PHASE_ORDER), label "Lỗi", `PHASE_COLORS.failed` (chart-theme.ts:32).
- Bất biến: tổng donut = usersCreated (test khóa số học này).
- UsersPage dùng `slicesFromPhaseCounts` (phaseCounts đã có `failed`) — không đổi.

---

## 6. Component test (LiveDashboardPage.test.tsx, pattern UsersPage.test.tsx)

1. Mock tick: `connectFailRate = 12.4`, `connectAttempts = 12400`, `connectFailsByType = {timeout:750, transport:340, reject:12, other:5}`, `usersFailed = 42`, `hasConnectData: true` → tile `12.4%`; summary `fails 1.1k` (=1107); legend timeout `(68%)`; không danger strip.
2. Tick 2: `connectFailRate = 32`, phase `steady` → danger strip visible.
3. Tick 3: `connectAttempts = 0`, `hasConnectData: true` → tile `--` (hoặc 0.0 — theo D4: `--` chỉ khi !lastTick/false; case này tile hiện `0.0%` vì lastTick tồn tại — assert đúng spec D4).
4. `totalFails = 0` → empty text "Không có connect fail trong run này".
5. Donut: `usersFailed = 42` → slice "Lỗi" + tổng = usersCreated.
6. **THÊM (UI-1)**: tick `hasConnectData: false` (replay, terminal phase) → tile `--` + card text "Run lịch sử (trước bản fix) không lưu dữ liệu connect" — KHÔNG có "đang chờ".

---

## 7. Trạng thái run/refresh

| Tình huống | Hành vi |
|---|---|
| Chưa có run (`idle` + 0 tick) | early-return sẵn có (LiveDashboardPage.tsx:159-168) — không đổi |
| Run live | Tile + card đọc `lastTick` — poll 1s sẵn có — không thêm polling |
| Worker restart giữa run (BE-2) | counter tụt — số hiển thị giảm (đúng semantics, nhãn chú thích); tile KHÔNG về `--` (D4) |
| Run kết thúc (frozen) | giữ giá trị cuối |
| Replay (R1) | `hasConnectData === false` → tile `--`, card empty state #2, sparkline bỏ qua — không crash, không "đang chờ" giả |

---

## 8. Bố cục (chỉ 2 thay đổi — giữ proposal-ui §3)

1. KPI grid `xl:grid-cols-8` → `xl:grid-cols-9` (LiveDashboardPage.tsx:200); tile mới cuối grid: `col-span-2 md:col-span-4 xl:col-span-1`.
2. Hàng 3 cột phải: bọc TOP ERRORS + card mới trong `div.space-y-4.lg:col-span-5` (pattern :264).

## 9. Mockup (số NHẤT QUÁN — UI-2)

```
┌─ CONNECT FAIL BREAKDOWN                  [lũy kế] ─┐
│ attempts 12.4k · fails 1.1k · usersFailed 42        │
│ ██████████████████░░░░░░░░░ bar 4 loại (sum 1107)   │
│ ● timeout   750 (68%)                                │
│ ● transport 340 (31%)                                │
│ ● reject     12 (1.1%)                               │
│ ● other       5 (0.5%)                               │
└─────────────────────────────────────────────────────┘
```
(68+31+1.1+0.5 = 100.6 — làm tròn hiển thị, tổng luôn tính trên sum(byType); mockup dùng 750+340+12+5 = 1107, KHÔNG 1200.)
