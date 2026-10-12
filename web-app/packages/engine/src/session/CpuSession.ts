/**
 * Headless port of `App.CPUControl.CPUController` - everything except drawing.
 *
 * Owns the CPU, the system bus, the schematic sheet, the console and the parsed program, and
 * implements the controller flows (parse / start / step / pause / stop / reset, state handling,
 * settings) in the same order as the original. The UI renders {@link CpuSession.view} and calls
 * the `handle*` methods; a {@link Scheduler} drives the CPU and the simulation.
 */
import { Bus, systemClock, type Clock } from '../bus/Bus';
import { Cpu, type CPUState, type CpuKey } from '../cpu/Cpu';
import { parse, type ParseResult } from '../cpu/Parser';
import { InvalidCodeLinesException, type Program } from '../cpu/Program';
import { ConsoleModel, ConsoleOutputStream, writeConsoleLn } from '../io/Console';
import { SchematicSheet } from '../schematic/Sheet';
import { MemoryTables } from './MemoryTables';

export const BTN_TXT_START = 'Spusti [F5]';
export const BTN_TXT_CONTINUE = 'Pokračuj [F5]';

/** Everything the CPU window shows that depends on controller state. */
export interface CpuView {
  statusText: string;
  /** -1 = indeterminate (running), otherwise 0..1 */
  progress: number;
  startText: string;
  parseEnabled: boolean;
  startEnabled: boolean;
  stepEnabled: boolean;
  pauseEnabled: boolean;
  stopEnabled: boolean;
  resetEnabled: boolean;
  editorEditable: boolean;
  /** editor line highlighted as executing (-1 none) */
  executionLine: number;
  /** request to move the caret to the execution line (scroll into view) */
  executionLineReveal: number;
  /** lines highlighted as parse errors */
  errorLines: number[];
}

export interface SessionOptions {
  clock?: Clock;
  /** Delay used for the original `Thread.sleep(100)` simulation warm-up (injectable for tests). */
  delay?: (ms: number) => Promise<void>;
  /** Alert when an interrupt label is missing (title "Chyba", header "Chyba prerušenia"). */
  onInterruptError?: (message: string) => void;
}

export class CpuSession {
  readonly clock: Clock;
  readonly bus: Bus;
  readonly sheet: SchematicSheet;
  readonly console = new ConsoleModel();
  readonly memory = new MemoryTables();

  cpu!: Cpu;
  /** The CPU the schematic window's buttons are bound to (bound once, like the original). */
  readonly schematicCpu: Cpu;
  cosCpu!: ConsoleOutputStream;

  private program: Program | null = null;
  private breakpointLines = new Set<number>();
  private fIntByLevel = true;
  private fMicrostep = false;
  private fStartPaused = false;
  private fPaused = false;
  private fInExecution = false;
  private busy = false;

  private viewState: CpuView = {
    statusText: 'Stav',
    progress: 0,
    startText: BTN_TXT_START,
    parseEnabled: true,
    startEnabled: true,
    stepEnabled: true,
    pauseEnabled: false,
    stopEnabled: false,
    resetEnabled: false,
    editorEditable: true,
    executionLine: -1,
    executionLineReveal: 0,
    errorLines: [],
  };
  private readonly listeners: (() => void)[] = [];
  private readonly delay: (ms: number) => Promise<void>;
  private readonly onInterruptError?: (message: string) => void;
  /** Wake-up hook set by the scheduler. */
  wake: () => void = () => {};

  constructor(options: SessionOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onInterruptError = options.onInterruptError;
    this.bus = new Bus(undefined, this.clock);
    this.sheet = new SchematicSheet(5000, 5000, 10, this.bus, this.clock);
    this.initCPU();
    this.schematicCpu = this.cpu;
    this.updateGUI();
  }

  // ---------------------------------------------------------------- observable view

  get view(): Readonly<CpuView> {
    return this.viewState;
  }

  subscribe(l: () => void): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private setView(patch: Partial<CpuView>): void {
    this.viewState = { ...this.viewState, ...patch };
    this.notify();
  }

  notify(): void {
    for (const l of [...this.listeners]) l();
  }

  isExecuting(): boolean {
    return this.fInExecution;
  }

  getProgram(): Program | null {
    return this.program;
  }

