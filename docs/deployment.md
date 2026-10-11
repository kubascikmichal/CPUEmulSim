# Deploying the CPU Emulator web application on a server

This guide installs the web version on one Linux server (Ubuntu/Debian or Fedora/RHEL) behind nginx with HTTPS:

```
browser ──HTTPS──► nginx :443 ──HTTP──► node (cpuemul.service) 127.0.0.1:8080 ──LDAPS──► AD (optional)
                                              │
                                              └── /var/lib/cpuemul  (accounts + user files)
```

Ready-made files are in [`web-app/deploy/`](../web-app/deploy):

| File | Installed as |
|---|---|
| [`server.production.yaml`](../web-app/deploy/server.production.yaml) | `/etc/cpuemul/server.yaml` |
| [`cpuemul.env.example`](../web-app/deploy/cpuemul.env.example) | `/etc/cpuemul/cpuemul.env` (secrets) |
| [`ldap-allowed-emails.txt`](../web-app/deploy/ldap-allowed-emails.txt) | `/etc/cpuemul/ldap-allowed-emails.txt` |
| [`cpuemul.service`](../web-app/deploy/cpuemul.service) | `/etc/systemd/system/cpuemul.service` |
| [`nginx-cpuemul.conf`](../web-app/deploy/nginx-cpuemul.conf) | `/etc/nginx/sites-available/cpuemul` or `/etc/nginx/conf.d/cpuemul.conf` |

The examples use the domain `cpuemul.example.sk`; replace it everywhere.

## 1. Prerequisites

- **Node.js 22** (the server runs its TypeScript directly with `--experimental-transform-types`):
  ```bash
  # Ubuntu/Debian (NodeSource)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs
  # Fedora
  sudo dnf install -y nodejs22   # or: dnf module install nodejs:22
  node -v                        # must print v22.x
  ```
- **nginx**, **git**, and **certbot** for the TLS certificate.
- A DNS record pointing `cpuemul.example.sk` to the server; ports 80 and 443 open.

## 2. Service user, directories, code

```bash
sudo useradd --system --home /var/lib/cpuemul --shell /usr/sbin/nologin cpuemul
sudo install -d -o cpuemul -g cpuemul -m 0700 /var/lib/cpuemul        # accounts + user files
sudo install -d -o root -g cpuemul -m 0750 /etc/cpuemul                # configuration

sudo git clone https://github.com/kubascikmichal/CPUEmulSim.git /opt/cpuemul
cd /opt/cpuemul/web-app
sudo npm ci                                         # all workspaces (the build needs dev dependencies)
sudo npm run build -w @cpuemul/web                  # → packages/web/dist (the browser application)
sudo npm test -w @cpuemul/server                    # optional: server tests incl. auth (in-process LDAP)
```

The code directory stays owned by root; the service only reads it.

## 3. Configuration

```bash
cd /opt/cpuemul/web-app/deploy
sudo install -o root -g cpuemul -m 0640 server.production.yaml   /etc/cpuemul/server.yaml
sudo install -o root -g cpuemul -m 0640 ldap-allowed-emails.txt  /etc/cpuemul/ldap-allowed-emails.txt
sudo install -o root -g root    -m 0600 cpuemul.env.example      /etc/cpuemul/cpuemul.env
```

What to check in `/etc/cpuemul/server.yaml`:

