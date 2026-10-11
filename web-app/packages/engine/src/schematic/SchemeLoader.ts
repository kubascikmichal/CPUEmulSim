/**
 * Port of `SchematicSim.Sheet.SchemeLoader` - `.schx` (XML, version "2.0") save/load.
 *
 * Gates are stored with their JAVA class names; {@link GATE_CLASSES} maps them both ways so files
 * stay interchangeable with the desktop application. Numbers are written with Java
 * `Double.toString` / `Integer.toString` formatting.
 */
import { AddressBus16, ControlBus, DataBus8 } from './buses/BusSymbol';
import { colorWeb } from './gates/colors';
import {
  AndGate, BusBuffer, Decoder38, Encoder83, Input, Led, MatrixKeyboard, NandGate, NorGate, NotGate,
  OrGate, PushButton, Ram8k, Register8, SevenSegmentDisplay, XorGate, type GateCtor,
} from './gates/gates';
import type { GateSymbol } from './gates/GateSymbol';
import { Point2D } from './geometry';
import type { Pin } from './Pin';
import { createGate, junctionKey, type SchematicSheet } from './Sheet';
import { Wire, WireJunction, type WireEnd } from './wire/Wire';
import { parseXml, serializeXml, XmlElement } from './xml';

const VERSION = '2.0';
const FORGIVEN_ID_PREFIX = 's';

const G = 'sk.uniza.fri.cp.SchematicSim.Gates.';
const B = 'sk.uniza.fri.cp.SchematicSim.Buses.';

/** Java fully-qualified class name → TypeScript class (explicit: class names are minified in builds). */
export const GATE_CLASSES = new Map<string, GateCtor>([
  [B + 'AddressBus16', AddressBus16],
  [B + 'DataBus8', DataBus8],
  [B + 'ControlBus', ControlBus],
  [G + 'Input', Input],
  [G + 'Led', Led],
  [G + 'PushButton', PushButton],
  [G + 'MatrixKeyboard', MatrixKeyboard],
  [G + 'SevenSegmentDisplay', SevenSegmentDisplay],
  [G + 'NotGate', NotGate],
  [G + 'AndGate', AndGate],
  [G + 'OrGate', OrGate],
  [G + 'NandGate', NandGate],
  [G + 'NorGate', NorGate],
  [G + 'XorGate', XorGate],
  [G + 'BusBuffer', BusBuffer],
  [G + 'Register8', Register8],
  [G + 'Ram8k', Ram8k],
  [G + 'Decoder38', Decoder38],
  [G + 'Encoder83', Encoder83],
]);

