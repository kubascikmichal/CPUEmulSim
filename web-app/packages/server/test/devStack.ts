/**
 * Local development / E2E stack: in-process AD test directory + the application server.
 * NOT for production (plaintext LDAP, non-secure cookie). Users: alice / Heslo123! (see adTestServer.ts).
 *
 *   node --experimental-transform-types packages/server/test/devStack.ts
 *
 * AUTH_MODE=local: local accounts with registration PLUS the test directory; LDAP users are admitted
 * by the e-mail allowlist `<data>/ldap-allowed-emails.txt` (seeded with alice's address only).
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { LdapAuthenticator } from '../src/ldap.ts';
import { LocalAccounts } from '../src/accounts.ts';
import { CombinedAuthenticator, EmailAllowlist } from '../src/combined.ts';
import { BASE, GROUP_USERS, SERVICE_DN, SERVICE_PASSWORD, startAdTestServer } from './adTestServer.ts';

const ad = await startAdTestServer();
const local = process.env.AUTH_MODE === 'local';
const dataDir = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'cpuemul-dev-'));
// seed the allowlist only if there is none yet (an existing list is never overwritten)
if (local && !existsSync(join(dataDir, 'ldap-allowed-emails.txt'))) {
  writeFileSync(join(dataDir, 'ldap-allowed-emails.txt'), '# dev stack\nalice.novakova@test.local\n');
}
const config = parseConfig({
  auth: { mode: local ? 'local' : 'ldap' },
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 8080), publicDir: resolve(import.meta.dirname, '../../web/dist') },
  ldap: {
    urls: [ad.url],
    allowInsecure: true,
    bind: { mode: 'search-then-bind', serviceDn: SERVICE_DN, servicePasswordEnv: 'DEV_LDAP_PW' },
    user: { baseDn: 'OU=Users,' + BASE },
    groups: { nested: true, baseDn: 'OU=Groups,' + BASE },
    allowedEmailsFile: join(dataDir, 'ldap-allowed-emails.txt'),
  },
  authorization: { roleMappings: [{ group: GROUP_USERS, role: 'user' }] },
  session: { secureCookie: false, idleTimeoutMin: Number(process.env.IDLE_MIN ?? 30) },
  files: { dataDir },
  security: { loginRateLimit: { perIpPerMin: 1000, perUserPerMin: 1000 } },
});
const ldap = new LdapAuthenticator(config.ldap!, local ? null : config.authorization!, { DEV_LDAP_PW: SERVICE_PASSWORD });
const accounts = new LocalAccounts(dataDir);
const app = await buildApp({
  config,
  authenticator: local ? new CombinedAuthenticator(accounts, ldap, new EmailAllowlist(config.ldap!.allowedEmailsFile)) : ldap,
  ...(local ? { registrar: accounts } : {}),
  logger: process.env.QUIET !== '1',
});
await app.listen({ host: config.server.host, port: config.server.port });
console.log(`dev stack: http://${config.server.host}:${config.server.port}  (LDAP ${ad.url}, data ${config.files.dataDir})`);
