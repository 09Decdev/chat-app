/**
 * ScenarioBuilderPage (F1) — action checkboxes:
 * - initEnabled: action % > 0 → bật; tất cả 0 → chỉ chat.
 * - renormalizeProfile: chia % đều cho actions được chọn (tổng = 100); 0 action chọn → chat 100%.
 * - Render: toggle 1 action → input % tương ứng về 0 + disabled, các action còn lại chia lại đều.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScenarioBuilderPage from '@/pages/loadtest/ScenarioBuilderPage';
import { initEnabled, renormalizeProfile } from '@/pages/loadtest/scenario-profile';
import type { ActionProfile } from '@/types/loadtest';

const storeState = vi.hoisted(() => ({
  profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 },
  setProfile: vi.fn(),
}));

vi.mock('@/store/loadtest.store', () => ({
  useLoadtestStore: (selector: (s: unknown) => unknown) => selector(storeState),
}));

describe('ScenarioBuilderPage — initEnabled (F1)', () => {
  it('% > 0 → bật; % = 0 → tắt (post mặc định tắt)', () => {
    const p: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 };
    expect(initEnabled(p)).toEqual({
      chat: true, read: true, comment: true, like: true, view: false, post: false,
    });
  });

  it('tất cả 0 → chỉ chat bật', () => {
    const p: ActionProfile = { chat: 0, read: 0, comment: 0, like: 0, view: 0 };
    expect(initEnabled(p)).toEqual({
      chat: true, read: false, comment: false, like: false, view: false, post: false,
    });
  });
});

describe('ScenarioBuilderPage — renormalizeProfile (F1)', () => {
  it('chia đều cho actions được chọn (tổng = 100), action tắt = 0', () => {
    const enabled = { chat: true, read: true, comment: true, like: true, view: false, post: false };
    const out = renormalizeProfile(enabled, { chat: 0, read: 0, comment: 0, like: 0, view: 0 });
    expect(out).toEqual({ chat: 25, read: 25, comment: 25, like: 25, view: 0, post: 0 });
    expect(Object.values(out).reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
  });

  it('bỏ chọn 1 action → chia lại đều cho các action còn lại (phần dư vào action cuối)', () => {
    const enabled = { chat: true, read: false, comment: true, like: true, view: false, post: false };
    const out = renormalizeProfile(enabled, { chat: 40, read: 30, comment: 20, like: 10, view: 0 });
    expect(out.read).toBe(0);
    expect(out.chat).toBe(33);
    expect(out.comment).toBe(33);
    expect(out.like).toBe(34);
    expect(Object.values(out).reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
  });

  it('0 action chọn → mặc định chat 100%', () => {
    const enabled = { chat: false, read: false, comment: false, like: false, view: false, post: false };
    expect(renormalizeProfile(enabled, { chat: 0, read: 0, comment: 0, like: 0, view: 0 })).toEqual({
      chat: 100, read: 0, comment: 0, like: 0, view: 0, post: 0,
    });
  });
});

describe('ScenarioBuilderPage — toggle action (F1)', () => {
  it('tắt read → input read = 0 + disabled, chat/comment/like chia lại đều', async () => {
    render(
      <MemoryRouter>
        <ScenarioBuilderPage />
      </MemoryRouter>,
    );
    const readSwitch = await screen.findByLabelText('Bật action read');
    // mặc định: read 30
    expect((document.getElementById('profile-read') as HTMLInputElement).value).toBe('30');
    fireEvent.click(readSwitch);
    expect((document.getElementById('profile-read') as HTMLInputElement).value).toBe('0');
    expect((document.getElementById('profile-read') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('profile-chat') as HTMLInputElement).value).toBe('33');
    expect((document.getElementById('profile-like') as HTMLInputElement).value).toBe('34');
    // tổng vẫn 100 → badge OK
    expect(document.body.textContent).toContain('100%');
  });
});