  // ---------------------------------------------------------------- CPU lifecycle

  private initCPU(): void {
    this.cosCpu = new ConsoleOutputStream(this.console);
    this.cosCpu.onPending = () => this.wake();
    this.cpu = new Cpu(this.cosCpu, this.bus, this.clock);
    this.cpu.onInterruptLabelError = (msg) => this.onInterruptError?.(msg);
    this.cpu.onRuntimeError = (msg) => writeConsoleLn(this.console, '[CPU] ' + msg, 'red');
    this.cpu.onStateChange((s) => this.onCPUStateChanged(s));
    this.cpu.start();
    this.cpu.setIntLevel(this.fIntByLevel);
    this.cpu.setMicrostep(this.fMicrostep);
  }

  private onCPUStateChanged(state: CPUState): void {
    switch (state) {
      case 'Running':
        return this.onCPURunning();
      case 'Paused':
        return this.onCPUPaused();
      case 'Waiting':
        return this.onCPUWaiting();
      case 'Idle':
        return this.onCPUIdle('Nečinný');
    }
  }

  private onCPURunning(): void {
    this.fPaused = false;
    if (!this.fInExecution) this.fInExecution = true;
    this.setView({
      executionLine: -1,
      progress: -1,
      statusText: 'Program sa vykonáva...',
      parseEnabled: false,
      startEnabled: false,
      stepEnabled: false,
      pauseEnabled: true,
      stopEnabled: true,
      resetEnabled: false,
      editorEditable: false,
    });
  }

  private onCPUPaused(): void {
    this.fPaused = true;
    this.setView({
      executionLine: this.program!.getLineOfInstruction(this.cpu.getRegPC() - 1),
      executionLineReveal: this.viewState.executionLineReveal + 1,
      progress: 0.5,
      statusText: this.cpu.getMessage() ?? '',
      startText: BTN_TXT_CONTINUE,
      parseEnabled: false,
      startEnabled: true,
      stepEnabled: true,
      pauseEnabled: false,
      stopEnabled: true,
      resetEnabled: false,
    });
    this.updateGUI();
  }

  private onCPUWaiting(): void {
    this.fPaused = true;
    this.setView({
      executionLine: this.program!.getLineOfInstruction(this.cpu.getRegPC() - 1),
      executionLineReveal: this.viewState.executionLineReveal + 1,
      progress: 0.5,
      statusText: this.cpu.getMessage() ?? '',
      parseEnabled: false,
      startEnabled: false,
      stepEnabled: false,
      pauseEnabled: false,
      stopEnabled: true,
      resetEnabled: false,
    });
  }

  private onCPUIdle(statusText: string): void {
    this.fInExecution = false;
    this.fPaused = false;
    this.setView({
      executionLine: -1,
      progress: 0,
      statusText,
      startText: BTN_TXT_START,
      parseEnabled: true,
      startEnabled: true,
      stepEnabled: true,
      pauseEnabled: false,
      stopEnabled: false,
      resetEnabled: true,
      editorEditable: true,
    });
    this.updateGUI();
  }

  /** Registers + tables refresh (`updateGUI`). */
  updateGUI(): void {
    this.memory.update(this.cpu, this.program);
    this.notify();
  }

  /** True while the GUI should refresh continuously (running and not paused). */
  isRunningUnpaused(): boolean {
    return this.fInExecution && !this.fPaused;
  }

  // ---------------------------------------------------------------- editor

  /** Any text change in the editor (style-only changes excluded). */
  onCodeChanged(): void {
    this.program = null;
    this.setView({ startText: BTN_TXT_START });
  }

  /** Breakpoint set changed in the editor (line indices). */
  setBreakpointLines(lines: Iterable<number>): void {
    this.breakpointLines = new Set(lines);
    if (this.program !== null) {
      try {
        this.program.setBreakpointLines(this.breakpointLines, true);
      } catch (e) {
        console.error(e); // NullPointerException in the original listener (printed, ignored)
      }
    }
  }

  // ---------------------------------------------------------------- parsing

