/** Auth flow types (CHAT_API.md muc 2). */

export interface DeviceInfo {
  installationId: string;
  deviceFingerprint: string;
  platform: 'ios' | 'android' | 'web';
  deviceName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  deviceInfo: DeviceInfo;
}

export interface LoginResponse {
  message?: string;
  accessToken: string;
  refreshToken: string;
  firstLogin?: boolean;
  authentic?: boolean;
  require2fa?: boolean;
}

export interface AuthUser {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}
