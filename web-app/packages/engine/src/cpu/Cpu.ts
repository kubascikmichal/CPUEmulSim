/**
 * Port of `sk.uniza.fri.cp.CPUEmul.CPU`.
 *
 * The Java class is a Thread; here {@link Cpu.threadBody} is a generator that mirrors `run()`
 * statement by statement. Blocking calls become yields (see runtime/threads.ts); everything else -
 * including the order of bus operations, flag computations and the exception-swallowing loop -
 * is kept identical. Registers are stored exactly like Java fields (signed byte/short values).
 */
import type { Bus, Clock } from '../bus/Bus';
import { systemClock } from '../bus/Bus';
import { Latch, ThreadContext, TICK, type Block } from '../runtime/threads';
import {
  InterruptedException,
  InvalidParameterException,
  parseIntJava,
  parseUnsignedIntJava,
  toByte,
  toShort,
  u16,
  u8,
} from '../util/java';
import type { InstructionType } from './InstructionSet';
import { parseConstant } from './Parser';
import { NonExistingInterruptLabelException, type Instruction, type Program } from './Program';

export type CPUState = 'Idle' | 'Running' | 'Paused' | 'Waiting';

/** Key event forwarded to SCALL KEY (JavaFX KeyEvent subset). */
export type CpuKey =
  /** KEY_PRESSED arrow key; `code` = JavaFX `KeyCode.impl_getCode()` (37–40). */
  | { kind: 'arrow'; code: number }
  /** KEY_TYPED; `character` = `KeyEvent.getCharacter()`. */
  | { kind: 'typed'; character: string };

/** `java.io.OutputStream` used by the CPU for SCALL DSP and bus warnings. */
export interface ConsoleStream {
  /** `write(int b)` - receives the (possibly negative) int value exactly as Java passes it. */
  write(b: number): void;
  /** `write(byte[] b)` - Java signed bytes. */
  writeBytes(bytes: number[]): void;
}

/** Optional `times_CPU` logger (Ctrl+F12). */
export type TimesLogger = (message: string) => void;

const BUS_WARNING = 'Pozor! Chyba zbernice. Spustite prosim simulaciu a usisite sa, ze nedochadza k zacykleniu. ';

export class Cpu {
  // flags (external access)
  private isCancelled = false;
  private isExecuting = false;
  private fMicrostep = false;
  private fIntLevel = false;
  private fPause = false;
  // internal
  private fIntLevelOld = false;
  private fEit = false;

  private state: CPUState = 'Paused';
  private message: string | null = null;
  private readonly stateListeners: ((s: CPUState) => void)[] = [];

  private cdlHalt: Latch | null = null;
  private keyPermits = 0;
  private key: CpuKey | null = null;
  readonly thread = new ThreadContext();

  // registers (Java field representation: signed)
  private regA = 0;
  private regB = 0;
  private regC = 0;
  private regD = 0;
  private regMP = 0;
  private regPC = 0;
  private regSP = 0;
  private flagCY = false;
  private flagIE = false;
  private flagZ = false;

  private readonly RAM = new Int8Array(256);
  private readonly stack = new Int8Array(65536);
  private program: Program | null = null;

  private lastErrorMsgPrint = 0;
  private generator: Generator<Block, void> | null = null;
  private currentBlock: Block | null = null;

  // times_CPU debug logging
  private static timesLogger: TimesLogger | null = null;
  private innStart = 0;
  private innEnd = 0;
  private progStart = 0;
  private numOfInstr = 0;

  /** Called when an interrupt label is missing (Java shows an Alert via Platform.runLater). */
  onInterruptLabelError: ((message: string) => void) | null = null;

  constructor(
    private readonly console: ConsoleStream,
    private readonly bus: Bus,
    private readonly clock: Clock = systemClock,
  ) {}

  static startTimesDebug(logger: TimesLogger): void {
    Cpu.timesLogger = logger;
  }

  static stopTimesDebug(): void {
    Cpu.timesLogger = null;
  }

  // ------------------------------------------------------------------ thread control

  /** `Thread.start()` */
  start(): void {
    this.generator = this.threadBody();
    this.advance();
  }

  isAlive(): boolean {
    return this.generator !== null;
  }

  /** What the "thread" is currently blocked on (null = finished). */
  get blockedOn(): Block | null {
    return this.currentBlock;
  }

