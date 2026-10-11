# Phase 3 — Migration Design

## 0. Decisions

### 0.0 Reference version (2026-10-11)

The migration target moved from 0.9.2 (`58fda1f`) to **upstream `v0.9.4`** (`de15311`). The Java reference is checked out on branch `upgrade-0.9.4`; the golden fixtures were re-recorded from it. D8 and D10 below follow the new reference.

### 0.1 Resolved (approved 2026-10-09)

| ID | Decision | Approved choice |
|---|---|---|
| D1 | Backend platform | **Node.js 22 + Fastify + TypeScript** |
| D2 | File open/save | **Approved deviation:** files are saved to the user's account on the server (flat per-user list, stored on the filesystem). The browser autosaves drafts locally (IndexedDB) for recovery. Design in §1.6 and §2.1 |
| D3 | Schematic window | **Separate browser window** sharing the engine |
| D4 | Shortcuts | Keep the same bindings; intercept where the browser allows; no new bindings |
| D5 | LDAP specifics | **Open:** the server URLs, TLS/CA, bind mode and service account, user base DN and authorised group(s) are still needed. They do not block engine or UI work |
| D6 | Session expiry | In-place re-login modal; state kept |
| D7 | Tablet | Touch equivalents, active only for touch input |
| D8 | Existing defects | Preserve all, as present in the reference version. 0.9.4 fixes #1 (interrupts from the schematic), so the port has working interrupts; it adds #17–#19, which are preserved |
| D9 | Koniec | Unsaved prompts → logout → login page |
| D10 | Title version | Follows `App.PROGRAM_VERSION` of the reference: `0.9.4` |
| D11 | Accounts before LDAP (requested 2026-10-11) | `auth.mode: local`: self-registration and password login on the login page. Accounts are stored in `${DATA_DIR}/accounts.json` (scrypt hash with per-user salt). Each account has its own file workspace (D2). Files can also be downloaded to the user's computer: `Stiahnuť do počítača` in the file dialog, `Súbor → Stiahnuť do počítača...` (code) and `Stiahnuť` (schematic toolbar). `auth.mode: ldap` remains available (LDAP only, group-based access); `none` skips login for local runs |
| D12 | LDAP next to local accounts (requested 2026-10-11) | In `auth.mode: local`, a filled-in `ldap` section (non-empty `urls`) adds directory logins; empty `urls` or a missing section means LDAP is not used. A name that belongs to a local account always uses the local password. Other names go to LDAP and are admitted only if the user's `mail` attribute is listed in `ldap.allowedEmailsFile` (`config/ldap-allowed-emails.txt`: one address per line, `#` comments, case-insensitive, re-read on change). Otherwise the result is `403 not_authorized`. LDAP users' session name and file workspace are their lowercase e-mail address; local names cannot contain `@`, so the two never collide. While the directory is down, local accounts still work and LDAP logins get `503` |

### 0.2 Original decision table (for reference)

The migration rules forbid implementing alternatives without explicit approval. Each item below is either something that cannot be transferred 1:1 to a browser, or a choice the requirements leave open.

