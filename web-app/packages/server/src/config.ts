/**
 * Server configuration: `config/server.yaml` (path in CPUEMUL_CONFIG), secrets from the environment.
 * Validated at startup - the server refuses to start with an invalid or insecure configuration.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ldapSchema = z.object({
  urls: z.array(z.string().url()).min(1),
  startTls: z.boolean().default(false),
  /** Only for local development / automated tests against a plaintext test directory. */
  allowInsecure: z.boolean().default(false),
  tls: z
    .object({
      caFile: z.string().optional(),
      rejectUnauthorized: z.boolean().default(true),
    })
    .default({}),
  connectTimeoutMs: z.number().int().positive().default(5000),
  bind: z.object({
    mode: z.enum(['search-then-bind', 'direct-bind']).default('search-then-bind'),
    serviceDn: z.string().optional(),
    servicePasswordEnv: z.string().default('LDAP_SERVICE_PASSWORD'),
  }),
  user: z.object({
    baseDn: z.string(),
    filter: z.string().default('(&(objectClass=user)(sAMAccountName={{username}}))'),
    attributes: z
      .object({
        username: z.string().default('sAMAccountName'),
        displayName: z.string().default('displayName'),
        /** e-mail attribute checked against the allowlist (`auth.mode: local` + LDAP) */
        mail: z.string().default('mail'),
      })
      .default({}),
    upnSuffix: z.string().optional(),
  }),
  groups: z
    .object({
      nested: z.boolean().default(true),
      baseDn: z.string().optional(),
    })
    .default({}),
  /**
   * `auth.mode: local` + LDAP: file with the e-mail addresses allowed to log in through LDAP (one per
   * line, `#` comments). Relative paths are resolved against the configuration file's directory.
   * Re-read whenever it changes - no restart needed.
   */
  allowedEmailsFile: z.string().default('ldap-allowed-emails.txt'),
});

/**
 * An `ldap` section without a server is "LDAP not used": a missing or empty section, or `urls`
 * missing / empty / only blank strings, becomes `undefined`.
 */
function normalizeLdap(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const urls = Array.isArray(v.urls) ? v.urls.filter((u) => typeof u === 'string' && u.trim() !== '').map((u) => (u as string).trim()) : [];
  if (urls.length === 0) return undefined;
  return { ...v, urls };
}

const configSchema = z.object({
  /**
   * `ldap` (default): LDAP login. `local`: accounts registered in the application itself
   * (`${files.dataDir}/accounts.json`). `none`: no login - every visitor gets a session as
   * `localUser`. Only `ldap` needs the `ldap`/`authorization` sections.
   */
  auth: z
    .object({
      mode: z.enum(['ldap', 'local', 'none']).default('ldap'),
      localUser: z.string().default('local'),
      /** `local` mode: whether new accounts can be registered from the login page. */
      allowRegistration: z.boolean().default(true),
    })
    .default({}),
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().default(8080),
      publicDir: z.string().default('../web/dist'),
      trustProxy: z.boolean().default(true),
    })
    .default({}),
  ldap: z.preprocess(normalizeLdap, ldapSchema.optional()),
  authorization: z
    .object({
      roleMappings: z.array(z.object({ group: z.string(), role: z.string() })).min(1),
    })
    .optional(),
  session: z
    .object({
      idleTimeoutMin: z.number().positive().default(30),
      absoluteTimeoutHours: z.number().positive().default(8),
      cookieName: z.string().default('cpuemul.sid'),
      secureCookie: z.boolean().default(true),
    })
    .default({}),
  files: z
    .object({
      dataDir: z.string().default('/data'),
      maxFileBytes: z.number().int().positive().default(2 * 1024 * 1024),
      maxUserBytes: z.number().int().positive().default(100 * 1024 * 1024),
      maxUserFiles: z.number().int().positive().default(1000),
    })
    .default({}),
  security: z
    .object({
      loginRateLimit: z
        .object({ perIpPerMin: z.number().int().positive().default(10), perUserPerMin: z.number().int().positive().default(5) })
        .default({}),
      /**
       * Proof-of-work captcha on registration (ALTCHA protocol, self-hosted). `maxNumber` is the
       * work bound: the browser computes on average maxNumber/2 SHA-256 hashes.
       */
      captcha: z
        .object({ enabled: z.boolean().default(true), maxNumber: z.number().int().positive().default(100_000) })
        .default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type LdapConfig = NonNullable<Config['ldap']>;
export type AuthorizationConfig = NonNullable<Config['authorization']>;

/** LDAP is used when a directory server is configured (`ldap.urls` not empty) and login is enabled. */
export function isLdapEnabled(config: Config): config is Config & { ldap: LdapConfig } {
  return config.auth.mode !== 'none' && config.ldap !== undefined;
}

/** @param baseDir directory of the configuration file (relative paths in it are resolved against it) */
export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  const config = configSchema.parse(raw);
  if (config.auth.mode === 'ldap') {
    if (!config.ldap) throw new Error('ldap section (with urls) is required when auth.mode is ldap');
    if (!config.authorization) throw new Error('authorization section is required when auth.mode is ldap');
  }
  if (!isLdapEnabled(config)) return config;
  if (!isAbsolute(config.ldap.allowedEmailsFile)) config.ldap.allowedEmailsFile = resolve(baseDir, config.ldap.allowedEmailsFile);
  const insecure = config.ldap.urls.some((u) => !u.startsWith('ldaps://')) && !config.ldap.startTls;
  if (insecure && !config.ldap.allowInsecure) {
    throw new Error('LDAP must use ldaps:// URLs or StartTLS (set ldap.allowInsecure only for local testing)');
  }
  if (config.ldap.bind.mode === 'search-then-bind' && !config.ldap.bind.serviceDn) {
    throw new Error('ldap.bind.serviceDn is required for search-then-bind');
  }
  if (config.ldap.bind.mode === 'direct-bind' && !config.ldap.user.upnSuffix) {
    throw new Error('ldap.user.upnSuffix is required for direct-bind');
  }
  return config;
}

export function loadConfig(path = process.env.CPUEMUL_CONFIG ?? 'config/server.yaml'): Config {
  return parseConfig(parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
}
