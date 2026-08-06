/**
 * ErrorBoundary (T-08 / F-9) — UI-SPEC-prod-refactor §1.
 *
 * Mount 2 lớp:
 *  - Lớp 1 (app-level): bọc <Routes/> trong App.tsx, homePath={routes.chat}, KHÔNG resetKey
 *    (tránh crash-loop — page lỗi → navigate → reset → crash lại vô hạn).
 *  - Lớp 2 (route-level loadtest): bọc <Outlet/> trong app-shell.tsx, resetKey={location.pathname}
 *    → chuyển trang tự reset.
 *
 * PII policy — HARD RULE: prod KHÔNG render error.message/stack/componentStack (có thể chứa
 * URL/query/token). Prod chỉ console.error sanitized { name }. import.meta.env.DEV mới hiện
 * <details> chi tiết kỹ thuật.
 */
import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export interface ErrorBoundaryProps {
  /** Đổi giá trị → reset trạng thái lỗi (route-level dùng location.pathname). */
  resetKey?: string | number;
  /** Đường "Về trang chủ" — app-level: routes.chat; loadtest: routes.loadtest. */
  homePath?: string;
  /** Hook report (prod-sanitized) — không nhận message/stack. */
  onError?: (error: Error, info: { componentStack?: string | null }) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface FallbackProps {
  focusRef: React.RefObject<HTMLDivElement>;
  error: Error | null;
  homePath?: string;
  onReload: () => void;
  onHome: () => void;
}

/** Fallback tự bảo vệ: nếu chính fallback throw → trả div text tĩnh thuần (không component). */
function Fallback({ focusRef, error, homePath, onReload, onHome }: FallbackProps) {
  try {
    return (
      <div
        ref={focusRef}
        role="alert"
        tabIndex={-1}
        className="flex min-h-[70vh] items-center justify-center p-4"
      >
        <Card className="w-full max-w-md space-y-4 border-destructive/40 bg-destructive/10 p-6 text-destructive">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div className="space-y-2">
              <h1 className="text-base font-semibold">Đã xảy ra lỗi không mong muốn</h1>
              <p className="text-sm opacity-90">
                Ứng dụng vừa gặp sự cố khi hiển thị trang này. Dữ liệu run được giữ trên server — bạn
                có thể tải lại trang để tiếp tục.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button className="min-h-11" onClick={onReload} autoFocus>
              Tải lại trang
            </Button>
            {homePath && (
              <Button variant="outline" className="min-h-11" onClick={onHome}>
                Về trang chủ
              </Button>
            )}
          </div>
          {import.meta.env.DEV && error && (
            <details className="text-xs opacity-80">
              <summary>Chi tiết kỹ thuật (dev)</summary>
              <pre className="font-mono whitespace-pre-wrap break-all">{error.message}</pre>
            </details>
          )}
        </Card>
      </div>
    );
  } catch {
    return (
      <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
        Đã xảy ra lỗi không mong muốn. Vui lòng tải lại trang.
      </div>
    );
  }
}

class ErrorBoundaryClass extends Component<
  ErrorBoundaryProps & { navigate: (path: string) => void },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  private focusRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, { componentStack: info.componentStack });
    // PII policy — prod KHÔNG log message/stack/raw (có thể chứa token/URL).
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error);
    } else {
      console.error('UI render error', { name: error.name });
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Route-level: resetKey (pathname) đổi → reset trạng thái lỗi (chuyển trang tự hồi phục).
    if (this.props.resetKey !== prevProps.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
      return;
    }
    // Focus container (WCAG 2.4.3) — nút "Tải lại trang" autoFocus.
    if (this.state.hasError) {
      this.focusRef.current?.focus();
    }
  }

  private handleHome = () => {
    const { homePath, navigate } = this.props;
    if (!homePath) return;
    navigate(homePath);
    // Reset sau 1 frame (D-19) — KHÔNG reset ngay (tránh crash-loop); nếu trang mới crash,
    // boundary re-arm bình thường. Reset chỉ khi user chủ động bấm.
    requestAnimationFrame(() => this.setState({ hasError: false, error: null }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <Fallback
          focusRef={this.focusRef}
          error={this.state.error}
          homePath={this.props.homePath}
          onReload={() => window.location.reload()}
          onHome={this.handleHome}
        />
      );
    }
    return this.props.children;
  }
}

/** Wrapper functional để dùng useNavigate (class component không gọi được hook). */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  const navigate = useNavigate();
  return <ErrorBoundaryClass {...props} navigate={navigate} />;
}

export default ErrorBoundary;