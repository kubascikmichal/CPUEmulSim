/**
 * Golden-master parity: replays every fixture recorded from the ORIGINAL Java engine
 * (tools/golden-harness) against the TypeScript port and requires identical results:
 * parse outcome, program structure, and - per halt - registers, flags, RAM/stack changes,
 * bus events, console output, state and status message.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Bus, Cpu, InvalidCodeLinesException, JavaRandom, parse, type CpuKey, type Program } from '../src';

const GOLDEN = join(__dirname, 'golden');
const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).sort();
const MAX_HALTS = 5000;
const CLOCK_BASE = 1_700_000_000_000; // Java uses epoch millis; the warning rate limit compares to 0

interface Halt {
  state: string;
  message: string | null;
  pc: number; a: number; b: number; c: number; d: number; sp: number; mp: number;
  cy: boolean; z: boolean; ie: boolean;
  ram: [number, number][];
  stack: [number, number][];
  bus: [string, number][];
  console: [string, number | number[]][];
  t?: number;
}

interface Run {
  microstep: boolean;
  intLevel: boolean;
  seed: number;
  halts: Halt[];
  endReason: string;
}

interface Fixture {
  code: string;
  parse: {
    ok: boolean;
    exception?: string;
    errorLines?: number[];
    errors?: string[];
    program?: unknown;
  };
  runs: Run[];
}

function describeProgram(program: Program) {
  const instructions: unknown[] = [];
  for (let i = 0; ; i++) {
    const inst = program.getInstruction(i);
    if (inst === null) break;
    instructions.push([inst.type, inst.firstParameter, inst.secondParameter]);
  }
  const sortedObject = (m: Map<number, number>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
  return {
    instructions,
    memory: program.getMemory(),
    lineToInstruction: sortedObject(program.lineIndexToInstructionIndex),
    interruptLabels: sortedObject(program.interruptionLabels),
    hasIO: program.hasIOInstruction(),
  };
}

function keysFor(name: string): string[][] {
  try {
    return readFileSync(join(__dirname, 'corpus', name + '.keys'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => {
        const parts = l.split(' ');
        return parts[0] === 'breaks' ? parts : [parts[0], parts[1], parts.slice(2).join(' ')];
      });
  } catch {
    return [];
  }
}

function keyEvent(key: string[]): CpuKey {
  const codes: Record<string, number> = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
  if (key[1] === 'arrow') return { kind: 'arrow', code: codes[key[2]] };
  const ch = key[2] === 'space' ? ' ' : key[2] === 'enter' ? '\r' : key[2];
  return { kind: 'typed', character: ch };
}

function splitScript(script: string[][]) {
  let mode = 'auto';
  const breakLines: number[] = [];
  const keys: string[][] = [];
  for (const line of script) {
    if (line[0] === 'mode') mode = line[1];
    else if (line[0] === 'breaks') breakLines.push(...line.slice(1).join(' ').split(' ').map(Number));
    else keys.push(line);
  }
  return { mode, breakLines: [...new Set(breakLines)].sort((a, b) => a - b), keys };
}

function replay(program: Program, expected: Run, keys: string[][], breakLines: number[]): Run {
  program.setBreakpointLines(breakLines);
  let now = CLOCK_BASE;
  const clock = { now: () => now };
  const bus = new Bus(new JavaRandom(BigInt(expected.seed)), clock);
  bus.reset();

  const busEvents: [string, number][] = [];
  bus.addressBus.addListener((_, v) => busEvents.push(['A', v]));
  bus.dataBus.addListener((_, v) => busEvents.push(['D', v]));
  bus.controlBus.addListener((_, v) => busEvents.push(['C', v]));

  const consoleOut: [string, number | number[]][] = [];
  const cpu = new Cpu(
    {
      write: (b) => consoleOut.push(['i', b]),
      writeBytes: (bytes) => consoleOut.push(['a', bytes]),
    },
    bus,
    clock,
  );
  cpu.start();
  cpu.setIntLevel(expected.intLevel);
  cpu.setMicrostep(expected.microstep);
  cpu.run();
  expect(cpu.getState()).toBe('Idle');

  busEvents.length = 0;
  cpu.reset();
  cpu.loadProgram(program);
  cpu.startExecute(true);

  const halts: Halt[] = [];
  const prevRam = new Int8Array(256);
  const prevStack = new Int8Array(65536);
  let keyIndex = 0;
  let endReason = 'limit';
  const nextKey = (when: string) => (keyIndex < keys.length && keys[keyIndex][0] === when ? keys[keyIndex] : null);
  const diff = (now: Int8Array, prev: Int8Array) => {
    const changes: [number, number][] = [];
    for (let i = 0; i < now.length; i++) {
      if (now[i] !== prev[i]) {
        changes.push([i, now[i] & 0xff]);
        prev[i] = now[i];
      }
    }
    return changes;
  };

  const snapshot = (): Halt => ({
    state: cpu.getState(),
    message: cpu.getMessage(),
    pc: cpu.getRegPC() & 0xffff,
    a: cpu.getRegA() & 0xff,
    b: cpu.getRegB() & 0xff,
    c: cpu.getRegC() & 0xff,
    d: cpu.getRegD() & 0xff,
    sp: cpu.getRegSP() & 0xffff,
    mp: cpu.getRegMP() & 0xffff,
    cy: cpu.isFlagCY(),
    z: cpu.isFlagZ(),
    ie: cpu.isFlagIE(),
    ram: diff(cpu.getRAM(), prevRam),
    stack: diff(cpu.getStack(), prevStack),
    bus: busEvents.splice(0),
    console: consoleOut.splice(0),
  });

  for (let halt = 0; halt < MAX_HALTS; halt++) {
    now = CLOCK_BASE + (expected.halts[halt]?.t ?? expected.halts[expected.halts.length - 1]?.t ?? 0);
    cpu.run();
    const state = cpu.getState();
    halts.push(snapshot());

    if (state === 'Idle') {
      endReason = 'idle';
      break;
    }
    if (state === 'Waiting') {
      const key = nextKey('wait');
      if (key === null) {
        endReason = 'waiting-no-key';
        cpu.stopExecute();
        cpu.run();
        halts.push(snapshot());
        break;
      }
      keyIndex++;
      cpu.setKeyPressed(keyEvent(key));
      continue;
    }
    let controlled = false;
    let scheduled: string[] | null;
    while ((scheduled = nextKey('@' + halt)) !== null) {
      keyIndex++;
      if (scheduled[1] === 'stop') {
        cpu.stopExecute();
        controlled = true;
      } else if (scheduled[1] === 'continue') {
        cpu.continueExecute();
        controlled = true;
      } else {
        cpu.setKeyPressed(keyEvent(scheduled));
      }
    }
    if (!controlled) cpu.step();
  }
  if (endReason === 'limit') cpu.stopExecute();
  cpu.cancel();

  return { microstep: expected.microstep, intLevel: expected.intLevel, seed: expected.seed, halts, endReason };
}

describe('golden parity with the Java engine', () => {
  test.each(files)('%s', (file) => {
    const name = file.replace(/\.json$/, '');
    const fixture: Fixture = JSON.parse(readFileSync(join(GOLDEN, file), 'utf8'));

    const lines = fixture.code.split('\n').length;
    const result = parse(fixture.code, lines);

    expect(result.ok).toBe(fixture.parse.ok);
    if (!result.ok) {
      expect(result.error.name).toBe(fixture.parse.exception);
      if (result.error instanceof InvalidCodeLinesException) {
        expect(result.error.lines).toEqual(fixture.parse.errorLines);
        expect(result.error.errors).toEqual(fixture.parse.errors);
      }
      return;
    }
    expect(describeProgram(result.program)).toEqual(fixture.parse.program);

    const { mode, breakLines, keys } = splitScript(keysFor(name));
    const expectedRuns = (mode === 'micro' ? [true] : mode === 'auto' && result.program.hasIOInstruction() ? [false, true] : [false]);
    expect(fixture.runs.map((r) => r.microstep)).toEqual(expectedRuns);
    expect(fixture.runs.length).toBeGreaterThan(0);
    for (const expectedRun of fixture.runs) {
      const actual = replay(result.program, expectedRun, keys, breakLines);
      const strip = (r: Run) => ({ ...r, halts: r.halts.map(({ t: _t, ...h }) => h) });
      expect(strip(actual)).toEqual(strip(expectedRun));
    }
  });
});
