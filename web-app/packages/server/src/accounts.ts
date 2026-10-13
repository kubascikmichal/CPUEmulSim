/**
 * Local user accounts (`auth.mode: local`): self-registration, password login and user management
 * (teachers / admin), stored in `${dataDir}/accounts.json`. Passwords are hashed with scrypt and a
 * per-user random salt and compared in constant time; the plain password is never stored or logged.
 * Implements the same {@link Authenticator} contract as the LDAP authenticator, so the two are
 * interchangeable by config.
 *
 * Every account has a full name, a role (`student` / `teacher`) and an enabled flag. Accounts written
 * by older versions (no role / enabled) are enabled students.
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuthResult } from './ldap.ts';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** scrypt cost parameters (N = 2^15, ~32 MB, tens of ms per hash). Stored per account. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;
const MAX_MEM = 64 * 1024 * 1024;

/** Account name rules: 3–32 characters, letters, digits, `.`, `_`, `-`; unique case-insensitively. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 100;

export type Role = 'student' | 'teacher';
export const ROLES: readonly Role[] = ['student', 'teacher'];

export type AccountError = 'invalid_username' | 'weak_password' | 'username_taken' | 'invalid_name' | 'not_found';
export type RegisterError = Extract<AccountError, 'invalid_username' | 'weak_password' | 'username_taken' | 'invalid_name'>;

interface PasswordHash {
  salt: string; // base64
  hash: string; // base64
  N: number;
  r: number;
  p: number;
}

interface StoredAccount extends PasswordHash {
  username: string;
  /** Full name (kept under its original field name for compatibility with older files). */
  displayName: string;
  role?: Role;
  enabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** Account as shown to teachers / the admin (no password data). */
export interface AccountInfo {
  username: string;
  name: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface NewAccount {
  username: string;
  name: string;
  password: string;
  role: Role;
}

export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: AccountError };

/** Full name rules: 1–100 characters after trimming, no control characters. */
export function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

/** Random password for imported accounts: 10 characters without look-alikes (0/O, 1/l/I). */
export function generatePassword(length = 10): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const info = (a: StoredAccount): AccountInfo => ({
  username: a.username,
  name: a.displayName,
  role: a.role ?? 'student',
  enabled: a.enabled ?? true,
  createdAt: a.createdAt,
  lastLoginAt: a.lastLoginAt ?? null,
});

export class LocalAccounts {
  private readonly file: string;
  private readonly reserved: Set<string>;
  private accounts: StoredAccount[] | null = null;
  /** Serialises every read-modify-write of the accounts file. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Hash of a random password - compared against for unknown users so timing does not reveal them. */
  private dummy: Promise<PasswordHash> | null = null;

  /**
   * @param reserved user names that can never be registered or created (case-insensitive), e.g. the
   *   admin account from the environment
   */
  constructor(dataDir: string, reserved: string[] = []) {
    this.file = join(dataDir, 'accounts.json');
    this.reserved = new Set(reserved.map((r) => r.toLowerCase()));
  }

