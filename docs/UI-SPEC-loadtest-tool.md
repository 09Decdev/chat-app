# UI-SPEC — MAYogu LoadTest Tool

**Phiên bản**: 0.1 — 2026-08-03
**Nguồn**: `docs/PRD-loadtest-tool.md` (v0.1) + `docs/UX-FLOW-loadtest-tool.md` (v0.1)
**Trạng thái**: Sẵn sàng cho LuxuryDeveloper triển khai (đợt theo Mục 6)
**Người thiết kế**: UI Designer (Agent)

---

## 0. Tóm tắt quyết định đã chốt (UI Designer)

1. **Dark-first duy nhất** (đúng hiện trạng `src/index.css`), mọi màu mới thêm dưới dạng HSL token trong cùng file — không mã màu cứng trong component.
2. **Chart library = recharts** (thêm dependency). **Cấm mọi animation** trên chart: `isAnimationActive={false}` mọi series, không dùng `framer-motion` cho chart/KPI. Đây là yêu cầu bắt buộc AC5.4 (100k events/s).
3. **Palette chart 8 hue colorblind-safe** (Okabe-Ito thích ứng nền tối) — không bao giờ dùng màu đỏ/xanh đơn thuần để phân biệt chuỗi P50/P95/P99; kèm dash-pattern + nhãn chữ.
4. **Component mới cần thêm** theo đúng chuẩn shadcn/ui + Radix hiện có: `Select`, `Switch`, `Tabs`, `Tooltip`, `Table`, `StatCard`, `Gauge`, `Progress`, `ChipGroup`, `AlertBanner` (spec chi tiết Mục 1.4). Radix packages mới: select/switch/tabs/tooltip/progress.
5. **Bố cục**: mobile baseline 1 cột, thao tác 1 tay (CTA chính sticky bottom thumb-zone ≥ 48px); desktop ≥ 1024px dùng grid 12 cột theo ghi chú desktop-enhanced của UX Architect — KHÔNG bịa layout khác wireframe.
6. **Chặn cứng preset 1M/10M**: Bắt đầu mở Confirm modal yêu cầu gõ đúng chuỗi "TÔI XÁC NHẬN" (không phải checkbox), mỗi lần chạy phải gõ lại (chỉ nhớ trong session). Gateway ngoài allowlist → ẩn hẳn nút Bắt đầu.
7. **LIVE vs FROZEN phân biệt bằng 3 kênh**: badge + border chart + banner role="alert" — không chỉ phụ thuộc màu.
8. **Thứ tự triển khai**: foundation (tokens + component mới + shell) → Màn 1 → Màn 2 → Màn 5 → Màn 6+7 → Màn 4 → Màn 3 (v1.1). Chi tiết Mục 6.

---

## 1. Design system mở rộng

### 1.1 Token HSL mới — thêm vào `src/index.css`

