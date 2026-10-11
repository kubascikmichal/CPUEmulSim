/**
 * In-process LDAP server emulating the Active Directory behaviour the authenticator relies on.
 * Test-only (never used in production): service bind, user binds with AD error sub-codes,
 * sAMAccountName / userPrincipalName search, memberOf, nested groups via the
 * LDAP_MATCHING_RULE_IN_CHAIN extensible filter, UPN binds.
 */
import ldap from 'ldapjs';

export const BASE = 'DC=test,DC=local';
export const SERVICE_DN = 'CN=svc-cpuemul,OU=Service,' + BASE;
export const SERVICE_PASSWORD = 'svc-secret';
export const GROUP_USERS = 'CN=CPUEmul-Users,OU=Groups,' + BASE;
export const GROUP_LAB = 'CN=Lab-Students,OU=Groups,' + BASE;
export const GROUP_OTHER = 'CN=Other,OU=Groups,' + BASE;
export const PASSWORD = 'Heslo123!';

interface User {
  sam: string;
  displayName: string;
  mail?: string;
  /** AD sub-code returned on bind (account state), e.g. 775 locked */
  state?: string;
}

const USERS: User[] = [
  { sam: 'alice', displayName: 'Alice Nováková', mail: 'Alice.Novakova@Test.Local' },
  { sam: 'bob', displayName: 'Bob Outsider', mail: 'bob@test.local' },
  { sam: 'carol', displayName: 'Carol Nested' },
  { sam: 'locked', displayName: 'Locked User', state: '775' },
  { sam: 'expired', displayName: 'Expired Password', state: '532' },
  { sam: 'disabled', displayName: 'Disabled User', state: '533' },
  { sam: 'mustchange', displayName: 'Must Change', state: '773' },
  { sam: 'pista', displayName: 'Pišta Ďurovič' },
];

const userDn = (sam: string) => `CN=${sam},OU=Users,${BASE}`;

/** group DN → member DNs */
const GROUPS: Record<string, string[]> = {
  [GROUP_USERS]: [userDn('alice'), GROUP_LAB, userDn('locked'), userDn('expired'), userDn('disabled'), userDn('mustchange'), userDn('pista')],
  [GROUP_LAB]: [userDn('carol')],
  [GROUP_OTHER]: [userDn('bob')],
};

const norm = (dn: string) => dn.replace(/\s+/g, '').toLowerCase();

function directGroups(dn: string): string[] {
  return Object.entries(GROUPS)
    .filter(([, members]) => members.some((m) => norm(m) === norm(dn)))
    .map(([g]) => g);
}

function transitiveGroups(dn: string): string[] {
  const out = new Set<string>();
  const queue = [dn];
  while (queue.length > 0) {
    for (const g of directGroups(queue.shift()!)) {
      if (!out.has(g)) {
        out.add(g);
        queue.push(g);
      }
    }
  }
  return [...out];
}

/** AD-style invalidCredentials (49) with the diagnostic message carrying the sub-code. */
function rejectBind(res: any, code: string) {
  res.diagnosticMessage = `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${code}, v4563`;
  res.end(49);
}

/** Starts the server; returns its URL and a stop function. */
export async function startAdTestServer(): Promise<{ url: string; stop: () => Promise<void>; binds: string[] }> {
  const server = ldap.createServer();
  const binds: string[] = [];

  server.bind(BASE, (req: any, res: any, next: any) => {
    const dn: string = req.dn.toString();
    const pw: string = req.credentials;
    binds.push(dn);
    if (norm(dn) === norm(SERVICE_DN)) {
      if (pw !== SERVICE_PASSWORD) return rejectBind(res, '52e');
      res.end();
      return next();
    }
    const user = USERS.find((u) => norm(userDn(u.sam)) === norm(dn));
    if (!user || pw !== PASSWORD) return rejectBind(res, '52e');
    if (user.state) return rejectBind(res, user.state);
    res.end();
    return next();
  });

  server.search(BASE, (req: any, res: any, next: any) => {
    // ldapjs compares lowercased attribute names against the (not lowercased) requested list
    res.attributes = (res.attributes ?? []).map((a: string) => a.toLowerCase());
    const filter: string = req.filter.toString();
    const chain = /member:1\.2\.840\.113556\.1\.4\.1941:=(.+)\)\)$/i.exec(filter);
    if (chain) {
      const dn = chain[1].replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      for (const g of transitiveGroups(dn)) res.send({ dn: g, attributes: { objectClass: ['group'], cn: [g.split(',')[0].substring(3)] } });
      res.end();
      return next();
    }
    for (const u of USERS) {
      const attributes = {
        objectClass: ['top', 'person', 'user'],
        sAMAccountName: [u.sam],
        userPrincipalName: [`${u.sam}@test.local`],
        displayName: [u.displayName],
        memberOf: directGroups(userDn(u.sam)),
        ...(u.mail ? { mail: [u.mail] } : {}),
      };
      if (!req.filter.matches(attributes)) continue;
      // project requested attributes ourselves (ldapjs drops values of explicitly requested ones)
      const requested: string[] = (req.attributes ?? []).filter((a: string) => a !== 'dn');
      const projected: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(attributes)) {
        const asked = requested.find((r) => r.toLowerCase() === k.toLowerCase());
        if (requested.length === 0 || asked) projected[asked ?? k] = v;
      }
      res.send({ dn: userDn(u.sam), attributes: projected }, true);
    }
    res.end();
    return next();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = (server as unknown as { address(): { port: number } }).address();
  return {
    url: `ldap://127.0.0.1:${address.port}`,
    binds,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
