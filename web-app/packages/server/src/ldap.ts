/**
 * LDAP / Active Directory authentication (ldapts).
 *
 *  - search-then-bind (service account) or direct-bind (UPN),
 *  - failover across the configured URLs, LDAPS / StartTLS with CA pinning,
 *  - nested group resolution via LDAP_MATCHING_RULE_IN_CHAIN, role mapping,
 *  - empty passwords are rejected BEFORE any bind (no unauthenticated bind),
 *  - AD sub-codes (52e, 775, 532, 533, 773, ...) are mapped to generic results and logged only.
 */
import { readFileSync } from 'node:fs';
import { Client, InvalidCredentialsError } from 'ldapts';
import type { AuthorizationConfig, LdapConfig } from './config.ts';

/** `account_disabled` is only returned for local accounts (after a correct password). */
export type AuthFailure = 'invalid_credentials' | 'not_authorized' | 'directory_unavailable' | 'account_disabled';

export type AuthResult =
  | { ok: true; username: string; displayName: string; roles: string[]; mail?: string }
  | { ok: false; error: AuthFailure; reason: string };

/** RFC 4515 escaping of a filter assertion value. */
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '*' || ch === '(' || ch === ')' || c === 0) out += '\\' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

/** AD error sub-code from an InvalidCredentials message ("... data 52e, v...") */
export function adSubCode(message: string): string | null {
  return /\bdata ([0-9a-f]{3,4})\b/i.exec(message)?.[1]?.toLowerCase() ?? null;
}

const AD_REASONS: Record<string, string> = {
  '525': 'user_not_found',
  '52e': 'invalid_credentials',
  '530': 'not_permitted_time',
  '531': 'not_permitted_workstation',
  '532': 'password_expired',
  '533': 'account_disabled',
  '701': 'account_expired',
  '773': 'must_change_password',
  '775': 'account_locked',
};

const VALID_USERNAME = /^[^\u0000-\u001f]{1,256}$/;

/** The subset of the ldapts Client used here (injectable for tests). */
export type LdapClient = Pick<Client, 'bind' | 'search' | 'unbind' | 'startTLS'>;

export class LdapAuthenticator {
  private readonly tlsOptions: { ca?: Buffer[]; rejectUnauthorized: boolean };

  constructor(
    private readonly ldap: LdapConfig,
    /** group → role mapping; null = no group check (access decided elsewhere, e.g. the e-mail allowlist) */
    private readonly authz: AuthorizationConfig | null,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clientFactory?: (url: string) => LdapClient,
  ) {
    this.tlsOptions = {
      rejectUnauthorized: ldap.tls.rejectUnauthorized,
      ...(ldap.tls.caFile ? { ca: [readFileSync(ldap.tls.caFile)] } : {}),
    };
  }

  private newClient(url: string): LdapClient {
    if (this.clientFactory) return this.clientFactory(url);
    return new Client({
      url,
      timeout: this.ldap.connectTimeoutMs,
      connectTimeout: this.ldap.connectTimeoutMs,
      ...(url.startsWith('ldaps://') ? { tlsOptions: this.tlsOptions } : {}),
    });
  }

  private async open(url: string): Promise<LdapClient> {
    const client = this.newClient(url);
    if (this.ldap.startTls && url.startsWith('ldap://')) await client.startTLS(this.tlsOptions);
    return client;
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    if (!VALID_USERNAME.test(username) || password.length === 0 || password.length > 1024) {
      return { ok: false, error: 'invalid_credentials', reason: 'empty_or_invalid_input' };
    }

    let lastNetworkError = 'no_server';
    for (const url of this.ldap.urls) {
      let client: LdapClient | null = null;
      try {
        client = await this.open(url);
        return await this.authenticateOn(client, url, username, password);
      } catch (e) {
        if (e instanceof InvalidCredentialsError) {
          const code = adSubCode(e.message);
          return { ok: false, error: 'invalid_credentials', reason: (code && AD_REASONS[code]) ?? 'invalid_credentials' };
        }
        lastNetworkError = (e as Error).message;
        // network / TLS / server failure → try the next directory server
      } finally {
        await client?.unbind().catch(() => {});
      }
    }
    return { ok: false, error: 'directory_unavailable', reason: lastNetworkError };
  }

