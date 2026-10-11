/**
 * Ports of `SchematicSim.Buses.{BusSymbol, AddressBus16, DataBus8, ControlBus}` (model part).
 *
 * The three rail buses share the same rail/tap behaviour (taps created from a signal menu,
 * resizable rail, `Zmazať` on a tap); it is factored into {@link RailBus} here while each
 * subclass keeps its own bus communication exactly as in the original.
 */
import type { Bus, ChangeListener } from '../../bus/Bus';
import type { PotentialValue } from '../electrical/Potential';
import { GateSymbol } from '../gates/GateSymbol';
import { Side } from '../geometry';
import { Pin, type Direction } from '../Pin';
import type { Wire } from '../wire/Wire';

const PKG = 'sk.uniza.fri.cp.SchematicSim.Buses.';
const RAIL_WIDTH = 2;
const MIN_ROWS = 3;
const MAX_ROWS = 60;
/** Rail thickness relative to a cell. */
export const RAIL_THICKNESS = 0.45;

export abstract class BusSymbol extends GateSymbol {
  abstract syncFromBus(): void;
  abstract getBusLabel(): string;

  getBus(): Bus {
    return this.getSheet().bus;
  }

  override getName(): string {
    return this.getBusLabel();
  }
}

/** JavaFX named colours used by the rails. */
const DARKRED = '#8B0000';
const DARKGREEN = '#006400';
const DARKGOLDENROD = '#B8860B';

/**
 * `BusSymbol.tapDotColor`: light rail tint for 1, dark for 0, gray for High-Z
 * (JavaFX `Color.interpolate(WHITE|BLACK, 0.5)`).
 */
export function tapDotColor(railColor: string, value: PotentialValue): string {
  if (value === 'NC') return '#808080';
  const target = value === 'HIGH' ? 255 : 0;
  const channels = [1, 3, 5].map((i) => Number.parseInt(railColor.substring(i, i + 2), 16));
  const mixed = channels.map((c) => c + (target - c) * 0.5);
  return 'rgb(' + mixed.join(',') + ')';
}

/** `BusSymbol.valueOr`: the net value of the pin, or `fallback` while the net is High-Z. */
function valueOr(pin: Pin, fallback: PotentialValue): PotentialValue {
  const value = pin.getPotential()?.getValue() ?? 'NC';
  return value !== 'NC' ? value : fallback;
}

export interface TapPoint {
  readonly pin: Pin;
  /** bit (AB/DB) or signal index (CB) */
  bit: number;
}

export abstract class RailBus extends BusSymbol {
  protected rows: number;
  /** Row at which the drawn rail starts (0 = top edge of the component; may be negative). */
  protected topRow = 0;
  protected pinsRef: Pin[] = [];
  protected readonly taps: TapPoint[] = [];

  constructor(sheet: ConstructorParameters<typeof GateSymbol>[0], defaultRows: number) {
    super(sheet);
    this.rows = defaultRows;
  }

  /** Menu entry labels (index = bit / signal). */
  abstract signalNames(): readonly string[];
  abstract readonly railColor: string;
  protected abstract tapDirection(bit: number): Direction;
  /** Tap pin name (`"AB" + bit`, `"D" + bit`, or the control signal name). */
  abstract tapName(bit: number): string;
  protected abstract driveTap(tap: TapPoint): void;
  /** Logic value shown by the tap dot (scheduleTapVisuals). */
  abstract tapValue(tap: TapPoint): PotentialValue;

  tapColor(tap: TapPoint): string {
    return tapDotColor(this.railColor, this.tapValue(tap));
  }

  protected createPins(): Pin[] {
    this.pinsRef = [];
    return this.pinsRef;
  }

  getRows(): number {
    return this.rows;
  }

  getTopRow(): number {
    return this.topRow;
  }

  getTaps(): readonly TapPoint[] {
    return this.taps;
  }

  getGridWidth(): number {
    return RAIL_WIDTH;
  }

  getGridHeight(): number {
    return this.rows;
  }

  getShortDescription(): string {
    return this.getBusLabel() + ' zbernica (' + this.signalNames().length + ' bitov)';
  }

  /** Creates tap `bit` at local y (snapped to the grid, clamped to the rail). */
  createTap(bit: number, localY: number): Pin {
    const cell = this.getSheet().getComponentCell();
    const x = (RAIL_WIDTH * cell) / 2.0;
    const y = snap(clamp(localY, (this.topRow + 1) * cell, this.rows * cell), cell);
    const direction = this.tapDirection(bit);
    const pin = new Pin(this, this.tapName(bit), direction, 0, 0, Side.RIGHT);
    this.configureTapPin(pin);
    pin.setLayoutX(x);
    pin.setLayoutY(y);
    const tap: TapPoint = { pin, bit };
    this.taps.push(tap);
    this.pinsRef.push(pin);
    this.driveTap(tap);
    this.visualChanged();
    return pin;
  }

