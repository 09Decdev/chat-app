import { describe, it, expect } from 'vitest';
import { env, routes } from '@/lib/env';

describe('env defaults (F-6 regression)', () => {
  it('refreshEndpoint mặc định = /auth/refresh-token (khớp gateway POST /auth/refresh-token)', () => {
    expect(env.refreshEndpoint).toBe('/auth/refresh-token');
  });

  it('gatewayUrl mặc định = http://localhost:3000 (bỏ trailing slash)', () => {
    expect(env.gatewayUrl).toBe('http://localhost:3000');
  });

  it('socketPath mặc định = /socket.io/', () => {
    expect(env.socketPath).toBe('/socket.io/');
  });

  it('routes map không đổi (không đổi route/URL — G-6)', () => {
    expect(routes.login).toBe('/login');
    expect(routes.chat).toBe('/');
    expect(routes.loadtest).toBe('/loadtest');
    expect(routes.loadtestLogin).toBe('/loadtest/login');
    expect(routes.loadtestRegister).toBe('/loadtest/register');
  });
});