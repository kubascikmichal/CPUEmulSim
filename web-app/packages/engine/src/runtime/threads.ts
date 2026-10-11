/**
 * Cooperative replacement for the Java threads of the original engine.
 *
 * A Java thread body becomes a generator; every point where the Java thread could block
 * (CountDownLatch.await, Semaphore.acquire, Object.wait) becomes a `yield` of a {@link Block}.
 * The scheduler resumes the generator when the blocking condition is satisfied.
 * Java's interrupt flag is modelled by {@link ThreadContext}.
 */
import { InterruptedException } from '../util/java';

export type Block =
  /** Free-running slice point between two instructions (no Java equivalent - time slicing only). */
  | { kind: 'tick' }
  /** Blocked in CountDownLatch.await (pause / step / micro-step / idle). */
  | { kind: 'halt'; latch: Latch }
  /** Blocked in Semaphore.acquire waiting for a key (SCALL KEY). */
  | { kind: 'key' }
  /** Blocked in Bus.waitForSteadyState waiting for the simulation to settle. */
  | { kind: 'steady' };

export const TICK: Block = { kind: 'tick' };
export const STEADY: Block = { kind: 'steady' };

/** Java `Thread` interrupt status. */
export class ThreadContext {
  interrupted = false;

  /** `Thread.interrupt()` */
  interrupt(): void {
    this.interrupted = true;
  }

  /** What a blocking call does when the interrupt flag is set: clear it and throw. */
  throwIfInterrupted(): void {
    if (this.interrupted) {
      this.interrupted = false;
      throw new InterruptedException();
    }
  }
}

/** `java.util.concurrent.CountDownLatch(1)` */
export class Latch {
  released = false;
  countDown(): void {
    this.released = true;
  }
}
