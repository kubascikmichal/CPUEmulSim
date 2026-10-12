/**
 * Model of the CPU window's register fields and the three memory tables (Zásobník, Konštanty, RAM),
 * ported from `CPUController.updateGUI*` and `MemoryTableCell`/`StackTableCell`.
 *
 * "Changed" highlight semantics: a cell is changed when the value set by the latest refresh differs
 * from the value set by the refresh before it (`oldData != newData`).
 */
import type { Cpu } from '../cpu/Cpu';
import type { Program } from '../cpu/Program';

export interface RegisterValues {
  /** Java signed values */
  a: number; b: number; c: number; d: number; pc: number; sp: number; mp: number;
  cy: boolean; z: boolean; ie: boolean;
}

class Table {
  readonly newData: Int8Array;
  readonly oldData: Int8Array;

  constructor(size: number) {
    this.newData = new Int8Array(size);
    this.oldData = new Int8Array(size);
  }

  set(row: number, value: number): void {
    this.oldData[row] = this.newData[row];
    this.newData[row] = value;
  }

  isChanged(row: number): boolean {
    return this.oldData[row] !== this.newData[row];
  }
}

export class MemoryTables {
  /** Stack table: row 0 = address 0, rows 1..65535 = addresses 65535 down to 1. */
  readonly stack = new Table(65536);
  readonly progMemory = new Table(256);
  readonly ram = new Table(256);
  stackHead = 0;
  /** Row index the stack table scrolls to (handleButtonToStackHeadAction). */
  stackScrollRow = 0;
  registers: RegisterValues = { a: 0, b: 0, c: 0, d: 0, pc: 0, sp: 0, mp: 0, cy: false, z: false, ie: false };
  /** Incremented on every refresh (UI change detection). */
  version = 0;

  /** Address shown in stack row `row`. */
  static stackAddressOfRow(row: number): number {
    return row === 0 ? 0 : 65535 - row + 1;
  }

  /**
   * `updateGUI()` (registers + all tables), or only `updateGUITableProgMemory()` with programOnly.
   * The parser rejects more than 256 BYTE constants, so the Konštanty table cannot overflow.
   */
  update(cpu: Cpu | null, program: Program | null, opts: { programOnly?: boolean } = {}): void {
    if (!opts.programOnly) {
      this.updateRegisters(cpu);
      this.updateStack(cpu);
    }
    this.updateProgMemory(program);
    if (!opts.programOnly) this.updateRam(cpu);
    this.version++;
  }

  private updateRegisters(cpu: Cpu | null): void {
    if (cpu !== null && cpu.isAlive()) {
      this.registers = {
        a: cpu.getRegA(), b: cpu.getRegB(), c: cpu.getRegC(), d: cpu.getRegD(),
        pc: cpu.getRegPC(), sp: cpu.getRegSP(), mp: cpu.getRegMP(),
        cy: cpu.isFlagCY(), z: cpu.isFlagZ(), ie: cpu.isFlagIE(),
      };
    } else {
      this.registers = { a: 0, b: 0, c: 0, d: 0, pc: 0, sp: 0, mp: 0, cy: false, z: false, ie: false };
    }
  }

  private updateStack(cpu: Cpu | null): void {
    if (cpu !== null) {
      const stack = cpu.getStack();
      const sp = cpu.getRegSP() & 0xffff;
      this.stack.set(0, stack[0]);
      for (let i = 65535; i > 0; i--) this.stack.set(65535 - i + 1, stack[i]);
      this.stackHead = sp;
    } else {
      for (let i = 0; i < 65536; i++) this.stack.set(i, 0);
      this.stackHead = 0;
    }
    this.toStackHead(cpu);
  }

  /** `Na vrchol`: scroll target row for the stack head. */
  toStackHead(cpu: Cpu | null): void {
    if (cpu !== null) {
      const sp = cpu.getRegSP() & 0xffff;
      this.stackScrollRow = sp === 0 ? 0 : 65535 - sp - 5;
    } else {
      this.stackScrollRow = 0;
    }
  }

  private updateProgMemory(program: Program | null): void {
    if (program !== null) {
      const mem = program.getMemory();
      const n = Math.min(mem.length, 256);
      for (let i = 0; i < n; i++) this.progMemory.set(i, mem[i]);
      for (let i = n; i < 256; i++) this.progMemory.set(i, 0);
    } else {
      for (let i = 0; i < 256; i++) this.progMemory.set(i, 0);
    }
  }

  private updateRam(cpu: Cpu | null): void {
    if (cpu !== null) {
      const ram = cpu.getRAM();
      for (let i = 0; i < ram.length; i++) this.ram.set(i, ram[i]);
    } else {
      for (let i = 0; i < 256; i++) this.ram.set(i, 0);
    }
  }
}
