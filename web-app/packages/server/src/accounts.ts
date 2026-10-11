/**
 * Local user accounts (`auth.mode: local`): self-registration and password login, stored in
 * `${dataDir}/accounts.json`. Passwords are hashed with scrypt and a per-user random salt and
 * compared in constant time; the plain password is never stored or logged. Implements the same
 * {@link Authenticator} contract as the LDAP authenticator, so the two are interchangeable by config.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
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

export type RegisterError = 'invalid_username' | 'weak_password' | 'username_taken';

interface StoredAccount {
  username: string;
  displayName: string;
  salt: string; // base64
  hash: string; // base64
  N: number;
  r: number;
  p: number;
  createdAt: string;
}

export class LocalAccounts {
  private readonly file: string;
  private accounts: StoredAccount[] | null = null;
  /** Serialises registrations (read-modify-write of the accounts file). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Hash of a random password - compared against for unknown users so timing does not reveal them. */
  private dummy: Promise<StoredAccount> | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'accounts.json');
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
      await handle.writeFile(JSON.stringify({ version: 1, accounts }, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }

  private static async hash(password: string, salt = randomBytes(16)): Promise<Omit<StoredAccount, 'username' | 'displayName' | 'createdAt'>> {
    const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAX_MEM });
    return { salt: salt.toString('base64'), hash: key.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  }

  private static async verify(account: Pick<StoredAccount, 'salt' | 'hash' | 'N' | 'r' | 'p'>, password: string): Promise<boolean> {
    const expected = Buffer.from(account.hash, 'base64');
    const key = await scrypt(password, Buffer.from(account.salt, 'base64'), expected.length, {
      N: account.N, r: account.r, p: account.p, maxmem: MAX_MEM,
    });
    return timingSafeEqual(key, expected);
  }

  /** Creates an account. Usernames are unique case-insensitively (the file store keys by lowercase). */
  register(username: string, password: string): Promise<{ ok: true; username: string } | { ok: false; error: RegisterError }> {
    const run = async () => {
      if (!USERNAME_PATTERN.test(username)) return { ok: false as const, error: 'invalid_username' as const };
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return { ok: false as const, error: 'weak_password' as const };
      const accounts = await this.load();
      const lower = username.toLowerCase();
      if (accounts.some((a) => a.username.toLowerCase() === lower)) return { ok: false as const, error: 'username_taken' as const };
      const account: StoredAccount = { username, displayName: username, ...(await LocalAccounts.hash(password)), createdAt: new Date().toISOString() };
      const next = [...accounts, account];
      await this.persist(next);
      this.accounts = next;
      return { ok: true as const, username };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Whether a local account with this name exists (case-insensitive). */
  async hasAccount(username: string): Promise<boolean> {
    const lower = username.toLowerCase();
    return (await this.load()).some((a) => a.username.toLowerCase() === lower);
  }

  /** Authenticator contract (same results as LDAP: unknown user and wrong password are identical). */
  async authenticate(username: string, password: string): Promise<AuthResult> {
    const accounts = await this.load();
    const lower = username.toLowerCase();
    const account = accounts.find((a) => a.username.toLowerCase() === lower);
    if (account === undefined) {
      this.dummy ??= LocalAccounts.hash(randomBytes(16).toString('hex')).then((h) => ({ ...h, username: '', displayName: '', createdAt: '' }));
      await LocalAccounts.verify(await this.dummy, password);
      return { ok: false, error: 'invalid_credentials', reason: 'unknown_user' };
    }
    if (!(await LocalAccounts.verify(account, password))) return { ok: false, error: 'invalid_credentials', reason: 'bad_password' };
    return { ok: true, username: account.username, displayName: account.displayName, roles: ['user'] };
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