Màu **nền tối `--background: 255 23% 5%`** (#0d0d13). Tất cả token dưới đây đạt tương phản ≥ 4.5:1 trên nền tối khi dùng làm text.

**Semantic (mở rộng từ `--destructive` có sẵn):**

| Token | HSL | Hex gần đúng | Tương phản vs nền tối | Dùng cho |
|---|---|---|---|---|
| `--success` | `152 62% 55%` | #21c98a | ~8.0:1 | steady, KPI đạt ngưỡng |
| `--success-foreground` | `0 0% 100%` | #fff | — | chữ trên badge success |
| `--warning` | `38 92% 58%` | #f2a63c | ~10.5:1 | cảnh báo hạ tầng, cooldown, bottleneck |
| `--warning-foreground` | `0 0% 8%` | #141414 | — | chữ trên badge warning |
| `--info` | `199 89% 60%` | #4fc3f7 | ~9.2:1 | hướng dẫn, trạng thái trung tính có thông tin |
| `--info-foreground` | `0 0% 100%` | #fff | — | chữ trên badge info |
| `--destructive` | `0 72% 56%` (đã có) | #e5484d | ~6.9:1 | error, kill-switch, banner chặn cứng |

**Chart palette — 8 hue colorblind-safe trên nền tối** (kế thừa dải Okabe-Ito, làm sáng hơn để đủ tương phản):

| Token | HSL | Hex gần đúng | Vai trò mặc định (action) | Ghi chú colorblind |
|---|---|---|---|---|
| `--chart-1` | `38 92% 60%` | #f2a63c | chat | amber/orange — phân biệt tốt với vàng bằng độ đậm |
| `--chart-2` | `199 89% 60%` | #4fc3f7 | read | sky — không nhầm với xanh dương đậm `chart-5` |
| `--chart-3` | `160 84% 45%` | #12b886 | comment | xanh teal — phân biệt được với xanh dương (deutan) |
| `--chart-4` | `48 96% 58%` | #f9e44a | like | vàng sáng — dùng lượng ít (gần amber) |
| `--chart-5` | `217 91% 60%` | #4d8ff7 | view | xanh dương đậm |
| `--chart-6` | `14 85% 60%` | #f2765b | topic | vermillion — không dùng cạnh `--destructive` |
| `--chart-7` | `291 64% 64%` | #e17ad8 | typing | hồng (trùng `--accent` — tái dùng) |
| `--chart-8` | `258 80% 75%` | #a99bff | vote_kick / khác | lavender |

**Quy tắc bất biến (HARD RULE):**
- Chuỗi P50/P95/P99 **không bao giờ** chỉ khác nhau bằng màu: P50 = `--chart-2` nét liền (`solid`), P95 = `--chart-1` gạch (`dasharray 6 4`), P99 = `--chart-6` chấm (`dasharray 2 3`), kèm legend có nhãn chữ "P50/P95/P99".
- Mọi legend có nhãn chữ + dấu (shape), không legend màu thuần.
- `--destructive` (đỏ) chỉ dùng cho lỗi/thao tác phá hủy — chart error rate phải kèm số + độ dốc, không đỏ đơn lẻ.

**Chart chrome (axes/gridline/tooltip):**
- Axes + gridline: `stroke: hsl(var(--border))`, độ dày 1px.
- Tick text: `fill: hsl(var(--muted-foreground))`, `font-size: 12px`.
- Tooltip nền: `hsl(var(--popover))` + border `hsl(var(--border))`, chữ `--popover-foreground`.
- Cursor: `stroke: hsl(var(--border))`.

### 1.2 Typography

**Font stack:** giữ `font-sans` mặc định của Tailwind (system-ui, Segoe UI, Roboto...) — đủ dấu tiếng Việt. **Bổ sung fallback CJK** trong `tailwind.config.js` `theme.extend.fontFamily.sans`:

```js
sans: [
  'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto',
  'Helvetica Neue', 'Arial', 'Noto Sans', 'PingFang SC', 'Hiragino Sans GB',
  'Microsoft YaHei', 'Noto Sans CJK SC', 'sans-serif',
],
```

**Scale (mobile = desktop, không đổi cỡ chữ theo breakpoint):**

| Class | Cỡ | Dùng cho |
|---|---|---|
| `text-xs` | 12px | label bảng, chú thích chart, badge. **Không dùng cỡ < 12px ở bất kỳ đâu** (CJK/VN dấu phải rõ) |
| `text-sm` | 14px | text cơ bản, bảng lỗi, form |
| `text-base` | 16px | tiêu đề section |
| `text-lg` | 18px | giá trị KPI mobile, nút CTA chính |
| `text-2xl` | 24px | giá trị KPI desktop (`font-semibold`) |
| `text-3xl` | 30px | số hero (Report summary) |

**Số liệu động bắt buộc `tabular-nums`** (chống nhảy chữ số gây rung màn hình khi tick 1s): thêm utility `font-variant-numeric: tabular-nums` vào class của mọi value động (KPI, bảng, gauge, chart tooltip). **runId/timestamp/mã lỗi dùng `font-mono`** (monospace mặc định Tailwind) + `tracking-tight`.

**Phân cấp dữ liệu (màn dày đặc):** value chính to + đậm + `tabular-nums`, label nhỏ `text-xs text-muted-foreground`, card border mờ `border-border`. Không dùng > 3 cỡ chữ trong 1 card.

### 1.3 Spacing & layout constants

- **Spacing**: dùng scale Tailwind sẵn có (4px base). Quy ước: padding trang `p-4` (desktop `p-6`), gap giữa section `space-y-4`, gap field trong form `space-y-3`, grid KPI `gap-3`.
- **Breakpoint**: `sm 640`, `md 768`, `lg 1024` (desktop-enhanced), `xl 1280`. Desktop-enhanced chỉ áp dụng cho màn 1/2/4/5/6/7 như UX doc; dưới 1024px luôn baseline 1 cột.
- **Safe-area (iOS)**: mọi thanh sticky (bottom nav, bottom CTA) có `pb-[env(safe-area-inset-bottom)]`; header sticky có `pt-[env(safe-area-inset-top)]` khi viewport mobile.
- **Thumb-zone**: vùng 50–90% chiều cao màn hình. CTA chính (Bắt đầu/Dừng/Kill) nằm ở **bottom sticky bar**: `fixed bottom-0 inset-x-0 z-40 border-t border-border bg-background/80 backdrop-blur` + `px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]`.
- **Sticky header run** (màn 1/2 khi run chạy): `sticky top-0 z-40 glass` — chứa badge phase + elapsed + cụm điều khiển (Tạm dừng / Dừng / log) — **truy cập được từ mọi màn khi run chạy** (UX-FLOW quy tắc nav #2).
- **Touch target**: tối thiểu **44px** (mọi nút/select/chip), CTA thumb-zone **48px** (`min-h-12`). Chip preset `min-h-11` (44px). Icon button `size="icon"` có sẵn h-10 = 40px — **tăng lên `h-11 w-11` cho icon có chức năng độc lập** (pause/stop/log) hoặc bọc trong vùng chạm 44px.

### 1.4 Component mới cần thêm (spec đầy đủ, chuẩn shadcn/ui)

Thêm vào `src/components/ui/`, đúng pattern file hiện có: CVA + Radix + `cn()` + forwardRef + kèm export default variants.

| # | Component | Dependency | Spec tối thiểu |
|---|---|---|---|
| 1 | `select.tsx` | `@radix-ui/react-select` | Trigger styled như `Input` (border-input, h-10, flex justify-between, `ChevronDown` icon size-4 text-muted-foreground); Content: `bg-popover text-popover-foreground border border-border rounded-md shadow-lg z-50`; Viewport dùng `ScrollArea` max-h 240px; Item: px-3 py-2 text-sm focus `bg-secondary`; ItemIndicator `Check` icon. Hỗ trợ `placeholder`, `disabled`, `aria-label` |
| 2 | `switch.tsx` | `@radix-ui/react-switch` | Thumb 20px; Track: `h-6 w-11 rounded-full bg-secondary data-[state=checked]:bg-primary`; kèm `aria-label` bắt buộc từ caller |
| 3 | `tabs.tsx` | `@radix-ui/react-tabs` | List: `inline-flex h-10 items-center gap-1 border-b border-border`; Trigger: `-mb-px px-4 py-2 text-sm text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary` |
| 4 | `tooltip.tsx` | `@radix-ui/react-tooltip` | Content: `bg-popover text-popover-foreground border border-border rounded-md px-3 py-1.5 text-xs shadow-md z-50`; delayDuration 300 |
| 5 | `table.tsx` | — (không dependency) | Primitives: Table (w-full caption-bottom text-sm), TableHeader, TableBody, TableRow (`border-b border-border`), TableHead (`h-10 px-3 text-left text-xs text-muted-foreground font-medium`), TableCell (`p-3 align-middle`). Toàn bộ số dùng `tabular-nums` |
| 6 | `stat-card.tsx` | recharts (sparkline) | Props: `{ title: string; value: string \| number; unit?: string; delta?: number; trend?: 'up' \| 'down' \| 'flat'; sparkline?: number[]; variant?: 'default' \| 'success' \| 'warning' \| 'error' \| 'info'; hint?: string }`. Render: Card → label `text-xs text-muted-foreground` → value `text-2xl font-semibold tabular-nums` (mobile text-lg) → delta row (icon `TrendingUp/Down/Minus` size-4 + màu variant; không animation) → sparkline (recharts `LineChart` cỡ ~60×24, `isAnimationActive={false}`, stroke `hsl(var(--primary))`, fillOpacity 0.15 Area, không tooltip). `hint` hiện qua Tooltip |
| 7 | `gauge.tsx` | — (SVG thuần, không cần recharts) | Props: `{ label: string; value: number; min?: 0; max?: 100; okThreshold: number; warnThreshold: number; format?: (v) => string; colorOnly?: false }`. Render: SVG arc 270° (circle stroke-dasharray, rotate -225°), track `--secondary`, value arc màu theo ngưỡng (≥ ok → success, ≥ warn → warning, còn lại → destructive). **Luôn hiển thị số lớn giữa** `text-2xl font-semibold tabular-nums` + label. Dưới arc: text trạng thái ("Đạt ngưỡng" / "Cảnh báo" / "Dưới ngưỡng") — không dựa màu đơn thuần. `role="img"` + `aria-label` tóm tắt số liệu |
| 8 | `progress.tsx` | `@radix-ui/react-progress` | Track `h-2 w-full rounded-full bg-secondary`; Indicator `bg-primary transition-none data-[state=...]` — **không animation transition** cho giá trị tick 1s |
| 9 | `chip-group.tsx` | — (Button + aria-pressed) | Props: `{ options: { value: string; label: string; warning?: boolean; disabled?: boolean }[]; value?: string; onChange: (v) => void; ariaLabel: string; size?: 'default' \| 'lg' }`. Render: `role="radiogroup"`, mỗi chip là `Button variant={active ? 'default' : 'outline'} aria-pressed` + `min-h-11`; chip có `warning` thêm icon `TriangleAlert` size-4 text-warning + Tooltip nội dung cảnh báo. Khi `disabled`: `disabled:opacity-50 disabled:cursor-not-allowed` |
| 10 | `alert-banner.tsx` | — | Props: `{ variant: 'destructive' \| 'warning' \| 'info' \| 'success'; title: string; description?: string; action?: { label: string; onClick: () => void }; dismissible?: boolean; onDismiss?: () => void }`. Render: div `rounded-lg border px-4 py-3` + màu variant (destructive: `border-destructive/40 bg-destructive/10 text-destructive`; warning: `border-warning/40 bg-warning/10 text-warning`; info: `border-info/40 bg-info/10 text-info`; success: `border-success/40 bg-success/10 text-success`), icon theo variant (CircleAlert / TriangleAlert / Info / CircleCheck), title `font-medium text-sm`, description `text-xs` + `role="alert"` **bắt buộc** (aria-live assertive). Action là `Button variant="link"` cỡ sm |

**Dependencies cần thêm vào `package.json`:**

```json
"dependencies": {
  "recharts": "^2.15.0",
  "@radix-ui/react-select": "^2.1.2",
  "@radix-ui/react-switch": "^1.1.1",
  "@radix-ui/react-tabs": "^1.1.1",
  "@radix-ui/react-tooltip": "^1.1.3",
  "@radix-ui/react-progress": "^1.1.0",
  "@tanstack/react-virtual": "^3.10.9"
}
```

(`@tanstack/react-virtual` dùng cho bảng lỗi đầy đủ + danh sách user v1.1.)

**CẤM (hard rules hiệu năng):**
- Không dùng `framer-motion` cho chart/KPI/bảng (đã có trong deps nhưng chỉ cho phase badge pulse).
- Mọi series recharts: `isAnimationActive={false}`.
- StatCard delta: không transition, không animation; icon tĩnh.
- KPI/chart không dùng `motion.div` wrapper.

---

## 2. Shell chung (AppShell) & điều hướng

**Component mới: `src/components/loadtest/app-shell.tsx`** — layout dùng chung toàn bộ route `/loadtest/*`:

```
AppShell
├─ RunStickyHeader            (chỉ render khi run ≠ idle: badge phase + elapsed + [Tạm dừng][Dừng][log])
├─ <Outlet />                 (content theo route)
└─ MobileBottomNav / DesktopTopNav   (theo breakpoint: lg ẩn bottom, hiện top)
```

**Routes (thêm vào `src/lib/env.ts` `routes`):**

| Route | Màn |
|---|---|
| `/loadtest` | Màn 1 Control Panel |
| `/loadtest/live` | Màn 2 Live Dashboard |
| `/loadtest/users/:id` | Màn 3 User Detail (v1.1) |
| `/loadtest/scenario` | Màn 4 Scenario Builder |
| `/loadtest/report` | Màn 5 Report |
| `/loadtest/settings` | Màn 6 Settings |
| `/loadtest/cleanup` | Màn 7 Cleanup |

**Bottom nav (mobile, < 1024px)** — `fixed bottom-0 inset-x-0 z-40 border-t border-border bg-background/80 backdrop-blur` + safe-area: 4 tab: **Cấu hình** (`/loadtest`, icon Settings2), **Live** (`/loadtest/live`, icon Activity), **Báo cáo** (`/loadtest/report`, icon FileBarChart), **Cài đặt** (`/loadtest/settings`, icon SlidersHorizontal). Tab Báo cáo: `disabled` khi chưa có run kết thúc + Tooltip "Chưa có báo cáo — chạy run đầu tiên". Active tab: `text-primary` + icon fill.

**Top nav (desktop ≥ 1024px)** — `sticky top-0 z-40 glass border-b border-border`: logo text "MAYogu LoadTest" (brand-text) + nav links + badge run state bên phải.

**Data layer: `src/store/loadtest-store.ts`** (zustand) — single source, spec Mục 4.1.

---

## 3. Từng màn MVP

> Quy ước: `[bottom]` = sticky bottom thumb-zone; `(chip)` = ChipGroup; `[box]` = Input/Select. Component tree là cây JSX thực tế dev phải dựng — props nêu đủ, phần tử thiếu => dev tự quyết định theo shadcn chuẩn, không hỏi lại.

---

### MÀN 1 — Control Panel (`/loadtest`) — MVP

**Layout mobile (baseline, 1 cột):**

```
[Sticky header] MAYogu LoadTest            (chip: IDLE)
[Bottom nav]   Cấu hình | Live | Báo cáo | Cài đặt
── content ──────────────────────────────────────────
1. PRESET                      → ChipGroup 5 chip + Custom
2. CẤU HÌNH RUN                → Card form 4 field
3. Banner cảnh báo hạ tầng     → AlertBanner (nếu cần)
4. ƯỚC LƯỢNG                   → Card estimate (3 stat nhỏ)
5. TỔNG QUAN NHANH (khi chạy)  → Card 3 StatCard
6. [bottom] [BẮT ĐẦU]          → sticky, 48px
```

**Layout desktop (≥ 1024px, grid-cols-12):** cột trái `lg:col-span-4`: Preset + Form + Confirm; cột phải `lg:col-span-8`: banner hạ tầng + Ước lượng + Tổng quan nhanh + **PhaseTimeline dạng thanh ngang** (Progress segments: provisioning → ramping → steady → cooldown, segment active sáng primary + label, xong chuyển success). CTA giữ sticky bottom full-width (không nhảy vị trí).

**Component tree:**

```
<ControlPanelPage>
├─ <RunStateBadge phase={phase} />            // idle=secondary, provisioning=warning pulse,
│                                             // ramping=primary, steady=success, cooldown=warning,
│                                             // finished=secondary, error=destructive
├─ <ChipGroup ariaLabel="Preset target"
│     options={[{value:'10k',label:'10k'},…,{value:'1M',label:'1M',warning:true},
│               {value:'10M',label:'10M',warning:true},{value:'custom',label:'Custom'}]}
│     value={preset} onChange={setPreset} />  // 1M/10M: icon TriangleAlert + Tooltip hạ tầng
├─ <Card>  // "CẤU HÌNH RUN" — disabled toàn bộ khi run ≠ idle
│  ├─ <Label>Target users</Label>
│  │   <Input type="number" min={1000} step={1000} value={target} />
│  │   // error text-xs text-destructive khi target > maxDuration*ramp (đổi ra user)
│  ├─ <Label>Ramp-up</Label>
│  │   <div className="flex gap-3">
│  │     <Select value={rampRate} options={[100,200,500,1000,'max']} />   // "/s"
│  │     <Select value={rampMode} options={['theo tốc độ','trong X phút']} />
│  │   </div>
│  ├─ <Label>Duration</Label>
│  │   <Select value={durationMin} options={[5,10,15,30,45,60]} />  // phút
│  │   // 60 = "60 phút (tối đa — access token 1h)", hint info icon
│  ├─ <Label>Action profile</Label>
│  │   <Button variant="outline" className="w-full justify-between" onClick={→/loadtest/scenario}>
│  │     chat 40 / read 30 / comment 20 / like 10   <ChevronRight/>
│  │   </Button>
│  ├─ <Label>Gateway (test)</Label>
│  │   <Input readOnly value={gatewayUrl} />   // readonly — sửa ở Settings
│  └─ <Button variant="ghost" size="sm">Chỉnh sửa kịch bản (YAML)</Button>
├─ <AlertBanner variant="warning" title="Preset 1M cần ~32–40 workers + ≥64GB RAM"
│     description="Máy hiện tại (~16 core / 64GB) chỉ đủ cho ≤ 100k. Đóng banner này chỉ có hiệu lực cho phiên này."
│     dismissible action={undefined} />         // 1M/10M bắt buộc hiện; không lưu dismiss vĩnh viễn
├─ <Card>  // "ƯỚC LƯỢNG" — tính client-side từ target/ramp, cập nhật realtime khi đổi field
│  ├─ <StatCard title="Workers" value={estWorkers} unit="workers" />
│  ├─ <StatCard title="RAM ước tính" value={estRamGB} unit="GB" />
│  ├─ <StatCard title="Thời gian seat ước tính" value={estSeatMin} unit="phút"
│  │     hint="Matching engine ~100 user/s (MAX_POP=200/2s)" />
│  └─ // estSeatMin = ceil(target / 100 / 60); workers = ceil(target/10000); RAM = target*60KB
├─ <Card hidden={phase==='idle'}>  // "TỔNG QUAN NHANH" — 3 StatCard, cập nhật 1s tick
│  ├─ <StatCard title="User đã tạo" value={usersCreated} sparkline={…} />
│  ├─ <StatCard title="Đã connect" value={usersConnected} variant="info" />
│  └─ <StatCard title="Active" value={usersActive} variant="success" />
└─ [bottom CTA]
   ├─ phase==='idle'    → <Button size="lg" className="w-full min-h-12" onClick={openConfirm}
   │                       disabled={allowlistFail || targetInvalid}>BẮT ĐẦU</Button>
   ├─ phase∈{provisioning,ramping,steady} → <div className="flex gap-3">
   │     <Button variant="outline" className="flex-1 min-h-12" onClick={pause}>Tạm dừng</Button>
   │     <Button variant="destructive" className="flex-1 min-h-12" onClick={openStop}>Dừng</Button>
   │   </div>  + đồng hồ elapsed text-lg tabular-nums ngay trên CTA
   └─ phase∈{cooldown,finished,error} → nút ẩn, thay banner "Đang chốt số liệu..." / "Xem báo cáo >"
```

**Confirm modal — `Dialog` (component `StartRunConfirmDialog`):**

```
Title:    "CẢNH BÁO MÔI TRƯỜNG TEST"
Body:     "Bạn sắp chạy LOAD TEST trên:  ws://test-01.mayogu.test
           Tool sẽ tạo user thật và gửi traffic thật.
           KHÔNG BAO GIỜ chạy trên production."
          + nếu preset 1M/10M: AlertBanner destructive trong modal
            "Preset 1M/10M vượt năng lực 1 máy — cần cluster (v1.1).
             Chạy trên máy này sẽ không đạt target và có thể quá tải tool."
Label:    "Gõ chính xác chuỗi bên dưới để xác nhận:  TÔI XÁC NHẬN"
Input:    <Input placeholder="TÔI XÁC NHẬN" value={typed} />
Footer:   [Hủy (outline)] [Bắt đầu (default)]  — disabled cho tới khi typed.trim() === "TÔI XÁC NHẬN"
```

- Chặn cứng: chuỗi phải khớp **chính xác** (trim, so khớp cả dấu); confirm chỉ nhớ trong session — mỗi lần mở modal lại phải gõ lại.
- Bấm Bắt đầu trong modal → gửi lệnh start → `navigate('/loadtest/live')`.

**Kill-switch / Stop dialog (`StopRunConfirmDialog`)**: `role="alertdialog"` — title "DỪNG RUN?", body "Dừng toàn bộ worker ≤ 5s và disconnect socket ≤ 10s. Số liệu sẽ là partial.", nút `[Dừng ngay]` variant destructive **disabled + đếm ngược 5s** ("Dừng ngay (5s)"), nút [Hủy] outline.

**Trạng thái:**

| State | Nội dung cụ thể | Vị trí | Phục hồi |
|---|---|---|---|
| Loading (đọc config/allowlist) | 4 khối `Skeleton` (h-10) cho preset + form + estimate; nút Bắt đầu disabled | trong card | tự hết khi config load xong |
| Empty (chưa run) | ẩn "TỔNG QUAN NHANH"; hint text-muted dưới preset: "Cấu hình xong bấm Bắt đầu" | dưới preset | — |
| Error: gateway ngoài allowlist | AlertBanner destructive "Gateway không nằm trong danh sách test. Thêm vào Settings trước khi chạy." + nút action "Mở Settings >" | trên form | → /loadtest/settings |
| Error: target > năng lực | AlertBanner warning "Target vượt năng lực máy — run sẽ chậm hơn dự kiến" (KHÔNG chặn, user tự chịu) | dưới estimate | vẫn Bắt đầu được |
| Error: thiếu OTP_SECRET / Redis | AlertBanner destructive "Thiếu OTP_SECRET hoặc quyền ghi Redis — không thể register. Kiểm tra Settings." + nút "Mở Settings >" | trên form | → /loadtest/settings |
| Running | form `disabled` (opacity-50 pointer-events-none), CTA đổi cụm Tạm dừng/Dừng + elapsed | toàn màn | Tạm dừng / Dừng |

**Data binding:** đọc từ `loadtestStore`: `config` (preset, target, rampRate, rampMode, durationMin, profile, gatewayUrl), `phase`, `counters` (usersCreated/usersConnected/usersActive), `estimation` (tính client). Gửi: `startRun(config)`, `pauseRun()`, `resumeRun()`, `stopRun(force?)`.

---

### MÀN 2 — Live Dashboard (`/loadtest/live`) — MVP

**Layout mobile (thứ tự ưu tiên quan sát — UX doc):**

```
[Sticky header] LIVE: run abc123  (chip: steady)  01:23:45 (LIVE)
                [Tạm dừng] [Dừng]            [log] >
── content (space-y-4) ──────────────────────────────
1. KPI grid: grid-cols-2 gap-3 → 8 StatCard (mỗi card min-h-24)
2. ACTIVE CONNECTIONS      → ChartCard (line, range select 30m)
3. ACTIONS/S THEO LOẠI     → ChartCard (stacked area + legend chips)
4. LATENCY P50/P95/P99     → ChartCard (line + [log] toggle)
5. SUCCESS / ECHO          → 2 Gauge cạnh nhau (grid-cols-2)
6. Bottleneck banner       → AlertBanner warning + action "Xem bằng chứng"
7. TOP ERRORS              → Card bảng top 10 + "Xem tất cả >"
8. SERVER-SIDE (gateway)   → Card 2 StatCard (badge "5s")
[Bottom nav]
```

**Layout desktop (≥ 1024px, grid-cols-12):**
- Hàng 1 (full width): KPI `grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3`.
- Hàng 2: `lg:col-span-8` — Connections line; `lg:col-span-4` — 2 gauge + queue + rooms (stack dọc).
- Hàng 3: `lg:col-span-7` — Actions/s stacked; `lg:col-span-5` — Top errors + server metrics.
- Latency: `lg:col-span-12` full width hoặc ghép vào hàng 2 bên trái (đè trục) — **chọn: Latency đặt trong `lg:col-span-8` cùng hàng 2, dưới Connections**; hàng 2 phải tự `grid-cols-12` con.
- Bottleneck banner: `lg:col-span-12`.

**Component tree:**

```
<LiveDashboardPage>
├─ <RunStickyHeader />                    // badge phase + LIVE/FROZEN + elapsed + controls
├─ <KpiGrid>                              // 8 StatCard — data từ lastTick
│  ├─ <StatCard title="Connect" value={connections} sparkline={ring('connections')} />
│  ├─ <StatCard title="Active" value={activeUsers} variant="success" />
│  ├─ <StatCard title="Actions/s" value={actionsPerSecTotal} sparkline={…} />
│  ├─ <StatCard title="Success" value={successRate} unit="%" variant={rateVariant} />
│  ├─ <StatCard title="Echo" value={echoRate} unit="%" variant={rateVariant}
│  │     hint="Chat success = echo chat:message (clientMsgId)" />
│  ├─ <StatCard title="Queue" value={queueCount} hint="Matching ~100 user/s"
│  │     variant={queueTrend==='up' ? 'warning' : 'default'} />
│  ├─ <StatCard title="Rooms" value={roomCount} />
│  └─ <StatCard title="ws_server" value={server.wsConnections} hint="Gateway /metrics — 5s" />
├─ <ChartCard title="ACTIVE CONNECTIONS" actions={<RangeSelect/>}>
│   <ConnectionsLineChart />              // spec Mục 4.2
├─ <ChartCard title="ACTIONS/S THEO LOẠI">
│   <ActionsStackedAreaChart />           // spec Mục 4.3 + legend ChipGroup
├─ <ChartCard title="LATENCY P50/P95/P99" actions={<LogToggle/>}>
│   <LatencyLineChart />                  // spec Mục 4.4
├─ <div className="grid grid-cols-2 gap-3">
│  ├─ <Gauge label="Success rate" value={successRate} okThreshold={97} warnThreshold={90} />
│  └─ <Gauge label="Chat echo rate" value={echoRate} okThreshold={95} warnThreshold={90}
│        hint="Rate-limited (no echo) tách khỏi lỗi thật" />
├─ <AlertBanner variant="warning" title="Nghi vấn bottleneck: queue-count tăng liên tục > 5 phút"
│     description="Matching engine trần ~100 user/s (MAX_POP=200/2s)."
│     action={{label:'Xem bằng chứng', onClick: scrollToChart('queue')}} />
├─ <TopErrorsCard>                        // Table top 10: [mã lỗi mono][freq][nút Xem tất cả → Dialog]
├─ <ServerMetricsCard>                    // 2 StatCard + Badge "scrape 5s"
└─ <MobileBottomNav />
```

**ChartCard (component mới `chart-card.tsx`)**: Card chứa header (title text-base + actions phải) + wrapper chart `h-56 md:h-64 w-full relative`. Chart chỉ re-render khi dữ liệu slice của nó đổi — spec Mục 4.1.

**LIVE vs FROZEN (bắt buộc 3 kênh phân biệt):**

| Kênh | LIVE (run đang chạy) | FROZEN (đã dừng/finished) |
|---|---|---|
| Badge | `Badge` success, icon `Activity` + `animate-pulse` (tôn trọng prefers-reduced-motion) | `Badge` secondary "FROZEN" + icon `Pause` |
| Border | Card chart bình thường `border-border` | tất cả ChartCard thêm `ring-1 ring-border opacity-90` |
| Banner | không có | AlertBanner info "Run đã kết thúc — số liệu cuối cùng. [Xem báo cáo >]" |

**Trạng thái:**

| State | Nội dung | Vị trí | Phục hồi |
|---|---|---|---|
| Loading | toàn bộ ChartCard hiện khối `Skeleton` đúng chiều cao chart + text "Đang kết nối dữ liệu live..." | mọi chart | tự hết khi nhận tick đầu |
| Empty (run mới) | KPI hiện `--`; chart trống + empty-state "Chờ dữ liệu 1s đầu tiên..." (text-muted centered) | trong từng ChartCard | tự hết sau tick đầu |
| Error E9 (dashboard WS rớt) | AlertBanner warning "Đang kết nối lại dữ liệu live..." + chart đóng băng (giữ giá trị cuối) | top content | tự reconnect + sync snapshot (backlog ≤ 3s) |
| Error E1/E2 (auto-stop) | AlertBanner destructive "Run tự dừng: register fail > 50% (mã lỗi: OTP_INVALID 62%, THROTTLED 31%)" + action "Xem báo cáo >" | top content | → /loadtest/report |
| Error E3 (worker chết) | AlertBanner destructive "3/8 worker mất kết nối — đang tự restart" + KPI active tụt | top content | coordinator restart; >50% chết 60s → auto-stop → banner E1 |
| Frozen | như bảng LIVE/FROZEN | toàn màn | nút "Xem báo cáo >" |

**Data binding:** `loadtestStore.lastTick` (schema Mục 4.1) + `ringBuffer` (tối đa 3600 tick). Mỗi chart subscribe đúng slice qua selector zustand — **cấm** subscribe toàn store rồi tự lọc (gây re-render 100k events/s).

---

### MÀN 3 — User Detail / Inspect (`/loadtest/users/:id`) — **v1.1 (chỉ chốt khung)**

Layout: header `[<] User #4821 (email mono)` → Card TRẠNG THÁI (KeyValue 5 dòng: phase/worker/roomId/token/reconnect+outbox) → `Switch` "Theo dõi" → Card TIMELINE (200 event gần nhất, **virtualized** `@tanstack/react-virtual`, mỗi dòng `text-xs font-mono`: ts | SEND/RECV | event | kết quả) → hàng action `[Disconnect][Force leave][Xem log]` (v1.1).
Desktop: panel phải dạng `Dialog`/drawer từ Dashboard, không rời trang. States: loading skeleton; empty "Không tìm thấy user" + nút quay lại; error "User đã bị xóa / run đã dừng".

---

### MÀN 4 — Scenario Builder (`/loadtest/scenario`) — MVP

**Layout mobile:** header (tên file + `[Lưu][Load]`) → PROFILES card → PACING card (readonly) → EDITOR YAML → VALIDATE list → `[bottom] [Hủy] [Lưu & áp dụng]`.
**Desktop (≥ 1024px):** `lg:col-span-8` editor; `lg:col-span-4` profiles + pacing + validate.

**Component tree:**

```
<ScenarioBuilderPage>
├─ <Card> // header: Input value=fileName + Button outline "Lưu" + Button outline "Load"
├─ <Card title="PROFILES (tổng phải = 100%)">
│  ├─ 4 hàng: <Label>chat</Label> <Input type="number" min={0} max={100} /> %
│  ├─ // tổng ≠ 100 → AlertBanner warning "Tổng profile = 85% — cần đủ 100%"
│  └─ // tổng = 100 → Badge success "100%"
├─ <Card title="PACING">   // readonly theo rate-limit thật, icon Lock
│  ├─ text-sm: "chat send ≥ 2s/user | typing 1.5s | topic 15s | cooldown 900s"
│  └─ text-xs text-muted-foreground: "Khóa cứng theo hệ thống — không sửa được"
├─ <Card title="EDITOR YAML">
│  ├─ <Textarea className="font-mono text-xs leading-5 min-h-64" spellCheck={false}
│  │     value={yaml} onChange={setYaml} />   // MVP: chưa có line numbers (ghi chú v1.1)
│  └─ // YAML sai cú pháp → dòng đầu tiên vi phạm có class bg-destructive/10 + sonner toast
├─ <Card title="KIỂM TRA">
│  └─ danh sách dòng: <div className="flex gap-2"> <Badge variant="destructive">Lỗi</Badge>
│       <span className="text-sm">phase rampUp 300s → 100k/s vượt matching trần 100/s</span></div>
│     // Badge: destructive = lỗi chặn lưu; warning = cảnh báo
└─ [bottom] <div className="flex gap-3">
     <Button variant="outline" className="flex-1 min-h-12" onClick={→back}>Hủy</Button>
     <Button className="flex-1 min-h-12" disabled={hasErrors} onClick={saveAndApply}>
       Lưu & áp dụng</Button></div>
```

**Trạng thái:** Loading = skeleton editor + "Đang tải kịch bản mặc định..."; Empty = editor trống + nút "Tạo từ template" (ghost, giữa editor); Error = YAML sai cú pháp → highlight dòng + toast sonner `error`.

---

### MÀN 5 — Report (`/loadtest/report`) — MVP

**Layout mobile:** header (badge finished/stopped/error + khoảng thời gian + thực tế) → SUMMARY 4 StatCard (grid-cols-2) → LATENCY bảng → BOTTLENECK candidates → CẤU HÌNH snapshot → EXPORT → `[bottom] [Dọn dẹp dữ liệu test >]`.
**Desktop:** SUMMARY 1 hàng 4 cột; latency `lg:col-span-7` + bottleneck `lg:col-span-5`; config + export dưới full width.

**Component tree:**

```
<ReportPage runId={runId}>
├─ <Card> // header: Badge (finished=success / stopped=warning / error=destructive)
│         // "2026-08-03 01:00–01:30 (30 phút) | thực tế 28:41"  font-mono text-xs
├─ <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">   // SUMMARY
│  ├─ <StatCard title="User đã tạo" value={12,000} />
│  ├─ <StatCard title="Connect max" value={11,850} />
│  ├─ <StatCard title="Active max" value={9,102} />
│  ├─ <StatCard title="Actions" value={8.2M} />
│  ├─ <StatCard title="Success" value={98.2} unit="%" variant="success" />
│  └─ <StatCard title="Throughput đỉnh" value={4.4k} unit="act/s" />
├─ <Card title="LATENCY P50/P95/P99 THEO ACTION">
│   <Table>  // cột: action (font-mono) | p50 | p95 | p99 | success% | count
│           // p50/p95/p99: text-xs tabular-nums font-mono
│           // success < 95% → text-destructive; else text-foreground
├─ <Card title="BOTTLENECK CANDIDATES">
│  └─ mỗi candidate 1 Card con:
│     <Badge variant={level==='High'?'destructive':level==='Med'?'warning':'secondary'}>
│       High/Med/Low</Badge>
│     <p className="text-sm">queue-count tăng liên tục 12 phút</p>
│     <p className="text-xs text-muted-foreground">→ matching trần ~100 user/s (MAX_POP=200/2s)</p>
│     <Button variant="link" size="sm" onClick={openEvidence(i)}>Xem bằng chứng ></Button>
├─ <Card title="CẤU HÌNH RUN (snapshot)">   // KeyValue 6 dòng text-sm
├─ <Card title="EXPORT">
│  ├─ <Button variant="outline" onClick={exportJson}>JSON</Button>
│  ├─ <Button variant="outline">Markdown</Button>
│  ├─ <Button variant="outline">CSV</Button>
│  └─ <span className="text-xs text-muted-foreground">Lưu trữ 30 ngày theo runId</span>
└─ [bottom] <Button variant="outline" className="w-full min-h-12" onClick={→/loadtest/cleanup}>
     Dọn dẹp dữ liệu test ></Button>
```

**Evidence Dialog (`EvidenceDialog`)**: Dialog chứa `LineChart` vẽ từ ring buffer của run (downsampled ≤ 1800 điểm) + **ReferenceArea** đánh dấu vùng nghi vấn (fill `hsl(var(--warning) / 0.08)`) + legend "Vùng nghi vấn". isAnimationActive=false. Export thành công → toast `sonner.success("Đã xuất report-{runId}.json")` kèm đường dẫn.

**Trạng thái:** Loading = skeleton bảng + "Đang tổng hợp (≤ 30s)..."; Empty = chưa có run → Card centered + Button "Chạy run đầu tiên" → /loadtest; Error/partial = AlertBanner warning "Số liệu partial — run bị dừng thủ công (kill-switch)" ở top.

---

### MÀN 6 — Settings (`/loadtest/settings`) — MVP

**Layout mobile:** MOI TRUONG TEST (allowlist) → SECRETS/TEST ENV → GIOI HAN MAC DINH → AN TOAN → `[bottom] [Hủy] [Lưu cấu hình]`.
**Desktop:** form 2 cột `lg:grid-cols-12` — trái `lg:col-span-7`: môi trường + secrets; phải `lg:col-span-5`: giới hạn + an toàn.

**Component tree:**

```
<SettingsPage>
├─ <Card title="MÔI TRƯỜNG TEST (allowlist — chặn cứng SD-1)">
│  ├─ mỗi URL 1 hàng: <span className="font-mono text-sm">{url}</span>
│  │     <Button variant="ghost" size="sm" aria-label={`Xóa ${url}`}><X/></Button>
│  ├─ <div className="flex gap-2"> <Input placeholder="ws://test-…" /> <Button variant="secondary">Thêm</Button> </div>
│  └─ <p className="text-xs text-muted-foreground">URL ngoài danh sách sẽ bị chặn ở Màn 1</p>
├─ <Card title="SECRETS / TEST ENV">
│  ├─ <Label>OTP_SECRET path</Label>
│  │   <Input type="password" value={otpSecretPath} />  // + nút Eye/EyeOff toggle (h-9)
│  ├─ <Label>Redis (write)</Label>
│  │   <Input type="password" value={redisUrl} />       // + toggle
│  └─ <p className="text-xs text-muted-foreground">Chỉ hiển thị dạng đăng ký, không in giá trị</p>
├─ <Card title="GIỚI HẠN MẶC ĐỊNH">
│  ├─ <Label>register ramp</Label> <Input type="number" /> 
│  │   <p className="text-xs text-muted-foreground">req/s — guest bucket 1000/8s</p>
│  ├─ <Label>per-user pacing</Label> <Input type="number" /> 
│  │   <p className="text-xs text-muted-foreground">action/s max</p>
│  ├─ <Label>max duration</Label> <Input type="number" /> 
│  │   <p className="text-xs text-muted-foreground">phút — access token 1h</p>
│  └─ <Label>report retention</Label> <Input type="number" />  <p …>ngày</p>
├─ <Card title="AN TOÀN">
│  ├─ <div className="flex items-center justify-between">
│  │   <Label>Bắt buộc xác nhận môi trường trước khi chạy</Label> <Switch defaultChecked />
│  ├─ <div className="flex items-center justify-between">
│  │   <Label>Auto-cleanup sau run (v1.1)</Label> <Switch disabled />
│  └─ <Button variant="outline" onClick={→/loadtest/cleanup}>Mở công cụ Cleanup ></Button>
└─ [bottom] <div className="flex gap-3">
     <Button variant="outline" className="flex-1 min-h-12">Hủy</Button>
     <Button className="flex-1 min-h-12">Lưu cấu hình</Button></div>
```

**Trạng thái:** Loading = skeleton form (đọc config); Empty = allowlist rỗng → AlertBanner warning "Chưa có môi trường test nào — tool sẽ chặn mọi run" (dưới title allowlist); Error = secret file không đọc được → AlertBanner destructive + hint "Kiểm tra đường dẫn file, định dạng KEY=VALUE" (trên card secrets).

---

### MÀN 7 — Cleanup (`/loadtest/cleanup`) — MVP

**Layout mobile:** header (runId + `[Dry-run][Thực thi]`) → TIM THAY 4 StatCard → BUOC THUC HIEN (3 bước + status badge) → banner cảnh báo → `[bottom] [Quay lại] [Thực thi xóa]`.
**Desktop:** trái `lg:col-span-7` bảng tìm thấy; phải `lg:col-span-5` các bước.

**Component tree:**

```
<CleanupPage runId={runId}>
├─ <Card> // header: Badge runId + 2 nút: <Button variant="outline" className={dryMode && active}>Dry-run</Button>
│         //                       <Button variant="destructive" className={!dryMode && active}>Thực thi</Button>
├─ <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">   // TIM THẤY
│  <StatCard title="User" value={12,000} hint="email loadtest.{runId}.*" />
│  <StatCard title="Post/comment" value={8,140} hint="prefix [lt]" />
│  <StatCard title="Redis keys" value={23,512} hint="otp:register / match / chat" />
│  <StatCard title="Session/device" value={12,000} />
├─ <Card title="BƯỚC THỰC HIỆN (3 tầng, chạy tuần tự)">
│  ├─ StepRow 1 "API nghiệp vụ: delete user/post/comment"   <Badge status ok|fail|pending>
│  ├─ StepRow 2 "Redis: del key theo pattern namespace"     <Badge …>
│  └─ StepRow 3 "Kiểm tra baseline" — liệt kê 3 dòng con:
│     ✓ ZCARD match:queue:waiting = 0 (ok)   text-xs font-mono
│     ✓ user loadtest.* còn lại = 0 (ok)
│     ✓ post/comment [lt] còn lại = 0 (ok)
│  // StepRow status: pending=secondary, ok=success, fail=destructive;
│  // fail → dừng chuỗi, cho "Chạy lại từ bước lỗi" (idempotent)
├─ <AlertBanner variant="destructive" title="Cảnh báo: 23,512 redis keys sẽ bị xóa. Tiếp tục?"
│     description="Dry-run chỉ đọc và hiển thị — không xóa gì." />
└─ [bottom] <div className="flex gap-3">
     <Button variant="outline" className="flex-1 min-h-12" onClick={→back}>Quay lại</Button>
     <Button variant="destructive" className="flex-1 min-h-12" disabled={!scanDone || executing}>
       {dryMode ? 'Chạy dry-run' : 'Thực thi xóa'}</Button></div>
```

**Trạng thái:** Loading = skeleton bảng + "Đang quét dữ liệu test..."; Empty = Badge success "Không tìm thấy dữ liệu test — hệ thống sạch" (Card centered); Error = baseline check fail → AlertBanner destructive liệt kê thứ còn sót (3 dòng) + nút "Chạy lại". Xong sạch → toast success + nút "Về Control Panel".

---

## 4. Chart spec — Live Dashboard

### 4.1 Data contract (dashboard ↔ coordinator, WebSocket)

Push **1 tick/1s** (`type: 'tick'`), coordinator aggregate từ worker qua IPC (PRD DB-1). Độ trễ ≤ 3s (AC5.1).

```ts
interface LoadTestTick {
  type: 'tick';
  runId: string;
  ts: number;                 // epoch ms — dùng làm trục X
  phase: 'provisioning' | 'ramping' | 'steady' | 'cooldown' | 'finished' | 'error' | 'stopped';
  elapsedSec: number;
  counters: {
    usersCreated: number; usersConnected: number; usersActive: number;
    actionsTotal: number; successTotal: number; failTotal: number;
    echoOk: number; echoSent: number;          // chat success = echo khớp clientMsgId
    queueCount: number; roomCount: number;
    droppedOutbox: number;                     // outbox đầy — cảnh báo backpressure
  };
  rates: { successRate: number; echoRate: number };       // 0–100
  actionsPerSec: Record<ActionType, number>;  // ActionType = chat|read|comment|like|view|typing|topic|vote_kick
  latency: { p50: number; p95: number; p99: number };     // ms — tổng hợp toàn run MVP
  errors: { code: string; count: number }[];  // top 10, giảm dần
  server: { wsConnections: number; wsMessagesEmitted: number; wsMessagesPerSec: number };
  workers: { alive: number; total: number; cpuAvg: number };
}
```

**Store (zustand `loadtestStore`):**
- `lastTick: LoadTestTick | null` — 1 phần tử cuối.
- `ring: number[]` + `ticks: LoadTestTick[]` — **ring buffer cố định 3600 tick** (1 giờ @1s); quá cũ → ghi đè vòng tròn.
- `wsStatus: 'connecting' | 'live' | 'reconnecting' | 'offline'`.
- Mỗi component subscribe bằng selector lấy đúng slice + `useShallow` — **cấm subscribe `state => state`**.
- `React.memo` wrapper mọi chart; props truyền là **primitive/array đã transform** (transform trong selector hoặc `useMemo`, không transform trong render).

### 4.2 ConnectionsLineChart — line

| Thuộc tính | Giá trị |
|---|---|
| Chart | `LineChart` (recharts) |
| Series | **tối đa 2**: `connections` (--chart-2, solid, strokeWidth 1.5), `activeUsers` (--chart-1, solid 1.5) |
| Trục X | `ts` epoch ms, `type="number"`, `domain={['dataMin','dataMax']}`, tickFormatter `HH:MM:SS`, tick 12px, `minTickGap 48`, tickMargin 6 |
| Trục Y | linear, width 44, tickFormatter compact (`1.2k`), `allowDecimals={false}` |
| Điểm | `dot={false}`, `activeDot={{r:3}}` |
| Tooltip | custom `ChartTooltip` (1 điểm duy nhất — không shared/sync với chart khác) |
| Animation | `isAnimationActive={false}` |
| Refresh | dữ liệu mới mỗi tick 1s; chart vẽ toàn bộ dải `ring` trong range đang chọn |
| Range | Select 5m / 15m / 30m / 1h / Tất cả — client cắt mảng, không hỏi lại server |

### 4.3 ActionsStackedAreaChart — stacked area

| Thuộc tính | Giá trị |
|---|---|
| Chart | `AreaChart`, mỗi action 1 `<Area stackId="a" …>` |
| Series | **tối đa 8** (MVP render 5–6 action đang chạy): chat=--chart-1, read=--chart-2, comment=--chart-3, like=--chart-4, view=--chart-5, typing=--chart-7, topic=--chart-6, vote_kick=--chart-8 |
| Style | `fillOpacity 0.85`, stroke cùng hue `strokeOpacity 0.6`; **không** strokeDasharray (area phân biệt bằng hue + legend) |
| Legend | `ChipGroup` (toggle hiện/ẩn series — state local; ẩn = xóa khỏi stack, KHÔNG set opacity 0 để tránh vẽ thừa) + tổng "actions/s: 4,120" |
| Trục X/Y | giống 4.2 (Y: linear) |
| Tooltip | hiển thị từng series + tổng hàng "Tổng" |

### 4.4 LatencyLineChart — line, log-scale toggle

| Thuộc tính | Giá trị |
|---|---|
| Chart | `LineChart` |
| Series | **cố định 3**: P50 = --chart-2 `solid`, P95 = --chart-1 `strokeDasharray="6 4"`, P99 = --chart-6 `strokeDasharray="2 3"` — phân biệt bằng dash pattern + legend chữ, KHÔNG chỉ màu |
| Trục Y | linear mặc định; toggle `[log]` → `scale="log"` domain `[1, max*1.1]`; unit ms |
| Tooltip | 1 điểm: 3 dòng "P50 120ms / P95 480ms / P99 1.2s" |
| Animation | `isAnimationActive={false}` |

### 4.5 Gauge — success/echo (Mục 1.4 #7)

SVG arc 270°, track `--secondary`, value arc màu theo ngưỡng; số lớn giữa `tabular-nums`; text trạng thái dưới (không màu đơn thuần). Ngưỡng mặc định: successRate ok ≥ 97 / warn ≥ 90; echoRate ok ≥ 95 / warn ≥ 90.

### 4.6 Heatmap — **v1.1 (spec trước, không render MVP)**

`ErrorDensityHeatmap`: hàng = top 8 mã lỗi, cột = bucket 10s trong range chọn; cell màu scale `--muted` → `--destructive` theo opacity (4 bậc alpha 0.25/0.5/0.75/1), giá trị count hiện qua Tooltip + text trong cell khi count > 0. MVP giữ chart error rate dạng line (đơn giản, đủ AC5.2); heatmap gắn toggle "Xem heatmap" (ẩn mặc định).

### 4.7 Bảng lỗi — Table + virtualized

- MVP: Table hiện **top 10** (`text-xs tabular-nums font-mono` cho mã lỗi); nút "Xem tất cả >" mở `Dialog` chứa danh sách đầy đủ **virtualized** bằng `@tanstack/react-virtual` (fixed row 40px, container max-h 60vh, tối đa 500 dòng).
- v1.1: danh sách user (`UserTable`) cũng virtualized cùng pattern — dùng cho Màn 3 và "danh sách active users" từ Dashboard.

### 4.8 Hiệu năng — checklist bắt buộc (AC5.4)

1. `isAnimationActive={false}` trên MỌI chart series; không `framer-motion` trên chart/KPI.
2. `React.memo` mọi chart; subscribe slice qua zustand selector + `useShallow`.
3. Chart wrapper height cố định (`h-56 md:h-64`) — không để recharts đo lại mỗi tick.
4. Downsampling: coordinator 1s sẵn; client range 1h/Tất cả → `maxPoints 1800` (lấy mẫu đều, không lọc min/max gây sai dạng).
5. Tooltip chỉ render khi hover (không active mặc định), 1 điểm duy nhất.
6. Không `ResponsiveContainer` bọc nhiều chart chung parent re-render — mỗi chart 1 container riêng.
7. Ring buffer 3600 tick cố định — không giữ vô hạn.

---

## 5. Interaction & A11y

### 5.1 Touch & thumb-zone

- Mọi nút/select/chip/switch ≥ **44px** chiều cao; CTA thumb-zone **48px** (`min-h-12`). Icon nút độc lập ≥ 44px (`h-11 w-11`).
- Thao tác chính (Bắt đầu/Dừng/Tạm dừng/Kill/Thực thi xóa) nằm **bottom sticky** (50–90% màn hình), không đặt dưới cùng nội dung cuộn.
- Khoảng cách giữa các nút liền kề ≥ 8px (tránh bấm nhầm Dừng thay vì Tạm dừng).
- Dừng/Kill-switch không bao giờ là nút duy nhất cạnh nhau với Bắt đầu (khi run: chỉ cụm Tạm dừng/Dừng).

### 5.2 Confirm modal chặn cứng

| Tình huống | Modal | Cơ chế chặn |
|---|---|---|
| Bắt đầu (mọi run) | `StartRunConfirmDialog` | Bắt đầu disabled đến khi gõ đúng **"TÔI XÁC NHẬN"** (trim, có dấu) — không phải checkbox; confirm session-only |
| Preset 1M/10M | cùng modal + AlertBanner destructive hạ tầng bên trong | vẫn phải gõ chuỗi; cộng thêm banner không đóng được vĩnh viễn (đóng = hết phiên) |
| Gateway ngoài allowlist | không mở modal | ẩn hẳn nút Bắt đầu + banner destructive |
| Dừng run (chủ động) | `StopRunConfirmDialog` | nút "Dừng ngay" disabled + đếm ngược 5s |
| Kill-switch (khẩn) | `role="alertdialog"` | đếm ngược 5s, focus vào nút đếm ngược |

### 5.3 A11y (WCAG AA trên nền tối)

1. **Tương phản**: mọi semantic color ≥ 4.5:1 trên `--background` (đã verify Mục 1.1). Chart line không yêu cầu 4.5 nhưng legend/nhãn dùng `--foreground`/`--muted-foreground`.
2. **Banner**: mọi `AlertBanner` có `role="alert"` (live region assertive). Không dùng toast thoáng qua cho lỗi ảnh hưởng run.
3. **Focus**: giữ `focus-visible:ring-2 ring-ring ring-offset-2` (chuẩn button hiện có) cho MỌI component mới; Radix Dialog/Tooltip/Select/Modal kế thừa focus trap sẵn.
4. **aria-label**: mọi icon-button (pause/stop/log/Eye toggle/Xóa URL) có `aria-label`; ChipGroup `role="radiogroup"` + chip `aria-pressed`; chart wrapper `role="img"` + `aria-label` tóm tắt (vd "Biểu đồ kết nối, giá trị mới nhất 11,982"); gauge `role="img"` + aria-label số.
5. **Live region**: KPI giá trị `aria-live="off"` (update 1s quá dày); chỉ thông báo qua `role="alert"` khi phase đổi / bottleneck / auto-stop.
6. **Không phụ thuộc màu**: trạng thái luôn có chữ/badge/shape (gauge có text, P-series có dash pattern, step status có icon Check/X + text ok/fail).
7. **prefers-reduced-motion**: tắt `animate-pulse` trên LIVE badge, không animation nào khác tồn tại trên màn này (đã cấm).
8. **Bảng**: `th` có scope; sắp xếp (v1.1) dùng `aria-sort`.
9. **Form**: mọi Input/Select có `Label` liên kết (`htmlFor`/Radix) + error text liên kết `aria-describedby`.

---

## 6. Thứ tự triển khai UI (đề xuất theo đợt)

> Phụ thuộc cốt lõi: Màn 2 cần chart palette (đợt 1) trước khi dựng chart. Mỗi đợt ra 1 PR nhỏ, test được ngay bằng mock tick.

| Đợt | Nội dung | Phụ thuộc | Màn |
|---|---|---|---|
| **1 — Foundation** | Thêm deps (recharts, Radix select/switch/tabs/tooltip/progress, react-virtual); token HSL mới (1.1); font CJK (1.2); 10 component mới (1.4); `AppShell` + bottom/top nav + routes; `loadtestStore` với mock tick (setInterval 1s fake data) | — | shell |
| **2 — Control Panel** | Màn 1: preset chips, form, estimate, banner, `StartRunConfirmDialog` (chặn cứng), `StopRunConfirmDialog` (đếm ngược), CTA thumb-zone, phase badge | Đợt 1 | 1 |
| **3 — Live Dashboard** | Màn 2: KPI grid, 4 chart (4.2–4.4), 2 Gauge, top errors + Dialog virtualized, banner bottleneck, LIVE/FROZEN, sticky run header | Đợt 1 (palette) | 2 |
| **4 — Report** | Màn 5: summary, latency table, bottleneck candidates + EvidenceDialog (ReferenceArea), export, partial banner | Đợt 1 | 5 |
| **5 — Settings + Cleanup** | Màn 6 (allowlist, secrets password + Eye, giới hạn, Switch) + Màn 7 (scan summary, 3-tầng step badges, dry-run/thực thi, baseline check) | Đợt 1 | 6, 7 |
| **6 — Scenario Builder** | Màn 4: profiles %, pacing readonly, YAML Textarea + validate list, Lưu & áp dụng | Đợt 1 | 4 |
| **7 — v1.1** | Màn 3 User Detail (virtualized timeline), ErrorDensityHeatmap (4.6), UserTable virtualized, top-nav desktop polish | Đợt 3 | 3 + nâng cấp |

**Khuyến nghị nhập cụm:** Đợt 1+2 = PR đầu tiên ("tool chạy được 1 nút"), Đợt 3 = PR quan sát, Đợt 4–6 = PR báo cáo/vận hành, Đợt 7 = v1.1.

---

## 7. Tham chiếu

- PRD: `docs/PRD-loadtest-tool.md` (CP-1…CP-5, DB-1…DB-7, RE-1…RE-3, SD-1…SD-4, AC5.1–5.4, AC6.1–6.3, AC7.1–7.5).
- UX-FLOW: `docs/UX-FLOW-loadtest-tool.md` (wireframe ASCII 7 màn, bảng nhánh lỗi E1–E11, ghi chú chuyển giao mục (e)).
- Design system hiện trạng: `src/index.css` (token HSL), `src/components/ui/` (13 component có sẵn), `src/lib/env.ts` (routes), `package.json`.
