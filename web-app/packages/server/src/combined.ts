/**
 * `auth.mode: local` with an LDAP server configured: application accounts AND directory accounts.
 *
 *  - A name that belongs to a local account is checked against the local password only.
 *  - Any other name is authenticated against LDAP. A successful bind is admitted only if the
 *    user's e-mail (`ldap.user.attributes.mail`) is listed in the allowlist file
 *    (`ldap.allowedEmailsFile`); otherwise `not_authorized`.
 *  - LDAP users get their e-mail address (lowercase) as the session user name, so their file
 *    workspace is keyed by it. Local names cannot contain `@`, so the two never collide.
 */
import { readFile, stat } from 'node:fs/promises';
import type { LocalAccounts } from './accounts.ts';
import type { AuthResult, LdapAuthenticator } from './ldap.ts';

/**
 * E-mail addresses allowed to log in through LDAP: one per line, `#` starts a comment, blank lines
 * ignored, compared case-insensitively. Re-read when the file's modification time changes.
 */
export class EmailAllowlist {
  private cache: { mtimeMs: number; emails: Set<string> } | null = null;

  constructor(
    readonly file: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  static parse(text: string): Set<string> {
    const emails = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim().toLowerCase();
      if (line !== '') emails.add(line);
    }
    return emails;
  }

  async emails(): Promise<Set<string>> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.file)).mtimeMs;
    } catch {
      if (this.cache?.mtimeMs !== -1) this.warn(`LDAP e-mail allowlist ${this.file} not found - no LDAP user is admitted`);
      this.cache = { mtimeMs: -1, emails: new Set() };
      return this.cache.emails;
    }
    if (this.cache === null || this.cache.mtimeMs !== mtimeMs) {
      this.cache = { mtimeMs, emails: EmailAllowlist.parse(await readFile(this.file, 'utf8')) };
    }
    return this.cache.emails;
  }

  async has(email: string): Promise<boolean> {
    return (await this.emails()).has(email.trim().toLowerCase());
  }
}

export class CombinedAuthenticator {
  constructor(
    private readonly local: LocalAccounts,
    private readonly ldap: LdapAuthenticator,
    private readonly allowlist: EmailAllowlist,
  ) {}

  async authenticate(username: string, password: string): Promise<AuthResult> {
    if (await this.local.hasAccount(username)) return this.local.authenticate(username, password);

    const result = await this.ldap.authenticate(username, password);
    if (!result.ok) return result;
    const mail = result.mail?.trim().toLowerCase();
    if (!mail) return { ok: false, error: 'not_authorized', reason: 'ldap_no_mail' };
    if (!(await this.allowlist.has(mail))) return { ok: false, error: 'not_authorized', reason: 'email_not_allowed' };
    return { ok: true, username: mail, displayName: result.displayName, roles: result.roles, mail };
  }

  /** Readiness: local accounts are usable even while the directory is unreachable. */
  async check(): Promise<boolean> {
    return this.local.check();
  }
}
