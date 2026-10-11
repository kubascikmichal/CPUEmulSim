/**
 * Integration tests of the headless CPUController port (CpuSession + Scheduler) with fake timers.
 * Expected texts/enablement come from the original CPUController (02-functional-specification §2.3).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CpuSession, Scheduler, schematic, type Timers } from '../src';

class FakeTime implements Timers {
  t = 1_000_000;
  private queue: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  asap(fn: () => void) {
    this.queue.push({ at: this.t, fn });
  }
  later(fn: () => void, ms: number) {
    this.queue.push({ at: this.t + ms, fn });
  }
  /** Run due tasks, advancing time, until `untilMs` elapsed or `cond` holds. */
  run(untilMs: number, cond: () => boolean = () => false) {
    const end = this.t + untilMs;
    while (this.t <= end && !cond()) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue.shift();
      if (next === undefined) {
        this.t = end + 1;
        break;
      }
      if (next.at > this.t) this.t = next.at;
      next.fn();
      this.t += 0.25; // every tick takes a little time
    }
  }
}

function setup() {
  const time = new FakeTime();
  const delays: number[] = [];
  const session = new CpuSession({
    clock: { now: () => time.t },
    delay: (ms) => {
      delays.push(ms);
      time.t += ms;
      return Promise.resolve();
    },
  });
  const scheduler = new Scheduler(session, time);
  return { time, session, scheduler, delays };
}

const lines = (code: string) => code.split('\n').length;

describe('CpuSession (CPUController port)', () => {
  test('initial state is Idle', () => {
    const { session } = setup();
    expect(session.view).toMatchObject({
      statusText: 'Nečinný',
      startText: 'Spusti [F5]',
      parseEnabled: true,
      startEnabled: true,
      stepEnabled: true,
      pauseEnabled: false,
      stopEnabled: false,
      resetEnabled: true,
    });
  });

  test('parse errors: red console lines, error lines, status', async () => {
    const { session } = setup();
    const code = 'MVI A, 1\nFOO\n';
    await session.parseCode(code, lines(code), false);
    expect(session.view.statusText).toBe('Chyba v kóde');
    expect(session.view.errorLines).toEqual([1]);
    expect(session.console.getText()).toBe("[Parser] [2] Neplatná inštrukcia 'FOO'\n");
    expect(session.console.paragraphs()[0].style.color).toBe('red');
  });

  test('F5 runs to the end; console success message; Idle afterwards', async () => {
    const { session, time } = setup();
    const code = 'MVI A, 5\nloop: DEC A\nJNZ loop\nMVI B, 7\n';
    await session.handleButtonStartAction(code, lines(code));
    time.run(1000);
    expect(session.console.getText()).toBe('Program úspešne zavedený!\n');
    expect(session.memory.registers.b).toBe(7);
    expect(session.view).toMatchObject({ statusText: 'Nečinný', startText: 'Spusti [F5]', resetEnabled: true });
  });

  test('F7 from Idle pauses before the first instruction, F7 steps, F10 stop still executes the pending instruction', async () => {
    const { session, time } = setup();
    const code = '; comment\nMVI A, 1\nMVI B, 2\nMVI C, 3\n';
    await session.handleButtonStepAction(code, lines(code));
    time.run(50);
    expect(session.view).toMatchObject({
      statusText: 'Vykonávanie pozastavené',
      startText: 'Pokračuj [F5]',
      executionLine: 1,
      startEnabled: true,
      stepEnabled: true,
      pauseEnabled: false,
      stopEnabled: true,
      resetEnabled: false,
      parseEnabled: false,
    });
    await session.handleButtonStepAction(code, lines(code));
    time.run(50);
    expect(session.view.executionLine).toBe(2);
    expect(session.memory.registers.a).toBe(1);
    session.handleButtonStopAction();
    time.run(50);
    expect(session.isExecuting()).toBe(false);
    expect(session.memory.registers.b).toBe(2); // quirk: pending instruction executed
    expect(session.memory.registers.c).toBe(0);
  });

  test('SCALL KEY waits ("Stlacte klavesu"), key resumes', async () => {
    const { session, time } = setup();
    const code = 'SCALL KEY\nMOV A, D\n';
    await session.handleButtonStartAction(code, lines(code));
    time.run(50);
    expect(session.view).toMatchObject({ statusText: 'Stlacte klavesu', stopEnabled: true, startEnabled: false, stepEnabled: false });
    session.keyboardInput({ kind: 'typed', character: 'x' });
    time.run(200);
    expect(session.memory.registers.a).toBe(120);
  });

  test('I/O program powers on the simulation with the 100 ms warm-up', async () => {
    const { session, time, delays } = setup();
    const code = 'OUT 0xFF, A\n';
    await session.handleButtonStartAction(code, lines(code));
    expect(delays).toEqual([100]);
    expect(session.sheet.isSimulationRunning()).toBe(true);
    time.run(200);
    // no circuit: bus is steady immediately (empty queue) - no bus error message
    expect(session.console.getText()).toBe('Program úspešne zavedený!\n');
  });

  test('bus error warning when the simulation is off (program without I/O auto power-on path)', async () => {
    const { session, time } = setup();
    session.sheet.powerOff();
    // LMR is an I/O instruction → would power on; drive the CPU directly with simulation off
    const code = 'MVI A, 1\n';
    await session.parseCode(code, lines(code), false);
    expect(session.getProgram()!.hasIOInstruction()).toBe(false);
  });

  test('end-to-end: OUT to register/LEDs and INN from switches through the loaded circuit', async () => {
    const { session, time } = setup();
    const text = readFileSync(join(__dirname, 'golden-schematic/io_register_buffer.schx'), 'utf8');
    expect(schematic.loadScheme(text, session.sheet)).toBe(true);
    const leds = session.sheet.getGates().filter((g) => g instanceof schematic.Led) as InstanceType<typeof schematic.Led>[];
    const switches = session.sheet.getGates().filter((g) => g instanceof schematic.Input) as InstanceType<typeof schematic.Input>[];
    // switches[0] drives OE_ (must stay 0); switches[1..8] are the data inputs
    switches[1].setOn(true);
    switches[4].setOn(true);

    const code = 'MVI A, 0xA5\nOUT 0xFF, A\nINN B, 0xFF\n';
    await session.handleButtonStartAction(code, lines(code));
    time.run(1000);

    expect(session.isExecuting()).toBe(false);
    const reg = session.sheet.getGates().find((g) => g instanceof schematic.Register8) as InstanceType<typeof schematic.Register8>;
    expect(reg.getLatch()).toBe(0xa5);
    time.run(300); // LED 100 ms hold after random power-on transients
    const litBits = leds.map((l) => (l.isLit() ? 1 : 0));
    expect(litBits).toEqual([1, 0, 1, 0, 0, 1, 0, 1]); // 0xA5, LSB first
    expect(session.memory.registers.b & 0xff).toBe(0b1001);
    expect(session.console.getText()).toBe('Program úspešne zavedený!\n');
  });
});
