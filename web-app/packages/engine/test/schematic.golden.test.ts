/**
 * Schematic golden parity: for every scenario recorded from the ORIGINAL Java simulator
 * (tools/golden-harness/src/SchematicGolden.java):
 *  1. loading the `.schx` and saving it again must reproduce the Java round-trip file byte for byte;
 *  2. replaying the scripted actions (switches, CPU bus cycles, keys, waits, wire edits) on the loaded
 *     sheet must produce identical snapshots (bus values, every pin's net value, LED / register /
 *     7-segment state, and after a wire edit the saved `.schx` text).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Bus, JavaRandom, schematic } from '../src';

const { SchematicSheet, loadScheme, saveScheme, Input, PushButton, MatrixKeyboard, Led, Register8, SevenSegmentDisplay, Wire } =
  schematic;
type Sheet = InstanceType<typeof SchematicSheet>;
type WireT = InstanceType<typeof Wire>;
type PinT = InstanceType<typeof schematic.Pin>;

/** SchematicController.GRID_SIZE in 0.9.4. */
const GRID = 10;
const EDIT_OPS = new Set(['wire', 'branch', 'drag', 'dragRelease', 'deleteWire']);

const DIR = join(__dirname, 'golden-schematic');

/**
 * Scenarios whose recorded values are not reproducible even by the original (a shorted net takes
 * a Math.random() value and the original simulates affected gates in java.util.HashSet order -
 * identity hash codes, different on every JVM run). For these only deterministic aspects are
 * compared: net membership of every pin and the number of random draws after each step.
 * None since the 0.9.4 scenarios avoid nets sharing a point.
 */
const NONDETERMINISTIC_IN_ORIGINAL: Record<string, string> = {};

function structuralOnly(snapshot: Record<string, unknown>): unknown {
  const gates = snapshot.gates as { id: string; pins: unknown[][] }[];
  return {
    rngState: snapshot.rngState,
    nets: gates.map((g) => ({ id: g.id, pins: g.pins.map((p) => [p[0], p[2]]) })),
  };
}
const scenarios = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

type Step = Record<string, unknown> & { op: string };

class FakeClock {
  t = 1_700_000_000_000;
  now = () => this.t;
}

function setup(name: string) {
  const clock = new FakeClock();
  const fixture = JSON.parse(readFileSync(join(DIR, name + '.json'), 'utf8'));
  const bus = new Bus(new JavaRandom(BigInt(fixture.seed)), clock);
  bus.reset();
  const sheet = new SchematicSheet(5000, 5000, GRID, bus, clock);
  const text = readFileSync(join(DIR, name + '.schx'), 'utf8');
  const loaded = loadScheme(text, sheet);
  sheet.settle(); // runLater work posted by the loader (junction reconcile) - runs before anything else
  return { clock, fixture, bus, sheet, loaded };
}

function pinOf(sheet: Sheet, ref: unknown): PinT {
  const [id, index] = ref as [string, number];
  return sheet.getGates().find((g) => g.getId() === id)!.getPins()[index];
}

/** Same wire construction as the harness: connect both ends, then settle like a finished drag. */
function wire(sheet: Sheet, a: PinT | InstanceType<typeof schematic.WireJunction>, b: PinT): WireT {
  const w = new Wire(sheet);
  sheet.addItem(w);
  w.getEnds()[0].connect(a);
  w.getEnds()[1].connect(b);
  w.settleToGrid();
  return w;
}

/** Harness `branch`: split the longest wire of the trunk's chain at its middle, wire to `to`. */
function branch(sheet: Sheet, trunk: WireT, to: PinT): void {
  const chain = [trunk];
  const queue = [trunk];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const end of current.getEnds()) {
      const j = end.getJunction();
      if (j === null || j.getConnectedWires().length !== 2) continue;
      for (const n of j.getConnectedWires()) {
        if (!chain.includes(n)) {
          chain.push(n);
          queue.push(n);
        }
      }
    }
  }
  let best = chain[0];
  let bestLen = -1;
  for (const w of chain) {
    const len = w.getEnds()[0].getConnectionPoint().distance(w.getEnds()[1].getConnectionPoint());
    if (len > bestLen) {
      bestLen = len;
      best = w;
    }
  }
  const p0 = best.getEnds()[0].getConnectionPoint();
  const p1 = best.getEnds()[1].getConnectionPoint();
  const j = best.splitAtPoint(new schematic.Point2D((p0.x + p1.x) / 2, (p0.y + p1.y) / 2));
  if (j === null) throw new Error('split failed');
  wire(sheet, j, to);
}

/** Run the simulation until the queue is empty and the bus reports steady state. */
function settle(sheet: InstanceType<typeof SchematicSheet>, clock: FakeClock) {
  for (let guard = 0; guard < 100000; guard++) {
    sheet.simulator.runSlice(Infinity);
    if (!sheet.isSimulationRunning() || sheet.simulator.queueSize() === 0) return;
  }
  throw new Error('simulation did not settle');
}

/** Advance the clock in 1 ms steps, running the loop (idle passes every 5 ms). */
function advance(sheet: InstanceType<typeof SchematicSheet>, clock: FakeClock, ms: number) {
  for (let i = 0; i < ms; i++) {
    clock.t += 1;
    sheet.simulator.runSlice(Infinity);
  }
}