| ID | Decision | Options | Recommendation | Why |
|---|---|---|---|---|
| **D1** | Backend platform | Node.js + TypeScript / ASP.NET Core | **Node.js 22 + Fastify + TypeScript** | One language with the engine and frontend; mature LDAP client (`ldapts`); the backend is thin (auth only). Both runtimes are installed locally |
| **D2** | File open/save | (a) File System Access API, with upload/download fallback outside Chromium; (b) server-side per-user file storage | **(a)** | Keeps "files on the user's machine", Save overwriting the current file, and Open/Save As pickers. (b) would introduce a new storage concept and new workflows. Limitation: no "current working directory" as the initial folder; pickers remember the last folder per context instead |
| **D3** | Schematic window | (a) separate browser window via `window.open`, sharing the engine; (b) in-page view | **(a)** | "Desktop Window → Web Page"; preserves two independent windows, the show/hide toggle and per-window shortcuts. Requires allowing pop-ups for the site once |
| **D4** | Browser-reserved shortcuts (Ctrl+N; possibly F12, F7, F10 depending on browser) | (a) keep the same bindings, intercepting where the browser allows and leaving the rest to the browser; (b) add alternative bindings | **(a)**, plus a per-browser compatibility table in the test report | (b) would be new behaviour. Toolbar and menu actions always work. Ctrl+N is known to be non-interceptable in a regular Chrome tab |
| **D5** | LDAP specifics | — | Needs input: server URLs, LDAPS/StartTLS and CA certificate, bind mode and service account, user base DN, authorised group DN(s) | Environment-specific |
| **D6** | Session expiry UX | (a) in-place re-login modal that keeps state; (b) redirect to `/login` | **(a)** | (b) destroys unsaved code and schematics, a data-loss path the desktop app does not have |
| **D7** | Tablet input | (a) touch equivalents: long-press = right-click, pinch = zoom, two-finger drag = pan, on-screen Shift modifier for rubber-band and multi-select; (b) desktop interaction only | **(a)**, gated to touch input so mouse behaviour is unchanged | The tablet requirement cannot be met otherwise; mouse and keyboard behaviour stays identical |
| **D8** | Existing defects (Phase 1 report, items 1–15) | preserve / fix individually | **Preserve all** (parity rule), with each one listed in the parity checklist | Fixing any of them changes behaviour; for example #1 would make interrupts work, which they currently do not |
| **D9** | `Súbor → Koniec` and window close in a browser | (a) Koniec = unsaved prompts → log out → login page; closing the tab = browser `beforeunload` prompt when unsaved; (b) add a separate Logout item | **(a)** | A page cannot reliably close itself; logging out is the closest equivalent of "exit the application". No new menu item is needed |
| **D10** | Version string shown in the title | `0.9.1` (current `App.PROGRAM_VERSION`) / `0.9.2` (POM) | **`0.9.1`** for parity, unless you choose otherwise | Title text is user-visible behaviour |

---

## 1. Frontend Architecture

### 1.1 Stack

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript 5 (strict) + Vite |
| Component library | MUI v5 (MenuBar built from `Button` + `Menu`; `Dialog`, `Tabs`, `Slider`, `Switch`, `Snackbar`, `LinearProgress`, `ToggleButtonGroup`) |
| Code editor | CodeMirror 6: custom gutter for breakpoint dots and line numbers, line decorations for the `execution-line`, `paragraph-error` and `break` styles, `StreamLanguage` highlighter built from the **same regex** as `CodeEditorFactory` |
| Large tables | `react-window` virtualisation (stack table: 65,536 rows) |
| Schematic rendering | Single SVG with four `<g>` layers (background grid, wires, gates, junctions) under one zoom/pan `transform`. Sheet grid 10 px; symbols reuse the Java geometry constants (component cell = 20 px) |
| Split panes | `react-resizable-panels` with the original initial positions (0.71 vertical, 0.13 schematic) |
| Icons | Original PNGs from `src/main/resources/icons` reused unchanged |
| Styling | Original colours from `CPUEmul_style.css` mapped 1:1 to CSS classes |
| Tests | Vitest (unit, golden), Playwright (E2E) |

### 1.2 Repository layout (new, alongside the untouched Java sources)

```
web-app/
  packages/
    engine/          # pure TS, no DOM: cpu/, bus/, schematic/, io/, util/  (ported 1:1)
    web/             # React app: cpu/, schematic/, auth/, files/, common/
    server/          # Fastify: auth/, session/, config/, static hosting
  tools/
    golden-harness/  # Java 8 test harness that records reference traces from the original engine
  docker/
```

The Java project stays as-is. It is the reference implementation for golden tests.

### 1.3 Engine execution model (replacing Java threads)

The browser runs JavaScript on one thread per window. The engine is hosted in the **CPU page** and shared by reference with the schematic window (`window.opener.cpuEmulEngine`, same origin). One cooperative scheduler drives all three original activities:

```
loop (MessageChannel macrotask, time-sliced ≤ 8 ms per slice):
  ┌─ CPU: execute instructions while state==Running, until slice budget used
  │     • bus write/read → listeners enqueue SheetChangeEvents synchronously (as in Java)
  │     • waitForSteadyState(): if simulation running → drain event queue synchronously
  │       (process events + simulate affected gates until queue empty) → return true;
  │       if simulation off → return false (console warning, 2 s rate limit)
  │     • pause/step/breakpoint/micro-step → state=Paused, yield (resume point saved)
  │     • SCALL KEY without key → state=Waiting, yield until key arrives
  ├─ Simulation: process queued events (from UI interactions: switches, buttons, keys)
  └─ Idle pass: if ≥5 ms since last idle pass and queue empty → simulate all gates
                (drives LED / 7-segment 100 ms holds) → steady state
UI refresh: requestAnimationFrame + "Interval obnovy GUI" timer (10–150 ms) while Running
```

