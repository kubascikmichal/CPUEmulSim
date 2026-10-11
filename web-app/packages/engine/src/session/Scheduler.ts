/**
 * Cooperative scheduler replacing the original threads: CPU thread, simulation thread,
 * console flushing (`fxWriteThrottle` runLater) and the GUI update service.
 *
 * Each tick runs CPU and simulation slices for at most {@link SLICE_MS}, flushes the console once
 * (max 15 ms, as the original) and refreshes the GUI every "Interval obnovy GUI" ms while a
 * program runs unpaused. When nothing can progress the scheduler sleeps until {@link wake}.
 */
import type { CpuSession } from './CpuSession';

export const SLICE_MS = 8;

export interface Timers {
  now(): number;
  /** Run soon (next macrotask). */
  asap(fn: () => void): void;
  /** Run after `ms`. */
  later(fn: () => void, ms: number): void;
}

export const browserTimers: Timers = {
  now: () => performance.now(),
  asap: (() => {
    if (typeof MessageChannel === 'undefined') return (fn: () => void) => setTimeout(fn, 0);
    const channel = new MessageChannel() as unknown as {
      port1: { onmessage: (() => void) | null };
      port2: { postMessage(message: number): void };
    };
    const queue: (() => void)[] = [];
    channel.port1.onmessage = () => queue.shift()?.();
    return (fn: () => void) => {
      queue.push(fn);
      channel.port2.postMessage(0);
    };
  })(),
  later: (fn, ms) => setTimeout(fn, ms),
};

export class Scheduler {
  private scheduled = false;
  private stopped = false;
  private lastGuiUpdate = 0;

  /** "Povoliť aktualizáciu GUI" */
  allowUpdateGUI = true;
  /** "Interval obnovy GUI" (ms, 10–150) */
  guiUpdateInterval = 150;

  constructor(
    private readonly session: CpuSession,
    private readonly timers: Timers = browserTimers,
  ) {
    session.wake = () => this.wake();
    session.sheet.subscribe(() => this.wake());
    session.sheet.simulator.onRunningChange(() => this.wake());
  }

  wake(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    this.timers.asap(() => this.tick());
  }

  stop(): void {
    this.stopped = true;
  }

  /** One scheduling round (public for tests). */
  tick(): void {
    this.scheduled = false;
    if (this.stopped) return;

    const { session } = this;
    const sim = session.sheet.simulator;
    const deadline = this.timers.now() + SLICE_MS;

    for (;;) {
      const simMore = sim.isRunning() ? sim.runSlice(session.clock.now() + SLICE_MS) : false;
      const cpuMore = session.cpu.run(Infinity, session.clock.now() + SLICE_MS);
      if (this.timers.now() >= deadline) break;
      if (!cpuMore && !simMore) {
        if (session.cpu.isWaitingForSteadyState() && sim.queueSize() > 0) continue;
        break;
      }
    }

    if (session.cosCpu.hasPending()) session.cosCpu.flush();

    const now = this.timers.now();
    if (this.allowUpdateGUI && session.isRunningUnpaused() && now - this.lastGuiUpdate >= this.guiUpdateInterval) {
      this.lastGuiUpdate = now;
      session.updateGUI();
    }

    // decide when to run again
    const cpuRunnable =
      session.cpu.blockedOn?.kind === 'tick' || (session.cpu.isWaitingForSteadyState() && sim.queueSize() > 0);
    if (cpuRunnable || session.cosCpu.hasPending()) {
      this.scheduled = true;
      this.timers.asap(() => this.tick());
    } else if (sim.isRunning() || session.cpu.isWaitingForSteadyState() || session.isRunningUnpaused()) {
      // idle passes of the simulation (5 ms), steady-state wait, GUI refresh cadence
      this.scheduled = true;
      this.timers.later(() => this.tick(), 2);
    }
  }
}
