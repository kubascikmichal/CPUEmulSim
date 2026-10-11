/** Port of `Instruction`, `Program` and the CPU exceptions. */
import type { InstructionDef, InstructionType } from './InstructionSet';

export class Instruction {
  constructor(
    readonly def: InstructionDef,
    public firstParameter: string | null = null,
    public secondParameter: string | null = null,
  ) {}

  get type(): InstructionType {
    return this.def.name;
  }
}

/** Port of `InvalidCodeLinesException`. */
export class InvalidCodeLinesException extends Error {
  override name = 'InvalidCodeLinesException';
  constructor(
    readonly lines: number[],
    readonly errors: string[],
  ) {
    super('Some lines of code are invalid!');
  }

  override toString(): string {
    return this.errors.map((e) => e + '\n').join('');
  }
}

/** Port of `NonExistingInterruptLabelException`. */
export class NonExistingInterruptLabelException extends Error {
  override name = 'NonExistingInterruptLabelException';
  constructor(intNumber: number) {
    super('Neexistujúce návestie prerušenia int' + (intNumber < 10 ? '0' : '') + intNumber);
  }
}

const IO_TYPES = new Set<InstructionType>(['LMI', 'LMR', 'SMI', 'SMR', 'INN', 'OUT', 'EIT']);

export class Program {
  private breaks = new Set<number>();
  private readonly ioInstruction: boolean;

  /**
   * @param instructions instruction list; index = address
   * @param memory program constants (BYTE), Java signed bytes
   * @param lineIndexToInstructionIndex editor line → instruction index (TreeMap, ascending keys)
   * @param interruptionLabels interrupt number (0-15) → instruction index
   */
  constructor(
    private readonly instructions: Instruction[],
    private readonly memory: number[],
    readonly lineIndexToInstructionIndex: Map<number, number>,
    readonly interruptionLabels: Map<number, number>,
  ) {
    this.ioInstruction = instructions.some((i) => IO_TYPES.has(i.type));
  }

  hasIOInstruction(): boolean {
    return this.ioInstruction;
  }

  /**
   * Equivalent of `setListenerOnBreakpointsChange` / its listener body: rebuilds the break set
   * from editor line indices. A line without an instruction maps to `null` in Java and
   * `TreeSet.add(null)` throws NullPointerException - reproduced (set stays partially filled).
   */
  setBreakpointLines(lines: Iterable<number>, onlyNonNegative = false): void {
    this.breaks.clear();
    for (const line of lines) {
      if (onlyNonNegative && line < 0) continue;
      const index = this.lineIndexToInstructionIndex.get(line);
      if (index === undefined) throw new TypeError('NullPointerException');
      this.breaks.add(index);
    }
  }

  /** First line (ascending) mapped to the given instruction address, or -1. */
  getLineOfInstruction(instructionAddress: number): number {
    for (const [line, index] of this.sortedLineEntries()) {
      if (index === instructionAddress) return line;
    }
    return -1;
  }

  private sortedLineEntries(): [number, number][] {
    return [...this.lineIndexToInstructionIndex.entries()].sort((a, b) => a[0] - b[0]);
  }

  /** Program constants as Java signed bytes. */
  getMemory(): number[] {
    return [...this.memory];
  }

  getByte(address: number): number {
    if (address > this.memory.length - 1) return 0;
    return this.memory[address];
  }

  getInstruction(address: number): Instruction | null {
    return address >= 0 && address < this.instructions.length ? this.instructions[address] : null;
  }

  get instructionCount(): number {
    return this.instructions.length;
  }

  isSetBreak(instructionAddress: number): boolean {
    return this.breaks.has(instructionAddress);
  }

  getAddressOfInterrupt(intNumber: number): number {
    const address = this.interruptionLabels.get(intNumber);
    if (address === undefined) throw new NonExistingInterruptLabelException(intNumber);
    return address;
  }
}