- `auth.mode: local` - users register and log in with their own accounts. Set `allowRegistration: false` to close registration (existing accounts and LDAP users can still log in).
- `server.host: 127.0.0.1`, `port: 8080` - only nginx can reach the app.
- `session.secureCookie: true` - correct behind HTTPS. Set it to `false` only for a plain-HTTP test run.
- `files.dataDir: /var/lib/cpuemul` - accounts (`accounts.json`, passwords stored as scrypt hashes) and every user's files.
- `ldap.urls: []` - LDAP is off. See [step 7](#7-turning-on-ldap).

Paths in the file must be absolute (see the comments in the file).

## 4. systemd service

```bash
sudo install -m 0644 /opt/cpuemul/web-app/deploy/cpuemul.service /etc/systemd/system/cpuemul.service
sudo systemctl daemon-reload
sudo systemctl enable --now cpuemul
systemctl status cpuemul                 # "active (running)"
journalctl -u cpuemul -n 20              # startup line: "auth: local accounts (no LDAP server configured)"
curl -s http://127.0.0.1:8080/api/health # {"status":"ok"}
```

The unit runs as `cpuemul` and may write only to `/var/lib/cpuemul`. It reads `CPUEMUL_CONFIG` and secrets from `/etc/cpuemul/cpuemul.env`.

## 5. nginx and HTTPS

```bash
# Debian/Ubuntu
sudo install -m 0644 /opt/cpuemul/web-app/deploy/nginx-cpuemul.conf /etc/nginx/sites-available/cpuemul
sudo ln -s /etc/nginx/sites-available/cpuemul /etc/nginx/sites-enabled/cpuemul
# Fedora/RHEL: sudo install -m 0644 ... /etc/nginx/conf.d/cpuemul.conf
#              sudo setsebool -P httpd_can_network_connect 1   # SELinux: allow nginx → 127.0.0.1:8080
sudo sed -i 's/cpuemul.example.sk/YOUR.DOMAIN/g' /etc/nginx/sites-available/cpuemul

# certificate (HTTP challenge served from /var/www/letsencrypt by the port-80 block)
sudo install -d /var/www/letsencrypt
sudo certbot certonly --webroot -w /var/www/letsencrypt -d YOUR.DOMAIN
sudo nginx -t && sudo systemctl reload nginx
```

If the certificate does not exist yet, `nginx -t` fails on the `ssl_certificate` lines. In that case, comment out the 443 `server { ... }` block, reload nginx, run certbot, then restore the block and reload again.

Open `https://YOUR.DOMAIN/`. You should land on the login page, with `Zaregistrovať sa` below the form.

## 6. Check it works

1. Register an account, write a program, save it with `Súbor → Uložiť ako...`.
2. `Súbor → Koniec` (logs out), log in again, `Súbor → Otvoriť...` - the file is listed.
3. `Stiahnuť do počítača` in the dialog downloads it.
4. `Simulátor` opens the schematic window (allow pop-ups for the site once).

On the server, the file is at `/var/lib/cpuemul/users/<name>/files/`.

## 7. Turning on LDAP

1. In `/etc/cpuemul/server.yaml`, fill in `ldap.urls` (LDAPS, e.g. `["ldaps://dc1.example.local:636"]`), `bind.serviceDn`, `user.baseDn`, and `tls.caFile` if the directory's certificate is signed by an internal CA (copy the CA PEM to `/etc/cpuemul/ldap-ca.pem`).
2. Put the service account password into `/etc/cpuemul/cpuemul.env` as `LDAP_SERVICE_PASSWORD=...`.
3. List the e-mail addresses that may log in through LDAP in `/etc/cpuemul/ldap-allowed-emails.txt`: one per line, `#` for comments, case-insensitive.
4. `sudo systemctl restart cpuemul`. The journal shows `auth: local accounts + LDAP (...)`.

LDAP users log in with their account name or e-mail and get a workspace under their e-mail address. A user whose e-mail is not on the list gets `Nemáte oprávnenie na použitie aplikácie.` Local accounts keep working, also while the directory is unreachable.

**The allowlist can be changed at any time without a restart**; the server re-reads it when the file changes:

```bash
sudo install -o root -g cpuemul -m 0640 new-list.txt /etc/cpuemul/ldap-allowed-emails.txt
```

The server refuses plain `ldap://` URLs without StartTLS (`startTls: true`).

## 8. Updates

```bash
cd /opt/cpuemul && sudo git pull
cd web-app && sudo npm ci && sudo npm run build -w @cpuemul/web
sudo systemctl restart cpuemul
```

Sessions are kept in memory, so a restart logs everyone out. Unsaved work survives in each browser's draft autosave, and users are offered to restore it after logging in again.

## 9. Backup

Back up `/var/lib/cpuemul` (accounts and all user files) and `/etc/cpuemul` (configuration, allowlist, secrets). Files are plain `.asm`/`.txt`/`.schx` and open unchanged in the desktop application.

```bash
sudo tar -czf /root/cpuemul-$(date +%F).tgz /var/lib/cpuemul /etc/cpuemul
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `journalctl` shows a configuration error at startup | The server validates the YAML; the message names the field (e.g. `ldap.bind.serviceDn is required`). |
| Browser shows `502 Bad Gateway` | nginx cannot reach the app: `systemctl status cpuemul`; on SELinux systems `setsebool -P httpd_can_network_connect 1`. |
| Login succeeds, but you land on the login page again | The browser drops the `Secure` session cookie on plain HTTP - use HTTPS (or `secureCookie: false` for a test without TLS). |
| `Adresárová služba nie je dostupná` for LDAP users | The DCs are unreachable, or the certificate is not trusted (`tls.caFile`). Local accounts still work. |
| LDAP user gets `Nemáte oprávnenie na použitie aplikácie.` | Their `mail` attribute is missing or not in `ldap-allowed-emails.txt`. |
| `413` / `Súbor sa nepodarilo uložiť: prekročený limit úložiska.` | Per-file or per-user quota (`files.*` in the config); nginx `client_max_body_size` must be larger than `maxFileBytes`. |
