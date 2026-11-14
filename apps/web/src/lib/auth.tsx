'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
import { useLocale } from './locale';

export interface OwnUser {
  id: string; email: string; status: string; emailVerifiedAt: string | null;
  ageVerifiedAt?: string | null; birthDate?: string | null; ageAttestedAt?: string | null;
  profile: { username: string; displayName: string; bio: string | null; avatarKey: string | null; locale: string; countryCode: string | null; timezone: string } | null;
  roles: Array<{ role: { name: string; permissions: string[] } }>;
  termsVersion?: string | null; privacyVersion?: string | null;
}
export interface Actor { userId: string; sessionId: string; familyId: string; roles: string[]; permissions: string[]; }
export interface RegisterInput {
  email: string; password: string; username: string; displayName: string; birthDate: string; locale: string;
  termsVersion: string; privacyVersion: string; acceptTerms: boolean; acceptPrivacy: boolean;
}
type AuthResult = { accessToken: string; expiresIn: number; emailDelivery?: 'sent' | 'unavailable' };
type RequestOptions = RequestInit & { auth?: boolean };
interface AuthValue {
  user: OwnUser | null; actor: Actor | null; loading: boolean;
  request: <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;
  refreshUser: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<AuthResult>;
  logout: () => Promise<void>;
  clearSession: () => void;
}
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}
const AuthContext = createContext<AuthValue | null>(null);

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, typeof data?.message === 'string' ? data.message : 'The request could not be completed.');
  return data as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<OwnUser | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);
  const access = useRef<string | null>(null);
  const pending = useRef<Promise<string> | null>(null);
  const lastTokenAt = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const clearSession = useCallback(() => {
    access.current = null; setUser(null); setActor(null);
    localStorage.removeItem('livestar-session-present');
    channel.current?.postMessage({ type: 'logout' });
  }, []);

  const loadUser = useCallback(async (token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    const [account, currentActor] = await Promise.all([
      fetch('/api/v1/users/me', { headers, credentials: 'include', cache: 'no-store' }).then(readResponse<OwnUser>),
      fetch('/api/v1/auth/me', { headers, credentials: 'include', cache: 'no-store' }).then(readResponse<Actor>),
    ]);
    setUser(account); setActor(currentActor);
  }, []);

  const accept = useCallback(async (result: AuthResult) => {
    access.current = result.accessToken; lastTokenAt.current = Date.now();
    localStorage.setItem('livestar-session-present', '1');
    channel.current?.postMessage({ type: 'token', token: result.accessToken });
    await loadUser(result.accessToken);
  }, [loadUser]);

  const rotate = useCallback(async (): Promise<string> => {
    if (pending.current) return pending.current;
    const operation = async () => {
      // Another tab may have refreshed while this tab waited for the origin lock.
      if (access.current && Date.now() - lastTokenAt.current < 1000) return access.current;
      const result = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', cache: 'no-store' }).then(readResponse<AuthResult>);
      await accept(result);
      return result.accessToken;
    };
    const next: Promise<string> = (async () => {
      if ('locks' in navigator) return await navigator.locks.request('livestar-web-refresh', operation);
      return await operation();
    })().catch(error => { clearSession(); throw error; }).finally(() => { pending.current = null; });
    pending.current = next;
    return next;
  }, [accept, clearSession]);

  const request = useCallback(async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
    const { auth = true, ...init } = options;
    const perform = (token: string | null) => fetch(`/api/v1${path.startsWith('/') ? path : `/${path}`}`, {
      ...init, credentials: 'include', cache: 'no-store',
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...Object.fromEntries(new Headers(init.headers)), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let response = await perform(access.current);
    if (auth && response.status === 401 && localStorage.getItem('livestar-session-present')) response = await perform(await rotate());
    return readResponse<T>(response);
  }, [rotate]);

  const refreshUser = useCallback(async () => {
    const current = access.current || await rotate();
    await loadUser(current);
  }, [loadUser, rotate]);

  useEffect(() => {
    const bus = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('livestar-auth');
    channel.current = bus;
    if (bus) bus.onmessage = event => {
      if (event.data?.type === 'logout') { access.current = null; setUser(null); setActor(null); }
      else if (event.data?.type === 'token' && typeof event.data.token === 'string') {
        access.current = event.data.token; lastTokenAt.current = Date.now();
        void loadUser(event.data.token).catch(() => undefined);
      }
    };
    let cancelled = false;
    if (localStorage.getItem('livestar-session-present')) {
      void rotate().catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    } else setLoading(false);
    return () => { cancelled = true; bus?.close(); if (channel.current === bus) channel.current = null; };
  }, [loadUser, rotate]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await request<AuthResult>('/auth/login', { method: 'POST', auth: false, body: JSON.stringify({ email, password }) });
    await accept(result);
  }, [accept, request]);
  const register = useCallback(async (input: RegisterInput) => {
    const result = await request<AuthResult>('/auth/register', { method: 'POST', auth: false, body: JSON.stringify(input) });
    await accept(result); return result;
  }, [accept, request]);
  const logout = useCallback(async () => {
    try { await request<void>('/auth/logout', { method: 'POST' }); }
    finally { clearSession(); }
  }, [clearSession, request]);
  const value = useMemo(() => ({ user, actor, loading, request, refreshUser, login, register, logout, clearSession }), [user, actor, loading, request, refreshUser, login, register, logout, clearSession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required.');
  return value;
}

export function RequireAuth({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { user, actor, loading } = useAuth();
  const { pick } = useLocale();
  const pathname = usePathname();
  if (loading) return <div className="empty-state card" role="status"><LoaderCircle className="spin" /><p>{pick('جارٍ التحقق من الجلسة…', 'Checking your session…')}</p></div>;
  if (!user) return <div className="empty-state card"><div className="icon-orb"><LockKeyhole /></div><h2>{pick('مساحتك الخاصة تبدأ بحسابك', 'Your personal space starts here')}</h2><p className="muted">{pick('سجّل الدخول للوصول إلى هذه الصفحة وإدارة حسابك بأمان.', 'Sign in to access this page and securely manage your account.')}</p><Link className="button gold" href={`/login?returnTo=${encodeURIComponent(pathname)}`}>{pick('تسجيل الدخول', 'Sign in')}</Link></div>;
  if (roles?.length && !roles.some(role => actor?.roles.includes(role))) return <div className="empty-state card"><LockKeyhole /><h2>{pick('الوصول مقيد', 'Access restricted')}</h2><p className="muted">{pick('هذه المساحة متاحة فقط لفريق الإدارة المخوّل.', 'This area is available to authorized team members only.')}</p></div>;
  return children;
}

export function useErrorMessage() {
  const { pick } = useLocale();
  return useCallback((error: unknown): string => {
    if (error instanceof ApiError) {
      const messages: Record<number, [string, string]> = {
        400: ['راجع البيانات المدخلة أو صلاحية الرابط ثم حاول مجدداً.', 'Check your details or link expiry, then try again.'],
        401: ['بيانات الدخول غير صحيحة أو انتهت صلاحية الجلسة.', 'The credentials are incorrect or the session has expired.'],
        403: ['لا تملك صلاحية تنفيذ هذا الإجراء.', 'You do not have permission to perform this action.'],
        409: ['البريد الإلكتروني أو اسم المستخدم مسجّل بالفعل.', 'The email or username is already registered.'],
        429: ['وصلت إلى الحد المؤقت للمحاولات. انتظر قليلاً ثم حاول مجدداً.', 'Too many attempts. Please wait a moment and try again.'],
        503: ['الخدمة مشغولة مؤقتاً. حاول بعد قليل.', 'The service is temporarily busy. Please try again shortly.'],
      };
      const message = messages[error.status];
      if (message) return pick(...message);
    }
    return pick('تعذر إكمال الطلب. تحقق من الاتصال وحاول مجدداً.', 'The request could not be completed. Check your connection and try again.');
  }, [pick]);
}
