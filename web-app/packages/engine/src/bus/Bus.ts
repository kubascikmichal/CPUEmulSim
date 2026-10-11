/**
 * Port of `sk.uniza.fri.cp.Bus.Bus` - system bus between the CPU and the schematic.
 * Holds address (16 bit), data (8 bit) and control (9 bit) values and the CPU <-> simulation
 * steady-state handshake.
 *
 * Differences from Java are confined to threading: listeners fire synchronously (as they did on
 * the CPU thread in Java) and waiting for steady state is a generator that yields {@link STEADY}.
 */
import { STEADY, type Block, type ThreadContext } from '../runtime/threads';
import { mathRandom, type RandomSource } from '../util/JavaRandom';
import { toByte, toShort, u16, u8 } from '../util/java';

export type ChangeListener = (oldValue: number, newValue: number) => void;

/** JavaFX `SimpleIntegerProperty` subset: change listeners fire only when the value changes. */
export class IntegerProperty {
  private listeners: ChangeListener[] = [];
  constructor(private value: number) {}

  get(): number {
    return this.value;
  }

  set(newValue: number): void {
    if (newValue === this.value) return;
    const old = this.value;
    this.value = newValue;
    for (const l of [...this.listeners]) l(old, newValue);
  }

  addListener(l: ChangeListener): void {
    this.listeners.push(l);
  }

  removeListener(l: ChangeListener): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
  }
}

export type ControlSignal = 'MW_' | 'MR_' | 'IW_' | 'IR_' | 'IA_' | 'IT' | 'RY' | 'BQ' | 'BA';

/** Bit positions of control signals (Bus.mapSignal). */
export const CONTROL_BITS: Record<ControlSignal, number> = {
  MW_: 8, MR_: 7, IW_: 6, IR_: 5, IA_: 4, IT: 3, RY: 2, BQ: 1, BA: 0,
};

/** What the bus needs to know about the simulation event queue. */
export interface EventQueueView {
  size(): number;
}

export interface Clock {
  /** `System.currentTimeMillis()` */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class Bus {
  readonly addressBus = new IntegerProperty(0);
  readonly dataBus = new IntegerProperty(0);
  readonly controlBus = new IntegerProperty(0);

  private isSimulationRunning = false;
  private simulationIdle = false;
  private simLoopHeartbeatMs = 0;
  private queue: EventQueueView | null = null;
  private lastSteadyDiagPrint = 0;

  constructor(
    private rand: RandomSource = mathRandom,
    private clock: Clock = systemClock,
  ) {
    this.initControlBus();
  }

  setRandomSource(rand: RandomSource): void {
    this.rand = rand;
  }

  setClock(clock: Clock): void {
    this.clock = clock;
  }

  /** Reset: random address and data, control lines to their inactive values. */
  reset(): void {
    this.setRandomAddress();
    this.setRandomData();
    this.initControlBus();
  }

  /** Java returns `short` (signed). */
  getAddressBus(): number {
    return toShort(this.addressBus.get());
  }

  /** Java returns `byte` (signed). */
  getDataBus(): number {
    return toByte(this.dataBus.get());
  }

  getControlBus(): number {
    return this.controlBus.get();
  }

  setAddressBus(address: number): void {
    this.addressBus.set(u16(address));
  }

  setDataBus(data: number): void {
    this.dataBus.set(u8(data));
  }

  setRandomAddress(): void {
    this.addressBus.set(this.rand.nextInt(65535));
  }

  setRandomData(): void {
    this.dataBus.set(this.rand.nextInt(256));
  }

  // ---------------------------------------------------------------- steady state handshake

  /**
   * Waits until the simulation reports it is idle with an empty event queue.
   * Returns false when the simulation is not running, is dead (no heartbeat for 30 s)
   * or the waiting thread was interrupted (the interrupt flag is then kept, as Java re-interrupts).
   */
  *waitForSteadyState(thread: ThreadContext): Generator<Block, boolean> {
    const waitStart = this.clock.now();
    while (this.isSimulationRunning) {
      if (this.queue !== null && this.queue.size() === 0 && this.simulationIdle) return true;
      if (!this.simulationAlive()) {
        this.reportSteadyFailure('simulacia mŕtva/ticho príliš dlho', this.clock.now() - waitStart,
          this.queue?.size() ?? -1);
        return false;
      }
      if (thread.interrupted) return false; // Object.wait throws, Bus re-interrupts and returns false
      yield STEADY;
    }
    this.reportSteadyFailure('simulacia nebezi', 0, -1);
    return false;
  }

  private simulationAlive(): boolean {
    const heartbeat = this.simLoopHeartbeatMs;
    return heartbeat === 0 || this.clock.now() - heartbeat < 30000;
  }

  reportSimLoopActivity(): void {
    this.simLoopHeartbeatMs = this.clock.now();
  }

  private reportSteadyFailure(reason: string, waitedMs: number, queueSize: number): void {
    const now = this.clock.now();
    if (now - this.lastSteadyDiagPrint > 2000) {
      this.lastSteadyDiagPrint = now;
      // eslint-disable-next-line no-console
      console.debug(`[Bus] waitForSteadyState=false (${reason} | cakal ms: ${waitedMs} | fronte: ${queueSize})`);
    }
  }

  setEventsQueue(queue: EventQueueView): void {
    this.queue = queue;
  }

  /** Simulation drained its queue and is going to wait. */
  dataInSteadyState(): void {
    this.simulationIdle = true;
  }

  /** Simulation starts processing an event. */
  simulationProcessingStarts(): void {
    this.simulationIdle = false;
  }

  /** Intentionally empty in the original (see Bus.dataIsChanging javadoc). */
  dataIsChanging(): void {}

  simulationIsRunning(isRunning: boolean): void {
    this.isSimulationRunning = isRunning;
  }

  // ---------------------------------------------------------------- control signals

  setMW_(v: boolean): void { this.mapToControlBus('MW_', v); }
  setMR_(v: boolean): void { this.mapToControlBus('MR_', v); }
  setIW_(v: boolean): void { this.mapToControlBus('IW_', v); }
  setIR_(v: boolean): void { this.mapToControlBus('IR_', v); }
  setIA_(v: boolean): void { this.mapToControlBus('IA_', v); }
  setIT(v: boolean): void { this.mapToControlBus('IT', v); }
  setRY(v: boolean): void { this.mapToControlBus('RY', v); }

  isIT(): boolean {
    return this.mapFromControlBus('IT');
  }

  isIA_(): boolean {
    return this.mapFromControlBus('IA_');
  }

  private initControlBus(): void {
    this.mapToControlBus('MW_', true);
    this.mapToControlBus('MR_', true);
    this.mapToControlBus('IW_', true);
    this.mapToControlBus('IR_', true);
    this.mapToControlBus('IA_', true);
    this.mapToControlBus('IT', false);
    this.mapToControlBus('RY', false);
    this.mapToControlBus('BQ', false);
    this.mapToControlBus('BA', false);
  }

  private mapToControlBus(signal: ControlSignal, value: boolean): void {
    const pos = CONTROL_BITS[signal];
    const current = this.controlBus.get();
    this.controlBus.set(value ? current | (1 << pos) : current & ~(1 << pos));
  }

  private mapFromControlBus(signal: ControlSignal): boolean {
    return (this.controlBus.get() & (1 << CONTROL_BITS[signal])) !== 0;
  }
}
