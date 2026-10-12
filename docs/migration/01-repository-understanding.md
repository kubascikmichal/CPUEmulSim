# Phase 1 — Repository Understanding Report

Scope: `CPUEmulSim` at upstream tag `v0.9.4` (commit `de15311`, github.com/ondrejkarpis/CPUEmulSim), checked out locally on branch `upgrade-0.9.4`.
Every statement below was verified by reading the source; file references point to the code that implements the behaviour.

> **Updated for 0.9.4.** The first version of this report described 0.9.2 (`58fda1f`). Between the two, the CPU, parser, CPU window and simulator loop did not change. The schematic editor changed substantially: a new wire model, a 10 px grid, and new component features. Sections F9–F12, the data model and the quirks list are updated. Changes from 0.9.2 are marked **(0.9.4)**.

---

## Current Architecture

### Summary

A single-process **JavaFX desktop application** (Java 8, Maven) with two top-level windows:

1. **CPU emulator window** ("CPU Emulator v. 0.9.4"): assembler editor, CPU control, registers, memory tables and console.
2. **Schematic simulator window** ("Simulátor - Schéma"): a grid-based logic schematic editor and event-driven logic simulator connected to the CPU through a shared system bus.

There is **no server, no network communication, no database and no authentication**. All state lives in memory; persistence is limited to user-chosen files (`.asm`/`.txt` for code, `.schx` for schematics).

### Technology inventory

| Area | Technology | Where |
|---|---|---|
| Language / runtime | Java 8 (source/target 1.8), JavaFX 8 bundled with the JDK | [pom.xml](../../pom.xml) |
| Build | Maven 3, `maven-assembly-plugin` fat jar (`CPUEmulSim.jar`), main class `sk.uniza.fri.cp.App.App` | [pom.xml](../../pom.xml) |
| UI | JavaFX (FXML + programmatic), one Swing dialog (About) | [Main_CPUEmul.fxml](../../src/main/resources/fxml/Main_CPUEmul.fxml), [AboutDialog.java](../../src/main/java/sk/uniza/fri/cp/App/AboutDialog.java) |
| Code editor | RichTextFX 0.8.2 (`CodeArea`, `InlineCssTextArea`) | [CodeEditorFactory.java](../../src/main/java/sk/uniza/fri/cp/App/CPUControl/CodeEditor/CodeEditorFactory.java) |
| Extra controls | ControlsFX 8.40.12 (`ToggleSwitch`, `Notifications`) | [SchematicController.java](../../src/main/java/sk/uniza/fri/cp/App/SchematicControl/SchematicController.java) |
| XML | JDOM2 2.0.6 (`.schx` read/write) | [SchemeLoader.java](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Sheet/SchemeLoader.java) |
| Logging | Log4j2 2.8.2 (`times_CPU` logger, root level ERROR) | [log4j2.xml](../../src/main/resources/log4j2.xml) |
| Utilities | commons-lang3 3.5 (`ArrayUtils`) | [Program.java](../../src/main/java/sk/uniza/fri/cp/CPUEmul/Program.java) |
| Tests | JUnit 4.13.2, two reflection-based unit tests | [src/test](../../src/test/java/sk/uniza/fri/cp/SchematicSim/Gates) |

### Dependency inventory

| Dependency | Version | Used for | Web migration note |
|---|---|---|---|
| `org.fxmisc.richtext:richtextfx` | 0.8.2 | Code editor, console | Replace with a browser code editor (CodeMirror 6 recommended) |
| `org.controlsfx:controlsfx` | 8.40.12 | ToggleSwitch, toast notifications | MUI `Switch`, `Snackbar` |
| `org.jdom:jdom2` | 2.0.6 | `.schx` XML | Browser `DOMParser` / `XMLSerializer` |
| `org.apache.logging.log4j:*` | 2.8.2 | Debug instruction timing log (Ctrl+F12) | Browser console |
| `org.apache.commons:commons-lang3` | 3.5 | `ArrayUtils.toPrimitive` | Not needed |
| `net.java.dev.jna:jna` | 4.3.0 | **Unused** (only "USB" mentions in comments, legacy of the removed breadboard/USB board) | Drop |
| `junit:junit` | 4.13.2 | Tests | Test harness only |

### Package structure (≈16,900 lines of Java)

| Package | Responsibility | Key classes |
|---|---|---|
| `sk.uniza.fri.cp.App` | Application bootstrap, About dialog | `App`, `AboutDialog` |
| `…App.CPUControl` | CPU window controller, value formatting, editor, console | `CPUController` (1,732 lines), `DataRepresentation`, `CodeEditorFactory`, `BreakpointFactory`, `RichTextFXHelpers`, `ConsoleOutputStream` |
| `…App.SchematicControl` | Schematic window controller | `SchematicController` |
| `sk.uniza.fri.cp.CPUEmul` | CPU emulator, assembler parser, program model | `CPU` (thread), `Parser` (JavaFX `Task`), `Program`, `Instruction`, `enumInstructionsSet`, `Regexes`, `CPUStates` |
| `sk.uniza.fri.cp.Bus` | Singleton system bus (address/data/control) and CPU↔simulation handshake | `Bus` |
| `sk.uniza.fri.cp.SchematicSim` | Schematic editor and simulator: sheet, grid, items, pins, potentials, wires, buses, components, file I/O | `SchematicSheet`, `SchematicSimulator`, `SchemeLoader`, `Potential`, `Pin`, `Wire`, `GateSymbol` and subclasses |

### Runtime threads and concurrency (behaviour-relevant)

| Thread | Created by | Role |
|---|---|---|
| JavaFX Application Thread | JavaFX | All UI, editor, file dialogs, most schematic editing |
| `CPU_Thread` (daemon) | `CPUController.initCPU()` | Fetch–execute loop; blocks on `CountDownLatch` (pause/step), `Semaphore` (keyboard), and `Bus.waitForSteadyState()` |
| `SchematicSimulationThread` | `SchematicSimulator` (JavaFX `Service`) | Event-driven logic simulation loop; polls event queue every 5 ms; idle passes re-simulate all gates (drives 100 ms hold timers) |
| Parser thread (daemon) | `CPUController.parseCode()` | Runs `Parser` task; progress bound to progress bar |
| GUI update service | `CPUController.updateGUIService` | While running and not paused, refreshes registers/tables every *N* ms (slider) |

