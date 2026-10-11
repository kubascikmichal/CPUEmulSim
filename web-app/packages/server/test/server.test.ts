/**
 * Server tests: LDAP scenarios L1–L20 (docs/migration/04-test-plan.md §4) and the file store
 * scenarios FS1–FS11 (§4a), against the in-process AD test directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { LocalAccounts } from '../src/accounts.ts';
import { userKey } from '../src/files.ts';
import { CombinedAuthenticator, EmailAllowlist } from '../src/combined.ts';
import { buildApp } from '../src/app.ts';
import { isLdapEnabled, parseConfig, type Config } from '../src/config.ts';
import { escapeFilterValue, LdapAuthenticator } from '../src/ldap.ts';
import { BASE, GROUP_USERS, PASSWORD, SERVICE_DN, SERVICE_PASSWORD, startAdTestServer } from './adTestServer.ts';

let ad: Awaited<ReturnType<typeof startAdTestServer>>;
let publicDir: string;

beforeAll(async () => {
  ad = await startAdTestServer();
  publicDir = mkdtempSync(join(tmpdir(), 'cpuemul-public-'));
  writeFileSync(join(publicDir, 'index.html'), '<html>app</html>');
  writeFileSync(join(publicDir, 'schematic.html'), '<html>schematic</html>');
  writeFileSync(join(publicDir, 'login.html'), '<html>login</html>');
  for (const d of ['assets', 'icons', 'login-assets']) mkdirSync(join(publicDir, d));
  writeFileSync(join(publicDir, 'assets', 'main.js'), 'console.log("app")');
  writeFileSync(join(publicDir, 'icons', 'cpu_icon.png'), 'png');
  writeFileSync(join(publicDir, 'login-assets', 'login.js'), 'login');
});

afterAll(async () => {
  await ad.stop();
});

function config(overrides: Partial<{ urls: string[]; nested: boolean; mode: 'search-then-bind' | 'direct-bind' }> = {}): Config {
  return parseConfig({
    server: { publicDir },
    ldap: {
      urls: overrides.urls ?? [ad.url],
      allowInsecure: true,
      connectTimeoutMs: 1000,
      bind: { mode: overrides.mode ?? 'search-then-bind', serviceDn: SERVICE_DN, servicePasswordEnv: 'TEST_LDAP_PW' },
      user: { baseDn: 'OU=Users,' + BASE, upnSuffix: 'test.local' },
      groups: { nested: overrides.nested ?? true, baseDn: 'OU=Groups,' + BASE },
    },
    authorization: { roleMappings: [{ group: GROUP_USERS, role: 'user' }] },
    session: { idleTimeoutMin: 30, absoluteTimeoutHours: 8, secureCookie: true },
    files: { dataDir: mkdtempSync(join(tmpdir(), 'cpuemul-data-')), maxFileBytes: 1000, maxUserBytes: 2500, maxUserFiles: 5 },
    security: { loginRateLimit: { perIpPerMin: 1000, perUserPerMin: 1000 } },
  });
}

const env = { TEST_LDAP_PW: SERVICE_PASSWORD };
const CSRF = { 'x-requested-with': 'cpuemul' };

async function app(cfg = config(), now?: () => number) {
  const a = await buildApp({ config: cfg, authenticator: new LdapAuthenticator(cfg.ldap!, cfg.authorization!, env), now, logger: false });
  return a;
}

async function login(a: Awaited<ReturnType<typeof app>>, username: string, password = PASSWORD, cookie?: string) {
  return a.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...CSRF, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    payload: { username, password },
  });
}

const sid = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'cpuemul.sid');

describe('LDAP authentication (L1–L20)', () => {
  test('L1 valid user in authorised group → 200, secure session cookie', async () => {
    const a = await app();
    const res = await login(a, 'alice');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ username: 'alice', displayName: 'Alice Nováková' });
    const c = sid(res) as unknown as { httpOnly: boolean; secure: boolean; sameSite: string; path: string };
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  });

  test('L2 wrong password → 401 invalid_credentials', async () => {
    const res = await login(await app(), 'alice', 'wrong');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('L3 unknown user → same response as L2 (no enumeration)', async () => {
    const res = await login(await app(), 'nobody');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('L4 empty password → 401 without any bind', async () => {
    const before = ad.binds.length;
    const res = await login(await app(), 'alice', '');
    expect(res.statusCode).toBe(401);
    expect(ad.binds.length).toBe(before);
  });

  test('L5 valid user not in a mapped group → 403 not_authorized', async () => {
    const res = await login(await app(), 'bob');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_authorized' });
  });

  test('L6 nested group membership: 200 with nested=true, 403 with nested=false', async () => {
    expect((await login(await app(config({ nested: true })), 'carol')).statusCode).toBe(200);
    expect((await login(await app(config({ nested: false })), 'carol')).statusCode).toBe(403);
  });

  test.each([
    ['L7', 'locked', 'account_locked'],
    ['L8', 'expired', 'password_expired'],
    ['L8b', 'mustchange', 'must_change_password'],
    ['L9', 'disabled', 'account_disabled'],
  ])('%s account state %s → generic 401, reason only internal', async (_id, user, reason) => {
    const cfg = config();
    const auth = new LdapAuthenticator(cfg.ldap!, cfg.authorization!, env);
    const result = await auth.authenticate(user, PASSWORD);
    expect(result).toEqual({ ok: false, error: 'invalid_credentials', reason });
    const res = await login(await app(cfg), user);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('L10 LDAP injection is escaped', async () => {
    expect(escapeFilterValue('*)(cn=*')).toBe('\\2a\\29\\28cn=\\2a');
    expect(escapeFilterValue('a\\b\u0000')).toBe('a\\5cb\\00');
    for (const u of ['*', '*)(sAMAccountName=*', 'ali*', 'alice)(|(x=*']) {
      expect((await login(await app(), u)).statusCode).toBe(401);
    }
  });

  test('L11 first directory server down → failover to the second', async () => {
    const res = await login(await app(config({ urls: ['ldap://127.0.0.1:1', ad.url] })), 'alice');
    expect(res.statusCode).toBe(200);
  });

  test('L12 all directory servers down → 503; readiness fails', async () => {
    const a = await app(config({ urls: ['ldap://127.0.0.1:1', 'ldap://127.0.0.1:2'] }));
    const res = await login(a, 'alice');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'directory_unavailable' });
    expect((await a.inject({ url: '/api/health/ready' })).statusCode).toBe(503);
    expect((await a.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  test('L13 configuration without TLS is refused unless explicitly allowed', () => {
    expect(() =>
      parseConfig({
        ldap: { urls: ['ldap://dc.example.local'], bind: { serviceDn: 'x' }, user: { baseDn: 'x' } },
        authorization: { roleMappings: [{ group: 'g', role: 'user' }] },
      }),
    ).toThrow(/ldaps/);
  });

  test('L14 rate limit → 429', async () => {
    const cfg = config();
    cfg.security.loginRateLimit = { perIpPerMin: 3, perUserPerMin: 100 };
    const a = await app(cfg);
    for (let i = 0; i < 3; i++) await login(a, 'alice', 'bad');
    const res = await login(a, 'alice');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited' });
  });

  test('L15 session fixation: a pre-set cookie is replaced by a new session id', async () => {
    const a = await app();
    const res = await login(a, 'alice', PASSWORD, 'cpuemul.sid=attacker-chosen');
    expect(sid(res)?.value).not.toBe('attacker-chosen');
    expect((await a.inject({ url: '/api/auth/session', headers: { cookie: 'cpuemul.sid=attacker-chosen' } })).statusCode).toBe(401);
  });

  test('L16/L17 idle timeout without keepalive; keepalive extends it', async () => {
    let t = 1_000_000;
    const a = await app(config(), () => t);
    const cookie = `cpuemul.sid=${sid(await login(a, 'alice'))!.value}`;
    t += 20 * 60_000;
    expect((await a.inject({ method: 'POST', url: '/api/auth/keepalive', headers: { ...CSRF, cookie } })).statusCode).toBe(204);
    t += 20 * 60_000; // 40 min since login, 20 since activity
    expect((await a.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(200);
    t += 31 * 60_000; // idle
    expect((await a.inject({ method: 'POST', url: '/api/auth/keepalive', headers: { ...CSRF, cookie } })).statusCode).toBe(401);
  });

  test('L18 absolute timeout even with activity', async () => {
    let t = 1_000_000;
    const a = await app(config(), () => t);
    const cookie = `cpuemul.sid=${sid(await login(a, 'alice'))!.value}`;
    for (let i = 0; i < 17; i++) {
      t += 29 * 60_000;
      await a.inject({ method: 'POST', url: '/api/auth/keepalive', headers: { ...CSRF, cookie } });
    }
    expect((await a.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  test('L19 logout destroys the session', async () => {
    const a = await app();
    const cookie = `cpuemul.sid=${sid(await login(a, 'alice'))!.value}`;
    expect((await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } })).statusCode).toBe(204);
    expect((await a.inject({ url: '/', headers: { cookie } })).headers.location).toBe('/login');
  });

  test('L20 unauthenticated access: pages redirect, bundle and APIs refuse', async () => {
    const a = await app();
    for (const url of ['/', '/index.html', '/schematic']) {
      const res = await a.inject({ url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    for (const url of ['/assets/main.js', '/icons/cpu_icon.png', '/api/files', '/api/auth/session']) {
      expect((await a.inject({ url })).statusCode).toBe(401);
    }
    expect((await a.inject({ method: 'POST', url: '/api/auth/keepalive', headers: CSRF })).statusCode).toBe(401);
    expect((await a.inject({ url: '/login' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/login-assets/login.js' })).statusCode).toBe(200);
  });

  test('direct-bind (UPN) mode binds as username@upnSuffix and reads the own entry', async () => {
    // ldapjs cannot accept UPN bind names, so this mode is tested against a scripted client
    const binds: string[] = [];
    const fake = {
      bind: async (dn: string, pw?: string) => {
        binds.push(dn);
        if (dn !== 'alice@test.local' || pw !== PASSWORD) {
          const { InvalidCredentialsError } = await import('ldapts');
          throw new InvalidCredentialsError('80090308: LdapErr: DSID, data 52e, v4563');
        }
      },
      search: async (_base: string, opts: { filter?: unknown }) => {
        const f = String(opts.filter);
        if (f.includes('1.2.840.113556.1.4.1941')) return { searchEntries: [{ dn: GROUP_USERS }], searchReferences: [] };
        if (f.includes('sAMAccountName=alice')) {
          return { searchEntries: [{ dn: 'CN=alice,OU=Users,' + BASE, sAMAccountName: 'alice', displayName: 'Alice Nováková' }], searchReferences: [] };
        }
        return { searchEntries: [], searchReferences: [] };
      },
      unbind: async () => {},
      startTLS: async () => {},
    };
    const cfg = config({ mode: 'direct-bind' });
    const auth = new LdapAuthenticator(cfg.ldap!, cfg.authorization!, env, () => fake as never);
    expect(await auth.authenticate('alice', PASSWORD)).toEqual({ ok: true, username: 'alice', displayName: 'Alice Nováková', roles: ['user'] });
    expect(binds).toEqual(['alice@test.local']);
    expect(await auth.authenticate('alice', 'bad')).toMatchObject({ ok: false, error: 'invalid_credentials' });
  });

  test('CSRF header required on state-changing API calls', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: PASSWORD } });
    expect(res.statusCode).toBe(403);
  });

  test('security headers (CSP, frame-ancestors)', async () => {
    const res = await (await app()).inject({ url: '/login' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });
});

describe('account file store (FS)', () => {
  let a: Awaited<ReturnType<typeof app>>;
  let cookie: string;
  let cookieB: string;

  beforeEach(async () => {
    a = await app();
    cookie = `cpuemul.sid=${sid(await login(a, 'alice'))!.value}`;
    cookieB = `cpuemul.sid=${sid(await login(a, 'pista'))!.value}`;
  });

  const put = (name: string, body: string | Buffer, c = cookie) =>
    a.inject({ method: 'PUT', url: '/api/files/' + encodeURIComponent(name), headers: { ...CSRF, cookie: c, 'content-type': 'text/plain; charset=utf-8' }, payload: body });

  test('FS1/FS2 save, list by extension, overwrite', async () => {
    expect((await put('prog.asm', 'MVI A, 1\n')).statusCode).toBe(204);
    expect((await put('notes.txt', 'x')).statusCode).toBe(204);
    expect((await put('prog.asm', 'MVI A, 2\n')).statusCode).toBe(204);
    const list = (await a.inject({ url: '/api/files?ext=asm', headers: { cookie } })).json();
    expect(list.map((f: { name: string }) => f.name)).toEqual(['prog.asm']);
    expect((await a.inject({ url: '/api/files/prog.asm', headers: { cookie } })).body).toBe('MVI A, 2\n');
  });

  test('FS7 content fidelity: UTF-8 bytes returned unchanged (CRLF, diacritics)', async () => {
    const body = Buffer.from('; Šťastný kód\r\nMVI A, 1\r\n', 'utf8');
    await put('a.asm', body);
    const res = await a.inject({ url: '/api/files/a.asm', headers: { cookie } });
    expect(Buffer.from(res.rawPayload).equals(body)).toBe(true);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  test.each(['../x.asm', 'a/b.asm', 'con:.asm', 'bad\u0001.asm', 'x'.repeat(252) + '.asm', 'noext', 'file.exe', ' lead.asm', 'trail.asm.', 'CON.asm'])(
    'FS8 invalid name %j → 400',
    async (name) => {
      const res = await put(name, 'x');
      expect([400, 404]).toContain(res.statusCode);
      if (res.statusCode === 400) expect(res.json()).toEqual({ error: 'invalid_name' });
    },
  );

  test('FS9 names are unique case-insensitively (HEAD and overwrite)', async () => {
    await put('prog.asm', 'old');
    expect((await a.inject({ method: 'HEAD', url: '/api/files/Prog.asm', headers: { cookie } })).statusCode).toBe(200);
    await put('Prog.asm', 'new');
    const list = (await a.inject({ url: '/api/files?ext=asm', headers: { cookie } })).json();
    expect(list.map((f: { name: string }) => f.name)).toEqual(['Prog.asm']);
  });

  test('FS10 quota: file size, total bytes and file count → 413', async () => {
    expect((await put('big.asm', 'x'.repeat(1001))).statusCode).toBe(413);
    await put('a.asm', 'x'.repeat(1000));
    await put('b.asm', 'x'.repeat(1000));
    expect((await put('c.asm', 'x'.repeat(600))).statusCode).toBe(413);
    expect((await put('c.asm', 'x'.repeat(100))).statusCode).toBe(204);
    for (const n of ['d.txt', 'e.txt']) await put(n, 'x');
    expect((await put('f.txt', 'x')).statusCode).toBe(413);
  });

  test('FS11 isolation between users', async () => {
    await put('secret.asm', 'alice only');
    expect((await a.inject({ url: '/api/files/secret.asm', headers: { cookie: cookieB } })).statusCode).toBe(404);
    expect((await a.inject({ url: '/api/files?ext=asm', headers: { cookie: cookieB } })).json()).toEqual([]);
    expect((await a.inject({ url: '/api/files/%2e%2e%2falice%2ffiles%2fsecret.asm', headers: { cookie: cookieB } })).statusCode).toBe(400);
  });

  test('missing file → 404', async () => {
    expect((await a.inject({ url: '/api/files/none.asm', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('auth.mode none (no login)', () => {
  const noAuth = {
    authenticate: async () => ({ ok: false as const, error: 'not_authorized' as const, reason: 'auth_disabled' }),
    check: async () => true,
  };
  const noAuthConfig = () =>
    parseConfig({
      auth: { mode: 'none', localUser: 'local' },
      server: { publicDir },
      session: { secureCookie: false },
      files: { dataDir: mkdtempSync(join(tmpdir(), 'cpuemul-data-')) },
    });

  test('ldap and authorization sections are not required', () => {
    expect(() => noAuthConfig()).not.toThrow();
  });

  test('pages, bundle and APIs work without logging in; /login goes to the app', async () => {
    const a = await buildApp({ config: noAuthConfig(), authenticator: noAuth, logger: false });
    expect((await a.inject({ url: '/' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/icons/cpu_icon.png' })).statusCode).toBe(200);
    const session = await a.inject({ url: '/api/auth/session' });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.username).toBe('local');
    expect((await a.inject({ url: '/login' })).headers.location).toBe('/');
  });

  test('files are stored for the local user across requests', async () => {
    const a = await buildApp({ config: noAuthConfig(), authenticator: noAuth, logger: false });
    const put = await a.inject({ method: 'PUT', url: '/api/files/a.asm', payload: 'MVI A,1', headers: { ...CSRF, 'content-type': 'text/plain' } });
    expect(put.statusCode).toBe(204);
    const get = await a.inject({ url: '/api/files/a.asm' });
    expect(get.body).toBe('MVI A,1');
  });

  test('LDAP mode still requires the ldap section', () => {
    expect(() => parseConfig({ authorization: { roleMappings: [{ group: 'g', role: 'user' }] } })).toThrow(/ldap section/);
  });
});

describe('auth.mode local (registration + password login)', () => {
  const localConfig = (dataDir: string, allowRegistration = true) =>
    parseConfig({
      auth: { mode: 'local', allowRegistration },
      server: { publicDir },
      session: { secureCookie: false },
      files: { dataDir },
      security: { loginRateLimit: { perIpPerMin: 1000, perUserPerMin: 1000 } },
    });
  const localApp = async (dataDir: string, allowRegistration = true) => {
    const accounts = new LocalAccounts(dataDir);
    return buildApp({ config: localConfig(dataDir, allowRegistration), authenticator: accounts, registrar: accounts, logger: false });
  };
  const post = (a: Awaited<ReturnType<typeof localApp>>, url: string, body: object, cookie?: string) =>
    a.inject({ method: 'POST', url, payload: body, headers: { ...CSRF, ...(cookie ? { cookie } : {}) } });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

  test('register creates an account and a session; files land in the new workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpuemul-local-'));
    const a = await localApp(dir);
    expect((await a.inject({ url: '/api/auth/config' })).json()).toEqual({ mode: 'local', registration: true, ldap: false });
    const res = await post(a, '/api/auth/register', { username: 'Jana.K', password: 'tajneheslo1' });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.username).toBe('Jana.K');
    const cookie = cookieOf(res);
    const put = await a.inject({ method: 'PUT', url: '/api/files/prog.asm', payload: 'MVI A,1', headers: { ...CSRF, cookie, 'content-type': 'text/plain' } });
    expect(put.statusCode).toBe(204);
    // the password is stored only as a scrypt hash
    const stored = readFileSync(join(dir, 'accounts.json'), 'utf8');
    expect(stored).not.toContain('tajneheslo1');
    expect(JSON.parse(stored).accounts[0]).toMatchObject({ username: 'Jana.K', N: 32768 });
  });

  test('log in again later (new server instance) and see the same files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpuemul-local-'));
    const a1 = await localApp(dir);
    const reg = await post(a1, '/api/auth/register', { username: 'peter', password: 'heslo12345' });
    await a1.inject({ method: 'PUT', url: '/api/files/a.schx', payload: '<Scheme/>', headers: { ...CSRF, cookie: cookieOf(reg), 'content-type': 'text/plain' } });
    await a1.close();

    const a2 = await localApp(dir);
    expect((await post(a2, '/api/auth/login', { username: 'peter', password: 'zle-heslo' })).statusCode).toBe(401);
    expect((await post(a2, '/api/auth/login', { username: 'nikto', password: 'heslo12345' })).json()).toEqual({ error: 'invalid_credentials' });
    const login = await post(a2, '/api/auth/login', { username: 'PETER', password: 'heslo12345' });
    expect(login.statusCode).toBe(200);
    const list = await a2.inject({ url: '/api/files?ext=schx', headers: { cookie: cookieOf(login) } });
    expect(list.json().map((f: { name: string }) => f.name)).toEqual(['a.schx']);
  });

  test('registration rules: duplicate (any case) 409, bad name / short password 400', async () => {
    const a = await localApp(mkdtempSync(join(tmpdir(), 'cpuemul-local-')));
    expect((await post(a, '/api/auth/register', { username: 'eva', password: 'heslo12345' })).statusCode).toBe(201);
    const dup = await post(a, '/api/auth/register', { username: 'EVA', password: 'ine-heslo-1' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'username_taken' });
    expect((await post(a, '/api/auth/register', { username: 'a b', password: 'heslo12345' })).json()).toEqual({ error: 'invalid_username' });
    expect((await post(a, '/api/auth/register', { username: 'ab', password: 'heslo12345' })).statusCode).toBe(400);
    expect((await post(a, '/api/auth/register', { username: 'adam', password: 'kratke' })).json()).toEqual({ error: 'weak_password' });
    expect((await post(a, '/api/auth/register', { username: '../root', password: 'heslo12345' })).json()).toEqual({ error: 'invalid_username' });
  });

  test('users see only their own files', async () => {
    const a = await localApp(mkdtempSync(join(tmpdir(), 'cpuemul-local-')));
    const u1 = cookieOf(await post(a, '/api/auth/register', { username: 'user1', password: 'heslo12345' }));
    const u2 = cookieOf(await post(a, '/api/auth/register', { username: 'user2', password: 'heslo12345' }));
    await a.inject({ method: 'PUT', url: '/api/files/tajne.asm', payload: 'X', headers: { ...CSRF, cookie: u1, 'content-type': 'text/plain' } });
    expect((await a.inject({ url: '/api/files?ext=asm', headers: { cookie: u2 } })).json()).toEqual([]);
    expect((await a.inject({ url: '/api/files/tajne.asm', headers: { cookie: u2 } })).statusCode).toBe(404);
  });

  test('registration off: endpoint 404, config says so; LDAP mode has no registration', async () => {
    const a = await localApp(mkdtempSync(join(tmpdir(), 'cpuemul-local-')), false);
    expect((await a.inject({ url: '/api/auth/config' })).json()).toEqual({ mode: 'local', registration: false, ldap: false });
    expect((await post(a, '/api/auth/register', { username: 'eva', password: 'heslo12345' })).statusCode).toBe(404);
    const ldapApp = await app();
    expect((await ldapApp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'eva', password: 'heslo12345' }, headers: CSRF })).statusCode).toBe(404);
  });

  test('register requires the CSRF header', async () => {
    const a = await localApp(mkdtempSync(join(tmpdir(), 'cpuemul-local-')));
    expect((await a.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'eva', password: 'heslo12345' } })).statusCode).toBe(403);
  });
});

describe('auth.mode local + LDAP (e-mail allowlist)', () => {
  /** Config with the test directory; `urls` empty = LDAP not used. */
  const combinedConfig = (dataDir: string, urls: string[] = [ad.url]) =>
    parseConfig(
      {
        auth: { mode: 'local' },
        server: { publicDir },
        session: { secureCookie: false },
        files: { dataDir },
        security: { loginRateLimit: { perIpPerMin: 1000, perUserPerMin: 1000 } },
        ldap: {
          urls,
          allowInsecure: true,
          connectTimeoutMs: 1000,
          bind: { mode: 'search-then-bind', serviceDn: SERVICE_DN, servicePasswordEnv: 'TEST_LDAP_PW' },
          user: { baseDn: 'OU=Users,' + BASE },
          allowedEmailsFile: 'allowed.txt',
        },
      },
      dataDir,
    );
  const combinedApp = async (dataDir: string, urls?: string[]) => {
    const cfg = combinedConfig(dataDir, urls);
    const accounts = new LocalAccounts(dataDir);
    const authenticator = isLdapEnabled(cfg)
      ? new CombinedAuthenticator(accounts, new LdapAuthenticator(cfg.ldap, null, env), new EmailAllowlist(cfg.ldap.allowedEmailsFile, () => {}))
      : accounts;
    return buildApp({ config: cfg, authenticator, registrar: accounts, logger: false });
  };
  const loginAs = (a: Awaited<ReturnType<typeof combinedApp>>, username: string, password = PASSWORD) =>
    a.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: CSRF });
  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpuemul-combined-'));
    writeFileSync(join(dir, 'allowed.txt'), '# LDAP access\nalice.novakova@test.local   # Alice\n\n');
    return dir;
  };

  test('empty LDAP section = LDAP not used (missing, null, urls [] or blank)', () => {
    const base = { auth: { mode: 'local' } };
    expect(isLdapEnabled(parseConfig(base))).toBe(false);
    expect(isLdapEnabled(parseConfig({ ...base, ldap: null }))).toBe(false);
    expect(isLdapEnabled(parseConfig({ ...base, ldap: { urls: [] } }))).toBe(false);
    expect(isLdapEnabled(parseConfig({ ...base, ldap: { urls: ['', '  '], user: {} } }))).toBe(false);
    expect(parseConfig({ ...base, ldap: { urls: [] } }).ldap).toBeUndefined();
  });

  test('with a server: the allowlist path is resolved against the config directory; insecure URLs still need allowInsecure', () => {
    const cfg = combinedConfig('/srv/cfg');
    expect(cfg.ldap!.allowedEmailsFile).toBe('/srv/cfg/allowed.txt');
    expect(() =>
      parseConfig({ auth: { mode: 'local' }, ldap: { urls: ['ldap://dc.example.local'], bind: { serviceDn: 'x' }, user: { baseDn: 'x' } } }),
    ).toThrow(/ldaps/);
  });

  test('LDAP user on the allowlist logs in (e-mail matched case-insensitively) and gets an e-mail workspace', async () => {
    const dir = workspace();
    const a = await combinedApp(dir);
    expect((await a.inject({ url: '/api/auth/config' })).json()).toEqual({ mode: 'local', registration: true, ldap: true });
    const res = await loginAs(a, 'alice');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ username: 'alice.novakova@test.local', displayName: 'Alice Nováková' });
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    await a.inject({ method: 'PUT', url: '/api/files/ldap.asm', payload: 'X', headers: { ...CSRF, cookie, 'content-type': 'text/plain' } });
    expect(readFileSync(join(dir, 'users', userKey('alice.novakova@test.local'), 'files', 'ldap.asm'), 'utf8')).toBe('X');
  });

  test('LDAP user not on the allowlist → 403; adding the address takes effect without restart', async () => {
    const dir = workspace();
    const a = await combinedApp(dir);
    const denied = await loginAs(a, 'bob');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'not_authorized' });
    writeFileSync(join(dir, 'allowed.txt'), 'alice.novakova@test.local\nBOB@test.local\n');
    utimesSync(join(dir, 'allowed.txt'), new Date(), new Date(Date.now() + 5000));
    expect((await loginAs(a, 'bob')).statusCode).toBe(200);
  });

  test('wrong LDAP password → 401; a user without mail → 403; missing allowlist file → 403', async () => {
    const dir = workspace();
    const a = await combinedApp(dir);
    expect((await loginAs(a, 'alice', 'zle')).statusCode).toBe(401);
    expect((await loginAs(a, 'pista')).statusCode).toBe(403); // no mail attribute
    const noList = mkdtempSync(join(tmpdir(), 'cpuemul-combined-'));
    expect((await loginAs(await combinedApp(noList), 'alice')).statusCode).toBe(403);
  });

  test('local accounts keep working next to LDAP and take precedence for their own name', async () => {
    const dir = workspace();
    const a = await combinedApp(dir);
    const reg = await a.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'lokalne-heslo' }, headers: CSRF });
    expect(reg.statusCode).toBe(201);
    expect((await loginAs(a, 'alice', 'lokalne-heslo')).json().user.username).toBe('alice');
    expect((await loginAs(a, 'alice', PASSWORD)).statusCode).toBe(401); // the LDAP password does not apply to a local name
    // registering an e-mail-like name is impossible, so an LDAP workspace cannot be taken over
    const squat = await a.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice.novakova@test.local', password: 'heslo12345' }, headers: CSRF });
    expect(squat.json()).toEqual({ error: 'invalid_username' });
  });

  test('directory unreachable: local accounts still log in, LDAP users get 503', async () => {
    const dir = workspace();
    const a = await combinedApp(dir, ['ldap://127.0.0.1:1']);
    await a.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'jana', password: 'heslo12345' }, headers: CSRF });
    expect((await loginAs(a, 'jana', 'heslo12345')).statusCode).toBe(200);
    expect((await loginAs(a, 'alice')).statusCode).toBe(503);
    expect((await a.inject({ url: '/api/health/ready' })).statusCode).toBe(200);
  });

  test('allowlist parsing: comments, blank lines, case, CRLF', () => {
    expect([...EmailAllowlist.parse('# x\r\nA@B.sk # c\r\n\r\n  c@d.sk  \n')]).toEqual(['a@b.sk', 'c@d.sk']);
  });
});
