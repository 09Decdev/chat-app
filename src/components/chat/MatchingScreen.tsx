import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { env } from '@/lib/env';
import './matching.css';

/** Demo people để lấp 3 slot radar khi đang tìm (cosmetic — mockup Option B).
 *  Khi match thật, thẻ "Đã ghép" hiện member thật từ matching:found. */
const DEMO_PEOPLE = [
  { n: 'Minh', c: 'linear-gradient(135deg,#FFB454,#FF7A6B)' },
  { n: 'Lan', c: 'linear-gradient(135deg,#6FE3C1,#7CC4FF)' },
  { n: 'Hùng', c: 'linear-gradient(135deg,#C9A7FF,#FF9DB8)' },
];

function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
function avatarBg(id: string): string {
  const h = hueFor(id || 'x');
  return `linear-gradient(135deg,hsl(${h} 72% 56%),hsl(${(h + 45) % 360} 68% 46%))`;
}
function labelFor(name: string | null | undefined, id: string): string {
  if (name && name.trim()) return name.trim().charAt(0).toUpperCase();
  return id.charAt(0).toUpperCase() || '?';
}

const COUNTDOWN_FROM = 6;

export function MatchingScreen() {
  const phase = useChatStore((s) => s.phase);
  const queueSize = useChatStore((s) => s.queueSize);
  const roomId = useChatStore((s) => s.roomId);
  const members = useChatStore((s) => s.members);
  const cancel = useChatStore((s) => s.cancelMatching);
  const enterRoom = useChatStore((s) => s.enterRoom);
  const me = useAuthStore((s) => s.user?.id);

  const matched = phase === 'matched';
  const [filled, setFilled] = useState(0);
  const [countdown, setCountdown] = useState(COUNTDOWN_FROM);
  const [search, setSearch] = useState<ReactNode>(<><span className="spin" />Đang tìm người quanh bạn…</>);
  const [showCard, setShowCard] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Simulation khi đang tìm (phase 'matching'): lấp slot + đếm ngược (cosmetic).
  // Deps gồm phase (không chỉ matched) — cancel rồi match lại lần 2 phải reset
  // countdown/slot animate lại từ đầu.
  useEffect(() => {
    if (matched) return;
    setFilled(0);
    setCountdown(COUNTDOWN_FROM);
    setShowCard(false);
    setSearch(<><span className="spin" />Đang tìm người quanh bạn…</>);
    DEMO_PEOPLE.forEach((p, i) => {
      const t = setTimeout(() => {
        setFilled(i + 1);
        setSearch(<>Đã tìm thấy <span style={{ color: 'var(--mint)' }}>{p.n}</span> · đang ghép phòng…</>);
      }, 700 + i * 850);
      timersRef.current.push(t);
    });
    let c = COUNTDOWN_FROM;
    const iv = setInterval(() => {
      c = Math.max(0, c - 1);
      setCountdown(c);
      if (c <= 0) clearInterval(iv);
    }, 900);
    timersRef.current.push(iv as unknown as ReturnType<typeof setTimeout>);
    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current = [];
    };
  }, [matched, phase]);

  // Khi matched: burst + hiện thẻ + tự vào phòng sau ~2.4s (hoặc bấm nút).
  useEffect(() => {
    if (!matched) return;
    setSearch('✓ Đã đủ người — mở phòng cho bạn!');
    const t1 = setTimeout(() => setShowCard(true), 60);
    const t2 = setTimeout(() => enterRoom(), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [matched, enterRoom]);

  const cdFrac = Math.max(0, countdown) / COUNTDOWN_FROM;
  const cdOffset = 163 * (1 - cdFrac);

  // Thẻ "Đã ghép": member thật, "Bạn" lên đầu; pad tới 6 slot.
  const cardMembers = [...members].sort((a, b) => Number(b.isMe) - Number(a.isMe));
  const slots6 = [
    ...cardMembers,
    ...Array(Math.max(0, env.maxMembers - cardMembers.length)).fill(null),
  ];

  const youInitial = (me ?? 'B').charAt(0).toUpperCase();

  return (
    <div className="ms">
      <div className="topbar">
        <div className="back" onClick={() => { if (!matched) void cancel(); }}>
          ←
        </div>
        <h2>Chat Ngẫu Nhiên</h2>
        {!matched && (
          <button className="cancel" onClick={() => void cancel()}>
            Hủy
          </button>
        )}
      </div>

      <div className="radarzone">
        <div className="radar">
          <div className="ring" />
          <div className="ring" />
          <div className="ring" />
          <div className="radarbase" />
          <div className="sweep" />
          <div className="slots">
            {DEMO_PEOPLE.map((p, i) => (
              <div key={i} className={`slot ${filled > i ? 'filled' : ''}`}>
                <div className="av" style={{ background: p.c }}>
                  {p.n.charAt(0)}
                </div>
                <span className="nm">{p.n}</span>
              </div>
            ))}
          </div>
          <div className={`burst ${matched ? 'go' : ''}`} />
        </div>

        <div className="youchip">
          <span className="dot">{youInitial}</span> Bạn đang ở đây
        </div>
        <div className="searchtxt">{search}</div>
      </div>

      <div className="queuecard">
        <div className="qinfo">
          <div className="l1">
            Hàng chờ: <b>{queueSize ?? '—'}</b> người
          </div>
          <div className="l2">{matched ? 'Đã ghép xong' : 'Đang tìm thêm người'}</div>
        </div>
        <div className="cd">
          <svg width="58" height="58" viewBox="0 0 58 58">
            <circle className="track" cx="29" cy="29" r="26" />
            <circle
              className="prog"
              cx="29"
              cy="29"
              r="26"
              style={{ strokeDashoffset: matched ? 0 : cdOffset }}
            />
          </svg>
          <div className="num">{matched ? '✓' : countdown}</div>
        </div>
      </div>

      <div className={`matchcard ${showCard ? 'show' : ''}`}>
        <span className="badge">✓ Đã ghép được phòng</span>
        <h3>
          Phòng <span>#{roomId ?? '—'}</span>
        </h3>
        <div className="members">
          {slots6.map((m, i) => (
            <div
              key={i}
              className={`m ${m ? '' : 'empty'}`}
              style={{
                ...(m ? { background: avatarBg(m.userId) } : {}),
                animationDelay: `${i * 0.07}s`,
              }}
            >
              {m ? labelFor(m.displayName, m.userId) : '+'}
            </div>
          ))}
        </div>
        <div className="mcount">
          <b>{members.length}/{env.maxMembers}</b> người đã vào
        </div>
        <button className="enterbtn" onClick={() => enterRoom()}>
          Vào phòng →
        </button>
      </div>
    </div>
  );
}