  /** True when blocked on a latch that has not been released yet. */
  isHalted(): boolean {
    return this.currentBlock?.kind === 'halt' && !this.currentBlock.latch.released;
  }

  isWaitingForKey(): boolean {
    return this.currentBlock?.kind === 'key';
  }

  isWaitingForSteadyState(): boolean {
    return this.currentBlock?.kind === 'steady';
  }

  /**
   * Runs the CPU "thread" until it blocks or the budget is spent.
   * @param maxTicks maximum number of executed loop iterations (instructions)
   * @param deadline optional wall-clock deadline (ms, `clock.now()`)
   * @returns true if the thread can make progress right now
   */
  run(maxTicks = Infinity, deadline = Infinity): boolean {
    let ticks = 0;
    while (this.generator !== null) {
      const block = this.currentBlock;
      if (block !== null && !this.canResume(block)) return false;
      if (block?.kind === 'tick' && (++ticks > maxTicks || this.clock.now() > deadline)) return true;
      this.advance();
      // still waiting for the simulation to settle: give the scheduler a chance to run it
      if (block?.kind === 'steady' && this.currentBlock?.kind === 'steady') return false;
    }
    return false;
  }

  private canResume(block: Block): boolean {
    switch (block.kind) {
      case 'tick':
        return true;
      case 'halt':
        return block.latch.released || this.thread.interrupted;
      case 'key':
        return this.keyPermits > 0 || this.thread.interrupted;
      case 'steady':
        return true; // re-checked inside Bus.waitForSteadyState
    }
  }

  private advance(): void {
    const r = this.generator!.next();
    if (r.done) {
      this.generator = null;
      this.currentBlock = null;
    } else {
      this.currentBlock = r.value;
    }
  }

  // ------------------------------------------------------------------ run()

  private *threadBody(): Generator<Block, void> {
    threadLoop: while (!this.isCancelled) {
      this.setState('Idle');

      while (!this.isExecuting) {
        try {
          yield* this.haltAwait();
        } catch (e) {
          if (!(e instanceof InterruptedException)) throw e;
          if (this.isCancelled) break threadLoop;
        }
      }

      let nextInstruction: Instruction | null;
      let it = false;

      this.setState('Running');

      this.bus.setRandomAddress();
      this.bus.setRandomData();

      this.progStart = this.nanoTime();

      while (!this.isCancelled && this.isExecuting && (nextInstruction = this.fetch()) !== null) {
        try {
          if (this.program!.isSetBreak(this.regPC - 1) || this.fPause) {
            this.updateMessage('Vykonávanie pozastavené');
            this.setState('Paused');
            this.fPause = true;
            yield* this.haltAwait();
          }

          this.setState('Running');

          if (this.fEit) {
            this.flagIE = true;
            this.fEit = false;
          }

          const logger = Cpu.timesLogger;
          if (logger !== null && this.nanoTime() - this.progStart > 1000000000) {
            this.progStart = this.nanoTime();
            logger(`INN: ${this.innEnd - this.innStart}`);
            logger(`Pocet: ${this.numOfInstr}`);
            this.numOfInstr = 0;
          }

          yield* this.execute(nextInstruction);
          this.numOfInstr++;

          it = this.bus.isIT();

          if (this.flagIE && it) {
            if (this.fIntLevel) {
              yield* this.handleInterrupt();
            } else if (!this.fIntLevelOld) {
              yield* this.handleInterrupt();
            }
          }
          this.fIntLevelOld = it;
        } catch (e) {
          if (e instanceof NonExistingInterruptLabelException) this.onInterruptLabelError?.(e.message);
          this.isExecuting = false;
        }
        yield TICK;
      }
      this.isExecuting = false;
    }
    // System.out.println("CPU koniec")
  }

  /** `program.getInstruction(Short.toUnsignedInt(regPC++))` */
  private fetch(): Instruction | null {
    const address = u16(this.regPC);
    this.regPC = toShort(this.regPC + 1);
    return this.program!.getInstruction(address);
  }

  private nanoTime(): number {
    return this.clock.now() * 1e6;
  }

  // ------------------------------------------------------------------ public control (CPUController calls)

  startExecute(startPaused: boolean): void {
    if (!this.isExecuting && this.program !== null) {
      this.regPC = 0;
      this.isExecuting = true;
      this.fPause = startPaused;
      this.cdlHalt?.countDown();
    }
  }

  pauseExecute(): void {
    this.fPause = true;
  }