  private async load(): Promise<StoredAccount[]> {
    if (this.accounts !== null) return this.accounts;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { accounts?: StoredAccount[] };
      this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.accounts = [];
    }
    return this.accounts;
  }

  /** Atomic write: temp file, fsync, rename. */
  private async persist(accounts: StoredAccount[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp-' + randomBytes(6).toString('hex');
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 2, accounts }, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
    this.accounts = accounts;
  }

  /** Runs `fn` after every earlier mutation has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private static async hash(password: string, salt = randomBytes(16)): Promise<PasswordHash> {
    const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAX_MEM });
    return { salt: salt.toString('base64'), hash: key.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  }

  private static async verify(account: PasswordHash, password: string): Promise<boolean> {
    const expected = Buffer.from(account.hash, 'base64');
    const key = await scrypt(password, Buffer.from(account.salt, 'base64'), expected.length, {
      N: account.N, r: account.r, p: account.p, maxmem: MAX_MEM,
    });
    return timingSafeEqual(key, expected);
  }

  private static index(accounts: StoredAccount[], username: string): number {
    const lower = username.toLowerCase();
    return accounts.findIndex((a) => a.username.toLowerCase() === lower);
  }

  /** Validation shared by registration and creation; null when the input is acceptable. */
  private validate(accounts: StoredAccount[], input: { username: string; name: unknown; password: unknown }): AccountError | null {
    if (!USERNAME_PATTERN.test(input.username)) return 'invalid_username';
    if (normalizeName(input.name) === null) return 'invalid_name';
    if (!isValidPassword(input.password)) return 'weak_password';
    if (this.reserved.has(input.username.toLowerCase()) || LocalAccounts.index(accounts, input.username) >= 0) return 'username_taken';
    return null;
  }

  private static async build(input: NewAccount): Promise<StoredAccount> {
    return {
      username: input.username,
      displayName: normalizeName(input.name)!,
      role: input.role,
      enabled: true,
      ...(await LocalAccounts.hash(input.password)),
      createdAt: new Date().toISOString(),
    };
  }

  /** Self-registration: a new, enabled student. */
  register(username: string, password: string, name: string): Promise<{ ok: true; username: string } | { ok: false; error: RegisterError }> {
    return this.create({ username, password, name, role: 'student' }).then((r) =>
      r.ok ? { ok: true as const, username: r.value.username } : { ok: false as const, error: r.error as RegisterError },
    );
  }

  /** Creates one account (teacher / admin action, or registration). */
  create(input: NewAccount): Promise<AccountResult<AccountInfo>> {
    return this.serial(async () => {
      const accounts = await this.load();
      const error = this.validate(accounts, input);
      if (error) return { ok: false as const, error };
      const account = await LocalAccounts.build(input);
      await this.persist([...accounts, account]);
      return { ok: true as const, value: info(account) };
    });
  }

  /**
   * Creates several accounts in one write (CSV import). Each input succeeds or fails on its own;
   * duplicates within the batch are reported as `username_taken`.
   */
  createMany(inputs: NewAccount[]): Promise<AccountResult<AccountInfo>[]> {
    return this.serial(async () => {
      const accounts = await this.load();
      const results: AccountResult<AccountInfo>[] = [];
      const accepted: { index: number; input: NewAccount }[] = [];
      const pending: StoredAccount[] = [];
      for (const input of inputs) {
        const error = this.validate([...accounts, ...pending], input);
        if (error) {
          results.push({ ok: false, error });
          continue;
        }
        // placeholder so later rows see the name as taken; replaced by the real record below
        pending.push({ username: input.username } as StoredAccount);
        accepted.push({ index: results.length, input });
        results.push({ ok: false, error: 'not_found' });
      }
      // hashing is the slow part - a few at a time on the thread pool
      const built: StoredAccount[] = [];
      for (let i = 0; i < accepted.length; i += 4) {
        built.push(...(await Promise.all(accepted.slice(i, i + 4).map((a) => LocalAccounts.build(a.input)))));
      }
      if (built.length > 0) await this.persist([...accounts, ...built]);
      accepted.forEach((a, i) => (results[a.index] = { ok: true, value: info(built[i]) }));
      return results;
    });
  }

  async list(): Promise<AccountInfo[]> {
    return (await this.load()).map(info);
  }

  async find(username: string): Promise<AccountInfo | null> {
    const accounts = await this.load();
    const i = LocalAccounts.index(accounts, username);
    return i < 0 ? null : info(accounts[i]);
  }

  /** Changes name, role and/or enabled state. */
  update(username: string, patch: { name?: unknown; role?: Role; enabled?: boolean }): Promise<AccountResult<AccountInfo>> {
    return this.serial(async () => {
      const accounts = await this.load();
      const i = LocalAccounts.index(accounts, username);
      if (i < 0) return { ok: false as const, error: 'not_found' as const };
      const next = { ...accounts[i] };
      if (patch.name !== undefined) {
        const name = normalizeName(patch.name);
        if (name === null) return { ok: false as const, error: 'invalid_name' as const };
        next.displayName = name;
      }
      if (patch.role !== undefined) next.role = patch.role;
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      await this.persist(accounts.map((a, j) => (j === i ? next : a)));
      return { ok: true as const, value: info(next) };
    });
  }

  setPassword(username: string, password: unknown): Promise<AccountResult<AccountInfo>> {
    return this.serial(async () => {
      if (!isValidPassword(password)) return { ok: false as const, error: 'weak_password' as const };
      const accounts = await this.load();
      const i = LocalAccounts.index(accounts, username);
      if (i < 0) return { ok: false as const, error: 'not_found' as const };
      const next = { ...accounts[i], ...(await LocalAccounts.hash(password)) };
      await this.persist(accounts.map((a, j) => (j === i ? next : a)));
      return { ok: true as const, value: info(next) };
    });
  }

  /** Removes the account record (the caller deletes the user's files). */
  remove(username: string): Promise<AccountResult<AccountInfo>> {
    return this.serial(async () => {
      const accounts = await this.load();
      const i = LocalAccounts.index(accounts, username);
      if (i < 0) return { ok: false as const, error: 'not_found' as const };
      await this.persist(accounts.filter((_, j) => j !== i));
      return { ok: true as const, value: info(accounts[i]) };
    });
  }

  /** Whether a local account with this name exists (case-insensitive). */
  async hasAccount(username: string): Promise<boolean> {
    return LocalAccounts.index(await this.load(), username) >= 0;
  }

  /**
   * Authenticator contract (same results as LDAP: unknown user and wrong password are identical).
   * A disabled account is reported as such only after a correct password.
   */
  async authenticate(username: string, password: string): Promise<AuthResult> {
    const accounts = await this.load();
    const account = accounts[LocalAccounts.index(accounts, username)];
    if (account === undefined) {
      this.dummy ??= LocalAccounts.hash(randomBytes(16).toString('hex'));
      await LocalAccounts.verify(await this.dummy, password);
      return { ok: false, error: 'invalid_credentials', reason: 'unknown_user' };
    }
    if (!(await LocalAccounts.verify(account, password))) return { ok: false, error: 'invalid_credentials', reason: 'bad_password' };
    const current = info(account);
    if (!current.enabled) return { ok: false, error: 'account_disabled', reason: 'account_disabled' };
    await this.touchLogin(account.username);
    return { ok: true, username: current.username, displayName: current.name, roles: [current.role] };
  }

  private touchLogin(username: string): Promise<void> {
    return this.serial(async () => {
      const accounts = await this.load();
      const i = LocalAccounts.index(accounts, username);
      if (i < 0) return;
      const next = { ...accounts[i], lastLoginAt: new Date().toISOString() };
      await this.persist(accounts.map((a, j) => (j === i ? next : a)));
    });
  }

  /** Readiness: the accounts file is readable (or not created yet). */
  async check(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }
}