  protected configureTapPin(_pin: Pin): void {}

  /** `Všetky`: create taps for all missing signals on the first free rows (extending the rail). */
  createAllTaps(): Pin | null {
    const cell = this.getSheet().getComponentCell();
    let first: Pin | null = null;
    const usedRows = new Set<number>();
    for (const tap of this.taps) usedRows.add(Math.round(tap.pin.getLayoutY() / cell));
    let nextFreeRow = this.topRow + 1;
    for (let i = 0; i < this.signalNames().length; i++) {
      if (this.hasTap(i)) continue;
      while (usedRows.has(nextFreeRow)) nextFreeRow++;
      if (nextFreeRow >= this.rows) this.setRows(nextFreeRow + 1);
      usedRows.add(nextFreeRow);
      const pin = this.createTap(i, nextFreeRow * cell);
      if (first === null) first = pin;
      nextFreeRow++;
    }
    if (first === null && this.pinsRef.length > 0) first = this.pinsRef[0];
    return first;
  }

  private hasTap(bit: number): boolean {
    return this.taps.some((t) => t.bit === bit);
  }

  /**
   * Wire dropped on the rail: the chosen tap is created and the wire's free end connected.
   * `localX` is the drop x in the component's local coordinates (original used it to pick
   * LEFT vs RIGHT against half the rail thickness - which in practice always yields RIGHT).
   */
  connectDroppedWire(creating: Wire, tapPin: Pin | null, localX: number): void {
    if (tapPin === null) return;
    const thickness = Math.max(4, this.getSheet().getComponentCell() * RAIL_THICKNESS);
    tapPin.setSide(localX < thickness / 2.0 ? Side.LEFT : Side.RIGHT);
    creating.catchFreeEnd().connect(tapPin);
    creating.mouseTransparent = false;
    creating.opacity = 1;
    this.getSheet().finishInProgressWire();
  }

  /** `Zmazať` on a tap: removes the tap and its wire. */
  deleteTap(tap: TapPoint): void {
    tap.pin.getWireEnd()?.getWire().delete();
    const i = this.taps.indexOf(tap);
    if (i >= 0) this.taps.splice(i, 1);
    const j = this.pinsRef.indexOf(tap.pin);
    if (j >= 0) this.pinsRef.splice(j, 1);
    this.visualChanged();
  }

  /** Drag of the bottom resize handle to local y. */
  resizeTo(localY: number): void {
    const cell = this.getSheet().getComponentCell();
    const newRows = clamp(Math.round(localY / cell), Math.max(this.topRow + MIN_ROWS, this.minRowsForTaps()), MAX_ROWS);
    if (newRows !== this.rows) {
      this.rows = newRows;
      this.getSheet().setChanged();
      this.visualChanged();
    }
  }

  /** Drag of the top resize handle to local y. */
  resizeTopTo(localY: number): void {
    const cell = this.getSheet().getComponentCell();
    const maxTopRow = Math.min(this.rows - MIN_ROWS, this.minTopRowForTaps());
    const newTopRow = clamp(Math.round((localY - cell / 2.0) / cell), -MAX_ROWS, maxTopRow);
    if (newTopRow !== this.topRow) {
      this.topRow = newTopRow;
      this.getSheet().setChanged();
      this.visualChanged();
    }
  }

  setRows(newRows: number): void {
    this.rows = clamp(newRows, Math.max(this.topRow + MIN_ROWS, this.minRowsForTaps()), MAX_ROWS);
    this.visualChanged();
  }

  setTopRow(newTopRow: number): void {
    const maxTopRow = Math.min(this.rows - MIN_ROWS, this.minTopRowForTaps());
    this.topRow = clamp(newTopRow, -MAX_ROWS, maxTopRow);
    this.visualChanged();
  }

  /** Highest possible top row keeping the rail above every tap (Integer.MAX_VALUE without taps). */
  private minTopRowForTaps(): number {
    if (this.taps.length === 0) return 2147483647;
    const cell = this.getSheet().getComponentCell();
    let minRow = 2147483647;
    for (const tap of this.taps) minRow = Math.min(minRow, Math.round(tap.pin.getLayoutY() / cell));
    return minRow - 1;
  }

  private minRowsForTaps(): number {
    const cell = this.getSheet().getComponentCell();
    let maxRow = 0;
    for (const tap of this.taps) maxRow = Math.max(maxRow, Math.round(tap.pin.getLayoutY() / cell));
    return maxRow + 1;
  }

  override saveProperties(): Map<string, string> {
    const taps = this.taps.map((t) => t.bit + ':' + Math.round(t.pin.getLayoutY())).join(';');
    return new Map([
      ['rows', String(this.rows)],
      ['topRow', String(this.topRow)],
      ['taps', taps],
    ]);
  }

