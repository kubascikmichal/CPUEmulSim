# Phase 2 — Functional Specification

This document is the behavioural contract for the web version. Anything stated here must behave identically after migration; anything not stated here must not be added.
**Reference version: upstream `v0.9.4`** (see [01](01-repository-understanding.md)). The CPU side is unchanged from 0.9.2. Schematic rules follow the 0.9.4 wire model and components.
"Terminology" means the exact Slovak strings in the original. They are reproduced verbatim, including original typos such as `usisite`, `Stlacte klavesu` and `Pokračuj` vs `Pokračovať`.

---

## 1. Feature Map

### 1.1 Feature → original source → web module

| ID | Feature | Original source | Web module (target) |
|---|---|---|---|
| F1 | Assembler editor | `CPUController`, `CodeEditorFactory`, `BreakpointFactory`, `RichTextFXHelpers` | `web/cpu/CodeEditor` (CodeMirror 6 + gutter/decorations) |
| F2 | Parser | `Parser`, `enumInstructionsSet`, `Regexes`, `InvalidCodeLinesException` | `engine/cpu/Parser.ts`, `engine/cpu/InstructionSet.ts`, `engine/cpu/Regexes.ts` |
| F3 | CPU emulator | `CPU`, `Program`, `Instruction`, `CPUStates`, `NonExistingInterruptLabelException` | `engine/cpu/Cpu.ts`, `Program.ts`, `Instruction.ts` |
| F4 | Execution control | `CPUController` handlers + state listeners | `web/cpu/useCpuController` + `CpuToolbar` |
| F5 | Registers & memory views | `CPUController` tables, `DataRepresentation` | `web/cpu/RegistersPane`, `MemoryPane` (virtualised tables), `engine/util/DataRepresentation.ts` |
| F6 | Console | `ConsoleOutputStream`, `writeConsoleLn` | `web/cpu/Console` + `engine/io/ConsoleSink.ts` |
| F7 | Settings menu | `CPUController` handlers | `web/cpu/MenuBar` |
| F8 | Code file management | `CPUController` file handlers | `web/files/FileDialog` + `web/files/codeFiles.ts` over `/api/files` (D2: account storage) |
| F9 | Schematic editor | `SchematicSheet`, `SchematicController`, `ItemPicker`, `Movable`, `HighlightGroup`, `GridSystem`, `GridOccupancy`, `SheetLayersManager`, `Wire/*` (0.9.4: `Joint`, `WireEnd`, `WireJunction`, `Wire`) | `web/schematic/SheetView.tsx` (SVG canvas, pointer events) + `engine/schematic/Sheet.ts`, `engine/schematic/wire/Wire.ts` |
| F10 | Schematic components | `Gates/*` (incl. 0.9.4 `RAMContentWindow`), `Buses/*`, `Pin/*` | `engine/schematic/gates/*`, `engine/schematic/buses/*` + `web/schematic/symbols.tsx`, `web/schematic/RamContentWindow.tsx` |
| F11 | Logic simulation | `SchematicSimulator`, `SheetEvent`, `SheetChangeEvent`, `Potential`, `PinType` | `engine/schematic/sim/*` |
| F12 | Schematic files | `SchemeLoader` | `engine/schematic/SchemeLoader.ts` + `web/files/schemeFiles.ts` over `/api/files` |
| NEW-C | Account file storage (D2) | — | `server/files/FileStore.ts`, `web/files/FileDialog` |
| NEW-D | Browser draft autosave (D2) | — | `web/files/drafts.ts` (IndexedDB), restore dialog |
| F13 | About | `AboutDialog` | `web/common/AboutDialog` |
| F14 | System bus | `Bus` | `engine/bus/Bus.ts` |
| NEW-A | LDAP login | — | `server/auth/*`, `web/auth/LoginPage` |
| NEW-B | Session management | — | `server/session/*`, `web/auth/SessionGuard` |

### 1.2 CPU feature rules (selected golden rules)

- **Start (F5) from Idle:**
  1. Parse if needed (status `Parsujem...`).
  2. If the program has I/O instructions (`LMI LMR SMI SMR INN OUT EIT`), power on the schematic simulation. If it was off, wait 100 ms.
  3. Mark the console as unused for the `[CPU KONZOLA]` header.
  4. **Reset the CPU**: registers, flags, RAM, stack and key buffer.
  5. Load the program and set PC = 0.
  6. Randomise the bus address and data, then run.