  /**
   * `parseCode(startExecution)`. Returns once parsing finished; on success optionally starts.
   */
  async parseCode(code: string, lineCount: number, startExecution: boolean): Promise<ParseResult> {
    this.setView({ errorLines: [], statusText: 'Parsujem...', progress: 0 });
    const result = parse(code, lineCount, (done, total) => (this.viewState.progress = total > 0 ? done / total : 0));

    if (result.ok) {
      writeConsoleLn(this.console, 'Program úspešne zavedený!', 'green');
      this.program = result.program;
      try {
        this.program.setBreakpointLines(this.breakpointLines);
      } catch (e) {
        // NullPointerException in setListenerOnBreakpointsChange: the rest of onSucceeded is skipped
        console.error(e);
        this.notify();
        return result;
      }
      this.memory.update(this.cpu, this.program, { programOnly: true });
      this.setView({ statusText: 'Program zavedený', progress: 1 });
      if (startExecution) await this.startExecution();
    } else if (result.error instanceof InvalidCodeLinesException) {
      for (const msg of result.error.errors) writeConsoleLn(this.console, '[Parser] ' + msg, 'red');
      this.program = null;
      this.memory.update(this.cpu, this.program, { programOnly: true });
      this.setView({ errorLines: [...result.error.lines], statusText: 'Chyba v kóde' });
    } else {
      // ClassCastException in the original onFailed handler: nothing else happens
      console.error(result.error);
      this.notify();
    }
    return result;
  }

  // ---------------------------------------------------------------- execution control

  /** Spusti / Pokračuj [F5] */
  async handleButtonStartAction(code: string, lineCount: number): Promise<void> {
    if (this.busy) return;
    this.fStartPaused = false;
    if (this.fInExecution && this.fPaused) {
      this.cpu.continueExecute();
      this.wake();
    } else {
      await this.startCPUAction(code, lineCount);
    }
  }

  /** Krok [F7] */
  async handleButtonStepAction(code: string, lineCount: number): Promise<void> {
    if (this.busy) return;
    this.fStartPaused = true;
    if (this.fInExecution) {
      this.cpu.step();
      this.wake();
    } else {
      await this.startCPUAction(code, lineCount);
    }
  }

  /** Pauza [F9] */
  handleButtonPauseAction(): void {
    this.cpu.pauseExecute();
    this.wake();
  }

  /** Stop [F10] */
  handleButtonStopAction(): void {
    this.cpu.stopExecute();
    this.cosCpu.clearBuffer();
    this.wake();
  }

  /** Reset [F12] */
  handleButtonResetAction(): void {
    this.cpu.reset();
    this.bus.reset();
    this.updateGUI();
    this.updateGUI(); // clears the "changed" highlight
  }

  private async startCPUAction(code: string, lineCount: number): Promise<void> {
    if (this.program === null) await this.parseCode(code, lineCount, true);
    else await this.startExecution();
  }

  private async startExecution(): Promise<void> {
    if (this.cpu.isAlive()) {
      if (this.program!.hasIOInstruction()) {
        const wasRunning = this.sheet.isSimulationRunning();
        this.sheet.powerOn();
        this.wake();
        if (!wasRunning) {
          // Thread.sleep(100) on the FX thread: the UI does not react meanwhile
          this.busy = true;
          try {
            await this.delay(100);
          } finally {
            this.busy = false;
          }
        }
      }
      this.cosCpu.setUnused();
      this.cpu.reset();
      this.cpu.loadProgram(this.program!);
      this.cpu.startExecute(this.fStartPaused);
      this.wake();
    } else {
      this.initCPU();
      await this.startExecution();
    }
  }

  /** Keyboard input forwarded while a program runs. */
  keyboardInput(key: CpuKey): void {
    this.cpu.setKeyPressed(key);
    this.wake();
  }

  // ---------------------------------------------------------------- settings

  setIntByLevel(byLevel: boolean): void {
    this.fIntByLevel = byLevel;
    this.cpu.setIntLevel(byLevel);
    this.notify();
  }

  isIntByLevel(): boolean {
    return this.fIntByLevel;
  }

  setMicrostep(value: boolean): void {
    this.fMicrostep = value;
    this.cpu.setMicrostep(value);
    this.notify();
  }

  isMicrostep(): boolean {
    return this.fMicrostep;
  }

  /** `Koniec`: the original cancels the CPU thread before asking about unsaved files. */
  cancelCpuThread(): void {
    this.cpu.cancel();
  }
}
