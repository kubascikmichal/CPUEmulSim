# Test Plan — Parity, Acceptance, Regression, LDAP, E2E

This plan defines what "behaviour matches" means and how each item is verified. In Phase 5, every row receives a result in the form **Original behaviour / New behaviour / Match**.
The original is upstream **v0.9.4** (see [03 §0.0](03-migration-design.md#00-reference-version-2026-10-11)).

Legend:
- **G**: golden test, automated comparison against the Java original.
- **U**: unit test.
- **E**: Playwright E2E test.
- **M**: manual side-by-side check.

---

## 1. Functional Parity Checklist

### CPU page

| # | Item | Original behaviour (expected) | Verify |
|---|---|---|---|
| C1.1 | Syntax highlighting | 5 keyword classes, labels `[a-zA-Z0-9]+:`, comments; colours from CSS | U + M |
| C1.2 | Breakpoint toggle | Gutter click toggles dot; non-instruction line → next instruction line; none if no instruction below | E |
| C1.3 | Breakpoints follow edits | Inserting or removing lines above moves breakpoints with their lines | E |
| C1.4 | UnBreak All | Clears all dots and line styles | E |
| C1.5 | Ctrl+/ | Comment/uncomment rules incl. trailing-newline handling | U |
| C1.6 | Font size | Ctrl+F9 / Ctrl+F10, 7–28 pt, default 9 pt | E |
| C1.7 | Modified marker | First change appends `*` once; program invalidated; Start text resets | E |
| C2.1 | Parser acceptance | Every corpus program: same accept/reject, same error list text and line numbers | G |
| C2.2 | Parser constants | Dec/hex/bin/oct/char boundaries; octal `010`=8; `09`=9 | G |
| C2.3 | Interrupt labels | `int00`–`int15`, `int0a`–`int0f`, duplicates, `INT0A` quirk (parse hangs at `Parsujem...`) | G + E |
| C2.4 | Parse UI | Status texts, progress, green/red console lines, error line highlight | E |
| C3.1 | Instruction semantics | Each opcode × boundary operand set: registers, flags, memory identical | G |
| C3.2 | Stack | Push/pop 8/16-bit, SP wrap 0↔65535 | G |
| C3.3 | Branching | All conditional jumps/calls, RET, label→index resolution, no-label quirk | G |
| C3.4 | Runtime stop quirks | `PUS F`, unresolved label → Idle silently | G + E |
| C3.5 | SCALL KEY/KPR/DSP | Waiting state, key value mapping (arrows 37–40, Enter 13, `š`→0x61), KPR flag | G + E |
| C3.6 | EIT timing | IE set before the instruction after EIT | G |
| C3.7 | Interrupt sequence | Level vs change mode; missing label alert text; 0.9.4: `IT` raised from a `CB` tap in the circuit | G (bus driven by harness) + E |
| C3.8 | Bus cycles | Exact sequence of address/data/control values per LMI/LMR/SMI/SMR/INN/OUT | G |
| C4.1 | State/UI matrix | Enablement, texts, progress, editor lock and highlight per state (02 §2.3) | E |
| C4.2 | Start | Reset before every run; auto-parse; auto power-on for I/O programs | E |
| C4.3 | Step from Idle | Starts paused at first instruction | E |
| C4.4 | Micro-step | Status shows each phase text in order for read and write | E |
| C4.5 | Stop in Waiting | Returns to Idle | E |
| C4.6 | Reset | Only in Idle; zeros; no changed highlight after | E |
| C5.1 | Register radix | Dec/Hex/Bin/ASCII formatting incl. `[LF]`, `[SPACE]` names and 16-bit `>>4` quirk | U |
| C5.2 | Register fields inert | Typing does not change CPU state | E |
| C5.3 | Stack table | Row order, head highlight, changed highlight, auto-scroll to `65535−SP−5` | E |
| C5.4 | Konštanty / RAM tables | 256 rows, radix toggles independent per tab and column; RAM changed highlight | E |
| C5.5 | GUI refresh | On by default; slider 10–150, snapping; disabling stops live refresh | E |
| C5.6 | Side panes | Registre/Pamäť collapse and expand, 250 ms | M |
| C6.1 | Console semantics | `[CPU KONZOLA]` once per run; LF keeps column; CR; overwrite | U + E |
| C6.2 | Bus warning | Exact text, ≤ 1 per 2 s, trailing-byte drop | G |
| C6.3 | Vyčistiť / collapse | Clears; collapse remembers divider | E |
| C7.1 | Settings | INT Level/Zmena exclusive; Mikro krokovanie; Povoliť aktualizáciu GUI; not persisted | E |
| C8.1 | New/Open/Save/Save As | Titles, pane title, prompts and button sets, UTF-8 and line handling; dialogs over account storage (D2) | E |
| C8.2 | Unsaved prompt conditions | Only when editor is non-blank; `Uložiť` only with current file | E |
| C8.3 | Open while running | Stops program first | E |
| C8.4 | Koniec | Code prompt, then schematic prompt; then logout (D9) | E |
| C8.5 | About | 4 lines + Ok | E |
| C8.6 | Ctrl+F12 | Toast texts; timing log to console | M |

### Schematic page

| # | Item | Original behaviour (expected) | Verify |
|---|---|---|---|
| S1.1 | Palette | 19 items, order, labels, icons, drag cursor/opacity | E |
| S1.2 | Drop rules | 0.9.4: accepted even on occupied cells (#19); ids `g<lowest free>`; instance names `REG1`/`RAM1`/`DEK1`/`KOD1` (lowest free number); a pin landing on a free wire end connects | U + E |
| S2.1 | Selection | Click, Shift+click, rubber band, background click | E |
| S2.2 | Move | Grid snap, clamping, multi-move | E |
| S2.3 | Delete | Delete/Backspace on release; cascades wires; selection cleanup | E |
| S2.4 | Copy/paste | Clipboard reset per copy; 0.9.4 wire inclusion rule (selected wires with pin or junction ends, closure over junctions, lone wires dropped); instance names not copied; paste anchor; new selection | E |
| S3.1 | Wiring (0.9.4) | L preview with axis lock; pin→pin out of line settles into two wires; empty-space release keeps a free end (L keeps both arms); zero-length release discarded; drop order pin → junction → free end → wire → nearest wire ≤ 5 px | G (`wire_edits`) + E |
| S3.2 | Wire model (0.9.4) | Split / settle / merge / zero-length removal produce the same structure as Java after each edit (new wire, branch, component drag + release, delete) | G (`wire_edits`: saved `.schx` byte-equal after every step) |
| S3.3 | Junctions and ends (0.9.4) | Only 3+-wire junctions visible/clickable; click selects their wires, Ctrl = chain; drag from wire body / junction / free end = branch; drag from an occupied pin = grab; double-click on a wire end deletes the wire | E |
| S4.1 | Zoom/pan | 0.3–3, ×1.1, anchor under cursor, clamping; status %; 0.9.4: pan only from a press on empty space, never with the right button | E |
| S4.2 | Status bar | Coordinates `XxY`, simulation status texts | E |
| S5.1 | Gate logic | Truth tables for NOT/AND/OR/NAND/NOR/XOR (2/3/4/8), Buffer, DEK, KOD, REG, RAM | G + U |
| S5.2 | Electrical | Driver priority, WEAK_OUT override, short-circuit highlight, Z propagation; 0.9.4: a floating net keeps one random level until it is driven | G |
| S5.3 | INP/LED | Toggle, pin placement menu, LED colour menu; 0.9.4 LED timing (lit while 1; off at once after a fall if lit ≥ 100 ms; short pulse lit 100 ms from its rising edge) | U + E |
| S5.4 | BTN/KBD | Momentary/Toggle, Label dialog (1 char), default key labels, column logic | U + E |
| S5.5 | 7-segment | Active-low segments, CA hold 100 ms, colour menu | U + E |
| S5.6 | Buses | Rail click menu (`Všetky`, signals), tap delete (`Zmazať`), resize limits for both ends (`topRow`), drop-wire-on-rail, DB read/write/hold, 0.9.4 names (`DB0..7`, `MW/`…), rail colours and tap tints, `IT` as input | G + E |
| S5.7 | Register8 / RAM 8k (0.9.4) | `Vymeň D-Q` swaps sides (saved `swapped`), labels D1–D8 / Q1–Q8; `Obsah` opens `Obsah pamäte RAM 8k` with live HEX/ASCII | U + E |
| S6.1 | Simulation | On/Off switch, editing lock, auto power-on from CPU, debug wire colours, watchdog alert | E |
| S7.1 | `.schx` load | Every corpus file loads to an equivalent model (gates, pins, wires, junctions, properties) | G |
| S7.2 | `.schx` save | Saved file byte-equal to Java's output for the same model | G |
| S7.3 | File prompts | 0.9.4: Save overwrites silently (no confirmation); unsaved prompts; titles | E |
| S8.1 | CPU mirror buttons | Texts (`Pokračovať [F5]`), enablement, F-keys in this window | E |
| S8.2 | Keyboard to CPU | Typed characters forwarded while executing; arrows not forwarded | E |

---

## 2. Migration Acceptance Checklist

- [ ] All parity rows above are marked **Match** (or the deviation is approved in writing).
- [ ] All existing quirks of the reference (01 §Existing defects: #2–#19; #1 fixed upstream) reproduced, or each fix approved (D8).
- [ ] Golden CPU traces: 100% match on the corpus (≥ 200 programs, including the lab assignments, if provided).
- [ ] `.schx` round-trip: Java→web→Java and web→Java→web produce identical files on the corpus.
- [ ] Every Slovak string in the original UI is present verbatim (automated string inventory diff).
- [ ] File storage scenarios FS1–FS14 pass; files downloaded from the store open unchanged in the desktop app.
- [ ] Shortcut compatibility table produced for Chrome, Edge, Firefox and Safari (D4).
- [ ] LDAP scenarios L1–L20 pass against the target AD (or a staging replica).
- [ ] Security review: TLS, cookie flags, CSP, rate limiting, LDAP escaping, no secrets in logs.
- [ ] Desktop (1280×720 and larger), laptop (1366×768) and tablet (1024×768 touch) layouts verified.
- [ ] No feature, screen, menu item or action exists that was not in the original, other than the approved additions:
  - login, the re-login dialog and logout via Koniec
  - account file dialogs and the draft-restore dialog (D2)
  - touch equivalents (D7)
- [ ] Deployment runbook and configuration reference delivered.

---

## 3. Regression Test Suite

### 3.1 Golden-master harness (reference = original Java engine)

- `tools/golden-harness/` is a Java 8 program that **adds no code to `src/main`**. It initialises the JavaFX toolkit (`new JFXPanel()`), then drives the original classes:
  - `Parser` → serialises the `Program`, or the error list.
  - `CPU`, through reflection or its public API → single-steps and records `{pc, a, b, c, d, sp, mp, cy, z, ie, ramDiff, stackDiff, busEvents[]}` per instruction.
  - `SchemeLoader` → loads and re-saves each `.schx`; records the netlist and pin states after scripted bus cycles.
- The output is JSON fixtures under `web-app/packages/engine/test/golden/`.
- The TypeScript engine replays the same inputs; Vitest compares the results field by field.
- Random sources (floating inputs, short circuits, idle bus values) are injected with a fixed-seed RNG on both sides, or excluded from comparison.

### 3.2 Corpus

| Set | Content |
|---|---|
| `opcodes/` | Generated: every mnemonic × operand boundary values |
| `parser/` | Valid and invalid programs: every error message, constant format and label form |
| `flow/` | Loops, calls, deep stack, wrap-around |
| `io/` | `INN`/`OUT`/`LMI`/`SMI` against reference schematics (INP→DB, DB→LED, RAM 8k, 7-segment, KBD) |
| `quirks/` | One program or schematic per existing defect (Phase 1 report, items 2–19) |
| `schx/` | Real user files plus generated files covering every component and property |

### 3.3 Unit tests

- `DataRepresentation`, `ConsoleSink`, block comment, breakpoint snapping, highlighting regex.
- Each gate's `simulate()`, `Potential` resolution (incl. 0.9.4 floating value), `GridOccupancy`, `SchemeLoader` formatting helpers, `ramContentText`. (0.9.4 deleted `OrthogonalRouter`; the wire model is covered by the `wire_edits` golden scenario.)
- `SevenSegmentDisplayTest` port; `LedTest` replaced by the 0.9.4 LED timing rules (upstream removed both JUnit tests in `376c0df`).

---

## 4. LDAP Authentication Test Scenarios

| # | Scenario | Expected |
|---|---|---|
| L1 | Valid user in authorised group | 200; session cookie `HttpOnly; Secure; SameSite=Strict`; app loads |
| L2 | Valid user, wrong password | 401; `Nesprávne používateľské meno alebo heslo.` |
| L3 | Unknown user | 401; same message as L2 (no enumeration) |
| L4 | Empty password | 400/401 **without** any bind attempt (anonymous-bind protection) |
| L5 | Valid user not in any mapped group | 403; `Nemáte oprávnenie na použitie aplikácie.` |
| L6 | User in nested group (group → group → user) | 200 when `nested: true`; 403 when `false` |
| L7 | Locked account (AD `data 775`) | 401 generic; audit log reason `locked` |
| L8 | Expired password (`data 532`) / must change (`data 773`) | 401 generic; audit reason logged |
| L9 | Disabled account (`data 533`) | 401 generic |
| L10 | LDAP injection in username (`*)(cn=*`, `\`, NUL) | Escaped; no match; 401 |
| L11 | Primary DC down, secondary up | Login succeeds via failover |
| L12 | All DCs down | 503; `Adresárová služba nie je dostupná…`; readiness probe fails |
| L13 | Untrusted LDAP certificate | Connection refused; 503; no fallback to plaintext |
| L14 | Rate limit exceeded | 429; `Príliš veľa pokusov…` |
| L15 | Session fixation attempt (pre-set cookie) | Session ID regenerated on login |
| L16 | Idle timeout with no user activity | Next keepalive → 401 → re-login modal; editor and schematic preserved |
| L17 | Program running, user idle | Idle timeout still applies (running is not activity); state preserved after re-login |
| L18 | Absolute timeout | Expires even with activity; re-login modal |
| L19 | Koniec → logout | Unsaved prompts first; session destroyed; `/` redirects to `/login`; schematic window closed |
| L20 | Unauthenticated access to `/`, `/schematic`, `/assets/*`, `/api/auth/keepalive` | Redirect to `/login` (pages) or 401 (API); app bundle never served |

Test environment: Samba AD DC in Docker with seeded users, groups (including nested) and account states, plus an OpenLDAP instance for the non-AD path.

---

## 4a. File Storage and Autosave Scenarios (D2)

| # | Scenario | Expected |
|---|---|---|
| FS1 | Save As new `prog.asm` | Dialog title `Uložiť ako..`; file listed under ASM filter; window title `CPU Emulator - prog.asm`; pane `Kód - prog.asm` |
| FS2 | Save with current file | Silent overwrite (code); no dialog |
| FS3 | Schematic Save with current file | 0.9.4: silent overwrite, no prompt |
| FS4 | Save As onto an existing name | `Súbor <name> už existuje. Prajete si ho nahradiť?` → `Áno`/`Nie` |
| FS5 | Save As without extension under the `TXT` filter | Saved as `<name>.txt` |
| FS6 | Open: filter switching | ASM shows only `.asm`, TXT only `.txt`, schematic dialog only `.schx` |
| FS7 | Content fidelity | UTF-8 with diacritics and CRLF input round-trip as in the original (lines normalised to `\n` on open); `.schx` bytes identical to the desktop output |
| FS8 | Invalid names (`../x.asm`, `a/b.asm`, `con:`, control characters, 256-byte name) | 400 `invalid_name`; message in the dialog; nothing written |
| FS9 | Case-insensitive uniqueness | `Prog.asm` vs existing `prog.asm` triggers the overwrite prompt |
| FS10 | Quota exceeded | 413; `Súbor sa nepodarilo uložiť: prekročený limit úložiska.`; editor keeps its unsaved state |
| FS11 | Isolation | User A cannot list or read user B's files by any name or encoding (including `%2e%2e`) |
| FS12 | Autosave and restore | Edit without saving → close the tab → reopen and log in → restore dialog → `Obnoviť` restores content, `*` flag and file name; `Zahodiť` deletes the draft |
| FS13 | Draft lifecycle | Draft removed after Save, Save As, New, Open, or `Nie`; never written while clean; never sent to the server |
| FS14 | Logout and expiry | Koniec deletes the user's drafts; session expiry keeps them; drafts of another user on the same browser are not offered |

---

## 5. End-to-End Scenarios (Playwright, Chrome primary; Firefox for fallbacks)

| # | Scenario |
|---|---|
| E1 | Log in → CPU page visible with title `CPU Emulator v. 0.9.4`, status `Nečinný`, button states per Idle |
| E2 | Type a program with an error → F4 → error line highlighted, `[Parser] [n] …` in red, status `Chyba v kóde` → fix → F4 → `Program úspešne zavedený!` |
| E3 | F5 a loop program → Running state UI → F9 → Paused with highlighted line → F7 ×3 → registers change, RAM/stack changed highlight → F5 continue → F10 → Idle |
| E4 | Set breakpoint on a comment line → moves to next instruction → F5 → pauses there |
| E5 | Micro-step: enable `Mikro krokovanie`, F7 into `OUT 0xFF, A` → status sequence matches the six write-phase texts |
| E6 | `SCALL KEY` program → Waiting, `Stlacte klavesu` → type `a` → D = 97; arrow ← → D = 37; F10 during Waiting → Idle |
| E7 | `SCALL DSP` output with LF/CR → console layout matches reference rendering |
| E8 | Open `.asm` from the account → title `CPU Emulator - x.asm` → edit → `Kód - x.asm*` → Ctrl+S overwrites silently → `*` cleared |
| E9 | New with unsaved changes → prompt with `Uložiť`/`Uložiť ako`/`Nie`/`Zrušiť` → each branch behaves as original |
| E10 | Simulátor → schematic window opens (1280×850, title `Simulátor - Schéma`) → Simulátor again → closes → reopen keeps sheet contents |
| E11 | Build INP×8 → DB taps, DB taps → LED×8, CB/AB as needed → run `INN A,0xFF / OUT 0xFF,A / JMP start` → toggle INP → LEDs follow; editing locked while On |
| E12 | LED timing (0.9.4): a long 1 then 0 → off at once; a pulse shorter than 100 ms → lit about 100 ms from its rising edge (±1 frame) |
| E13 | 7-segment with CA toggling → hold behaviour |
| E14 | BTN Toggle mode and Label dialog; KBD key labels and column outputs |
| E15 | Wiring (0.9.4): pin→pin as an L of two wires, free-end wire on an empty-space release, branch from a wire body, drop on a junction, grab from an occupied pin, double-click on an end deletes |
| E16 | Rubber band + Ctrl+C/Ctrl+V → pasted gates and wires at the mouse position, selected |
| E17 | Save `.schx` (silent overwrite) → reload file → identical model; compare with Java output |
| E18 | Short circuit (two OUTs, different values) → red highlights on shorted pins |
| E19 | Debug switch → wire colours Z gray / 0 blue / 1 red |
| E20 | Koniec with unsaved code and schematic → two prompts in order → logout → login page |
| E21 | Session expiry while program running → re-login modal → program and state intact |
| E22 | Tablet profile (touch): long-press context menu, pinch zoom, two-finger pan (only if D7 is approved) |
| E23 | Firefox and Safari: the full file flow (E8, FS1–FS6) and draft restore behave identically to Chrome |
