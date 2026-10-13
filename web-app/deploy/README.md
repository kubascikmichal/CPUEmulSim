# Deployment files

Example files for running the CPU Emulator web application on a Linux server. The full guide (nginx or Apache, HTTPS, LDAP, backups, troubleshooting) is [docs/deployment.md](../../docs/deployment.md).

| File | Installed as | Purpose |
|---|---|---|
| `server.production.yaml` | `/etc/cpuemul/server.yaml` | Server configuration (local accounts; LDAP off until `ldap.urls` is filled in) |
| `cpuemul.env.example` | `/etc/cpuemul/cpuemul.env` | Secrets: config path, administrator name and password, LDAP service account password |
| `ldap-allowed-emails.txt` | `/etc/cpuemul/ldap-allowed-emails.txt` | E-mail addresses allowed to log in through LDAP |
| `cpuemul.service` | `/etc/systemd/system/cpuemul.service` | systemd service that runs the app |
| `apache2-cpuemul.conf` | `/etc/apache2/sites-available/cpuemul.conf` | Apache 2: HTTPS + reverse proxy (or use nginx) |
| `nginx-cpuemul.conf` | `/etc/nginx/sites-available/cpuemul` | nginx: HTTPS + reverse proxy (or use Apache) |

## Creating the service on Debian

Run as a user with `sudo`.

### 1. Install Node.js 22 and git

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git
node -v          # must print v22.x
which node       # must print /usr/bin/node (the path used in cpuemul.service)
```

### 2. Create a user and directories for the service

```bash
sudo useradd --system --home /var/lib/cpuemul --shell /usr/sbin/nologin cpuemul
sudo install -d -o cpuemul -g cpuemul -m 0700 /var/lib/cpuemul   # accounts and user files
sudo install -d -o root -g cpuemul -m 0750 /etc/cpuemul          # configuration
```

### 3. Download and build the app

```bash
sudo git clone https://github.com/kubascikmichal/CPUEmulSim.git /opt/cpuemul
cd /opt/cpuemul/web-app
sudo npm ci
sudo npm run build -w @cpuemul/web
```

### 4. Configuration

```bash
cd /opt/cpuemul/web-app/deploy
sudo install -o root -g cpuemul -m 0640 server.production.yaml  /etc/cpuemul/server.yaml
sudo install -o root -g cpuemul -m 0640 ldap-allowed-emails.txt /etc/cpuemul/ldap-allowed-emails.txt
sudo install -o root -g root    -m 0600 cpuemul.env.example     /etc/cpuemul/cpuemul.env
```

In `/etc/cpuemul/server.yaml`, check `port: 8080` and the paths. Set `CPUEMUL_ADMIN_USERNAME` and `CPUEMUL_ADMIN_PASSWORD` in `/etc/cpuemul/cpuemul.env` (the administrator assigns teacher roles; see [Users and roles](../../docs/deployment.md#users-and-roles)). Fill in `LDAP_SERVICE_PASSWORD` in `/etc/cpuemul/cpuemul.env` only once you turn on LDAP.

### 5. Create and start the service

```bash
sudo cp /opt/cpuemul/web-app/deploy/cpuemul.service /etc/systemd/system/cpuemul.service
sudo systemctl daemon-reload              # load the new unit
sudo systemctl enable --now cpuemul       # start now and at every boot
```

### 6. Check it is running

```bash
systemctl status cpuemul                  # should show "active (running)"
journalctl -u cpuemul -n 30               # log; contains "auth: local accounts ..."
curl -s http://127.0.0.1:8080/api/health  # {"status":"ok"}
```

### Everyday commands

| Task | Command |
|---|---|
| Restart (after changing `server.yaml` or `cpuemul.env`) | `sudo systemctl restart cpuemul` |
| Stop / start | `sudo systemctl stop cpuemul` / `sudo systemctl start cpuemul` |
| Follow the log live | `journalctl -u cpuemul -f` |
| Do not start at boot | `sudo systemctl disable cpuemul` |
| After editing the `.service` file | `sudo systemctl daemon-reload && sudo systemctl restart cpuemul` |
| Update the app | `cd /opt/cpuemul && sudo git pull && cd web-app && sudo npm ci && sudo npm run build -w @cpuemul/web && sudo systemctl restart cpuemul` |

Changes to the e-mail allowlist do not need a restart.

### What the service file does

It runs `node … src/main.ts` as the `cpuemul` user in `/opt/cpuemul/web-app/packages/server`. It loads `CPUEMUL_CONFIG` and the passwords from `/etc/cpuemul/cpuemul.env`, restarts the app after a crash, and lets it write only to `/var/lib/cpuemul`.

### If it does not start

- `journalctl -u cpuemul -n 50` shows the reason, for example an invalid config value or a port already in use.
- `status=203/EXEC` means Node is not at `/usr/bin/node`. Put the output of `which node` into `ExecStart=` and run `daemon-reload`.

## Making it reachable from outside

The service listens only on `127.0.0.1:8080`. To serve it over HTTPS, put Apache 2 (`apache2-cpuemul.conf`) or nginx (`nginx-cpuemul.conf`) in front of it. See [docs/deployment.md](../../docs/deployment.md), section 5 (nginx) or 5b (Apache).