- **Step (F7) from Idle:** like Start, but begins paused before the first instruction.
- **Breakpoint and pause check:** after fetching the instruction at PC and incrementing PC, *before* executing it. The highlighted line is the line of instruction `PC−1`.
- **Program end:** PC beyond the last instruction → Idle (`Nečinný`). Uncaught runtime errors also end in Idle.
- **Stop (F10):**
  - Ends execution, including from `Waiting` or a micro-step pause.
  - Discards pending CPU console characters that have not been printed yet.
- **Reset (F12):** enabled only in Idle. Zeroes the CPU state, resets the bus (random address and data; control word: active-low lines 1, others 0), then refreshes the GUI twice so no "changed" highlight remains.
- **Editing code:**
  - Discards the parsed program; the next F5 re-parses.
  - Breakpoint gutter dots stay; breakpoints are rebound to instruction indices at the next parse.
- **Changing breakpoints during execution** takes effect immediately for the running program, which listens for breakpoint changes.

### 1.3 Instruction semantics (golden rules)

Notation:
- `R`, `Rd`, `Rs`: unsigned register values (8-bit 0–255; `M`/`S` 16-bit 0–65535).
- `K`: constant value.
- `res`: the full integer result *before* truncation to register width.
- "—": the flag is unchanged.

| Mnemonic | Operands | Effect | Z | CY |
|---|---|---|---|---|
| ADD / ADC / ADI | `Rd, Rs` / `Rd, Rs` / `Rd, K8` | Rd += Rs / Rs+CY / K | `(res & 0xFF)==0` | `res > 255` |
| SUB / SUC / SBI | same | Rd −= Rs / Rs+CY / K | `(res & 0xFF)==0` | `res < 0` |
| AND / ANI | `Rd, Rs` / `Rd, K8` | Rd &= … | `res==0` | — |
| ORR / ORI | | Rd \|= … | `res==0` | — |
| XOR / XRI | | Rd ^= … | `res==0` | — |
| INC | `A..D` | Rd += 1 | `(res & 0xFF)==0` | **same as Z** |
| INX | `S\|M` | R += 1 | `(res & 0xFFFF)==0` | **same as Z** |
| DEC | `A..D` | Rd −= 1 | `(res & 0xFF)==0` | `(Rd_before & 0xFF)==0` |
| DCX | `S\|M` | R −= 1 | `(res & 0xFFFF)==0` | `(R_before & 0xFFFF)==0` |
| CMP / CMI | `Rd, Rs` / `Rd, K8` | no write | `Rd−x==0` | `Rd−x<0` |
| SHL | `Rd, 1..8` | Rd <<= K | `(res&0xFF)==0` | — |
| SHR | `Rd, 1..8` | Rd >>= K | `(res&0xFF)==0` | — |
| SCR | `Rd, 1..8` | CY = bit(K−1) of Rd; Rd >>= K | `(res&0xFF)==0` | bit K−1 |
| RTL | `Rd, 1..8` | `(Rd<<K)\|(Rd>>(8−K))` | `(res&0xFF)==0` | — |
| RCL | `Rd, 1..8` | as RTL | `(res&0xFF)==0` | bit0 of res |
| RTR | `Rd, 1..8` | `(Rd>>K)\|(Rd<<(8−K))` | `(res&0xFF)==0` | — |
| RCR | `Rd, 1..8` | as RTR | `(res&0xFF)==0` | bit7 of res |
| MOV | `Rd, Rs` | Rd = Rs | — | — |
| MVI | `Rd, K8` | Rd = K | — | — |
| MXI | `S\|M, K16` | R16 = K | — | — |
| MVX | `C, S\|M` | C = R16>>8, D = R16&0xFF | — | — |
| MVX | `S\|M, A` | R16 = B·256 \| A (2nd operand value unused) | — | — |
| MMR | `Rd, Rs` | Rd = progMem[Rs] (0 if out of range) | — | — |
| LMI / LMR | `Rd, K16` / `Rd` | Rd = bus memory read at K / MP (`MR_`) | — | — |
| SMI / SMR | `K16, Rs` / `Rs` | bus memory write at K / MP (`MW_`) | — | — |
| INN / OUT | `Rd, K16` / `K16, Rs` | bus I/O read / write (`IR_` / `IW_`) | — | — |
| PUS | `A..D\|M` (`F` accepted by parser) | 8-bit: `stack[SP]=v; SP−−`; `M`: push high then low | — | — |
| POP | `A..D\|M` (`F` accepted) | 8-bit: `SP = (SP==65535)?0:SP+1; v=stack[SP]`; `M`: pop low then high | — | — |
| STR / LDR | `Rd, Rs` | RAM[Rd] = Rs / Rd = RAM[Rs] | — | — |
| JMP | `label` | PC = target | — | — |
| JE·JZR / JNE·JNZ | | if Z / if !Z | | |
| JL·JCY / JNL·JGE·JNC | | if CY / if !CY | | |
| JG / JNG·JLE | | if !CY && !Z / if CY \|\| Z | | |
| CAL, CE·CZR, CNE·CNZ, CL·CCY, CNL·CGE·CNC, CG, CNG·CLE | `label` | same conditions; push PC (16-bit) then jump | — | — |
| RET | — | PC = pop16 | — | — |
| EIT | — | IE := 1 immediately **before the next instruction executes** | — | — |
| DIT | — | IE := 0 | — | — |
| SCALL | `KEY` | wait (`Waiting`, `Stlacte klavesu`) unless a key is buffered; D = key value | — | — |
| SCALL | `KPR` | — | — | CY = key buffered |
| SCALL | `DSP` | write D to console | — | — |
| BYTE | `K8` | pseudo: append to program memory | — | — |