How the original guarantees are preserved:

| Java mechanism | Observable guarantee | Web equivalent |
|---|---|---|
| `CountDownLatch` halt (pause/step/micro-step) | CPU stops at the exact same point; the status shows the message | The CPU is written as an explicit micro-step state machine (`phase` field per bus cycle) that can stop between any two phases |
| `Semaphore semKey` | Only the last key is kept; KPR = permit available; Reset drains it | `keyAvailable: boolean` + `lastKey` with identical rules |
| `Bus.waitForSteadyState()` with simulation thread idle flag | CPU continues only after the circuit has settled | Synchronous drain: the result is equal to the settled state, matching the "immediate settling" in commit `2876ca2` |
| Simulation 5 ms idle `allGates.simulate()` | LED / 7-segment 100 ms timing (0.9.4 LED: minimum lit time from the rising edge) | Same 5 ms idle pass, wall-clock `Date.now()` |
| `Platform.runLater` (wire settle, junction reconcile) | Geometry is resolved after the current event, in posting order | `runLater` → ordered microtask queue; `flushLater()` drains it synchronously (tests, golden replay) |
| 5 s watchdog (queue non-empty, no progress) | Alert `Chyba simulácie. Príliš dlhá odozva.` | The drain loop counts processed events and elapsed time; on oscillation (queue never empties within 5 s of wall time across slices) the same alert is shown and the simulation stops |
| `Platform.runLater` coalescing (LED, INP, BTN visuals) | Visuals lag the model by at most one frame | View subscribes to model change flags and re-renders on `requestAnimationFrame` |
| Parser `Task` with progress | Progress bar fills while parsing | Parser runs in a time-sliced async loop, reporting progress per line |

### 1.4 Numeric semantics helpers

`toByte(x) = (x << 24) >> 24`, `toShort(x) = (x << 16) >> 16`, `u8(x) = x & 0xFF` and `u16(x) = x & 0xFFFF`. Every register write goes through the Java-equivalent cast. Golden tests cover every opcode at the boundaries 0, 1, 127, 128, 255, 256 and 65535.

### 1.5 Keyboard routing (both windows)

- A capture-phase `keydown` listener on each window reproduces the original scene accelerators and event filters, using exactly the tables in the Phase 1 report. It calls `preventDefault` for handled keys.
- CPU key input mirrors JavaFX's `KEY_TYPED` + `KEY_PRESSED` filters, implemented with `keydown`/`keypress` mapping:
  - The CPU window forwards typed characters and arrow keys while executing.
  - The schematic window forwards typed characters only.

### 1.6 Files: account storage + browser autosave (D2, approved deviation)

The native OS file dialogs become in-app modal file dialogs over the user's server-side file list. Every other part of the file workflow is unchanged: which actions exist, when prompts appear, which buttons they offer, titles, and Save-vs-Save-As semantics.

| Original | Web |
|---|---|
| `FileChooser` open, title `Otvoriť súbor...`, filters `ASM *.asm` / `TXT *.txt` | Modal `FileDialog` (mode *open*) with the same title. It has a filter dropdown (`ASM`, `TXT`), a list of the user's files of that type (name, size, modified), a name field, and `Otvoriť` / `Zrušiť` buttons. Double-click opens. Loads via `GET /api/files/{name}` and applies the same UTF-8 decoding and line normalisation |
| Save (silent overwrite of the current file) | `PUT /api/files/{currentName}`, silent, exactly as the original |
| Save As, title `Uložiť ako..` (code) / `Uložiť schému ako...` (schematic), suggested name = current file | `FileDialog` (mode *save*) with the same title, suggested name and filter. The extension is added from the filter if missing. An existing name asks `Súbor <name> už existuje. Prajete si ho nahradiť?` (`Áno`/`Nie`), mirroring the OS save dialog's overwrite check |
| Schematic Save to the current file | Silent overwrite (0.9.4 removed the `Naozaj si prajete prepísať súbor <name>?` prompt) |
| `.schx` open, title `Načítať schému...`, filter `SCHX` | `FileDialog` with the same title and filter |
| Initial directory = folder of current file / working dir | Not applicable: the store is a flat list |

