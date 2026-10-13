/** Client of the user management API (`/api/admin/*`). */
import { authFetch } from '../auth/api';

export type Role = 'student' | 'teacher';

export interface ManagedUser {
  username: string;
  name: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  online: boolean;
  lastActivityAt: string | null;
  fileCount: number;
  storageBytes: number;
}

export interface ImportResult {
  created: { line: number; name: string; username: string; password: string }[];
  skipped: { line: number; name: string; username: string; error: string }[];
}

/** Error codes of the API → Slovak messages. */
export const ERROR_TEXT: Record<string, string> = {
  invalid_username: 'Neplatné používateľské meno (3–32 znakov: písmená, číslice, bodka, podčiarkovník, pomlčka).',
  weak_password: 'Heslo musí mať 8–128 znakov.',
  invalid_name: 'Zadajte meno a priezvisko (najviac 100 znakov).',
  username_taken: 'Používateľské meno je už obsadené.',
  not_found: 'Používateľ neexistuje.',
  forbidden: 'Na túto akciu nemáte oprávnenie.',
  invalid_role: 'Neplatná rola.',
  too_many_rows: 'Súbor má priveľa riadkov (najviac 300 naraz).',
  invalid_request: 'Neplatná požiadavka.',
  unavailable: 'Server nie je dostupný. Skúste to neskôr.',
};

export class AdminApiError extends Error {
  constructor(readonly code: string) {
    super(ERROR_TEXT[code] ?? code);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(url, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AdminApiError('unavailable');
  }
  // session gone → login; no longer a teacher → back to the emulator
  if (res.status === 401) {
    window.location.replace('/login');
    throw new AdminApiError('unavailable');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdminApiError((data as { error?: string }).error ?? 'unavailable');
  return data as T;
}

const userUrl = (username: string) => '/api/admin/users/' + encodeURIComponent(username);

export const adminApi = {
  list: () => request<{ actor: 'admin' | 'teacher'; users: ManagedUser[] }>('GET', '/api/admin/users'),
  create: (u: { username: string; name: string; password: string; role: Role }) =>
    request<{ user: ManagedUser }>('POST', '/api/admin/users', u),
  importCsv: (csv: string) => request<ImportResult>('POST', '/api/admin/users/import', { csv }),
  update: (username: string, patch: { name?: string; enabled?: boolean; role?: Role }) =>
    request<{ user: ManagedUser }>('PATCH', userUrl(username), patch),
  setPassword: (username: string, password: string) => request<void>('PUT', userUrl(username) + '/password', { password }),
  remove: (username: string) => request<void>('DELETE', userUrl(username)),
};