Register writes truncate to width with Java `(byte)`/`(short)` semantics.

**Bus read cycle.** Each `→` step is a micro-step pause point when micro-stepping and stepping; the status text is in quotes:

1. "Nastavenie adresy" → set address.
2. "Nastavenie priznaku IOR|MR = 0" → `IR_`/`MR_` = 0.
3. Wait for steady state.
4. "Nacitanie dat" → Rd = data bus.
5. "Zrusenie priznaku IOR|MR" → `IR_`/`MR_` = 1; randomise the data bus.
6. "Zrusenie adresy" → randomise the address bus.

**Bus write cycle:**

1. "Nastavenie adresy" → set address.
2. "Nastavenie dat" → set data.
3. "Nastavenie priznaku IOW|MW = 0" → `IW_`/`MW_` = 0.
4. Wait for steady state.
5. "Zrusenie priznaku ZAPISU" → `IW_`/`MW_` = 1.
6. Wait for steady state.
7. "Zrusenie dat" → randomise data.
8. "Zrusenie adresy" → randomise address.

If steady state fails (simulation off, or no heartbeat for 30 s), the console warning is printed at most once every 2 s and the cycle continues with the current bus value.

**Interrupt.** After every executed instruction:

1. Sample `it = bus.IT`. (0.9.4: the circuit drives it through a `CB` tap `IT`; in 0.9.2 it was always 0.)
2. If `IE && it` and (level mode, or edge mode with previous sample 0):
   1. IE = 0, `IA_` = 0.
   2. Wait for steady state.
   3. Read the data bus.
   4. `IA_` = 1.
   5. Push PC.
   6. PC = index of label `int(data & 0x0F)`. If that label is missing, alert and stop.
3. Store the previous sample.

**SCALL KEY value:**
- Arrow keys give 37 (←), 38 (↑), 39 (→), 40 (↓).
- Any other key gives `(byte) firstChar(typed text)`.
- Only the last key pressed is kept; there is no queue. `KPR` reports whether a key event arrived since it was last consumed.

---

## 2. Screen Mapping

### 2.1 Window/screen mapping