/** Java `Double.toString(double)` for the values occurring in files (pixel coordinates). */
export function javaDoubleToString(d: number): string {
  if (Number.isNaN(d)) return 'NaN';
  if (d === Infinity) return 'Infinity';
  if (d === -Infinity) return '-Infinity';
  if (d === 0) return Object.is(d, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(d);
  if (abs >= 1e-3 && abs < 1e7) {
    const s = String(d);
    return s.includes('.') ? s : s + '.0';
  }
  // computerized scientific notation: d.dddE±n
  const [mantissa, exp] = d.toExponential().split('e');
  const m = mantissa.includes('.') ? mantissa : mantissa + '.0';
  return m + 'E' + (exp.startsWith('+') ? exp.substring(1) : exp);
}

// ==================================================================== save

export function saveScheme(sheet: SchematicSheet): string {
  const root = new XmlElement('Scheme').setAttribute('ver', VERSION);

  const gatesElement = new XmlElement('Gates');
  for (const gate of sheet.getGates()) {
    const gateElement = new XmlElement('Gate').setAttribute('id', gate.getId() ?? '');
    gateElement.addContent(new XmlElement('class').addContent(gate.javaClassName));
    gateElement.addContent(new XmlElement('gridX').addContent(String(gate.getGridPosX())));
    gateElement.addContent(new XmlElement('gridY').addContent(String(gate.getGridPosY())));
    const propertiesElement = new XmlElement('properties');
    for (const [name, value] of gate.saveProperties()) {
      propertiesElement.addContent(new XmlElement('property').setAttribute('name', name).setAttribute('value', value));
    }
    gateElement.addContent(propertiesElement);
    gatesElement.addContent(gateElement);
  }
  root.addContent(gatesElement);

  const wiresElement = new XmlElement('Wires');
  for (const wire of sheet.getWires()) {
    const wireElement = new XmlElement('Wire').setAttribute('color', wire.getColor().toUpperCase());
    const [start, end] = wire.getEnds();
    appendWireEnd(wireElement, 'start', start);
    appendWireEnd(wireElement, 'end', end);
    wiresElement.addContent(wireElement);
  }
  root.addContent(wiresElement);

  return serializeXml(root);
}

function appendWireEnd(wireElement: XmlElement, name: string, end: WireEnd): void {
  const endElement = new XmlElement(name);
  const pin = end.getPin();
  const junction = end.getJunction();
  if (pin !== null) {
    endElement.addContent(new XmlElement('gateId').addContent(pin.getOwner().getId() ?? ''));
    endElement.addContent(new XmlElement('pinIndex').addContent(String(pin.getOwner().getPins().indexOf(pin))));
  } else if (junction !== null) {
    endElement.addContent(
      new XmlElement('junction')
        .addContent(new XmlElement('x').addContent(javaDoubleToString(junction.getLayoutX())))
        .addContent(new XmlElement('y').addContent(javaDoubleToString(junction.getLayoutY()))),
    );
  } else {
    endElement.addContent(new XmlElement('x').addContent(javaDoubleToString(end.getLayoutX())));
    endElement.addContent(new XmlElement('y').addContent(javaDoubleToString(end.getLayoutY())));
  }
  wireElement.addContent(endElement);
}

// ==================================================================== load

/** Exceptions the original `load` catches (→ returns false). Anything else propagates. */
class CaughtLoadError extends Error {}

/**
 * Loads a scheme into the sheet (clearing it first).
 * @returns true on success, false on the errors the original catches; other errors propagate
 */
export function loadScheme(text: string, sheet: SchematicSheet): boolean {
  try {
    let rootElement: XmlElement;
    try {
      rootElement = parseXml(text);
    } catch (e) {
      throw new CaughtLoadError(String(e));
    }
    if (rootElement.name.toLowerCase() !== 'scheme') return false;

    sheet.clearSheet();

    const gatesById = new Map<string, GateSymbol>();
    const gatesElement = rootElement.getChild('Gates');
    if (gatesElement !== null) {
      for (const gateElement of gatesElement.getChildren('Gate')) {
        const className = gateElement.getChildText('class');
        if (className === null) throw new CaughtLoadError('NullPointerException');
        const ctor = GATE_CLASSES.get(className);
        if (ctor === undefined) throw new CaughtLoadError('ClassNotFoundException: ' + className);
        const gate = createGate(ctor, sheet);

        const id = gateElement.getAttributeValue('id');
        gate.setId(id !== null && id.length > 0 ? id : FORGIVEN_ID_PREFIX + gatesById.size);
        sheet.addItem(gate);

        const gridX = javaParseInt(gateElement.getChildText('gridX'));
        const gridY = javaParseInt(gateElement.getChildText('gridY'));
        gate.moveTo(gridX, gridY);
        sheet.getOccupancy().occupy(gate);

        gate.loadProperties(readProperties(gateElement));
        gatesById.set(gate.getId()!, gate);
      }
    }

    const wiresElement = rootElement.getChild('Wires');
    if (wiresElement !== null) {
      const loadedWires: Wire[] = [];
      const pendingResolve: { wire: Wire; start: XmlElement | null; end: XmlElement | null }[] = [];
      const hubByKey = new Map<number, WireJunction>();
      for (const wireElement of wiresElement.getChildren('Wire')) {
        const entry = loadWire(sheet, wireElement, gatesById, loadedWires, hubByKey);
        if (entry.wire.areBothEndsConnected()) loadedWires.push(entry.wire);
        else pendingResolve.push(entry);
      }

      const stillPending: typeof pendingResolve = [];
      for (const entry of pendingResolve) {
        resolveJunctionEnd(entry.wire.getEnds()[0], entry.start, loadedWires, hubByKey);
        resolveJunctionEnd(entry.wire.getEnds()[1], entry.end, loadedWires, hubByKey);
        if (entry.wire.areBothEndsConnected()) loadedWires.push(entry.wire);
        else stillPending.push(entry);
      }
      for (const entry of stillPending) entry.wire.delete();
    }
  } catch (e) {
    if (e instanceof CaughtLoadError) {
      console.error(e);
      return false;
    }
    throw e;
  }
  return true;
}

function loadWire(
  sheet: SchematicSheet,
  wireElement: XmlElement,
  gatesById: Map<string, GateSymbol>,
  loadedWires: Wire[],
  hubByKey: Map<number, WireJunction>,
): { wire: Wire; start: XmlElement | null; end: XmlElement | null } {
  const startElement = wireElement.getChild('start');
  const endElement = wireElement.getChild('end');

  const wire = new Wire(sheet);
  sheet.addItem(wire);
  wire.changeColor(colorWeb(colorFromHex(wireElement.getAttributeValue('color'))));

  const [e0, e1] = wire.getEnds();
  connectPinEnd(e0, startElement, gatesById);
  connectPinEnd(e1, endElement, gatesById);

  resolveJunctionEnd(e0, startElement, loadedWires, hubByKey);
  resolveJunctionEnd(e1, endElement, loadedWires, hubByKey);

  return { wire, start: startElement, end: endElement };
}

function readProperties(gateElement: XmlElement): Map<string, string> {
  const properties = new Map<string, string>();
  const propertiesElement = gateElement.getChild('properties');
  if (propertiesElement !== null) {
    for (const p of propertiesElement.getChildren('property')) {
      const name = p.getAttributeValue('name');
      const value = p.getAttributeValue('value');
      if (name !== null) properties.set(name, value === null ? '' : value);
    }
  }
  return properties;
}

function findPin(endElement: XmlElement | null, gatesById: Map<string, GateSymbol>): Pin | null {
  if (endElement === null) return null;
  const gateId = endElement.getChildText('gateId');
  if (gateId === null) return null;
  const gate = gatesById.get(gateId);
  if (gate === undefined) return null;
  const idx = endElement.getChildText('pinIndex');
  if (idx === null || !/^[+-]?\d+$/.test(idx)) return null;
  const pinIndex = Number.parseInt(idx, 10);
  const pins = gate.getPins();
  return pinIndex >= 0 && pinIndex < pins.length ? pins[pinIndex] : null;
}

function connectPinEnd(end: WireEnd, endElement: XmlElement | null, gatesById: Map<string, GateSymbol>): void {
  if (endElement === null || end.isConnected()) return;
  const pin = findPin(endElement, gatesById);
  if (pin !== null && !pin.isOccupied()) end.connect(pin);
}

function resolveJunctionEnd(
  end: WireEnd,
  endElement: XmlElement | null,
  loadedWires: Wire[],
  hubByKey: Map<number, WireJunction>,
): boolean {
  if (endElement === null || end.isConnected()) return true;
  const junctionElement = endElement.getChild('junction');
  if (junctionElement === null) return false;

  let x: number;
  let y: number;
  try {
    x = javaParseDouble(junctionElement.getChildText('x'));
    y = javaParseDouble(junctionElement.getChildText('y'));
  } catch {
    return false;
  }

  const pos = new Point2D(x, y);
  const key = junctionKey(x, y);

  // the junction may already have been created by another end at the same point
  const shared = hubByKey.get(key);
  if (shared !== undefined && !shared.isRemoved()) {
    end.connect(shared);
    return true;
  }

  // an existing hub exactly at the point
  for (const loadedWire of loadedWires) {
    if (loadedWire === end.getWire()) continue;
    for (const other of loadedWire.getEnds()) {
      const existing = other.getJunction();
      if (existing !== null && junctionKey(existing.getLayoutX(), existing.getLayoutY()) === key) {
        hubByKey.set(key, existing);
        end.connect(existing);
        return true;
      }
    }
  }

  // a trunk wire only passes through the point - split it in two
  const grid = end.getSheet().getGrid().getSizeMin();
  for (const loadedWire of loadedWires) {
    if (loadedWire === end.getWire()) continue;
    if (loadedWire.distanceToPoint(pos) <= grid / 2.0) {
      const junction = loadedWire.splitAtPoint(pos);
      if (junction !== null) {
        hubByKey.set(key, junction);
        end.connect(junction);
        return true;
      }
    }
  }

  // no wire passes here: a standalone hub
  const standalone = WireJunction.at(end.getSheet(), x, y);
  hubByKey.set(key, standalone);
  end.connect(standalone);
  return true;
}

function colorFromHex(hex: string | null): string {
  return hex !== null && hex.startsWith('#') ? hex : '#000000';
}

/** `Integer.parseInt` - throws NumberFormatException (NOT caught by the original loader). */
function javaParseInt(s: string | null): number {
  if (s === null || !/^[+-]?\d+$/.test(s)) throw new Error('NumberFormatException: ' + s);
  return Number.parseInt(s, 10);
}

/** `Double.parseDouble` - null → NullPointerException (caught), bad text → NumberFormatException. */
function javaParseDouble(s: string | null): number {
  if (s === null) throw new CaughtLoadError('NullPointerException');
  const t = s.trim();
  if (!/^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[dDfF]?)$/.test(t)) {
    throw new Error('NumberFormatException: ' + s);
  }
  return Number.parseFloat(t.replace(/[dDfF]$/, ''));
}
