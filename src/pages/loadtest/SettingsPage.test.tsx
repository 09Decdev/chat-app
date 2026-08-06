/**
 * SettingsPage — guard UI khi NHẬP URL production vào allowlist:
 * - gõ https://api.mayogu.com → AlertBanner đỏ cảnh báo (không chặn input).
 * - gõ URL test (.test) → không hiện banner.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '@/pages/loadtest/SettingsPage';
import type { LoadTestConfig } from '@/types/loadtest';

const mocks = vi.hoisted(() => ({
  allowlist: vi.fn(),
  saveAllowlist: vi.fn(),
  toApiError: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: { allowlist: mocks.allowlist, saveAllowlist: mocks.saveAllowlist },
  toApiError: mocks.toApiError,
}));

const storeState = vi.hoisted(() => ({
  config: null as LoadTestConfig | null,
  configLoading: false,
  requireEnvConfirm: true,
  setRequireEnvConfirm: vi.fn(),
}));

vi.mock('@/store/loadtest.store', () => ({
  useLoadtestStore: (selector: (s: unknown) => unknown) => selector(storeState),
}));

describe('SettingsPage — guard khi nhập production URL', () => {
  it('gõ production URL (api.mayogu.com) → hiện banner cảnh báo', async () => {
    mocks.allowlist.mockResolvedValue({ allowlist: [] });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('ws://test-…');
    fireEvent.change(input, { target: { value: 'https://api.mayogu.com' } });
    expect(screen.getByText('Đây có vẻ là PRODUCTION')).toBeInTheDocument();
  });

  it('gõ URL test (.test) → KHÔNG hiện banner', async () => {
    mocks.allowlist.mockResolvedValue({ allowlist: [] });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('ws://test-…');
    fireEvent.change(input, { target: { value: 'ws://test-01.mayogu.test' } });
    expect(screen.queryByText('Đây có vẻ là PRODUCTION')).not.toBeInTheDocument();
  });
});