**Browser autosave (local drafts):**

- **Store:** IndexedDB database `cpuemul-drafts`, keyed by `<username>/code` and `<username>/schematic`. The value is `{content, currentFileName, savedAt}`; the schematic content is serialised in `.schx` format by the same `SchemeLoader`.
- **When it writes:**
  - Only while there are unsaved changes (the code `*` flag, or `SchematicSheet.hasChanged`).
  - Debounced 1 s after each change, and also on `visibilitychange`/`pagehide`.
  - The draft is deleted when the content becomes clean: Save, Save As, New, Open, or `Nie` in an unsaved prompt.
- **Restore:**
  - After login, if a draft exists, the window shows the modal `Obnovenie` / `Našli sa neuložené zmeny z <date time>. Prajete si ich obnoviť?` with `Obnoviť` and `Zahodiť`.
  - Restoring loads the content and marks it unsaved, with the `*` flag and the current file name restored.
  - The CPU and schematic windows each restore their own draft.
- **Privacy:** drafts are deleted on logout via Koniec (D9). On session expiry they are kept, since D6 keeps the in-memory state anyway.
- **Scope:** autosave never writes to the server. Only explicit Save or Save As does.

**Not added** (absent in the original): delete, rename, folders, sharing, version history. A user's files can only be created or overwritten. Delete may be requested later as a separate change.

### 1.7 Window titles

- `document.title` in each window follows exactly the original title rules.
- The favicon uses `cpu_icon.png` in the CPU window and `simulator_icon_128.png` in the schematic window.

---

## 2. Backend Architecture

```
            ┌─────────────────────── Node.js 22 (Fastify, TS) ───────────────────────┐
 Browser ──►│ helmet (CSP, HSTS) · rate-limit · @fastify/cookie · session plugin     │
  HTTPS     │                                                                         │
            │ /api/auth/*  ──► AuthService ──► LdapClient (ldapts, LDAPS, CA pinned) ─┼──► AD DCs
            │ /api/files/* ──► FileStore ──► /data/users/<user>/files/  (volume)      │
            │ /api/health                                                             │
            │ static: /login (public) · / /schematic /assets (session-gated)          │
            │ SessionStore: memory (single node) | Redis (multi node)                 │
            │ AuditLog: pino JSON → stdout                                            │
            └─────────────────────────────────────────────────────────────────────────┘
```

- **No database.** The server holds sessions and the per-user file store on the filesystem (D2).

### 2.1 FileStore (D2)

- **Layout:**
  - Directory: `${DATA_DIR}/users/<userKey>/files/<name>`.
  - `userKey` is the lowercase `sAMAccountName`, restricted to `[a-z0-9._-]`. Any other character is percent-encoded, so the key is stable and injective.
  - Content is stored as raw UTF-8 bytes, exactly what the editor or `SchemeLoader` produced. A file downloaded by an administrator opens unchanged in the desktop app.
- **Name rules:**
  - 1–255 bytes UTF-8, extension `.asm`, `.txt` or `.schx`.
  - Rejected: `/ \ : * ? " < > |`, control characters, and leading or trailing dots and spaces.
  - Names are unique case-insensitively, because Windows users expect that.
  - Name validation happens on the server; the client's checks are only for user messages.