| Original | Web equivalent | Route | Notes |
|---|---|---|---|
| — (none) | **Login page** | `/login` | New, required by LDAP. Slovak labels |
| CPU window (`Stage`, 1280×640) | **CPU page** | `/` | Same layout: MenuBar, toolbar, 3-column split, console, status bar. `document.title` mirrors the window title |
| Schematic window (`Stage`, 1280×850, shown/hidden by `Simulátor`) | **Schematic page in a second browser window** | `/schematic` (opened via `window.open` with 1280×850 features) | `Simulátor` toggles: open/focus ↔ close. Closing the window = hide (state lives in the shared engine, so nothing is lost, same as hide) |
| `Alert` CONFIRMATION (unsaved code / schematic) | MUI modal `Dialog` | — | Same title, header, content, buttons, order and conditional `Uložiť`. (The 0.9.2 schematic overwrite confirmation no longer exists in 0.9.4.) |
| `RAMContentWindow` stage `Obsah pamäte RAM 8k` (0.9.4, 820×540, one per RAM) | Non-modal floating panel in the schematic page, one per RAM, with a close button | — | Same title, `Adresa / HEX` and `ASCII` columns, 16 bytes per row, read-only monospace text, refreshed every 200 ms (text replaced only on change) |
| `Alert` ERROR (interrupt, simulation timeout) | MUI modal `Dialog` | — | Same texts |
| Swing `AboutDialog` (256×150, modal) | MUI modal `Dialog` | — | Same 4 lines and `Ok` |
| `TextInputDialog` (button / key label) | MUI `Dialog` + single-character `TextField` | — | Same title and prompt; input limited to 1 character |
| JavaFX `ContextMenu` (gates, buses, taps, wires) | MUI `Menu` anchored at the pointer | — | Same items, check/radio state, order and separators |
| ControlsFX `Notifications` (DEBUG) | MUI `Snackbar` with a warning icon | — | Same title and text |
| Native `FileChooser` | In-app modal `FileDialog` over the user's account files (D2) | — | Same dialog titles (`Otvoriť súbor...`, `Uložiť..`, `Uložiť ako..`, `Načítať schému...`, `Uložiť schému...`, `Uložiť schému ako...`), filter names (`ASM`, `TXT`, `SCHX`) and suggested name |
| — (none) | Draft restore dialog (D2) | — | New: `Obnovenie` / `Našli sa neuložené zmeny z <date time>. Prajete si ich obnoviť?` / `Obnoviť` · `Zahodiť` |

### 2.2 CPU page component tree (mirrors FXML)

```
<CpuPage>
  <MenuBar>  Súbor | Nastavenia | Pomoc            (accelerator hints shown as in JavaFX)
  <Toolbar>  icon buttons ×4 (tooltips: Nový kód, Otvoriť kód, Uložiť kód, Uložiť kód ako)
             Syntax [F4] · Spusti [F5] · Krok [F7] · Pauza [F9] · Stop [F10] · Reset [F12]
             Simulátor
  <VerticalSplit initial=0.71>
    <HorizontalSplit>
      <CollapseRail "Registre"/> <RegistersPane/>          (max 220/200 px)
      <CodePane title="Kód…"> [Načítať][Uložiť][UnBreak All] <CodeEditor/>
      <MemoryPane/> <CollapseRail "Pamäť"/>                (max 280/300 px)
    <ConsolePane title="Konzola" collapsible> [Vyčistiť]
  <StatusBar> <ProgressBar/> <StatusLabel/> … "Interval obnovy GUI" <Slider 10–150/> <value/> "ms"
```

### 2.3 CPU state machine and UI enablement

| CPU state | Parse | Start (text) | Step | Pause | Stop | Reset | Status label | Progress | Editor | Line highlight |
|---|---|---|---|---|---|---|---|---|---|---|
| Idle (also initial) | on | on `Spusti [F5]` | on | off | off | on | `Nečinný` | 0 | editable | none |
| Running | off | off | off | on | on | off | `Program sa vykonáva...` | indeterminate | read-only, focused | none |
| Paused | off | on `Pokračuj [F5]` | on | off | on | off | CPU message (`Vykonávanie pozastavené` or micro-step text) | 0.5 | read-only | line of PC−1, scrolled into view |
| Waiting | off | off | off | off | on | off | `Stlacte klavesu` | 0.5 | read-only | line of PC−1 |

The schematic page mirrors the buttons with its own texts. In Paused, Start reads `Pokračovať [F5]`; in every other state it reads `Spustiť [F5]`. Enablement is the same as in the table. The parse status texts are `Parsujem...`, `Program zavedený` and `Chyba v kóde`.

### 2.4 Schematic page component tree