  override loadProperties(properties: Map<string, string>): void {
    // topRow first and unclamped: rows is not set yet, a clamp would bend the value
    const topRowValue = properties.get('topRow');
    if (topRowValue !== undefined) {
      const n = parseJavaInt(topRowValue.trim());
      if (n !== null) this.topRow = n;
    }
    const rowsValue = properties.get('rows');
    if (rowsValue !== undefined) {
      const n = parseJavaInt(rowsValue.trim());
      if (n !== null) this.setRows(n);
    }
    const tapsValue = properties.get('taps');
    if (tapsValue !== undefined && tapsValue.length > 0) {
      for (const entry of tapsValue.split(';')) {
        const part = entry.split(':');
        if (part.length !== 2) continue;
        const bit = parseJavaInt(part[0].trim());
        const y = parseJavaDouble(part[1].trim());
        if (bit === null || y === null) continue;
        this.createTap(bit, y);
      }
    }
  }

  reset(): void {
    for (const tap of this.taps) tap.pin.setState('NOT_CONNECTED');
  }
}

// ==================================================================== AddressBus16

export class AddressBus16 extends RailBus {
  readonly javaClassName = PKG + 'AddressBus16';
  readonly railColor = DARKRED;
  private static readonly NAMES = Array.from({ length: 16 }, (_, i) => 'AB' + i);
  private readonly onAddressBusChange: ChangeListener = () => this.syncFromBus();

  constructor(sheet: ConstructorParameters<typeof GateSymbol>[0]) {
    super(sheet, 12);
  }

  override initialize(): void {
    super.initialize();
    this.getBus().addressBus.addListener(this.onAddressBusChange);
    this.syncFromBus();
  }

  getBusLabel() { return 'AB'; }
  signalNames() { return AddressBus16.NAMES; }
  tapName(bit: number) { return 'AB' + bit; }
  protected tapDirection(): Direction { return 'OUTPUT'; }

  protected driveTap(tap: TapPoint): void {
    const address = this.getBus().getAddressBus() & 0xffff;
    this.setPin(tap.pin, (address & (1 << tap.bit)) !== 0 ? 'HIGH' : 'LOW');
    this.visualChanged();
  }

  tapValue(tap: TapPoint): PotentialValue {
    const driven = ((this.getBus().getAddressBus() & 0xffff) & (1 << tap.bit)) !== 0 ? 'HIGH' : 'LOW';
    return valueOr(tap.pin, driven);
  }

  syncFromBus(): void {
    for (const tap of this.taps) this.driveTap(tap);
  }

  simulate(): void {}
}

// ==================================================================== DataBus8

export class DataBus8 extends RailBus {
  readonly javaClassName = PKG + 'DataBus8';
  readonly railColor = DARKGREEN;
  private static readonly NAMES = Array.from({ length: 8 }, (_, i) => 'DB' + i);
  private read = false;
  private write = false;
  private data = 0;
  private readonly onDataBusChange: ChangeListener = () => this.handleDataChange();
  private readonly onControlBusChange: ChangeListener = () => this.handleControlChange();

  constructor(sheet: ConstructorParameters<typeof GateSymbol>[0]) {
    super(sheet, 8);
  }

  override initialize(): void {
    super.initialize();
    this.getBus().dataBus.addListener(this.onDataBusChange);
    this.getBus().controlBus.addListener(this.onControlBusChange);
    this.data = this.getBus().getDataBus() & 0xff;
    this.syncFromBus();
  }

  getBusLabel() { return 'DB'; }
  signalNames() { return DataBus8.NAMES; }
  tapName(bit: number) { return 'DB' + bit; }
  protected tapDirection(): Direction { return 'INOUT'; }

  /** Weak output: idle/held bus data never overpowers a strong driver on the net. */
  protected override configureTapPin(pin: Pin): void {
    pin.getOwnedPotential().setType('WEAK_OUT');
  }

  protected driveTap(tap: TapPoint): void {
    if (this.write) this.setPin(tap.pin, (this.data & (1 << tap.bit)) !== 0 ? 'HIGH' : 'LOW');
    else this.setPin(tap.pin, 'HIGH_IMPEDANCE');
    this.visualChanged();
  }

  tapValue(tap: TapPoint): PotentialValue {
    return tap.pin.getPotential()?.getValue() ?? 'NC';
  }

  syncFromBus(): void {
    const ctrl = this.getBus().getControlBus();
    this.data = this.getBus().getDataBus() & 0xff;
    this.read = (ctrl & 0xb0) !== 0xb0;
    this.write = (ctrl & 0x140) !== 0x140;
    for (const tap of this.taps) this.driveTap(tap);
  }

