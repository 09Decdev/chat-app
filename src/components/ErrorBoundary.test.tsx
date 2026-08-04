import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/** Component luôn throw — kích hoạt error boundary. */
function Boom(): never {
  throw new Error('boom-secret');
}

describe('ErrorBoundary (F-9)', () => {
  it('child throw → fallback hiện (role=alert, nút "Tải lại trang"), không trắng trang', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary homePath="/">
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải lại trang' })).toBeInTheDocument();
    expect(screen.getByText('Đã xảy ra lỗi không mong muốn')).toBeInTheDocument();
  });

  it('child render bình thường → render children (không fallback)', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary homePath="/">
          <div>content-ok</div>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText('content-ok')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});