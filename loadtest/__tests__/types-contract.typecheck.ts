/**
 * T-11 (G-3) — TYPE 2-CHIỀU (compile-time half): `src/types/loadtest.ts` ↔ `loadtest/types.ts`.
 *
 * Gán chéo 2 chiều (structural): nếu 1 bên thêm field bắt buộc / đổi union / đổi type,
 * `npm run loadtest:typecheck` (tsc -p loadtest/tsconfig.json) sẽ FAIL → contract vỡ được bắt ngay.
 * (Comment cũ ghi "phải khớp" — nay thành test thật.)
 *
 * Runtime half (giá trị hằng số) ở `types-contract.test.ts`.
 *
 * CÁC TYPE CỐ Ý KHÔNG NẰM TRONG LIST (chênh lệch có chủ đích, đừng thêm vào):
 * - `ErrorSample.action`: src là `string` (UI hiển thị lỏng — các loại lỗi register/login/connect),
 *   loadtest là union cụ thể `ActionType | 'register' | 'login' | 'connect'`. KHÔNG yêu cầu khớp 2 chiều.
 * - `RunStatus` / `LoadTestConfig` / `LoadtestAdminUser` / `CleanupResult`…: chỉ frontend có (đọc thêm từ API admin/history).
 */
import type * as LT from '../types';
import type * as SRC from '../../src/types/loadtest';

// ─── RunPhase: union phải khớp CHÍNH XÁC 2 chiều (thêm phase 1 bên → fail) ───
declare const srcRunPhase: SRC.RunPhase;
export const runPhaseBackend: LT.RunPhase = srcRunPhase;
declare const ltRunPhase: LT.RunPhase;
export const runPhaseFrontend: SRC.RunPhase = ltRunPhase;

// ─── ActionType ───
declare const srcActionType: SRC.ActionType;
export const actionTypeBackend: LT.ActionType = srcActionType;
declare const ltActionType: LT.ActionType;
export const actionTypeFrontend: SRC.ActionType = ltActionType;

// ─── ActionProfile ───
declare const srcProfile: SRC.ActionProfile;
export const profileBackend: LT.ActionProfile = srcProfile;
declare const ltProfile: LT.ActionProfile;
export const profileFrontend: SRC.ActionProfile = ltProfile;

// ─── StartRunRequest (body POST /api/loadtest/start) ───
declare const srcStartReq: SRC.StartRunRequest;
export const startReqBackend: LT.StartRunRequest = srcStartReq;
declare const ltStartReq: LT.StartRunRequest;
export const startReqFrontend: SRC.StartRunRequest = ltStartReq;

// ─── RunConfig ───
declare const srcRunConfig: SRC.RunConfig;
export const runConfigBackend: LT.RunConfig = srcRunConfig;
declare const ltRunConfig: LT.RunConfig;
export const runConfigFrontend: SRC.RunConfig = ltRunConfig;

// ─── LoadTestTick (tick 1s — UI-SPEC §4.1, polling dashboard) ───
declare const srcTick: SRC.LoadTestTick;
export const tickBackend: LT.LoadTestTick = srcTick;
declare const ltTick: LT.LoadTestTick;
export const tickFrontend: SRC.LoadTestTick = ltTick;

// ─── ActionReport (RE-1) ───
declare const srcActionReport: SRC.ActionReport;
export const actionReportBackend: LT.ActionReport = srcActionReport;
declare const ltActionReport: LT.ActionReport;
export const actionReportFrontend: SRC.ActionReport = ltActionReport;

// ─── BottleneckCandidate (RE-2) ───
declare const srcBottleneck: SRC.BottleneckCandidate;
export const bottleneckBackend: LT.BottleneckCandidate = srcBottleneck;
declare const ltBottleneck: LT.BottleneckCandidate;
export const bottleneckFrontend: SRC.BottleneckCandidate = ltBottleneck;

// ─── RunReport (report cuối — frontend đọc qua GET /api/loadtest/report & /runs/{id}) ───
// loadtest thêm noPostFixtureSkipped? (optional — T-07/S-12) — optional field không phá khớp 2 chiều.
declare const srcReport: SRC.RunReport;
export const reportBackend: LT.RunReport = srcReport;
declare const ltReport: LT.RunReport;
export const reportFrontend: SRC.RunReport = ltReport;

// ─── UserPhase (bảng users virtualized — 8 phase phải khớp 2 chiều) ───
declare const srcUserPhase: SRC.UserPhase;
export const userPhaseBackend: LT.UserPhase = srcUserPhase;
declare const ltUserPhase: LT.UserPhase;
export const userPhaseFrontend: SRC.UserPhase = ltUserPhase;

// ─── UserActionState (action đang chạy — union phải khớp 2 chiều) ───
declare const srcActionState: SRC.UserActionState;
export const actionStateBackend: LT.UserActionState = srcActionState;
declare const ltActionState: LT.UserActionState;
export const actionStateFrontend: SRC.UserActionState = ltActionState;

// ─── VirtualUserRow (row GET /users — field bắt buộc 2 chiều, thêm field 1 bên → fail) ───
declare const srcUserRow: SRC.VirtualUserRow;
export const userRowBackend: LT.VirtualUserRow = srcUserRow;
declare const ltUserRow: LT.VirtualUserRow;
export const userRowFrontend: SRC.VirtualUserRow = ltUserRow;
