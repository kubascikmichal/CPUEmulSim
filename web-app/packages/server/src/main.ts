/** Entry point: `CPUEMUL_CONFIG=config/server.yaml LDAP_SERVICE_PASSWORD=... node src/main.ts` */
import { LocalAccounts } from './accounts.ts';
import { CombinedAuthenticator, EmailAllowlist } from './combined.ts';
import { isLdapEnabled, loadConfig } from './config.ts';
import { buildApp, type Authenticator, type Registrar } from './app.ts';
import { LdapAuthenticator } from './ldap.ts';

const config = loadConfig();
// auth.mode none: sessions are created automatically, the login endpoint is never needed
const noAuth: Authenticator = {
  authenticate: async () => ({ ok: false, error: 'not_authorized', reason: 'auth_disabled' }),
  check: async () => true,
};
let authenticator: Authenticator;
let registrar: Registrar | undefined;
if (config.auth.mode === 'local') {
  const accounts = new LocalAccounts(config.files.dataDir);
  registrar = accounts;
  if (isLdapEnabled(config)) {
    // LDAP server configured: directory users too, admitted by the e-mail allowlist
    const ldap = new LdapAuthenticator(config.ldap, config.authorization ?? null);
    authenticator = new CombinedAuthenticator(accounts, ldap, new EmailAllowlist(config.ldap.allowedEmailsFile));
    console.log(`auth: local accounts + LDAP (${config.ldap.urls.join(', ')}), allowlist ${config.ldap.allowedEmailsFile}`);
  } else {
    authenticator = accounts;
    console.log('auth: local accounts (no LDAP server configured)');
  }
} else if (config.auth.mode === 'none') {
  authenticator = noAuth;
} else {
  authenticator = new LdapAuthenticator(config.ldap!, config.authorization!);
}
const app = await buildApp({ config, authenticator, registrar });
await app.listen({ host: config.server.host, port: config.server.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
