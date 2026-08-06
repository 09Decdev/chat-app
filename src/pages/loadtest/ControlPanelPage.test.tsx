/**
 * ControlPanelPage — guard UI production:
 * - gatewayUrl (từ config server) giống PRODUCTION → AlertBanner đỏ cảnh báo.
 * - URL test (.test/localhost) → không hiện banner.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ControlPanelPage from '@/pages/loadtest/ControlPanelPage';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LoadTestConfig } from '@/types/loadtest';

const storeState = vi.hoisted(() => ({
  config: null as LoadTestConfig | null,
  configLoading: false,
  configError: null,
  phase: 'idle',
  elapsedSec: 0,
  runId: '',
  lastTick: null,
  profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 },
  startRun: vi.fn(),
  stopRun: vi.fn(),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  resetRun: vi.fn(),
  requireEnvConfirm: true,
  paused: false,
  loadConfig: vi.fn(),
}));

vi.mock('@/store/loadtest.store', () => ({
  useLoadtestStore: (selector: (s: unknown) => unknown) => selector(storeState),
}));

function makeConfig(gatewayUrl: string, allowlist: string[]): LoadTestConfig {
  return {
    port: 3401,
    allowlist,
    allowlistFromFile: [],
    gatewayUrl,
    maxTarget: 200_000,
    maxDurationMin: 60,
    maxRegisterRamp: 100,
    presets: [{ id: '10k', label: '10k', targetUsers: 10_000, requiresCluster: false }],
    hasOtpSecret: true,
    hasRedisConfigured: true,
    reportsDir: './docs/loadtest-reports',
    allowRegister: false,
  };
}

describe('ControlPanelPage — guard production target', () => {
  it('gatewayUrl production (api.mayogu.com) trong config → hiện banner cảnh báo', () => {
    storeState.config = makeConfig('https://api.mayogu.com', ['https://api.mayogu.com', 'http://localhost:3000']);
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ControlPanelPage />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Đây có vẻ là PRODUCTION')).toBeInTheDocument();
    expect(screen.getByText(/thêm tường minh vào LOADTEST_ALLOWLIST/)).toBeInTheDocument();
  });

  it('gatewayUrl test (.test) → KHÔNG hiện banner', () => {
    storeState.config = makeConfig('ws://test-01.mayogu.test', ['http://test-01.mayogu.test']);
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ControlPanelPage />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText('Đây có vẻ là PRODUCTION')).not.toBeInTheDocument();
  });
});