CPU↔simulation coupling: bus property listeners (`DataBus8`, `AddressBus16`, `ControlBus`) fire **synchronously on the CPU thread** when the CPU changes bus values and enqueue `SheetChangeEvent`s; the CPU then calls `Bus.waitForSteadyState()`, which waits until the simulation queue is empty **and** the simulation thread reports idle (30 s watchdog).

---

## Existing Features

### F1 — Assembler editor ([CPUController.java](../../src/main/java/sk/uniza/fri/cp/App/CPUControl/CPUController.java), [CodeEditorFactory.java](../../src/main/java/sk/uniza/fri/cp/App/CPUControl/CodeEditor/CodeEditorFactory.java))

- Line numbers; syntax highlighting, case-insensitive, by class:
  - arithmetic/logic: purple, bold
  - shift/rotate: `#80632a`, bold
  - move/IO: `#348038`, bold
  - branch: `#144e80`, bold
  - special: `#638000`, bold
  - labels `\w+:` at the line start (same rule as the parser; was `[a-zA-Z0-9]+:` anywhere): `#804000`, bold
  - comments `;.*`: cadetblue
- Caret line background `#f2f9fc`; executing line `#caffca`; error line `#ffb1ae`; breakpoint line `#ff8331`.
- Breakpoints: click the gutter to toggle a red dot. Clicking a non-instruction line places the breakpoint on the **next** instruction line (`Parser.isInstrucionLine`). Breakpoints follow line insertions and deletions. **UnBreak All** clears them.
- Block comment toggle (**Ctrl+/**): extends the selection to line start and adds or removes a leading `;` on every line. It un-comments only when every selected line starts with `;`.
- Font size: **Ctrl+F9** shrinks, **Ctrl+F10** grows, range 7–28 pt, default 9 pt.
- Any text change discards the parsed program, resets the Start button text to `Spusti [F5]`, and appends `*` to the pane title once.
- Read-only while a program is running; editing is re-enabled on Idle.

### F2 — Assembler parser ([Parser.java](../../src/main/java/sk/uniza/fri/cp/CPUEmul/Parser.java), [enumInstructionsSet.java](../../src/main/java/sk/uniza/fri/cp/CPUEmul/enumInstructionsSet.java), [Regexes.java](../../src/main/java/sk/uniza/fri/cp/CPUEmul/Regexes.java))

- Removes comments (`;` to end of line, **even inside a character literal**). Labels match `^\s*\w+:`.
- Tokenizes with `[^\s"',]+|'.'`. Mnemonics are case-insensitive and validated against the enum. Parameter count and per-parameter regexes are checked.
- Constants:
  - byte: decimal 0–255, hex `0x..`, binary `...b`, octal with a leading `0`, char `'c'`
  - short: decimal 0–65535, hex, binary up to 16 bits, octal
- Interrupt labels: `int00`–`int15` or `INT00`–`INT15`, decimal. Duplicate interrupt label is an error. Since 2026-10-12, any other label starting with `int` (any case) is a parse error; before, `int0a`–`int0f` were hex interrupt labels and other `int…` labels were ordinary labels.
- `BYTE k` appends to program memory (constants) and does not emit an instruction.
- Labels resolve to **instruction indices**. PC addresses instructions, not bytes.
- Error message format: `[<line>] <message>`. Messages are Slovak, verbatim:
  - `Návestie … už existuje`
  - `Nesprávny prvý parameter inštrukcie '…'`
  - `Zlý počet parametrov…`
  - `Neplatná inštrukcia '…'`
  - `Neplatné návestie '…'`
  - two `MVX`-specific messages
- Parse result:
  - Success: console prints `Program úspešne zavedený!` in green and the status shows `Program zavedený`.
  - Failure: error lines are highlighted, every error is printed in red as `[Parser] …`, and the status shows `Chyba v kóde`.

### F3 — CPU emulator ([CPU.java](../../src/main/java/sk/uniza/fri/cp/CPUEmul/CPU.java))

- **Registers:**
  - 8-bit: A, B, C, D
  - 16-bit: PC, SP, MP (named `M` in code, `S` = SP)
  - Flags: CY, Z, IE
- **Memory:**
  - internal RAM 256 B (`STR`/`LDR`)
  - stack 64 KiB, push is `stack[SP--]`
  - program memory = `BYTE` constants (`MMR`)
- **Instruction set:** 66 mnemonics. The exact flag semantics of each opcode are documented in [02-functional-specification.md §1.3](02-functional-specification.md#13-instruction-semantics-golden-rules). These are the parity contract.
- **Bus cycles:**
  - `LMI`/`LMR` read memory (`MR_`)
  - `SMI`/`SMR` write memory (`MW_`)
  - `INN` reads I/O (`IR_`), `OUT` writes I/O (`IW_`)
  - Each cycle is a fixed sequence of microsteps, each pausable when micro-stepping.
- **System calls:**
  - `SCALL KEY` blocks in the `Waiting` state with the message `Stlacte klavesu` until a key arrives, then sets D. Arrow keys produce JavaFX key code 37–40; other keys produce the typed character, truncated to 8 bits.
  - `SCALL KPR` sets CY = key available.
  - `SCALL DSP` prints D to the console.
- **Interrupts:**
  - `EIT` enables IE *after* the next instruction; `DIT` disables.
  - After each instruction, `IT` is sampled. With `IE` set it triggers either by level or by change, per the setting.
  - The interrupt sequence: IA_ low, wait for steady state, read data bus, IA_ high, push PC, PC = address of label `int<data & 0x0F>`.
  - A missing label shows the alert `Chyba prerušenia / Neexistujúce návestie prerušenia intNN`.
- **States:** `Idle`, `Running`, `Paused`, `Waiting`. A program ends when PC runs past the last instruction; there is no HLT.
- **Runtime exceptions** silently stop execution and return to Idle, for example the `F` register in `PUS`/`POP`, or a label left unresolved.
- **Debug timing log** (**Ctrl+F12**): toggles the `times_CPU` logger, which prints the I/O instruction duration and the instruction count once per second to stdout. A toast `DEBUG / Logovanie zapnuté|vypnuté` confirms the toggle.

### F4 — Execution control ([CPUController.java](../../src/main/java/sk/uniza/fri/cp/App/CPUControl/CPUController.java))

| Action | Button text | Key | Behaviour |
|---|---|---|---|
| Parse | `Syntax [F4]` | F4 | Parse in background thread; progress bar shows progress |
| Start / Continue | `Spusti [F5]` / `Pokračuj [F5]` | F5 | If paused → continue; else parse if needed, reset CPU, load, start |
| Step | `Krok [F7]` | F7 | If executing → execute one instruction (or one microstep); else start paused at first instruction |
| Pause | `Pauza [F9]` | F9 | Pause before next instruction |
| Stop | `Stop [F10]` | F10 | Stop execution, clear pending console output buffer |
| Reset | `Reset [F12]` | F12 | (Idle only) zero registers/RAM/stack, reset bus (random address/data, control lines inactive) |

Button enablement per state, status texts, progress bar values and editor highlight per state are in [02 §2.3](02-functional-specification.md#23-cpu-state-machine-and-ui-enablement).

Before starting a program that contains I/O instructions (`LMI LMR SMI SMR INN OUT EIT`), the controller powers on the schematic simulation. If the simulation was off, it waits 100 ms.

### F5 — Registers and memory inspection

- Registers pane `Registre`: A, B, C, D, PC, SP, MP text fields plus CY, Z and IE.
  - A radix toggle selects `Dec`/`Hex`/`Bin`/`ASCII`.
  - The fields are editable except CY, but edits are **never written back** to the CPU.
- Memory pane `Pamäť` has three tabs, each with independent address radix (`Dec`/`Hex`) and data radix (`Dec`/`Hex`/`Bin`/`ASCII`):
  - **Zásobník:** 65,536 rows, ordered address 0, then 65535 down to 1. The stack head row is blue `#7eb6fd`; changed data is pink `#fdadbd`. The `Na vrchol` button scrolls to the head, which also happens automatically on every refresh.
  - **Konštanty:** 256 rows of `BYTE` program memory.
  - **RAM:** 256 rows, with changed data highlighted.
- Continuous GUI refresh during execution:
  - `Nastavenia → Povoliť aktualizáciu GUI` is on by default.
  - The status-bar slider `Interval obnovy GUI` runs from 10 to 150 ms (default 150) and snaps to ticks.
- Both side panes collapse and expand with a 250 ms animation, via the vertical `Registre` / `Pamäť` buttons.

### F6 — Console ([ConsoleOutputStream.java](../../src/main/java/sk/uniza/fri/cp/App/CPUControl/io/ConsoleOutputStream.java))

- Read-only rich text area in the collapsible `Konzola` pane, with a `Vyčistiť` button in its header.
- Parser messages and CPU output share the console.
- The first CPU character of each run prints a red `[CPU KONZOLA]` header. CPU text is monospace.
- Control characters:
  - LF moves to a new line **while keeping the caret column**.
  - CR returns to the start of the line.
  - Other characters **overwrite** at the caret.
- Output is throttled: at most 15 ms of writes per UI tick.
- Bus failure warning (at most once every 2 s): `Pozor! Chyba zbernice. Spustite prosim simulaciu a usisite sa, ze nedochadza k zacykleniu.`

### F7 — Settings menu `Nastavenia`

- `INT - Level` (default) and `INT - Zmena` are mutually exclusive check items.
- `Mikro krokovanie` toggles micro-stepping.
- `Povoliť aktualizáciu GUI` toggles continuous refresh.

Settings are **not persisted** between runs.

### F8 — Code file management

- **New:** `Nový`, Ctrl+N.
- **Open:** `Otvoriť...`, Ctrl+O, filters `ASM *.asm` and `TXT *.txt`. Read as UTF-8, line-by-line, with `\n` appended to every line. Open stops a running program first.
- **Save:** `Uložiť`, Ctrl+S. Overwrites the current file without asking, or behaves like Save As when there is none.
- **Save As:** `Uložiť ako...`, Ctrl+Shift+S.
- **Exit:** `Koniec`.
- Toolbar icon buttons duplicate New/Open/Save/Save As. The code pane has extra `Načítať` (Open) and `Uložiť` (Save) buttons.
- Unsaved-changes dialog:
  - Shown only when the editor is non-blank.
  - Title `Potvrdenie`, header `Zmeny vo vašom kóde neboli uložené`, text `Prajete si uložiť zmeny?`.
  - Buttons: `Uložiť` (only if a file is open), `Uložiť ako`, `Nie`, `Zrušiť`.
- Window title:
  - At start: `CPU Emulator v. 0.9.4`
  - After New: `CPU Emulator - nový program`
  - After Open or Save: `CPU Emulator - <file>`
- Pane title: `Kód`, `Kód - <file>`, plus `*` when modified.

### F9 — Schematic editor ([SchematicSheet.java](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Sheet/SchematicSheet.java), [SchematicController.java](../../src/main/java/sk/uniza/fri/cp/App/SchematicControl/SchematicController.java))

- **Sheet:** 5000×5000 px, **10 px grid (0.9.4)**. Components are still drawn on a fixed 20 px component cell (`SchematicSheet.COMPONENT_CELL`), so bodies and pin spacing are unchanged; gate positions, wire ends and paste offsets snap to the 10 px grid. It starts empty.
- **Zoom:** mouse wheel, ×1.1 per step, range 0.3–3. The point under the cursor stays fixed.
- **Pan:** drag the background. **(0.9.4)** Only a press that starts on empty space pans; dragging an item, or with the right button, never pans. Content is clamped so it always covers the viewport.
- **Palette:** order and display names, from the `getImage` label or `getName`:
  `AB`, `DB`, `CB`, `INP`, `LED`, `BTN`, `KBD`, `7SEG`, `NOT`, `AND`, `OR`, `NAND`, `NOR`, `XOR`, `Buffer`, `REG`, `8kB RAM`, `DEK`, `KOD`.
  Drag from the palette onto the sheet. **(0.9.4)** The drop is no longer checked against occupied cells; components may overlap. A component whose pin lands on a free wire end (within half a grid cell) connects to it on release.
- **Instance names (0.9.4):** `REG`, `RAM`, `DEK` and `KOD` components get the smallest unused number (`REG1`, `REG2`, …), shown as the body title instead of `REGISTER` / `RAM 8k×8` / `DECODER` / `ENCODER`. Pasted copies get a fresh number. Saved as property `name`.
- **Selection:**
  - Click selects; Shift+click toggles.
  - Shift+drag on the background draws a dashed rubber band that adds intersecting gates and wires.
  - Clicking the background clears the selection.
- **Move:** drag a gate. If it is selected, all selected gates move with it. Positions snap to the grid and are clamped to the sheet.
- **Delete:** Delete or Backspace (on key release) deletes the selection. Deleting a gate also deletes its wires.
- **Copy/paste:** Ctrl+C / Ctrl+V. Paste lands at the last mouse grid position, or (2,2) if unknown. Wires are copied only if they are selected *and* both ends are on copied gates. The pasted items become the selection.
- **Wires (0.9.4 model, [Wire.java](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Wire/Wire.java)):**
  - A wire is always **one straight horizontal or vertical segment**. A bend is two wires meeting at an ownerless junction hub. A hub with 2 wires is an invisible bend; with 3 or more it shows a black dot (radius cell/7) and becomes clickable.
  - The orthogonal router, bends with stubs, joints, `Reroute` and `branchExit` are **removed**.
  - **Drawing:** drag from a free pin. An L-shaped preview follows the cursor; its first arm's axis locks on the first move of ≥ 3 px. On release:
    - pin → pin out of line: the wire settles into two wires with a bend at (target x, source y);
    - release in empty space: the wire is **kept with a free end** (0.9.2 deleted it). An L-shaped release keeps both arms when the second is at least half a grid cell long. A release on the starting spot (zero length) is discarded.
  - **Drop resolution order:** pin → junction (also an invisible bend within half a grid cell) → free end of another wire (a shared junction is created) → the wire under the cursor (split there) → the nearest wire within 5 px of an empty-space release → nothing.
  - **Branch:** drag from a wire's body (splits it at the grid point), from a visible junction, or from a free wire end (a junction is founded there).
  - **Grab:** dragging from an occupied pin (or the end on it) detaches that end and drags it with the preview. Releasing it back near its pin restores it.
  - **Delete:** double-click on a wire end deletes the wire. The Delete key deletes selected wires.
  - **Selection:** click selects the wire; Shift toggles; **Ctrl+click selects the chain** through invisible bends (also on a visible junction). Selection and hover draw a dashed inverse-colour overlay above the 2 px line.
  - **Following components:** when a component moves, a wire end on a pin follows it. A junction at the other end moves only perpendicular to the wire. Two pinned ends that fall out of line split into a bend after the move. During a component drag nothing is merged or removed; on release, zero-length wires are removed and collinear wires through a 2-wire hub are merged into one.
  - Debug toggle colours wires by state: Z gray, 0 blue, 1 red.
- **Editing lock:** editing is disabled while the simulation runs, except component interaction (switches, buttons, keyboard).
- **Status bar:** grid coordinates `XxY`, `Simulácia beží` / `Simulácia zastavená`, and zoom `NN%`.
- **Toolbar:**
  - `Nový` clears the sheet (tooltip `Vymazať plochu`).
  - `Otvoriť`, `Uložiť`, `Uložiť ako`.
  - `On/Off:` simulation switch.
  - `Debug:` switch.
  - CPU mirror buttons `Spustiť [F5]` / `Pokračovať [F5]`, `Krok [F7]`, `Pauza [F9]`, `Stop [F10]`, `Reset [F12]`. They track CPU state and the F-keys work in this window.

### F10 — Schematic components ([Gates/](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Gates), [Buses/](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Buses))

| Component (class) | Pins (index order) | Behaviour | Context menu | Saved properties |
|---|---|---|---|---|
| `AddressBus16` "AB" | taps `AB0..AB15` (OUTPUT) | Drives taps from address bus. Rail **dark red (0.9.4)** | Rail click: `Všetky`, `AB0..AB15`; tap right-click: `Zmazať`; drag either rail end to resize (bottom: 3–60 rows; **top end (0.9.4)**: up to 60 rows above the origin, the label follows) | `rows`, `topRow` (0.9.4), `taps=bit:y;…` |
| `DataBus8` "DB" | taps **`DB0..DB7` (0.9.4)** (WEAK_OUT) | Write (`MW/`/`IW/` low): drives data; read (`MR/`/`IR/` low): taps Z, net values written to bus; holds data after write. Rail **dark green** | same, `DB0..DB7` | `rows`, `topRow`, `taps` |
| `ControlBus` "CB" | taps **`MW/ MR/ IW/ IR/ IA/ IT` (0.9.4)** | Drives the CPU signals onto the taps; **`IT` is an input (0.9.4)**: the circuit drives it and `simulate()` writes it to the bus, so hardware interrupts work. Rail **dark goldenrod** | same | `rows`, `topRow`, `taps=signal:y;…` |
| `Input` "INP" | `O` | Click toggles 0/1, value shown inside | `Vývod vpravo/vľavo/hore/dole` | `pinSide`, `state` |
| `Led` "LED" | `IN` | **(0.9.4)** Lit while the input is 1. When it falls, the LED goes off at once if it has been lit ≥ 100 ms; a shorter pulse keeps it lit until 100 ms after its rising edge. Every rising edge restarts the count | `Vývod` ▸ `vpravo/vľavo/hore/dole`, `Farba LED` ▸ `Červená/Zelená/Modrá/Žltá/Oranžová` | `color` (#RRGGBB), `pinSide` |
| `PushButton` "BTN" | `I`, `O` (WEAK_OUT) | O=0 while pressed and I=0, else 1; momentary or toggle | `Toggle` (check), `Label…` (1 char dialog `Label tlačidla` / `Zadaj jedno písmeno:`) | `label` (only if set); toggle **not** saved |
| `MatrixKeyboard` "KBD" | `R0..R3` in, `C0..C3` out (WEAK_OUT) | 4×4; column=0 if a pressed key in it has its row=0; default labels `0123456789ABCDEF` bottom-to-top | `Toggle`, `Label…` (per key under cursor, dialog `Label klávesy`) | `labelN` for non-default labels |
| `SevenSegmentDisplay` "7-segment" | `A B C D E F G DP CA` | Segment lit when its input=0 and CA=0; CA 0→1 holds snapshot 100 ms | Colour radio items | `color` |
| `NotGate` "NOT" | `A`, `Y` | Y = ¬A | — | — |
| `AndGate`/`OrGate`/`NandGate`/`NorGate`/`XorGate` | `A..H` (2/3/4/8), `Y` | Standard logic | `2 vstupy`, `3 vstupy`, `4 vstupy`, `8 vstupov` | `inputs` |
| `BusBuffer` "Buffer" | `A`, `G/`, `Y` | Y=A when G/=0 else Z | — | — |
| `Register8` "Register 8" | `D0..D7`, `OE/`, `LE`, `Q0..Q7` (body labels **D1–D8 / Q1–Q8**, 0.9.4) | Transparent latch while LE=1; Q driven when OE/=0 else Z | **`Vymeň D-Q` (0.9.4)**: swaps the input and output sides | `name`, `swapped` (0.9.4); latch not saved |
| `Ram8k` "RAM 8k" | `D0..D7` (IO), `WE/`, `OE/`, `E1/`, `E2`, `A0..A12` | Enabled when E1/=0 & E2=1; WE/=0 writes, else OE/=0 reads, else Z | **`Obsah` (0.9.4)**: window `Obsah pamäte RAM 8k` with live `Adresa / HEX` and `ASCII` columns (16 bytes per row, refreshed every 200 ms) | `name` (0.9.4); contents not saved |
| `Decoder38` "DEK" | `A`,`B`,`C`,`G`, `Y0..Y7` | G=0 → all 1; G=1 → output CBA is 0 | — | `name` (0.9.4) |
| `Encoder83` "KOD" | `EI`, `D0..D7`, `EO`,`GS`,`A0`,`A1`,`A2` | Priority on lowest 0 input; EI=1 → all 1; no zero → EO=0 | — | `name` (0.9.4) |

Electrical model ([Potential.java](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Electrical/Potential.java)):

- A net's value resolves from its driver types: `OUT` > `WEAK_OUT` > `TRI_OUT` > `IO` > `IN` > `NC`.
- Two conflicting strong drivers are a **short circuit**. The net value becomes *random* and the shorted pins are highlighted red.
- A WEAK_OUT is overridden by any strong driver.
- Unconnected or floating inputs read as **random** 0/1. **(0.9.4)** The random level is drawn once per floating net and kept until the net gets a defined 0/1 (`Potential.getFloatingValue`), so floating inputs no longer flicker on every simulation step.
- Component outlines are 3 px (Input 2 px), wires 2 px, pin cores 2.5 px **(0.9.4)**. Active-low signal names use `/` instead of `_` (`MW/`, `OE/`, `G/`, …).

### F11 — Schematic simulation ([SchematicSimulator.java](../../src/main/java/sk/uniza/fri/cp/SchematicSim/Sheet/SchematicSimulator.java))

- Power on runs these steps in order:
  1. Reset all gates.
  2. Simulate all gates once.
  3. Re-sync all buses from the system bus.
  4. Enter the event loop.
- **Event loop:**
  - A queue of `SheetChangeEvent(pin, value)`. A new event for the same pin replaces the queued one.
  - Processing an event updates the net and re-simulates every gate with an input on that net.
  - On 5 ms of idleness, every gate is simulated again. This is what times the LED and 7-segment holds. The loop then reports steady state to the bus.
  - **Watchdog:** after 5 s with no progress and a non-empty queue, the alert `Chyba simulácie. Príliš dlhá odozva.` is shown and the simulation stops.
- Power off drains the remaining events and resets all gates.

### F12 — Schematic file management (`.schx`)

- Open/Save/Save As with filter `SCHX *.schx`.
- **(0.9.4)** Save to the current file overwrites it silently. The 0.9.2 prompt `Naozaj si prajete prepísať súbor <name>?` was removed.
- Unsaved dialog: `Zmeny vo vašej schéme neboli uložené` in this window; `Zmeny v schéme neboli uložené` at application exit.
- Window title: `Simulátor - Schéma` or `Simulátor - Schéma - <file>`.
- Load powers off a running simulation and clears the sheet.
- Unknown elements are ignored. Unresolvable wires are dropped. Junction ends are resolved over two passes: an existing hub at the same rounded point, else a loaded wire passing within half a grid cell is split there, else a standalone hub. `<Joints>` and `branchExit` of older files are ignored.

### F13 — Help

`Pomoc → O programe...` opens the modal `O programe`. It shows four text lines (original author, thesis year, modifications) and an `Ok` button.

---

## Existing UI Structure

```
CPU window (BorderPane, 1280×640, icon cpu_icon.png, title "CPU Emulator v. 0.9.4")
├─ top
│  ├─ MenuBar
│  │  ├─ Súbor: Nový (Ctrl+N) · Otvoriť... (Ctrl+O) · Uložiť (Ctrl+S) · Uložiť ako... (Ctrl+Shift+S) · ── · Koniec
│  │  ├─ Nastavenia: ☑ INT - Level · ☐ INT - Zmena · ── · ☐ Mikro krokovanie · ── · ☑ Povoliť aktualizáciu GUI
│  │  └─ Pomoc: O programe...
│  └─ Toolbar: [new][open][save][save-as] | Syntax [F4] · Spusti [F5] · Krok [F7] · Pauza [F9] · Stop [F10] · Reset [F12] | Simulátor
├─ center: vertical SplitPane (0.71)
│  ├─ horizontal SplitPane
│  │  ├─ [▮ Registre] + TitledPane "Registre": Dec|Hex|Bin|ASCII · A B C D · PC SP MP · CY Z IE
│  │  ├─ TitledPane "Kód": [Načítať] [Uložiť] [UnBreak All] · code editor
│  │  └─ TitledPane "Pamäť" + [▮ Pamäť]: tabs Zásobník (+ Na vrchol) · Konštanty · RAM
│  └─ TitledPane "Konzola" (collapsible) with [Vyčistiť] in header
└─ bottom: ProgressBar · status label · "Interval obnovy GUI" slider · value · "ms"

Schematic window (BorderPane, 1280×850, icon simulator_icon_128.png, title "Simulátor - Schéma"; shown/hidden by "Simulátor")
├─ top: ToolBar: Nový · Otvoriť · Uložiť · Uložiť ako | On/Off: ⏻ | Debug: ⏻ ⟶ Spustiť [F5] · Krok [F7] · Pauza [F9] · Stop [F10] · Reset [F12]
├─ center: SplitPane (0.13): palette (scroll, flow) | sheet (zoom/pan canvas)
└─ bottom: "XxY" coordinates · status · zoom %

Dialogs: unsaved code (CPU), unsaved schematic (×2 variants), About (Swing), RAM content window (0.9.4),
native file open/save (×4 contexts), interrupt error alert, simulation timeout alert,
button/key label input dialogs, context menus (gates, buses, taps, wires), DEBUG toast.
```

### Keyboard shortcut inventory

| Key | CPU window | Schematic window |
|---|---|---|
| F4 | Parse | — |
| F5 / F7 / F9 / F10 / F12 | Start-Continue / Step / Pause / Stop / Reset | same (mirror buttons) |
| Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S | New / Open / Save / Save As (code) | — |
| Ctrl+/ | Toggle block comment | — |
| Ctrl+F9 / Ctrl+F10 | Editor font − / + | — |
| Ctrl+F12 | Toggle CPU timing debug log | — |
| Ctrl+C / Ctrl+V | (editor native) | Copy / paste selection |
| Delete / Backspace | (editor native) | Delete selection |
| Arrow keys | Sent to CPU while executing | Not forwarded |
| Typed characters | Sent to CPU while executing | Sent to CPU while executing |

---

## Existing Data Model

### CPU state

| Item | Type | Reset value |
|---|---|---|
| A, B, C, D | 8-bit (Java `byte`, read unsigned) | 0 |
| PC, SP, MP | 16-bit (Java `short`, read unsigned) | 0 |
| CY, Z, IE | boolean | false |
| RAM | `byte[256]` | zeros |
| Stack | `byte[65536]` | zeros |
| Program | instruction list (index = address), program memory (`BYTE` list), line↔instruction map, interrupt label map (0–15 → index), breakpoint set (instruction indices) | — |

### System bus ([Bus.java](../../src/main/java/sk/uniza/fri/cp/Bus/Bus.java))

Address bus is 16 bits; data bus is 8 bits. The control word bit positions:

| Bit | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|---|
| Signal | `MW/` | `MR/` | `IW/` | `IR/` | `IA/` | `IT` | `RY` | `BQ` | `BA` |

- Active-low signals idle at 1; `IT`, `RY`, `BQ` and `BA` idle at 0.
- Idle address and data values are **random**: `nextInt(65535)` and `nextInt(256)`.

### `.schx` file format (version "2.0", UTF-8, JDOM pretty-printed)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Scheme ver="2.0">
  <Gates>
    <Gate id="g0">
      <class>sk.uniza.fri.cp.SchematicSim.Gates.AndGate</class>
      <gridX>20</gridX>                                   <!-- 0.9.4: in 10 px grid units -->
      <gridY>8</gridY>
      <properties>
        <property name="inputs" value="2" />
      </properties>
    </Gate>
  </Gates>
  <Wires>
    <Wire color="#000000">
      <start><gateId>g0</gateId><pinIndex>2</pinIndex></start>
      <end><junction><x>300.0</x><y>120.0</y></junction></end>  <!-- or gateId/pinIndex, or x/y (free end) -->
    </Wire>
  </Wires>
</Scheme>
```

**(0.9.4)** The version attribute is still `"2.0"`, but the content changed:
- `gridX`/`gridY` are in 10 px units. Files from ≤ 0.9.3 (20 px units) load at half their coordinates; the upstream commit acknowledges this.
- `<Joints>` and `branchExit` are neither written nor read.
- New properties: `topRow` (AB/DB/CB, written between `rows` and `taps`), `name` (REG/RAM/DEK/KOD), `swapped` (Register8, after `name`).

- Gate ids are `g<n>`, using the lowest free n. On load, a missing id becomes `s<n>`.
- The `<class>` element contains a **Java fully-qualified class name**, instantiated by reflection. The web version must map these names.
- Pins are referenced by **index into the component's pin list**; the order is listed in F10. Bus taps are created from properties *before* wires attach.
- A wire end on a junction is saved as the junction's position. On load, all ends at the same rounded point share one hub.
- Coordinates are pixels written by Java `Double.toString`, for example `120.0`.

### Code files

Plain text in UTF-8. On load, line endings are normalised to `\n`; on save, the text is written exactly as it appears in the editor.

---

## Existing Workflows

1. **Write and run:**
   1. Type or open code.
   2. Press F4 to parse. Errors are highlighted and printed to the console.
   3. Press F5 to run; it parses automatically if needed.
   4. The status shows `Program sa vykonáva...` and the progress bar is indeterminate.
   5. The program ends at the last instruction, and the status shows `Nečinný`.
2. **Debug:**
   1. Set breakpoints with the gutter or start with F7.
   2. When paused, the current line is highlighted green and the status shows `Vykonávanie pozastavené`.
   3. F7 steps one instruction; F5 continues; F9 pauses a running program; F10 stops.
   4. F12 resets when Idle.
3. **Micro-step bus cycles:**
   1. Enable `Mikro krokovanie`.
   2. Step into a bus instruction. Each F7 advances one bus phase, and the status shows the phase name, for example `Nastavenie adresy`, `Nastavenie priznaku IOR = 0` or `Nacitanie dat`.
4. **Hardware I/O:**
   1. Open `Simulátor` and build a circuit, using AB/DB/CB taps and devices.
   2. Optionally switch it on.
   3. Run a program that uses `INN`/`OUT`/`LMI`/`SMI`. The simulation powers on automatically.
   4. While it runs, toggle INP switches and press BTN/KBD keys; watch the LEDs and 7-segment display. **(0.9.4)** An `IT` tap driven by the circuit raises hardware interrupts (`EIT` + `int00..int15` handlers); a RAM's `Obsah` window shows its memory live.
   5. Editing is locked until the simulation is switched off.
5. **Keyboard program:** `SCALL KEY` waits; the user types in either window.
6. **Save and exit:**
   1. Save the code and the schematic.
   2. Exit with `Koniec` or the window close button. Unsaved prompts appear for the code first, then the schematic.

---

## Existing Authentication Model

**None.** There are no user accounts, login, roles, permissions, sessions or audit trail. Anyone who can launch the jar has full access to every feature, and file access is whatever the OS user permits.

Consequence for the migration: LDAP authentication is **purely additive**. It gates access to the application. No existing feature differs by user, so role mapping can only allow or deny access unless new restrictions are explicitly requested.

---

## Migration Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Concurrency model**: 4–5 Java threads with latches/semaphores and a 5 ms idle poll become a single-threaded browser runtime | Timing-dependent behaviour (micro-step pauses, `Waiting` state, bus steady wait, 100 ms holds, GUI refresh cadence) could drift | Re-implement as a cooperative scheduler that preserves the *observable* sequence: steady state = event queue drained (matches commit `2876ca2` "simulate immediate settling"); keep 5 ms idle re-simulation; wall-clock holds |
| R2 | **Java numeric semantics** (signed `byte`/`short` casts, `Integer.parseUnsignedInt`, shift behaviour) | Wrong flags/values → emulator results differ | Explicit `toByte`/`toShort` helpers; golden-master trace tests against the Java CPU on a program corpus |
| R3 | **Nondeterminism by design**: floating inputs, short circuits and idle bus values are random | Parity cannot be checked bit-for-bit for those cases | Exclude random cases from golden tests, or inject a seedable RNG behind the same distribution |
| R4 | **`.schx` compatibility**: Java class names, pin-index addressing, `Double.toString` formatting, property order; 0.9.4 changed grid units and dropped `<Joints>` under the same `ver="2.0"` | Files may not round-trip between the desktop and web versions; ≤ 0.9.3 files shift on load in both | Class-name map in both directions; emit the same FQCNs; Java-style number formatting; round-trip tests on real files (byte-equal against Java 0.9.4) |
| R5 | **Browser-reserved shortcuts**: Ctrl+N (new window), possibly F12 (devtools), F5 reload, F7 caret browsing, F10 menu focus | Documented shortcuts may not reach the app | `preventDefault` where browsers allow it (F5, F7, F9, F10, Ctrl+S, Ctrl+O generally); Ctrl+N cannot be intercepted in a normal Chrome tab. Needs a decision (see the design doc, D4) |
| R6 | **File system access**: no native file dialogs, no "current directory", no silent overwrite in Firefox/Safari | Save/Open semantics change | File System Access API (Chromium) gives true Save-overwrites-current-file; elsewhere upload/download fallback. Decision D2 |
| R7 | **Two windows** sharing one engine | Show/hide semantics and shared keyboard routing | Schematic opens as a second browser window bound to the same engine instance. Decision D3 |
| R8 | **Rich editor parity** (RichTextFX → web editor): paragraph styles, gutter breakpoints that track edits, caret follow, pt-based font sizing | Subtle editor behaviour differences | CodeMirror 6 with custom gutter and line decorations; dedicated editor parity tests |
| R9 | **65,536-row stack table** with per-row highlight and auto-scroll on every refresh | Performance at a 10 ms refresh | Virtualised table; refresh only visible rows |
| R10 | **Keyboard → `SCALL KEY` mapping**: JavaFX `KEY_TYPED` characters and arrow `impl_getCode()` values; non-ASCII truncated to 8 bits | Programs that read keys could behave differently | DOM `keydown`/`keypress` mapping table reproducing the JavaFX values (Enter→13, Backspace→8, Esc→27, arrows→37–40, `š`→0x61) |
| R11 | **Session expiry** (new with LDAP) while work is unsaved or a program is running | Data loss: a new failure mode that does not exist today | Expiry must not reload the page; show a re-login dialog and keep in-memory state. Decision D6 |
| R12 | **Tablet support**: the UI depends on the right mouse button, Shift+drag, the wheel and hover | Tablet users cannot reach context menus or zoom | Touch equivalents (long-press = right-click, pinch = zoom, two-finger pan) are required by the tablet requirement but change input gestures. Decision D7 |
| R13 | **Existing defects** (below) | Preserve them or fix them? | Default: preserve exactly (parity rule); each listed for explicit decision D8. #1 is fixed upstream in 0.9.4; #17–#19 are new in 0.9.4 |
| R14 | **Rewrite volume**: about 17k lines, most of it engine and editor logic | Schedule and regression risk | Port the engine first, as headless TypeScript with golden tests; then the UI |

### Existing defects and quirks found (preserved by default; struck-through items are fixed)

These affect "identical behaviour". Each needs a keep or fix decision (D8 in the design doc).

1. ~~**Hardware interrupts cannot be triggered from the schematic.**~~ **Fixed in 0.9.4** (`4bfa6c8`): `IT` is an input tap, `ControlBus.simulate()` writes the circuit's value to the bus, and `int00..int15` handlers run.
2. ~~**`PUS F` / `POP F` pass the parser but stop execution at runtime.**~~ `getRegisterVal("F")` throws, and the CPU silently returns to Idle. **Fixed: F is a flag byte (bit0 = CY, bit1 = Z, bit2 = IE); `POP F` restores all three. Any other runtime failure is now printed to the console instead of stopping silently.** (2026-10-12, web app and Java)
3. ~~**Labels resolve only when at least one label is defined.**~~ In a program with no labels, `JMP 5` jumps to instruction 5, and `JMP x` stops execution at runtime. **Fixed: labels are always resolved; a jump/call operand must be a defined label (`JMP 5` works only with a label `5:`).** (2026-10-12, web app and Java)
4. **A `BYTE` line maps to the previous instruction index** in the line↔instruction map. A breakpoint there, which is only possible on a mixed line, breaks on the preceding instruction.
5. ~~**Interrupt label `INT0a`**~~ (uppercase `INT`, lowercase hex digit) makes the parser throw an uncaught `NumberFormatException`. The status stays at `Parsujem...` and no error is listed. Related behaviour confirmed by golden recording: **Fixed: only `int00`–`int15` / `INT00`–`INT15` (decimal) are interrupt labels; any other label starting with `int` (any case) is a parse error. Unexpected parser failures are reported as errors instead of hanging at `Parsujem...`.** (2026-10-12, web app and Java)
   - `INT0A` (uppercase hex digit) is silently an *ordinary* label.
   - `int0f` and `int15` are the same interrupt 15, so defining both gives `Návestie pre prerušenie int15 už existuje`.
6. ~~**More than 256 `BYTE` constants**~~ overflow the 256-row `Konštanty` table (`IndexOutOfBoundsException` during refresh). **Fixed: the 257th constant is a parse error `Príliš veľa konštánt BYTE (max. 256)`.** (2026-10-12, web app and Java)
7. **`Koniec` cancels the CPU thread before the unsaved prompts.** If the user then cancels, a new CPU thread is created on the next run, but the schematic's CPU buttons stay bound to the old thread's state.
8. **The 16-bit ASCII display** uses `value >> 4` instead of `>> 8` for the high character.
9. ~~**`ConsoleOutputStream.write(byte[])` drops the last byte.**~~ It is only visible on the bus warning, whose last character is a space. **Fixed (also `write(byte[], off, len)` bounds in Java).** (2026-10-12, web app and Java)
10. ~~**Register text fields are editable but inert.**~~ CY is read-only; Z and IE are editable but ignored. **Fixed: all register and flag fields are read-only.** (2026-10-12, web app and Java)
11. ~~**The LED colour menu always pre-selects `Červená`**~~, regardless of the actual colour. **Fixed: the menu checks the LED's actual colour (and pin side).** (2026-10-12, web app and Java)
12. ~~**Wire colour can only be changed through file content.**~~ The 0.9.2 dead `ColorPicker` pane is gone in 0.9.4; the `color` attribute is still saved and loaded. **Fixed: wire context menu `Farba vodiča` (Čierna, Červená, Zelená, Modrá, Žltá, Oranžová, Šedá) colours the whole wire - all segments joined through bends - or all selected wires.** (2026-10-12, web app and Java)
13. **Version strings:** 0.9.4 aligned `App.PROGRAM_VERSION` and the POM (`0.9.4`), but the README still names `CPUEmulSim-1.6.0-jar-with-dependencies.jar` (the build produces `target/CPUEmulSim.jar`).
14. ~~**Comment stripping ignores quotes**~~, so `MVI A, ';'` is a parse error. **Fixed: `;` inside `'…'` or `"…"` does not start a comment (parser, breakpoint lines, highlighting).** (2026-10-12, web app and Java)
15. ~~**Editor highlighting accepts labels `[a-zA-Z0-9]+:`**~~, while the parser accepts `\w+:`. Labels with `_` parse but are not highlighted. **Fixed: highlighting uses the parser's rule (`\w+:` at the line start).** (2026-10-12, web app and Java)
16. **Reloading a `.schx` can short separate nets together** (still present in 0.9.4, wider reach). Found by golden recording (`logic_gates` scenario). `SchemeLoader` shares one junction hub per rounded coordinate (`hubByKey`). Branches of *different* nets whose junctions land on the same grid point are therefore merged on load; in the scenario, three independent switch outputs end up on one net. Saving after such a load writes the merged structure, so load→save is not idempotent for these files. A shorted net then takes `Math.random()` values. Because the original simulates gates in `HashSet` (identity-hash) order, the resulting values differ between JVM runs.

   **0.9.4:** the loader shares one hub per rounded point (`hubByKey`) *and* splits any already-loaded wire passing within half a grid cell of a junction end. Nets whose wires overlap or touch a foreign junction point are merged on load. The 0.9.4 bend placement (corner at the target pin's x) makes overlapping wires common when several nets run to pins in one column. Found while recording the golden scenarios: the first 0.9.4 `logic_gates` layout shorted its inputs and the Java simulator ran out of memory. The scenarios were rebuilt so that no two nets share a point.
17. **(0.9.4) A wire with a free end is saved but not loaded.** `appendWireEnd` writes a free end as `x`/`y`, but `SchemeLoader.load` deletes every wire whose ends cannot be resolved to a pin or junction. Free wires vanish on reload.
18. **(0.9.4) Older schematics shift and lose their bends on load.** `gridX`/`gridY` written in 20 px units are read as 10 px units, and `<Joints>` are ignored. Wires load as straight, possibly diagonal, pin-to-pin lines until edited.
19. **(0.9.4) Palette drops ignore occupancy.** Components can be dropped onto each other. `GridOccupancy` is still maintained but never consulted.
