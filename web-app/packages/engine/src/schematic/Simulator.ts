/**
 * Port of `SchematicSim.Sheet.SchematicSimulator` as a cooperative, time-sliced loop.
 *
 * Java ran an event loop on its own thread polling the queue with a 5 ms timeout. Here
 * {@link Simulator.runSlice} performs the same loop body; "poll timed out" is detected with the
 * clock, so idle passes (simulate every gate - drives LED / 7-segment hold timers) happen at the
 * same cadence. Steady-state notifications to the {@link Bus} are made at the same points.
 */
import type { Bus, Clock } from '../bus/Bus';
import { BusSymbol } from './buses/BusSymbol';
import type { GateSymbol, SheetEvent } from './gates/GateSymbol';

const ASYNCH_TIMEOUT_MS = 5000;
const IDLE_POLL_TIMEOUT_MS = 5;

export class Simulator {
  private readonly eventsQueue: SheetEvent[] = [];
  private allGates: GateSymbol[] = [];
  private running = false;
  private cancelled = false;
  private steadyState = false;
  private lastActivityTime = 0;
  private pollStart = 0;
  private readonly runningListeners: ((running: boolean) => void)[] = [];

  /** `Alert(ERROR, "Chyba simulácie. Príliš dlhá odozva.")` */
  onTimeout: (() => void) | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly clock: Clock,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  onRunningChange(l: (running: boolean) => void): () => void {
    this.runningListeners.push(l);
    return () => {
      const i = this.runningListeners.indexOf(l);
      if (i >= 0) this.runningListeners.splice(i, 1);
    };
  }

  private setRunning(v: boolean): void {
    if (v === this.running) return;
    this.running = v;
    for (const l of [...this.runningListeners]) {
      try {
        l(v);
      } catch (e) {
        console.error(e);
      }
    }
  }

  queueSize(): number {
    return this.eventsQueue.length;
  }

  /** Power on: initial evaluation of all gates, then the event loop runs in slices. */
  start(allGates: GateSymbol[]): void {
    if (this.running) return;
    this.allGates = allGates;
    this.cancelled = false;
    this.setRunning(true);

    this.bus.setEventsQueue({ size: () => this.eventsQueue.length });
    this.bus.simulationIsRunning(true);
    this.bus.simulationProcessingStarts();

    try {
      this.allGates.forEach((g) => g.reset());
      this.allGates.forEach((g) => g.simulate());
      for (const gate of this.allGates) if (gate instanceof BusSymbol) gate.syncFromBus();
    } catch (t) {
      console.error('[Sim] Chyba simulácie:', t);
      this.finish();
      return;
    }

    this.steadyState = false;
    this.lastActivityTime = this.clock.now();
    this.pollStart = this.clock.now();
  }

  /** Power off (Service.cancel): drain remaining events, reset gates, detach from the bus. */
  stop(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.bus.simulationProcessingStarts();
    const gatesToUpdate = new Set<GateSymbol>();
    try {
      while (this.eventsQueue.length > 0) {
        this.eventsQueue.shift()!.process(gatesToUpdate);
        gatesToUpdate.forEach((g) => g.simulate());
        gatesToUpdate.clear();
      }
      this.allGates.forEach((g) => g.reset());
    } catch (t) {
      console.error('[Sim] Chyba simulácie:', t);
    }
    this.finish();
  }

  private finish(): void {
    this.setRunning(false);
    this.bus.simulationIsRunning(false);
  }

  /** `addEvent`: a pending event for the same pin is replaced. */
  addEvent(event: SheetEvent): void {
    if (event.pin !== null) {
      for (let i = this.eventsQueue.length - 1; i >= 0; i--) {
        if (this.eventsQueue[i].pin === event.pin) this.eventsQueue.splice(i, 1);
      }
    }
    this.eventsQueue.push(event);
  }

  /**
   * Runs the loop body until the deadline (or until it would block on an empty queue).
   * @returns true if there is pending work (events) after the slice
   */
  runSlice(deadline: number): boolean {
    if (!this.running || this.cancelled) return false;
    const gatesToUpdate = new Set<GateSymbol>();

    while (this.running && !this.cancelled) {
      const now = this.clock.now();
      this.bus.reportSimLoopActivity();

      if (this.eventsQueue.length === 0) {
        // queue.poll(5 ms) timed out → idle pass
        if (now - this.pollStart >= IDLE_POLL_TIMEOUT_MS) {
          try {
            this.allGates.forEach((g) => g.simulate());
          } catch (e) {
            console.error(e);
          }
          this.bus.dataInSteadyState();
          this.steadyState = true;
          this.lastActivityTime = this.clock.now();
          this.pollStart = this.clock.now();
          continue;
        }
        return false;
      }

      if (now > deadline) return true;

      const event = this.eventsQueue.shift()!;
      this.pollStart = now;

      if (now - this.lastActivityTime > ASYNCH_TIMEOUT_MS) {
        if (this.eventsQueue.length > 0) {
          console.error('[Sim] RUŠÍM simuláciu - príliš dlhá odozva');
          this.onTimeout?.();
          this.stop();
          return false;
        }
        this.lastActivityTime = now;
      }

      if (this.steadyState) {
        this.bus.simulationProcessingStarts();
        this.steadyState = false;
      }

      try {
        event.process(gatesToUpdate);
        gatesToUpdate.forEach((g) => g.simulate());
        gatesToUpdate.clear();
        this.lastActivityTime = this.clock.now();
        if (this.eventsQueue.length === 0) {
          this.bus.dataInSteadyState();
          this.steadyState = true;
          this.pollStart = this.clock.now();
        }
      } catch (e) {
        console.error(e);
        gatesToUpdate.clear();
      }
    }
    return false;
  }
}
