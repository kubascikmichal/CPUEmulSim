import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Bus, JavaRandom, schematic } from '../src';

const { SchematicSheet, loadScheme, saveScheme, WIRE_COLOR_CHOICES } = schematic;
const DIR = join(__dirname, 'golden-schematic');
const RED = '#FF0000';
const BLUE = '#0000FF';

function load(name: string) {
  const clock = { now: () => 1_700_000_000_000 };
  const bus = new Bus(new JavaRandom(1n), clock);
  bus.reset();
  const sheet = new SchematicSheet(5000, 5000, 10, bus, clock);
  loadScheme(readFileSync(join(DIR, name + '.schx'), 'utf8'), sheet);
  sheet.settle();
  return sheet;
}

const names = readdirSync(DIR).filter((f) => f.endsWith('.schx') && !f.includes('roundtrip')).map((f) => f.slice(0, -5));

describe('wire colour (context menu "Farba vodiča")', () => {
  test('menu offers the wire colours', () => {
    expect(WIRE_COLOR_CHOICES.map(([label]) => label)).toEqual(['Čierna', 'Červená', 'Zelená', 'Modrá', 'Žltá', 'Oranžová', 'Šedá']);
  });

  test('colours the whole chain through bends and nothing else', () => {
    let multiSegment = 0;
    for (const name of names) {
      const sheet = load(name);
      for (const wire of sheet.getWires()) {
        for (const w of sheet.getWires()) w.changeColor('#000000');
        const chain = new Set(wire.collectChain());
        if (chain.size > 1) multiSegment++;
        wire.setChainColor(RED);
        for (const w of sheet.getWires()) expect(w.getColor()).toBe(chain.has(w) ? RED : '#000000');
      }
    }
    expect(multiSegment).toBeGreaterThan(0); // the corpus has wires with bends
  });

  test('a selected wire colours every selected wire', () => {
    const sheet = load('junction_fanout');
    const wires = sheet.getWires();
    const a = wires[0];
    const b = wires.find((w) => !a.collectChain().includes(w))!;
    sheet.clearSelect();
    sheet.addSelect(a);
    sheet.addSelect(b);
    a.setChainColor(BLUE);
    for (const w of [...a.collectChain(), ...b.collectChain()]) expect(w.getColor()).toBe(BLUE);
  });

  test('the colour survives save and load', () => {
    const sheet = load('junction_fanout');
    const wire = sheet.getWires()[0];
    wire.setChainColor(BLUE);
    const expected = sheet.getWires().filter((w) => w.getColor() === BLUE).length;
    const clock = { now: () => 1_700_000_000_000 };
    const bus = new Bus(new JavaRandom(1n), clock);
    bus.reset();
    const reloaded = new SchematicSheet(5000, 5000, 10, bus, clock);
    loadScheme(saveScheme(sheet), reloaded);
    reloaded.settle();
    expect(reloaded.getWires().filter((w) => w.getColor() === BLUE).length).toBe(expected);
  });
});