  continueExecute(): void {
    if (this.fPause) {
      this.fPause = false;
      this.cdlHalt?.countDown();
    }
  }

  step(): void {
    this.fPause = true;
    this.cdlHalt?.countDown();
  }

  stopExecute(): void {
    if (this.isExecuting) {
      this.isExecuting = false;
      if (this.cdlHalt !== null) this.cdlHalt.countDown();
      else this.thread.interrupt();
    }
  }

  cancel(): void {
    this.isCancelled = true;
    this.thread.interrupt();
    this.run();
  }

  reset(): void {
    this.regA = this.regB = this.regC = this.regD = 0;
    this.regMP = this.regPC = this.regSP = 0;
    this.flagCY = this.flagIE = this.flagZ = false;
    this.RAM.fill(0);
    this.stack.fill(0);
    if (this.keyPermits > 0) this.keyPermits = 0;
  }

  loadProgram(program: Program): void {
    this.program = program;
  }

  setKeyPressed(key: CpuKey): void {
    this.key = key;
    if (this.keyPermits === 0) this.keyPermits = 1;
  }

  setIntLevel(intByLevel: boolean): void {
    this.fIntLevel = intByLevel;
  }

  setMicrostep(value: boolean): void {
    this.fMicrostep = value;
  }

  getState(): CPUState {
    return this.state;
  }

  onStateChange(listener: (s: CPUState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const i = this.stateListeners.indexOf(listener);
      if (i >= 0) this.stateListeners.splice(i, 1);
    };
  }

  /** ObjectProperty.setValue - listeners fire only on change. */
  private setState(s: CPUState): void {
    if (s === this.state) return;
    this.state = s;
    for (const l of [...this.stateListeners]) l(s);
  }

  getMessage(): string | null {
    return this.message;
  }

  private updateMessage(msg: string): void {
    this.message = msg;
  }

  // register getters (Java signed values)
  getRegA(): number { return this.regA; }
  getRegB(): number { return this.regB; }
  getRegC(): number { return this.regC; }
  getRegD(): number { return this.regD; }
  getRegMP(): number { return this.regMP; }
  getRegPC(): number { return this.regPC; }
  getRegSP(): number { return this.regSP; }
  isFlagCY(): boolean { return this.flagCY; }
  isFlagIE(): boolean { return this.flagIE; }
  isFlagZ(): boolean { return this.flagZ; }
  getRAM(): Int8Array { return this.RAM.slice(); }
  getStack(): Int8Array { return this.stack.slice(); }

  // ------------------------------------------------------------------ execute()