describe('schematic golden parity with the Java simulator', () => {
  test.each(scenarios)('%s: load + save reproduces the Java round-trip file', (name) => {
    const { sheet, loaded, fixture } = setup(name);
    expect(loaded).toBe(fixture.loaded);
    const expected = readFileSync(join(DIR, name + '.roundtrip.schx'), 'utf8');
    expect(saveScheme(sheet)).toBe(expected);
  });

  test.each(scenarios)('%s: scripted simulation matches', (name) => {
    const { clock, fixture, bus, sheet } = setup(name);
    const rng = new JavaRandom(BigInt(fixture.mathRandomSeed));
    schematic.setElectricalRandom(rng);
    const gate = (id: unknown) => sheet.getGates().find((g) => g.getId() === id)!;

    const snapshots: unknown[] = [];
    for (const step of fixture.steps as Step[]) {
      let result: number | undefined;
      switch (step.op) {
        case 'power':
          sheet.powerOn();
          advance(sheet, clock, 20);
          break;
        case 'setOn':
          (gate(step.gate) as InstanceType<typeof Input>).setOn(step.value as boolean);
          break;
        case 'button':
          (gate(step.gate) as InstanceType<typeof PushButton>).setPressedState(step.value as boolean);
          break;
        case 'press':
          (gate(step.gate) as InstanceType<typeof MatrixKeyboard>).setPressed(step.row as number, step.col as number);
          break;
        case 'release':
          (gate(step.gate) as InstanceType<typeof MatrixKeyboard>).releasePressed(step.row as number, step.col as number);
          break;
        case 'address':
          bus.setAddressBus(step.addr as number);
          break;
        case 'cpuWrite': {
          const io = step.io as boolean;
          bus.setAddressBus(step.addr as number);
          bus.setDataBus(step.data as number);
          if (io) bus.setIW_(false);
          else bus.setMW_(false);
          settle(sheet, clock);
          if (io) bus.setIW_(true);
          else bus.setMW_(true);
          settle(sheet, clock);
          bus.setRandomData();
          bus.setRandomAddress();
          break;
        }
        case 'cpuRead': {
          const io = step.io as boolean;
          bus.setAddressBus(step.addr as number);
          if (io) bus.setIR_(false);
          else bus.setMR_(false);
          settle(sheet, clock);
          result = bus.getDataBus() & 0xff;
          if (io) bus.setIR_(true);
          else bus.setMR_(true);
          bus.setRandomData();
          bus.setRandomAddress();
          break;
        }
        case 'wait':
          advance(sheet, clock, step.ms as number);
          break;
        case 'wire':
          wire(sheet, pinOf(sheet, step.from), pinOf(sheet, step.to));
          break;
        case 'branch':
          branch(sheet, pinOf(sheet, step.from).getWireEnd()!.getWire(), pinOf(sheet, step.to));
          break;
        case 'drag':
          sheet.beginComponentDrag();
          gate(step.gate).moveTo(step.gx as number, step.gy as number);
          break;
        case 'dragRelease':
          sheet.releaseGate(gate(step.gate));
          break;
        case 'deleteWire':
          pinOf(sheet, step.at).getWireEnd()!.getWire().delete();
          break;
        default:
          throw new Error('unknown op ' + step.op);
      }
      sheet.settle();
      settle(sheet, clock);

      const nets = new Map<unknown, number>();
      const netOf = (root: unknown) => {
        if (!nets.has(root)) nets.set(root, nets.size);
        return nets.get(root)!;
      };
      const snap: Record<string, unknown> = {
        address: bus.getAddressBus() & 0xffff,
        data: bus.getDataBus() & 0xff,
        control: bus.getControlBus(),
        gates: sheet.getGates().map((g) => {
          const gm: Record<string, unknown> = {
            id: g.getId(),
            pins: g.getPins().map((p) => [p.getName(), p.getPotential()?.getValue() ?? 'null', netOf(p.getPotential())]),
          };
          if (g instanceof Led) gm.lit = g.isLit();
          if (g instanceof Register8) gm.latch = g.getLatch();
          if (g instanceof SevenSegmentDisplay) {
            gm.segments = g.getLitSegments();
            gm.powered = g.isPowered();
          }
          return gm;
        }),
      };
      if (result !== undefined) snap.result = result;
      if (EDIT_OPS.has(step.op)) snap.schx = saveScheme(sheet);
      snap.rngState = rng.getState().toString();
      snapshots.push(snap);
    }
    sheet.powerOff();

    const diffs: string[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      let expected = fixture.snapshots[i];
      let actual = snapshots[i];
      if (name in NONDETERMINISTIC_IN_ORIGINAL) {
        expected = structuralOnly(expected);
        actual = structuralOnly(actual as Record<string, unknown>);
      } else {
        // the number of transient random draws during CPU bus cycles depends on real-time thread
        // interleaving in the original (CPU thread enqueues while the simulation thread runs);
        // settled values are deterministic and compared in full
        expected = { ...expected, rngState: undefined };
        actual = { ...(actual as object), rngState: undefined };
      }
      deepDiff(expected, actual, `step ${i} (${JSON.stringify((fixture.steps as Step[])[i])})`, diffs);
    }
    expect(diffs.slice(0, 25)).toEqual([]);
  });
});

function deepDiff(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) {
    if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    return;
  }
  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
    const label = Array.isArray(expected) && Array.isArray(e[k]) && typeof (e[k] as unknown[])[0] === 'string'
      ? `${path}.${(e[k] as unknown[])[0]}` : (k === 'id' ? path : `${path}.${k}`);
    deepDiff(e[k], a[k], (e as { id?: string }).id ? `${path}[${(e as { id?: string }).id}].${k}` : label, out);
  }
}