  private handleDataChange(): void {
    if ((this.getBus().getControlBus() & 0xb0) !== 0xb0) return;
    this.data = this.getBus().getDataBus() & 0xff;
    for (const tap of this.taps) this.setPin(tap.pin, (this.data & (1 << tap.bit)) !== 0 ? 'HIGH' : 'LOW');
    this.visualChanged();
  }

  private handleControlChange(): void {
    const ctrl = this.getBus().getControlBus();
    const writeActive = (ctrl & 0x140) !== 0x140;
    const readActive = (ctrl & 0xb0) !== 0xb0;

    if (writeActive && !this.write) {
      this.write = true;
      this.getBus().dataIsChanging();
      for (const tap of this.taps) this.driveTap(tap);
    } else if (!writeActive && this.write) {
      this.write = false;
      this.getBus().dataIsChanging();
    }

    if (readActive && !this.read) {
      this.read = true;
      this.getBus().dataIsChanging();
      for (const tap of this.taps) this.setPin(tap.pin, 'HIGH_IMPEDANCE');
    } else if (!readActive && this.read) {
      this.read = false;
      this.getBus().dataIsChanging();
      for (const tap of this.taps) this.setPin(tap.pin, 'HIGH_IMPEDANCE');
    }
  }

  private readPinsIntoBus(): void {
    let result = this.data;
    for (const tap of this.taps) {
      if (this.isHigh(tap.pin)) result |= 1 << tap.bit;
      else if (this.isLow(tap.pin)) result &= ~(1 << tap.bit);
    }
    if (result !== this.data) {
      this.data = result;
      this.getBus().setDataBus(result);
    }
  }

  simulate(): void {
    if (this.read) this.readPinsIntoBus();
    else if (this.write) for (const tap of this.taps) this.driveTap(tap);
    this.visualChanged();
  }
}

// ==================================================================== ControlBus

const SIGNAL_NAMES = ['MW/', 'MR/', 'IW/', 'IR/', 'IA/', 'IT'];
const BIT_OF_SIGNAL = [8, 7, 6, 5, 4, 3];
/** IT is the only input signal (circuit → CPU); the rest are driven by the CPU. */
const INPUT_SIGNAL = [false, false, false, false, false, true];

export class ControlBus extends RailBus {
  readonly javaClassName = PKG + 'ControlBus';
  readonly railColor = DARKGOLDENROD;
  private readonly onControlBusChange: ChangeListener = () => this.syncFromBus();

  constructor(sheet: ConstructorParameters<typeof GateSymbol>[0]) {
    super(sheet, 7);
  }

  override initialize(): void {
    super.initialize();
    this.getBus().controlBus.addListener(this.onControlBusChange);
    this.syncFromBus();
  }

  getBusLabel() { return 'CB'; }
  signalNames() { return SIGNAL_NAMES; }
  tapName(signal: number) { return SIGNAL_NAMES[checkIndex(signal)]; }
  protected tapDirection(signal: number): Direction { return INPUT_SIGNAL[checkIndex(signal)] ? 'INPUT' : 'OUTPUT'; }

  protected driveTap(tap: TapPoint): void {
    if (INPUT_SIGNAL[tap.bit]) {
      this.visualChanged();
      return;
    }
    const ctrl = this.getBus().getControlBus();
    this.setPin(tap.pin, (ctrl & (1 << BIT_OF_SIGNAL[tap.bit])) !== 0 ? 'HIGH' : 'LOW');
    this.visualChanged();
  }

  tapValue(tap: TapPoint): PotentialValue {
    // an input signal reads the circuit - without a connection it is High-Z (gray)
    if (INPUT_SIGNAL[tap.bit]) return tap.pin.getPotential()?.getValue() ?? 'NC';
    const ctrl = this.getBus().getControlBus();
    return valueOr(tap.pin, (ctrl & (1 << BIT_OF_SIGNAL[tap.bit])) !== 0 ? 'HIGH' : 'LOW');
  }

  syncFromBus(): void {
    for (const tap of this.taps) this.driveTap(tap);
  }

  simulate(): void {
    let it = false;
    for (const tap of this.taps) {
      if (!INPUT_SIGNAL[tap.bit]) continue;
      if (!this.isHigh(tap.pin)) continue;
      it = true;
    }
    this.getBus().setIT(it);
  }
}

// ==================================================================== helpers

/** Java array access semantics: ArrayIndexOutOfBoundsException. */
function checkIndex(i: number): number {
  if (i < 0 || i >= SIGNAL_NAMES.length) throw new RangeError('ArrayIndexOutOfBoundsException: ' + i);
  return i;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number, cell: number): number {
  return Math.round(value / cell) * cell;
}

/** `Integer.parseInt` returning null instead of throwing (callers ignore NumberFormatException). */
function parseJavaInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** `Double.parseDouble` subset returning null instead of throwing. */
function parseJavaDouble(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[dDfF]?$/.test(s)) return null;
  return Number.parseFloat(s);
}