  private *execute(instruction: Instruction): Generator<Block, void> {
    let Rd: number;
    let Rs: number;
    let K: number;
    let addr: number;
    const p1 = instruction.firstParameter as string;
    const p2 = instruction.secondParameter as string;
    const t: InstructionType = instruction.type;

    switch (t) {
      case 'ADD':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        Rd += Rs;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd > 255;
        break;
      case 'ADC':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        Rd += Rs + (this.flagCY ? 1 : 0);
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd > 255;
        break;
      case 'ADI':
        Rd = this.getRegisterVal(p1);
        K = parseConstant(p2);
        Rd += K;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd > 255;
        break;
      case 'SUB':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        Rd -= Rs;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd < 0;
        break;
      case 'SUC':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        Rd -= Rs + (this.flagCY ? 1 : 0);
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd < 0;
        break;
      case 'SBI':
        Rd = this.getRegisterVal(p1);
        K = parseConstant(p2);
        Rd -= K;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        this.flagCY = Rd < 0;
        break;
      case 'AND':
        Rd = this.getRegisterVal(p1) & this.getRegisterVal(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'ANI':
        Rd = this.getRegisterVal(p1) & parseConstant(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'ORR':
        Rd = this.getRegisterVal(p1) | this.getRegisterVal(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'ORI':
        Rd = this.getRegisterVal(p1) | parseConstant(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'XOR':
        Rd = this.getRegisterVal(p1) ^ this.getRegisterVal(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'XRI':
        Rd = this.getRegisterVal(p1) ^ parseConstant(p2);
        this.setRegisterVal(p1, Rd);
        this.flagZ = Rd === 0;
        break;
      case 'INC':
        Rd = this.getRegisterVal(p1) + 1;
        this.setRegisterVal(p1, Rd);
        this.flagCY = this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'INX':
        Rd = this.getRegisterVal(p1) + 1;
        this.setRegisterVal(p1, Rd);
        this.flagCY = this.flagZ = (Rd & 0xffff) === 0;
        break;
      case 'DEC':
        Rd = this.getRegisterVal(p1);
        this.flagCY = (Rd & 0xff) === 0;
        this.setRegisterVal(p1, --Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'DCX':
        Rd = this.getRegisterVal(p1);
        this.flagCY = (Rd & 0xffff) === 0;
        this.setRegisterVal(p1, --Rd);
        this.flagZ = (Rd & 0xffff) === 0;
        break;
      case 'CMP':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        this.flagZ = Rd - Rs === 0;
        this.flagCY = Rd - Rs < 0;
        break;
      case 'CMI':
        Rd = this.getRegisterVal(p1);
        K = parseConstant(p2);
        this.flagZ = Rd - K === 0;
        this.flagCY = Rd - K < 0;
        break;
      case 'SHL':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd <<= K;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'SHR':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd >>= K;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'SCR':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        this.flagCY = (Rd & (1 << (K - 1))) !== 0;
        Rd >>= K;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'RTL':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd = (Rd << K) | (Rd >> (8 - K));
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'RCL':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd = (Rd << K) | (Rd >> (8 - K));
        this.flagCY = (Rd & 1) === 1;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'RTR':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd = (Rd >> K) | (Rd << (8 - K));
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'RCR':
        Rd = this.getRegisterVal(p1);
        K = parseIntJava(p2);
        Rd = (Rd >> K) | (Rd << (8 - K));
        this.flagCY = (Rd & 0x80) !== 0;
        this.setRegisterVal(p1, Rd);
        this.flagZ = (Rd & 0xff) === 0;
        break;
      case 'MOV':
        this.setRegisterVal(p1, this.getRegisterVal(p2));
        break;
      case 'MVI':
      case 'MXI':
        this.setRegisterVal(p1, parseConstant(p2));
        break;
      case 'MVX':
        if (p1.toUpperCase() === 'C') {
          Rs = this.getRegisterVal(p2);
          const L = Rs & 0xff;
          const H = Rs >> 8;
          this.setRegisterVal('C', H);
          this.setRegisterVal('D', L);
        } else {
          const val = (this.getRegisterVal('B') * 256) | this.getRegisterVal('A');
          this.setRegisterVal(p1, val);
        }
        break;
      case 'MMR':
        Rs = this.getRegisterVal(p2);
        this.setRegisterVal(p1, this.program!.getByte(Rs));
        break;
      case 'LMI':
        addr = toShort(parseConstant(p2));
        yield* this.read('LMI', addr, p1);
        break;
      case 'LMR':
        yield* this.read('LMR', this.regMP, p1);
        break;
      case 'SMI':
        addr = toShort(parseConstant(p1));
        yield* this.write('SMI', addr, toByte(this.getRegisterVal(p2)));
        break;
      case 'SMR':
        yield* this.write('SMR', this.regMP, toByte(this.getRegisterVal(p1)));
        break;
      case 'INN':
        addr = toShort(parseConstant(p2));
        yield* this.read('INN', addr, p1);
        break;
      case 'OUT':
        addr = toShort(parseConstant(p1));
        yield* this.write('OUT', addr, toByte(this.getRegisterVal(p2)));
        break;
      case 'PUS':
        if (/^M$/i.test(p1)) this.pushShort(toShort(this.getRegisterVal(p1)));
        else this.pushByte(toByte(this.getRegisterVal(p1)));
        break;
      case 'POP':
        if (/^M$/i.test(p1)) this.setRegisterVal(p1, this.popShort());
        else this.setRegisterVal(p1, this.pop());
        break;
      case 'STR':
        Rd = this.getRegisterVal(p1);
        Rs = this.getRegisterVal(p2);
        this.RAM[Rd] = toByte(Rs);
        break;
      case 'LDR':
        Rs = this.getRegisterVal(p2);
        this.setRegisterVal(p1, this.RAM[Rs]);
        break;
      case 'JMP':
        this.regPC = this.jumpTarget(p1);
        break;
      case 'JE':
      case 'JZR':
        if (this.flagZ) this.regPC = this.jumpTarget(p1);
        break;
      case 'JNE':
      case 'JNZ':
        if (!this.flagZ) this.regPC = this.jumpTarget(p1);
        break;
      case 'JL':
      case 'JCY':
        if (this.flagCY) this.regPC = this.jumpTarget(p1);
        break;
      case 'JNL':
      case 'JGE':
      case 'JNC':
        if (!this.flagCY) this.regPC = this.jumpTarget(p1);
        break;
      case 'JG':
        if (!this.flagCY && !this.flagZ) this.regPC = this.jumpTarget(p1);
        break;
      case 'JNG':
      case 'JLE':
        if (this.flagCY || this.flagZ) this.regPC = this.jumpTarget(p1);
        break;
      case 'CAL':
        this.call(p1);
        break;
      case 'CE':
      case 'CZR':
        if (this.flagZ) this.call(p1);
        break;
      case 'CNE':
      case 'CNZ':
        if (!this.flagZ) this.call(p1);
        break;
      case 'CL':
      case 'CCY':
        if (this.flagCY) this.call(p1);
        break;
      case 'CNL':
      case 'CGE':
      case 'CNC':
        if (!this.flagCY) this.call(p1);
        break;
      case 'CG':
        if (!this.flagCY && !this.flagZ) this.call(p1);
        break;
      case 'CNG':
      case 'CLE':
        if (this.flagCY || this.flagZ) this.call(p1);
        break;
      case 'RET':
        this.regPC = this.popShort();
        break;
      case 'EIT':
        this.fEit = true;
        break;
      case 'DIT':
        this.flagIE = false;
        break;
      case 'SCALL':
        switch (p1.toUpperCase()) {
          case 'KEY':
            if (!this.tryAcquireKey()) {
              this.updateMessage('Stlacte klavesu');
              this.setState('Waiting');
              yield* this.acquireKey();
              this.setState('Running');
            }
            if (this.key!.kind === 'arrow') this.setRegisterVal('d', this.key!.code);
            else if (this.key!.character.length === 0) throw new RangeError('StringIndexOutOfBoundsException');
            else this.setRegisterVal('d', this.key!.character.charCodeAt(0));
            break;
          case 'KPR':
            this.flagCY = this.keyPermits > 0;
            break;
          case 'DSP':
            this.console.write(this.regD);
            break;
        }
        break;
      case 'BYTE':
        break;
    }
  }

  /** `(short) Integer.parseUnsignedInt(label)` - an unresolved label throws NumberFormatException. */
  private jumpTarget(param: string): number {
    return toShort(parseUnsignedIntJava(param));
  }

  private call(param: string): void {
    this.pushShort(this.regPC);
    this.regPC = this.jumpTarget(param);
  }

  // ------------------------------------------------------------------ interrupts

  private *handleInterrupt(): Generator<Block, void> {
    this.flagIE = false;
    this.bus.setIA_(false);
    yield* this.waitForSteadySimulation();
    const data = this.bus.getDataBus();
    this.bus.setIA_(true);
    this.pushShort(this.regPC);
    const intNumber = data & 0x0f;
    this.regPC = toShort(this.program!.getAddressOfInterrupt(intNumber));
  }

  // ------------------------------------------------------------------ registers & stack

  private getRegisterVal(regName: string): number {
    switch (regName.toUpperCase()) {
      case 'A': return u8(this.regA);
      case 'B': return u8(this.regB);
      case 'C': return u8(this.regC);
      case 'D': return u8(this.regD);
      case 'M': return u16(this.regMP);
      case 'S': return u16(this.regSP);
      case 'PC': return u16(this.regPC);
    }
    throw new InvalidParameterException('Neplatny register');
  }

  private setRegisterVal(regName: string, value: number): void {
    switch (regName.toUpperCase()) {
      case 'A': this.regA = toByte(value); break;
      case 'B': this.regB = toByte(value); break;
      case 'C': this.regC = toByte(value); break;
      case 'D': this.regD = toByte(value); break;
      case 'M': this.regMP = toShort(value); break;
      case 'S': this.regSP = toShort(value); break;
      case 'PC': this.regPC = toShort(value); break;
      default: throw new InvalidParameterException('Neplatny register');
    }
  }

  private pushByte(value: number): void {
    let SP = u16(this.regSP);
    this.stack[SP--] = value; // SP = -1 → (short) → 0xFFFF
    this.regSP = toShort(SP);
  }

  private pushShort(value: number): void {
    const L = value & 0xff;
    const H = (value >> 8) & 0xff;
    this.pushByte(toByte(H));
    this.pushByte(toByte(L));
  }

  private pop(): number {
    let SP = u16(this.regSP);
    if (SP === 65535) SP = 0;
    else SP++;
    this.regSP = toShort(SP);
    return this.stack[SP];
  }

  private popShort(): number {
    const L = u8(this.pop());
    const H = u8(this.pop()) << 8;
    return toShort(H | L);
  }

  // ------------------------------------------------------------------ bus cycles

  private *read(inst: InstructionType, addr: number, destRegName: string): Generator<Block, void> {
    this.innStart = this.nanoTime();
    yield* this.microstepAwait('Nastavenie adresy');
    this.bus.setAddressBus(addr);

    yield* this.microstepAwait('Nastavenie priznaku ' + (inst === 'INN' ? 'IOR' : 'MR') + ' = 0');
    if (inst === 'INN') this.bus.setIR_(false);
    else this.bus.setMR_(false);

    yield* this.waitForSteadySimulation();
    if (!this.isExecuting) throw new InterruptedException('CPU stopped');

    yield* this.microstepAwait('Nacitanie dat');
    const Rd = this.bus.getDataBus();
    this.setRegisterVal(destRegName, Rd);

    yield* this.microstepAwait('Zrusenie priznaku ' + (inst === 'INN' ? 'IOR' : 'MR'));
    if (inst === 'INN') this.bus.setIR_(true);
    else this.bus.setMR_(true);
    this.bus.setRandomData();

    yield* this.microstepAwait('Zrusenie adresy');
    this.bus.setRandomAddress();
    this.innEnd = this.nanoTime();
  }

  private *write(inst: InstructionType, addr: number, data: number): Generator<Block, void> {
    yield* this.microstepAwait('Nastavenie adresy');
    this.bus.setAddressBus(addr);

    yield* this.microstepAwait('Nastavenie dat');
    this.bus.setDataBus(data);

    yield* this.microstepAwait('Nastavenie priznaku ' + (inst === 'OUT' ? 'IOW' : 'MW') + ' = 0');
    if (inst === 'OUT') this.bus.setIW_(false);
    else this.bus.setMW_(false);

    yield* this.waitForSteadySimulation();
    if (!this.isExecuting) throw new InterruptedException('CPU stopped');

    yield* this.microstepAwait('Zrusenie priznaku ZAPISU');
    if (inst === 'OUT') this.bus.setIW_(true);
    else this.bus.setMW_(true);

    yield* this.waitForSteadySimulation();
    if (!this.isExecuting) throw new InterruptedException('CPU stopped');

    yield* this.microstepAwait('Zrusenie dat');
    this.bus.setRandomData();

    yield* this.microstepAwait('Zrusenie adresy');
    this.bus.setRandomAddress();
  }

  private *microstepAwait(msg: string): Generator<Block, void> {
    if (this.isExecuting && this.fMicrostep && this.fPause) {
      this.updateMessage(msg);
      this.setState('Paused');
      yield* this.haltAwait();
      this.setState('Running');
    }
  }

  /** `cdlHalt = new CountDownLatch(1); cdlHalt.await(); cdlHalt = null;` */
  private *haltAwait(): Generator<Block, void> {
    const latch = new Latch();
    this.cdlHalt = latch;
    this.thread.throwIfInterrupted();
    while (!latch.released) {
      yield { kind: 'halt', latch };
      this.thread.throwIfInterrupted();
    }
    this.cdlHalt = null;
  }

  private tryAcquireKey(): boolean {
    if (this.keyPermits > 0) {
      this.keyPermits--;
      return true;
    }
    return false;
  }

  /** `semKey.acquire()` */
  private *acquireKey(): Generator<Block, void> {
    this.thread.throwIfInterrupted();
    while (this.keyPermits === 0) {
      yield { kind: 'key' };
      this.thread.throwIfInterrupted();
    }
    this.keyPermits--;
  }

  private *waitForSteadySimulation(): Generator<Block, void> {
    const steady = yield* this.bus.waitForSteadyState(this.thread);
    if (!steady && this.isExecuting) {
      if (this.clock.now() - this.lastErrorMsgPrint > 2000) {
        this.console.writeBytes([...new TextEncoder().encode(BUS_WARNING)].map(toByte));
        this.console.write(10);
        this.console.write(13);
        this.lastErrorMsgPrint = this.clock.now();
      }
    }
  }
}