- **Writes are atomic:** write to a temp file, `fsync`, then `rename`. The last write wins, as with local files in the original.
- **Limits** (configurable): 2 MB per file, 100 MB and 1,000 files per user. When exceeded the server returns `413`, shown as `Súbor sa nepodarilo uložiť: prekročený limit úložiska.`
- **Authorisation:** every operation is scoped to the session's user. There is no cross-user access path.
- **API:** see [02 §3](02-functional-specification.md#3-api-mapping).
- **Backup:** volume-level (snapshot or rsync), documented in the runbook.
- **Config:** `config/ldap.yaml` is validated at startup with a `zod` schema. Secrets come only from environment variables. The server refuses to start without TLS settings for LDAP.
- **CSP:** `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, and no inline scripts. The schematic pop-up is same-origin.

---

## 3. Authentication Architecture

The authentication flow is specified in [02 §5](02-functional-specification.md#5-ldap-integration-design). This section covers the components:

| Component | Responsibility |
|---|---|
| `LdapClient` | Connection with failover across `urls`, TLS, timeouts; `bind`, `search`; LDAP filter and DN escaping (RFC 4515/4514) |
| `AuthService` | Credential validation, search-then-bind or direct-bind, group resolution (nested via matching rule in chain), role mapping, AD error mapping to generic responses |
| `SessionService` | Create (with ID regeneration), touch (keepalive), idle and absolute expiry checks, destroy |
| `authGuard` (Fastify hook) | Gates `/`, `/schematic`, `/assets/*`, `/api/auth/keepalive`, `/api/auth/session` |
| `web/auth/LoginPage` | Form, error display, redirect to `/` on success |
| `web/auth/SessionGuard` | Activity tracking (both windows), throttled keepalive, re-login modal on `401` (D6), logout on `Koniec` (D9) |

Threat considerations:
- Anonymous or unauthenticated bind is prevented by rejecting empty passwords.
- LDAP injection is prevented by escaping.
- Credential stuffing is slowed by rate limits; AD lockout policy applies.
- Session fixation is prevented by ID regeneration.
- CSRF is prevented by `SameSite=Strict` cookies plus a required custom header.
- XSS impact is reduced because the cookie is `HttpOnly` and the CSP is strict.
- Transport is TLS end-to-end, and LDAP uses LDAPS or StartTLS only.

---

## 4. Deployment Architecture

```
 Users ─HTTPS─► Reverse proxy (nginx / IIS ARR / F5) ─HTTP(S)─► cpuemul container(s) ─LDAPS─► AD
                TLS termination, HSTS                           Node 22, port 8080
                                                                │
                                                                ├─► persistent volume /data (user files)
                                                                └─(optional)─► Redis (sessions, multi-node)
```

| Item | Choice |
|---|---|
| Artifact | Docker image, multi-stage: builds `engine` + `web`, then copies the static bundle into the `server` image. Runs as non-root on `node:22-alpine` |
| Configuration | `config/ldap.yaml` mounted read-only; environment variables `LDAP_SERVICE_PASSWORD`, `SESSION_SECRET`, `REDIS_URL` (optional), `PUBLIC_BASE_URL` |
| Certificates | AD CA certificate mounted at `tls.caFile` |
| Storage | Persistent volume mounted at `DATA_DIR` (default `/data`), owned by the container user; included in backups |
| Scaling | Single node with the memory session store is sufficient for teaching labs. For multiple nodes, use Redis for sessions plus a shared volume (NFS/SMB) for `/data` |
| Health | `/api/health` liveness; readiness checks LDAP connectivity with a service-account bind |
| Logging | JSON audit and application logs to stdout |
| Browser support | Current Chrome, Edge, Firefox and Safari. File handling is server-side and drafts use IndexedDB, so there is no per-browser file difference |
| Devices | Desktop and laptop: full. Tablet: with touch equivalents (D7). Mobile: not targeted |

---

## 5. Implementation Plan (Phase 4, after approval)

| Step | Deliverable | Exit criterion |
|---|---|---|
| 4.1 | Golden harness (Java, test-only) that runs the original `Parser`/`CPU` headless and records per-instruction traces; `.schx` corpus | Traces for the program corpus committed |
| 4.2 | `engine/cpu`: Parser, Program, CPU, DataRepresentation | 100% golden trace match; all 15 quirks reproduced |
| 4.3 | `engine/bus` + `engine/schematic` model, electrical, simulation, SchemeLoader | `.schx` round-trip byte-equal on the corpus; scripted bus-cycle traces match Java; 0.9.4 wire edits (`wire_edits` scenario) produce byte-equal files after every step |
| 4.4 | `web/cpu` CPU page | Parity checklist sections C1–C8 pass |
| 4.5 | `web/schematic` schematic page | Parity checklist sections S1–S8 pass |
| 4.6a | `server` FileStore + `/api/files` + web `FileDialog` + IndexedDB autosave | File scenarios FS1–FS14 pass |
| 4.6 | `server` auth + session + static gating | LDAP scenarios L1–L20 pass against a test AD (Samba AD DC container) |
| 4.7 | E2E suite, packaging, deployment docs | E2E suite green on Chrome; Firefox fallback cases green |
