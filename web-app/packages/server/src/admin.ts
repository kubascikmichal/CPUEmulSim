/**
 * The administrator account (`auth.mode: local`). Not stored in `accounts.json`: its name and password
 * come from the environment (`CPUEMUL_ADMIN_USERNAME`, `CPUEMUL_ADMIN_PASSWORD`, normally in
 * `/etc/cpuemul/cpuemul.env`). The name is reserved - nobody can register or create it.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_PATTERN } from './accounts.ts';
import type { AuthResult } from './ldap.ts';

export const ADMIN_ROLE = 'admin';
export const ADMIN_USERNAME_ENV = 'CPUEMUL_ADMIN_USERNAME';
export const ADMIN_PASSWORD_ENV = 'CPUEMUL_ADMIN_PASSWORD';

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));

export class EnvAdmin {
  private readonly salt = randomBytes(16);
  /** Only a key derived from the password is kept in memory after start-up. */
  private readonly key: Promise<Buffer>;

  constructor(
    readonly username: string,
    password: string,
  ) {
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`${ADMIN_USERNAME_ENV}: 3–32 characters, letters, digits, '.', '_', '-'`);
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new Error(`${ADMIN_PASSWORD_ENV} must have ${PASSWORD_MIN}–${PASSWORD_MAX} characters`);
    }
    this.key = derive(password, this.salt);
  }

  /**
   * Admin from the environment, or null when neither variable is set. Setting only one of them is a
   * configuration error.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnvAdmin | null {
    const username = env[ADMIN_USERNAME_ENV]?.trim() ?? '';
    const password = env[ADMIN_PASSWORD_ENV] ?? '';
    if (username === '' && password === '') return null;
    if (username === '' || password === '') throw new Error(`set both ${ADMIN_USERNAME_ENV} and ${ADMIN_PASSWORD_ENV}`);
    return new EnvAdmin(username, password);
  }

  matches(username: string): boolean {
    return username.toLowerCase() === this.username.toLowerCase();
  }

  async authenticate(password: string): Promise<AuthResult> {
    const ok = timingSafeEqual(await derive(password, this.salt), await this.key);
    if (!ok) return { ok: false, error: 'invalid_credentials', reason: 'bad_password' };
    return { ok: true, username: this.username, displayName: 'Administrátor', roles: [ADMIN_ROLE] };
  }
}

interface Authenticator {
  authenticate(username: string, password: string): Promise<AuthResult>;
  check(): Promise<boolean>;
}

/** Checks the admin name first, everything else goes to the wrapped authenticator. */
export function withAdmin(admin: EnvAdmin | null, inner: Authenticator): Authenticator {
  if (admin === null) return inner;
  return {
    authenticate: (username, password) => (admin.matches(username) ? admin.authenticate(password) : inner.authenticate(username, password)),
    check: () => inner.check(),
  };
}