```
<SchematicPage>
  <Toolbar> Nový(empty-trash) · Otvoriť · Uložiť · Uložiť ako · " | " · "  |  " · "On/Off:" <Switch/>
            · "  |  " · "Debug:" <Switch/> ⟶ Spustiť [F5] · Krok [F7] · Pauza [F9] · Stop [F10] · Reset [F12]
  <Split initial=0.13>
    <Palette>  19 items in original order, grab cursor, 0.6 opacity while dragging
    <Sheet>    SVG: grid layer (10 px) · wires layer · gates layer · junctions layer (same z-order; only junctions of 3+ wires are drawn)
  <StatusBar> "XxY" … status … "NN%"
```

---

## 3. API Mapping

The original has **no network API**. All emulator, simulator, editor and file operations stay **client-side** so that behaviour, latency and file semantics stay as close as possible to the desktop version. Moving the emulator to the server would introduce latency into micro-step, keyboard and 100 ms hold timing.

The REST API covers authentication and session management (new and required by LDAP) and account file storage (approved deviation D2).

| Method | Path | Purpose | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/auth/login` | LDAP bind and group check; create session | public (rate-limited) | `200 {user:{username, displayName}, session:{idleTimeoutSec, absoluteExpiresAt}}` / `401 {error:"invalid_credentials"}` / `403 {error:"not_authorized"}` / `503 {error:"directory_unavailable"}` |
| `GET` | `/api/auth/config` | Which login forms to show: `{mode, registration}` | public | `200` |
| `POST` | `/api/auth/register` | `auth.mode: local` only (D11): create an account and a session. Username 3–32 of `[A-Za-z0-9._-]`, unique case-insensitively; password 8–128 characters | public (rate-limited, CSRF header) | `201 {user, session}` / `400 {error: invalid_username\|weak_password}` / `409 {error: username_taken}` / `404` when registration is off |
| `POST` | `/api/auth/logout` | Destroy session | session | `204` |
| `GET` | `/api/auth/session` | Current session state (used on load and after re-login) | session | `200 {…}` / `401` |
| `POST` | `/api/auth/keepalive` | Extend idle timeout on user activity (the app is client-side, so the server otherwise sees no traffic) | session | `204` / `401` |
| `GET` | `/api/files?ext=asm,txt` | List the user's files of the given types: `[{name, size, modifiedAt}]`, sorted by name | session | `200` |
| `GET` | `/api/files/{name}` | Read file content (raw UTF-8 bytes) | session | `200 text/plain; charset=utf-8` / `404` |
| `HEAD` | `/api/files/{name}` | Existence check (Save As overwrite prompt) | session | `200` / `404` |
| `PUT` | `/api/files/{name}` | Create or overwrite (atomic) | session | `204` / `400 invalid_name` / `413 quota_exceeded` |
| `GET` | `/api/health` | Liveness and readiness (includes LDAP reachability for readiness) | public | `200 {status}` |
| `GET` | `/` , `/schematic`, `/assets/*` | Application shell and bundles | **session required**; otherwise redirect to `/login` | static |
| `GET` | `/login`, `/login-assets/*` | Login page | public | static |

Mapping of original operations to the web: every user action in sections 1–2 maps to an in-browser engine call (`engine.cpu.start()`, `engine.sheet.powerOn()`, and so on). No action maps to an HTTP call except login, logout, keepalive, and the file actions Open, Save and Save As (code and schematic). There is deliberately no delete or rename endpoint, because the original has no such actions.

---

## 4. Component Mapping (Java → TypeScript)

The engine port is **class-for-class** so that each TypeScript module can be reviewed side by side with its Java original.

| Java class | TS module | Port notes |
|---|---|---|
| `CPUEmul.CPU` | `engine/cpu/Cpu.ts` | Thread loop → resumable state machine (see 03 §1.3); identical `execute()` switch; `byte`/`short` via helpers |
| `CPUEmul.Parser` | `engine/cpu/Parser.ts` | Same regexes (Java→JS regex differences reviewed: `\p{XDigit}` → `[0-9A-Fa-f]`, `(?i)` → flag `i`, `String.matches` → anchored `^(?:…)$`); progress callback |
| `CPUEmul.Program`, `Instruction`, `enumInstructionsSet`, `Regexes`, `CPUStates` | same names | 1:1 |
| `Exceptions.*` | `engine/cpu/errors.ts` | Same messages |
| `Bus.Bus` | `engine/bus/Bus.ts` | Singleton per engine; observable properties (sync listeners, same order); steady-state = sync drain |
| `App.CPUControl.DataRepresentation` | `engine/util/DataRepresentation.ts` | Exact formatting incl. `>> 4` quirk (D8) |
| `App.CPUControl.io.ConsoleOutputStream` | `engine/io/ConsoleSink.ts` + `web/cpu/Console` | Same LF/CR/overwrite semantics, `[CPU KONZOLA]` header, 15 ms throttle |
| `App.CPUControl.CPUController` | `web/cpu/*` (hooks + components) | UI only; logic paths kept in same order |
| `App.CPUControl.CodeEditor.*` | `web/cpu/CodeEditor/*` | Highlight regex identical; breakpoint snapping via `Parser.isInstrucionLine` |
| `App.SchematicControl.SchematicController` | `web/schematic/SchematicPage` | Toolbar, status, key handling |
| `App.AboutDialog` | `web/common/AboutDialog.tsx` | Same text |
| `SchematicSim.Sheet.SchematicSheet` | `engine/schematic/Sheet.ts` + `web/schematic/SheetView.tsx` | Model/editor logic in engine (instance naming, drop resolution `resolveWireDrop`, junction-aware copy/paste); zoom/pan/rubber-band and the event order in view |
| `SchematicSim.Sheet.SchematicSimulator` | `engine/schematic/sim/Simulator.ts` | Event queue with same de-dup rule; idle pass every 5 ms; 5 s watchdog |
| `SchemeLoader` | `engine/schematic/SchemeLoader.ts` | Java FQCN ↔ TS class registry; Java `Double.toString` formatting |
| `SheetEvent`, `SheetChangeEvent`, `SheetLayersManager`, `GridSystem`, `GridOccupancy`, `Movable`, `HighlightGroup`, `Item`, `ItemPicker`, `Selectable`, `Side`, `Connectable` | same names under `engine/schematic/*` | 1:1 model; rendering split to `web/schematic/*` |
| `Electrical.Potential`, `PinType` | `engine/schematic/electrical/*` | Identical tree algorithm and short-circuit rules; RNG injectable |
| `Pin.*` | `engine/schematic/pin/*` | Model + highlight state; view renders |
| `Wire.*` (0.9.4: `Wire`, `WireEnd`, `WireJunction`, `Joint`; `WireSegment` and `OrthogonalRouter` were deleted upstream) | `engine/schematic/wire/Wire.ts` | Straight-segment model ported method by method: L preview, settle/split, drop resolution, junction reconcile (dirty set, merge, zero-length removal), net rebuild from drivers. `Platform.runLater` becomes an ordered microtask queue (`runLater` / `flushLater`) |
| `Gates.*` (16 classes + `RAMContentWindow`), `Buses.*` (4 classes) | `engine/schematic/gates/*`, `buses/*` + `web/schematic/symbols.tsx` | Simulation logic in engine, drawing in SVG symbol components using identical geometry constants (component cell 20 px) |

---

## 5. LDAP Integration Design

### 5.1 Requirements traceability

| Requirement | Design element |
|---|---|
| LDAP login page | `/login` page: `Používateľské meno`, `Heslo`, `Prihlásiť`; Slovak error messages |
| Active Directory integration | `ldapts` client; AD-aware user lookup (`sAMAccountName` / `userPrincipalName`); nested groups via `LDAP_MATCHING_RULE_IN_CHAIN` |
| Configurable LDAP server settings | `config/ldap.yaml` + environment overrides (below) |
| Group-based authorization | `authorization.roleMappings`: AD group DN → app role; login denied if no mapped role |
| Session expiration | Server-side sessions; idle and absolute timeouts; client keepalive on user activity |
| Secure authentication flow | LDAPS/StartTLS only, CA pinning, no password storage, HttpOnly/Secure/SameSite cookies, rate limiting, generic error messages, audit log |
| No OAuth / no social login | Not implemented. Local accounts exist only in `auth.mode: local` (D11), the interim mode before LDAP |

### 5.2 Configuration (all values are deployment-specific; examples only)

```yaml
ldap:
  urls: ["ldaps://dc1.example.local:636", "ldaps://dc2.example.local:636"]  # failover order
  startTls: false                 # true when using ldap:// + StartTLS
  tls:
    caFile: /etc/cpuemul/ldap-ca.pem
    rejectUnauthorized: true
  connectTimeoutMs: 5000
  bind:
    mode: search-then-bind        # or: direct-bind (UPN = {username}@{upnSuffix})
    serviceDn: CN=svc-cpuemul,OU=Service,DC=example,DC=local
    servicePasswordEnv: LDAP_SERVICE_PASSWORD
  user:
    baseDn: OU=Users,DC=example,DC=local
    filter: "(&(objectClass=user)(sAMAccountName={{username}}))"   # value LDAP-escaped
    attributes: { username: sAMAccountName, displayName: displayName }
    upnSuffix: example.local
  groups:
    nested: true                  # uses (member:1.2.840.113556.1.4.1941:={{userDn}})
    baseDn: OU=Groups,DC=example,DC=local
authorization:
  roleMappings:
    - group: CN=CPUEmul-Users,OU=Groups,DC=example,DC=local
      role: user
  defaultRole: null               # null = deny when no group matches
session:
  idleTimeoutMin: 30
  absoluteTimeoutHours: 8
  cookieName: cpuemul.sid
  secureCookie: true
  store: memory                   # or redis (multi-instance)
security:
  loginRateLimit: { perIpPerMin: 10, perUserPerMin: 5 }
```

### 5.3 Roles

The original application has **no permission differences**. Every user can use every feature. The role model therefore defines a single role, `user`, which grants access to the application. The architecture keeps `roleMappings` as a list so that further roles can be mapped later, but no feature is gated by a role unless that is explicitly requested, since gating would be new behaviour.

### 5.4 Login flow

1. The browser requests `/`. With no valid session it gets a `302` to `/login`.
2. The user submits credentials to `POST /api/auth/login` over HTTPS. The body is JSON, and a CSRF header `X-Requested-With: cpuemul` is required.
3. The server validates the input: non-empty fields and length limits. An empty password is rejected **before** any bind, to prevent an unauthenticated anonymous bind from counting as success.
4. The server binds against AD:
   - **search-then-bind:** bind as the service account, search for the user with the escaped filter (exactly one entry required), then bind as the user's DN with the supplied password.
   - **direct-bind:** bind as `username@upnSuffix`, then read the user's own entry.
5. The server resolves group membership, including nested groups, and maps it to roles. With no role the response is `403 not_authorized`.
6. The server regenerates the session ID (preventing session fixation) and stores `{username, displayName, roles, createdAt, lastActivity}`. The password is never stored or logged.
7. The server sets the cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`) and writes an audit log line (success or failure, username, IP, reason code).
8. The browser loads the application.

### 5.5 Session expiration

- **Idle timeout:** the server compares the time since `lastActivity`. The client sends `POST /api/auth/keepalive`, throttled to at most once per minute, whenever there is real user input (keyboard or pointer) in either window. A running program does **not** count as activity.
- **Absolute timeout:** fixed lifetime from login; it cannot be extended.
- **On expiry:** the next keepalive returns `401`. The client shows a **modal re-login dialog over the current page**, without navigating away. Engine state, the editor, unsaved code and the schematic stay in memory, and the running program is not stopped. After a successful re-login the dialog closes (decision D6).
- **Logout:** `Súbor → Koniec` runs the original unsaved-changes prompts. On confirmation it calls `/api/auth/logout`, closes the schematic window and shows `/login` (decision D9).

### 5.6 Error messages (login page)

| Condition | Message (Slovak, UI language of the app) |
|---|---|
| Wrong username/password | `Nesprávne používateľské meno alebo heslo.` |
| Not in an authorised group | `Nemáte oprávnenie na použitie aplikácie.` |
| Directory unreachable | `Adresárová služba nie je dostupná. Skúste to neskôr.` |
| Rate limited | `Príliš veľa pokusov. Skúste to neskôr.` |
| Session expired (re-login dialog) | `Platnosť relácie vypršala. Prihláste sa znova.` |

Messages for wrong credentials and an unknown user are identical, which prevents user enumeration. AD sub-codes (`data 52e`, `data 775` locked, `data 532` expired password) are logged server-side only.
