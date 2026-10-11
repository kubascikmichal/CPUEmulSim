/**
 * The single engine instance of the application. Lives in the CPU window; the schematic window
 * is rendered by this same JavaScript realm into its own document (see schematic/mount.tsx).
 */
import { CpuSession, Scheduler } from '@cpuemul/engine';

export interface Runtime {
  session: CpuSession;
  scheduler: Scheduler;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime === null) {
    const session = new CpuSession({
      onInterruptError: (message) => interruptErrorHandler?.(message),
    });
    const scheduler = new Scheduler(session);
    runtime = { session, scheduler };
  }
  return runtime;
}

let interruptErrorHandler: ((message: string) => void) | null = null;

/** Alert `Chyba / Chyba prerušenia / <message>` shown by the CPU window. */
export function setInterruptErrorHandler(handler: (message: string) => void): void {
  interruptErrorHandler = handler;
}
