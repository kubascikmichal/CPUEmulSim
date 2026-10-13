/** Auth API client (`/api/auth/*`). */
export interface SessionInfo {
  /** role: `admin`, `teacher`, `student` (local accounts) or `user` (LDAP / no login) */
  user: { username: string; displayName: string; role: string };
  session: { idleTimeoutSec: number; absoluteExpiresAt: string };
}

export const CSRF_HEADER = { 'X-Requested-With': 'cpuemul' };

export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: 'same-origin', headers: { ...CSRF_HEADER, ...(init.headers ?? {}) } });
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Nesprávne používateľské meno alebo heslo.',
  not_authorized: 'Nemáte oprávnenie na použitie aplikácie.',
  account_disabled: 'Účet je zablokovaný. Obráťte sa na vyučujúceho.',
  directory_unavailable: 'Adresárová služba nie je dostupná. Skúste to neskôr.',
  rate_limited: 'Príliš veľa pokusov. Skúste to neskôr.',
};

export async function loginRequest(username: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await authFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) return { ok: true };
    let code = res.status === 429 ? 'rate_limited' : 'invalid_credentials';
    try {
      code = (await res.json()).error ?? code;
    } catch {
      /* no body */
    }
    return { ok: false, message: MESSAGES[code] ?? MESSAGES.invalid_credentials };
  } catch {
    return { ok: false, message: MESSAGES.directory_unavailable };
  }
}

export async function logoutRequest(): Promise<void> {
  try {
    await authFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
}