  private async authenticateOn(client: LdapClient, url: string, username: string, password: string): Promise<AuthResult> {
    const attrs = this.ldap.user.attributes;
    let userDn: string;
    let entry: Record<string, unknown>;

    if (this.ldap.bind.mode === 'search-then-bind') {
      await client.bind(this.ldap.bind.serviceDn!, this.servicePassword());
      const found = await this.findUser(client, username);
      if (found === null) return { ok: false, error: 'invalid_credentials', reason: 'user_not_found' };
      userDn = found.dn;
      entry = found;
      // bind as the user on a fresh connection - the service connection stays for group lookup
      const userClient = await this.open(url);
      try {
        await userClient.bind(userDn, password);
      } finally {
        await userClient.unbind().catch(() => {});
      }
    } else {
      await client.bind(`${username}@${this.ldap.user.upnSuffix}`, password);
      const found = await this.findUser(client, username);
      if (found === null) return { ok: false, error: 'invalid_credentials', reason: 'user_not_found' };
      userDn = found.dn;
      entry = found;
    }

    let roles = ['user'];
    if (this.authz !== null) {
      const groups = await this.groupsOf(client, userDn, entry);
      roles = this.rolesFor(groups);
      if (roles.length === 0) return { ok: false, error: 'not_authorized', reason: 'no_mapped_group' };
    }

    const name = first(entry[attrs.username]) ?? username;
    const mail = first(entry[attrs.mail]);
    return { ok: true, username: name, displayName: first(entry[attrs.displayName]) ?? name, roles, ...(mail ? { mail } : {}) };
  }

  private async findUser(client: LdapClient, username: string): Promise<(Record<string, unknown> & { dn: string }) | null> {
    const filter = this.ldap.user.filter.replace(/\{\{username\}\}/g, escapeFilterValue(username));
    const { searchEntries } = await client.search(this.ldap.user.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', this.ldap.user.attributes.username, this.ldap.user.attributes.displayName, this.ldap.user.attributes.mail, 'memberOf'],
      sizeLimit: 2,
    });
    return searchEntries.length === 1 ? (searchEntries[0] as Record<string, unknown> & { dn: string }) : null;
  }

  private async groupsOf(client: LdapClient, userDn: string, entry: Record<string, unknown>): Promise<string[]> {
    if (this.ldap.groups.nested) {
      const base = this.ldap.groups.baseDn ?? this.ldap.user.baseDn;
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter: `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=${escapeFilterValue(userDn)}))`,
        attributes: ['dn'],
      });
      return searchEntries.map((e) => e.dn);
    }
    const memberOf = entry.memberOf;
    return Array.isArray(memberOf) ? memberOf.map(String) : memberOf ? [String(memberOf)] : [];
  }

  rolesFor(groups: string[]): string[] {
    const normalized = new Set(groups.map(normalizeDn));
    const roles = new Set<string>();
    for (const m of this.authz?.roleMappings ?? []) if (normalized.has(normalizeDn(m.group))) roles.add(m.role);
    return [...roles];
  }

  private servicePassword(): string {
    const pw = this.env[this.ldap.bind.servicePasswordEnv];
    if (!pw) throw new Error(`service password missing (${this.ldap.bind.servicePasswordEnv})`);
    return pw;
  }

  /** Readiness probe: can we reach a directory server (and bind as the service account)? */
  async check(): Promise<boolean> {
    for (const url of this.ldap.urls) {
      let client: LdapClient | null = null;
      try {
        client = await this.open(url);
        if (this.ldap.bind.mode === 'search-then-bind') await client.bind(this.ldap.bind.serviceDn!, this.servicePassword());
        return true;
      } catch {
        /* next */
      } finally {
        await client?.unbind().catch(() => {});
      }
    }
    return false;
  }
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}

function normalizeDn(dn: string): string {
  return dn
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .join(',');
}
