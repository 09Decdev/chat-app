/**
 * Error codes va message tieng Viet theo CHAT_API.md muc 6.
 * Frontend switch theo `error` code de hien message phu hop.
 */

export const ChatErrorCode = {
  PHONE_NOT_VERIFIED: 'CHAT_PHONE_NOT_VERIFIED',
  ALREADY_SEATED: 'CHAT_ALREADY_SEATED',
  COOLDOWN_ACTIVE: 'CHAT_COOLDOWN_ACTIVE',
  FORBIDDEN: 'CHAT_FORBIDDEN',
  CONTENT_TOO_LONG: 'CHAT_CONTENT_TOO_LONG',
  RATE_LIMITED: 'CHAT_RATE_LIMITED',
  INVALID_CURSOR: 'CHAT_INVALID_CURSOR',
  // Topic (CHAT_API.md §10.7)
  TOPIC_TITLE_INVALID: 'CHAT_TOPIC_TITLE_INVALID',
  TOPIC_RATE_LIMITED: 'CHAT_TOPIC_RATE_LIMITED',
  TOPIC_ROOM_FULL: 'CHAT_TOPIC_ROOM_FULL',
  ROOM_NOT_FOUND: 'CHAT_ROOM_NOT_FOUND',
} as const;

export type ChatErrorCode = (typeof ChatErrorCode)[keyof typeof ChatErrorCode];

export const CommonErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  BUSINESS_LOGIC: 'BUSINESS_LOGIC_ERROR',
  NOT_FOUND: 'RESOURCE_NOT_FOUND',
} as const;

/** Message tieng Viet cho tung error code (fallback neu server khong tra message). */
export const errorMessageVi: Record<string, string> = {
  [ChatErrorCode.PHONE_NOT_VERIFIED]: 'Ban can xac minh so dien thoai de su dung chat.',
  [ChatErrorCode.ALREADY_SEATED]: 'Ban dang o trong mot phong. Vui long roi phong truoc.',
  [ChatErrorCode.COOLDOWN_ACTIVE]: 'Ban vua roi phong, vui long cho it phut de tiep tuc.',
  [ChatErrorCode.FORBIDDEN]: 'Ban khong the truy cap phong nay.',
  [ChatErrorCode.CONTENT_TOO_LONG]: 'Noi dung qua dai (toi da 4000 ky tu).',
  [ChatErrorCode.RATE_LIMITED]: 'Ban dang gui qua nhanh, vui long giam toc do.',
  [ChatErrorCode.INVALID_CURSOR]: 'Du lieu trang cu bi loi, tai lai trang dau tien.',
  [ChatErrorCode.TOPIC_TITLE_INVALID]: 'Chủ đề phải 3-80 ký tự.',
  [ChatErrorCode.TOPIC_RATE_LIMITED]: 'Bạn đang sửa quá nhanh, vui lòng chờ.',
  [ChatErrorCode.TOPIC_ROOM_FULL]: 'Phòng đã đủ 6 chủ đề.',
  [ChatErrorCode.ROOM_NOT_FOUND]: 'Phòng không còn tồn tại.',
  [CommonErrorCode.UNAUTHORIZED]: 'Phiendang da het han, vui long dang nhap lai.',
  [CommonErrorCode.BUSINESS_LOGIC]: 'Xu ly nghiep vu that bai.',
  [CommonErrorCode.NOT_FOUND]: 'Khong tim thay tai nguyen.',
};

/** Socket chat:error codes (CHAT_API.md muc 5.2). */
export const SocketChatErrorCode = {
  FORBIDDEN: 'FORBIDDEN',
  BAD_REQUEST: 'BAD_REQUEST',
  LEAVE_FAILED: 'LEAVE_FAILED',
} as const;

export function friendlyMessage(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  return errorMessageVi[code] ?? fallback;
}
