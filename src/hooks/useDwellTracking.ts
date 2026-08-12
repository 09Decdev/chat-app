import { useEffect, useRef } from 'react';
import { feedApi } from '@/lib/feed-api';

/**
 * Đo dwell time (thời gian post hiện trên màn hình) + gửi về backend qua view API.
 *
 * Cách hoạt động (algorithm client-side):
 * - IntersectionObserver: post vào viewport (≥50% visible) → bắt đầu đếm (clientStartedAt).
 * - Post rời viewport / tab ẩn / unmount → tính dwellMs = now - clientStartedAt, gửi registerView.
 * - clientStartedAt = mốc lúc post vào viewport (server cross-check AC-1.5: serverObserved ≈ dwellMs).
 * - Skip nếu dwell < MIN (500ms) — tránh noise (lướt qua nhanh).
 * - Fire-and-forget — không block UX, error swallowed.
 *
 * @param postId ID post (undefined → không track)
 * @param onRecord callback khi 1 dwell được ghi (để UI show "recorded Xms" cho test)
 */
const MIN_DWELL_MS = 500;
const OBSERVE_THRESHOLD = 0.5;

export function useDwellTracking(
  postId: string | undefined,
  onRecord?: (dwellMs: number) => void,
) {
  const elRef = useRef<HTMLElement | null>(null);
  const startedAtRef = useRef<number | null>(null);
  // Ref callback để effect không re-run khi onRecord đổi
  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;

  useEffect(() => {
    if (!postId) return;
    const el = elRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const flush = () => {
      if (startedAtRef.current == null) return;
      const startedAt = startedAtRef.current;
      const dwellMs = Date.now() - startedAt;
      startedAtRef.current = null;
      if (dwellMs >= MIN_DWELL_MS) {
        feedApi.registerView(postId, { dwellMs, clientStartedAt: startedAt }).catch(() => {});
        onRecordRef.current?.(dwellMs);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            startedAtRef.current = Date.now();
          } else {
            flush();
          }
        }
      },
      { threshold: OBSERVE_THRESHOLD },
    );
    observer.observe(el);

    // Flush khi user ẩn tab / rời page — không mất dwell đang đo
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [postId]);

  return elRef;
}
