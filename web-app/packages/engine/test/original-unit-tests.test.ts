/**
 * Ports of the original JUnit tests (src/test/java/.../Gates/LedTest.java and
 * SevenSegmentDisplayTest.java, removed upstream in 0.9.4) plus the 0.9.4 LED timing rules
 * (commit 716b10b: lit while 1; off at once after the fall if lit >= 100 ms; a short pulse lights
 * it for 100 ms; every LOW->HIGH edge restarts the count).
 */
import { expect, test } from 'vitest';
import { Bus, schematic } from '../src';

const { SchematicSheet, createGate, Led, SevenSegmentDisplay } = schematic;

function sheet() {
  return new SchematicSheet(5000, 5000, 10, new Bus());
}

test('LED stays lit while the input is 1, longer than 100 ms', () => {
  const led = createGate(Led, sheet());
  led.applyInputState(true, 0);
  led.applyInputState(true, 500);
  expect(led.isLit()).toBe(true);
});

test('LED lit >= 100 ms turns off immediately when the input falls', () => {
  const led = createGate(Led, sheet());
  led.applyInputState(true, 0);
  led.applyInputState(false, 100);
  expect(led.isLit()).toBe(false);
});

test('a short pulse keeps the LED lit until 100 ms after its rising edge', () => {
  const led = createGate(Led, sheet());
  led.applyInputState(true, 0);
  led.applyInputState(false, 10);
  expect(led.isLit(), 'still within 100 ms of the rising edge').toBe(true);
  led.applyInputState(false, 99);
  expect(led.isLit()).toBe(true);
  led.applyInputState(false, 100);
  expect(led.isLit()).toBe(false);
});

test('every LOW->HIGH edge restarts the 100 ms count', () => {
  const led = createGate(Led, sheet());
  led.applyInputState(true, 0);
  led.applyInputState(false, 50);
  led.applyInputState(true, 80);
  led.applyInputState(false, 120);
  expect(led.isLit(), '40 ms after the second edge').toBe(true);
  led.applyInputState(false, 180);
  expect(led.isLit()).toBe(false);
});

test('SevenSegmentDisplayTest.shouldUpdateSegmentStateImmediatelyWhenInputChanges', () => {
  const display = createGate(SevenSegmentDisplay, sheet());

  const enabled = Array<boolean>(8).fill(false);
  enabled[0] = true;
  display.applyLitState(enabled, false);
  expect(display.getLitSegments()[0], 'Segment should turn on immediately when enabled.').toBe(true);

  display.applyLitState(Array<boolean>(8).fill(false), false);
  expect(display.getLitSegments()[0], 'Segment should turn off immediately when the signal changes; there must be no forced delay.').toBe(false);
  expect(display.isCaHoldActive(), 'CA hold should not remain active after a normal input change.').toBe(false);
});
