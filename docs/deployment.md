# Deploying the CPU Emulator web application on a server

This guide installs the web version on one Linux server (Ubuntu/Debian or Fedora/RHEL) behind a web server with HTTPS, either **nginx** ([step 5](#5-nginx-and-https)) or **Apache 2** ([step 5b](#5b-apache-2-and-https)):

```
browser ──HTTPS──► nginx or Apache :443 ──HTTP──► node (cpuemul.service) 127.0.0.1:8080 ──LDAPS──► AD (optional)
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
| [`apache2-cpuemul.conf`](../web-app/deploy/apache2-cpuemul.conf) | `/etc/apache2/sites-available/cpuemul.conf` or `/etc/httpd/conf.d/cpuemul.conf` (instead of nginx) |

The examples use the domain `cpuemul.example.sk`; replace it everywhere.

A short Debian-only walkthrough of creating the systemd service is in [`web-app/deploy/README.md`](../web-app/deploy/README.md).

## 1. Prerequisites

- **Node.js 22** (the server runs its TypeScript directly with `--experimental-transform-types`):
  ```bash
  # Ubuntu/Debian (NodeSource)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs
  # Fedora
  sudo dnf install -y nodejs22   # or: dnf module install nodejs:22
  node -v                        # must print v22.x
  ```
- **nginx** or **Apache 2**, **git**, and **certbot** for the TLS certificate.
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

- `auth.mode: local` - users register and log in with their own accounts. Registration asks for the full name and a captcha (`security.captcha`, a proof of work solved in the browser - no external service). Set `allowRegistration: false` to close registration (existing accounts and LDAP users can still log in).
- `server.host: 127.0.0.1`, `port: 8080` - only nginx can reach the app.
- `session.secureCookie: true` - correct behind HTTPS. Set it to `false` only for a plain-HTTP test run.
- `files.dataDir: /var/lib/cpuemul` - accounts (`accounts.json`, passwords stored as scrypt hashes) and every user's files.
- `ldap.urls: []` - LDAP is off. See [step 7](#7-turning-on-ldap).

Paths in the file must be absolute (see the comments in the file).

In `/etc/cpuemul/cpuemul.env`, set the administrator: `CPUEMUL_ADMIN_USERNAME` and `CPUEMUL_ADMIN_PASSWORD` (8-128 characters). See [Users and roles](#users-and-roles).

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

## Users and roles

With `auth.mode: local` there are three kinds of users:

| Role | Who | Can |
|---|---|---|
| Student | everyone who registers (or is created / imported by a teacher) | use the emulator, save and load own files |
| Teacher | a student promoted by the administrator | additionally: on the page **Správa používateľov** (menu `Súbor`, or `https://YOUR.DOMAIN/admin`) list students (online state, last login, storage), create students, import a class from CSV, change a student's name or password, block / unblock, delete a student with all files |
| Administrator | the account from `cpuemul.env` | everything a teacher can, for every account, and switches accounts between student and teacher |

- Blocking, deleting or a new password logs the user out at once. A blocked user sees "Účet je zablokovaný" at login.
- CSV import: one student per line, `name;username` (e.g. `Ján Novák;jnovak`); a header line is optional, `,` works too. Passwords are generated; the teacher downloads the list (name, username, password) right after the import - it is not shown again. At most 300 lines per import.
- Accounts registered before this version become active students.
- Changing the administrator's name or password: edit `cpuemul.env`, then `sudo systemctl restart cpuemul`.

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

## 5b. Apache 2 and HTTPS

Use this instead of step 5 if the server runs Apache. The app service from step 4 is the same; Apache only terminates TLS and proxies to `127.0.0.1:8080`.

**Debian/Ubuntu** (package and service `apache2`):

```bash
sudo apt-get install -y apache2
sudo a2enmod proxy proxy_http ssl headers rewrite
sudo install -m 0644 /opt/cpuemul/web-app/deploy/apache2-cpuemul.conf /etc/apache2/sites-available/cpuemul.conf
sudo sed -i 's/cpuemul.example.sk/YOUR.DOMAIN/g' /etc/apache2/sites-available/cpuemul.conf
sudo a2ensite cpuemul
sudo a2dissite 000-default            # optional: the default site would answer for unknown host names
sudo systemctl enable --now apache2
```

**Fedora/RHEL** (package and service `httpd`; proxy, headers and rewrite modules are loaded by default):

```bash
sudo dnf install -y httpd mod_ssl
sudo install -m 0644 /opt/cpuemul/web-app/deploy/apache2-cpuemul.conf /etc/httpd/conf.d/cpuemul.conf
sudo sed -i -e 's/cpuemul.example.sk/YOUR.DOMAIN/g' \
            -e 's#${APACHE_LOG_DIR}/#logs/#' /etc/httpd/conf.d/cpuemul.conf   # APACHE_LOG_DIR is Debian-only
sudo setsebool -P httpd_can_network_connect 1   # SELinux: allow Apache → 127.0.0.1:8080
sudo systemctl enable --now httpd
```

**Certificate** (both). The port-80 virtual host serves certbot's HTTP challenge from `/var/www/letsencrypt`:

```bash
sudo install -d /var/www/letsencrypt
sudo certbot certonly --webroot -w /var/www/letsencrypt -d YOUR.DOMAIN
sudo apachectl configtest && sudo systemctl reload apache2   # Fedora: reload httpd
```

If the certificate does not exist yet, `configtest` fails on the `SSLCertificateFile` lines. Comment out the `<VirtualHost *:443>` block, reload Apache, run certbot, then restore the block and reload again.

Managing the two services:

| Task | App | Apache (Debian / Fedora) |
|---|---|---|
| Status | `systemctl status cpuemul` | `systemctl status apache2` / `httpd` |
| Restart after config change | `sudo systemctl restart cpuemul` | `sudo systemctl reload apache2` / `httpd` |
| Logs | `journalctl -u cpuemul -f` | `/var/log/apache2/cpuemul-error.log` / `/var/log/httpd/cpuemul-error.log` |
| Start at boot | `sudo systemctl enable cpuemul` | `sudo systemctl enable apache2` / `httpd` |

Notes:
- `ProxyPreserveHost` and `RequestHeader set X-Forwarded-Proto "https"` pass the original host and scheme to the app; mod_proxy adds `X-Forwarded-For`, which the app uses for rate limiting (`trustProxy: true`).
- Upload size is limited by the app (`files.maxFileBytes`, 413 `prekročený limit úložiska`). Apache 2.4 does not apply `LimitRequestBody` to proxied request bodies, so it is not set in the site.

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
| Browser shows `502 Bad Gateway` / `503 Service Unavailable` | The web server cannot reach the app: `systemctl status cpuemul`; on SELinux systems `setsebool -P httpd_can_network_connect 1`. Apache: check that `proxy` and `proxy_http` are enabled (`apachectl -M`). |
| Apache: `Invalid command 'SSLEngine'` | mod_ssl missing: `a2enmod ssl` (Debian) or `dnf install mod_ssl` (Fedora). |
| Apache: `Invalid command 'RequestHeader'` / `'RewriteEngine'` | `a2enmod headers rewrite` (Debian). |
| Login succeeds, but you land on the login page again | The browser drops the `Secure` session cookie on plain HTTP - use HTTPS (or `secureCookie: false` for a test without TLS). |
| `Adresárová služba nie je dostupná` for LDAP users | The DCs are unreachable, or the certificate is not trusted (`tls.caFile`). Local accounts still work. |
| LDAP user gets `Nemáte oprávnenie na použitie aplikácie.` | Their `mail` attribute is missing or not in `ldap-allowed-emails.txt`. |
| `413` / `Súbor sa nepodarilo uložiť: prekročený limit úložiska.` | Per-file or per-user quota (`files.*` in the config). With nginx, `client_max_body_size` must be larger than `maxFileBytes`. |
