/**
 * Ports of all non-bus components of `SchematicSim.Gates` (model part). Pin order, sizes,
 * simulation logic, saved properties and the 100 ms hold timers are identical to the original.
 */
import { Side } from '../geometry';
import { Pin, type PinState } from '../Pin';
import type { SchematicSheet } from '../Sheet';
import { COLOR_CHOICES, colorWeb, FX } from './colors';
import { GateSymbol } from './GateSymbol';

const PKG = 'sk.uniza.fri.cp.SchematicSim.Gates.';

const inputPin = (owner: GateSymbol, name: string, x: number, y: number, side: Side) =>
  new Pin(owner, name, 'INPUT', x, y, side);
const outputPin = (owner: GateSymbol, name: string, x: number, y: number, side: Side) =>
  new Pin(owner, name, 'OUTPUT', x, y, side);

// ==================================================================== multi-input gates

const SUPPORTED_COUNTS = [2, 3, 4, 8];
const INPUT_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export abstract class MultiInputGate extends GateSymbol {
  private inputCount = 2;

  abstract getSymbolText(): string;

  negated(): boolean {
    return false;
  }

  /** Context-menu items: `2 vstupy`, `3 vstupy`, `4 vstupy`, `8 vstupov`. */
  static readonly MENU = SUPPORTED_COUNTS.map((n) => ({ count: n, label: n + (n === 8 ? ' vstupov' : ' vstupy') }));

  protected createPins(): Pin[] {
    const count = this.effectiveInputCount();
    const list: Pin[] = [];
    for (let i = 0; i < count; i++) list.push(inputPin(this, INPUT_NAMES[i], 0, 1 + i, Side.LEFT));
    list.push(outputPin(this, 'Y', this.getGridWidth(), this.outputRow(), Side.RIGHT));
    return list;
  }

  getGridWidth(): number {
    return 2;
  }

  getGridHeight(): number {
    return this.effectiveInputCount() + 1;
  }

  protected inputPins(): Pin[] {
    const pins = this.getPins();
    return pins.slice(0, pins.length - 1);
  }

  protected getOutput(): Pin {
    const pins = this.getPins();
    return pins[pins.length - 1];
  }

  getInputCount(): number {
    return this.effectiveInputCount();
  }

  setInputCount(count: number): void {
    if (!SUPPORTED_COUNTS.includes(count) || count === this.effectiveInputCount()) return;

    const currentPins = [...this.getPins()];
    const currentInputs = currentPins.slice(0, currentPins.length - 1);
    const currentOutput = currentPins[currentPins.length - 1];
    const keep = Math.min(count, currentInputs.length);

    for (let i = count; i < currentInputs.length; i++) {
      const end = currentInputs[i].getWireEnd();
      if (end !== null) end.getWire().delete();
    }

    this.inputCount = count;

    const newPins = currentInputs.slice(0, keep);
    for (let i = keep; i < count; i++) newPins.push(inputPin(this, INPUT_NAMES[i], 0, 1 + i, Side.LEFT));

    const cell = this.getSheet().getComponentCell();
    currentOutput.setLayoutX(this.getGridWidth() * cell);
    currentOutput.setLayoutY(this.outputRow() * cell);
    currentOutput.getWireEnd()?.refreshPosition();
    newPins.push(currentOutput);

    this.replacePins(newPins);
    if (this.isSelected() && this.isSelectable()) {
      this.deselect();
      this.select();
    }
    this.visualChanged();
  }

  override saveProperties(): Map<string, string> {
    return new Map([['inputs', String(this.effectiveInputCount())]]);
  }

  override loadProperties(properties: Map<string, string>): void {
    const value = properties.get('inputs');
    if (value === undefined) return;
    const count = Number.parseInt(value, 10);
    if (/^[+-]?\d+$/.test(value) && SUPPORTED_COUNTS.includes(count)) {
      this.setInputCount(count);
      this.getSheet().getOccupancy().free(this);
      this.getSheet().getOccupancy().occupy(this);
    }
  }

  private effectiveInputCount(): number {
    return Math.max(this.inputCount, 2);
  }

  outputRow(): number {
    return Math.trunc((1 + this.effectiveInputCount()) / 2);
  }

  reset(): void {
    this.setPinForce(this.getOutput(), 'NOT_CONNECTED');
  }
}

export class AndGate extends MultiInputGate {
  readonly javaClassName = PKG + 'AndGate';
  getSymbolText() { return '&'; }
  simulate(): void {
    let allHigh = true;
    for (const input of this.inputPins()) {
      if (!this.isHigh(input)) {
        allHigh = false;
        break;
      }
    }
    this.setPin(this.getOutput(), allHigh ? 'HIGH' : 'LOW');
  }
  getName() { return 'AND'; }
  getShortDescription() { return '2-8 vstupové logické hradlo AND (Y = A · B · ...)'; }
}

export class NandGate extends MultiInputGate {
  readonly javaClassName = PKG + 'NandGate';
  getSymbolText() { return '&'; }
  override negated() { return true; }
  simulate(): void {
    let allHigh = true;
    for (const input of this.inputPins()) {
      if (!this.isHigh(input)) {
        allHigh = false;
        break;
      }
    }
    this.setPin(this.getOutput(), allHigh ? 'LOW' : 'HIGH');
  }
  getName() { return 'NAND'; }
  getShortDescription() { return '2-8 vstupové logické hradlo NAND (Y = NOT (A · B · ...))'; }
}

export class OrGate extends MultiInputGate {
  readonly javaClassName = PKG + 'OrGate';
  getSymbolText() { return '≥1'; }
  simulate(): void {
    let anyHigh = false;
    for (const input of this.inputPins()) {
      if (this.isHigh(input)) {
        anyHigh = true;
        break;
      }
    }
    this.setPin(this.getOutput(), anyHigh ? 'HIGH' : 'LOW');
  }
  getName() { return 'OR'; }
  getShortDescription() { return '2-8 vstupové logické hradlo OR (Y = A + B + ...)'; }
}

export class NorGate extends MultiInputGate {
  readonly javaClassName = PKG + 'NorGate';
  getSymbolText() { return '≥1'; }
  override negated() { return true; }
  simulate(): void {
    let anyHigh = false;
    for (const input of this.inputPins()) {
      if (this.isHigh(input)) {
        anyHigh = true;
        break;
      }
    }
    this.setPin(this.getOutput(), anyHigh ? 'LOW' : 'HIGH');
  }
  getName() { return 'NOR'; }
  getShortDescription() { return '2-8 vstupové logické hradlo NOR (Y = NOT (A + B + ...))'; }
}

export class XorGate extends MultiInputGate {
  readonly javaClassName = PKG + 'XorGate';
  getSymbolText() { return '=1'; }
  simulate(): void {
    let oddHigh = false;
    for (const input of this.inputPins()) if (this.isHigh(input)) oddHigh = !oddHigh;
    this.setPin(this.getOutput(), oddHigh ? 'HIGH' : 'LOW');
  }
  getName() { return 'XOR'; }
  getShortDescription() { return '2-8 vstupové logické hradlo XOR (Y = A ⊕ B ⊕ ...)'; }
}

// ==================================================================== NOT, Buffer

export class NotGate extends GateSymbol {
  readonly javaClassName = PKG + 'NotGate';
  private a!: Pin;
  private y!: Pin;
  protected createPins(): Pin[] {
    this.a = inputPin(this, 'A', 0, 1, Side.LEFT);
    this.y = outputPin(this, 'Y', this.getGridWidth(), 1, Side.RIGHT);
    return [this.a, this.y];
  }
  simulate(): void {
    this.setPin(this.y, this.isHigh(this.a) ? 'LOW' : 'HIGH');
  }
  reset(): void {
    this.setPinForce(this.y, 'NOT_CONNECTED');
  }
  getGridWidth() { return 2; }
  getGridHeight() { return 2; }
  getName() { return 'NOT'; }
  getShortDescription() { return 'Invertor (Y = ¬A)'; }
}

export class BusBuffer extends GateSymbol {
  readonly javaClassName = PKG + 'BusBuffer';
  private a!: Pin;
  private g!: Pin;
  private y!: Pin;
  protected createPins(): Pin[] {
    this.a = inputPin(this, 'A', 0, 1, Side.LEFT);
    this.g = inputPin(this, 'G/', 1, 0, Side.TOP);
    this.y = outputPin(this, 'Y', this.getGridWidth(), 1, Side.RIGHT);
    return [this.a, this.g, this.y];
  }
  simulate(): void {
    if (this.isLow(this.g)) this.setPin(this.y, this.isHigh(this.a) ? 'HIGH' : 'LOW');
    else this.setPin(this.y, 'HIGH_IMPEDANCE');
  }
  reset(): void {
    this.setPinForce(this.y, 'NOT_CONNECTED');
  }
  getGridWidth() { return 2; }
  getGridHeight() { return 2; }
  getName() { return 'Buffer'; }
  getShortDescription() { return 'Bus buffer - Y = A pri G/=0, inak výstup v Z'; }
}

// ==================================================================== pin placement helpers (LED / Input)

function placementOffsetX(side: Side, width: number, fallback: number): number {
  switch (side) {
    case Side.LEFT: return 0;
    case Side.RIGHT: return width;
    case Side.TOP:
    case Side.BOTTOM: return 1;
  }
  return fallback;
}

function placementOffsetY(side: Side, height: number): number {
  switch (side) {
    case Side.TOP: return 0;
    case Side.BOTTOM: return height;
  }
  return 1;
}

// ==================================================================== LED

export const INPUT_HOLD_MS = 100;

export class Led extends GateSymbol {
  readonly javaClassName = PKG + 'Led';
  private pinIn!: Pin;
  private on = false;
  private wasHigh = false;
  /** Time of the last LOW→HIGH edge (start of the minimum 100 ms lit time). */
  private litSinceMs = 0;
  private ledColor: string = FX.RED;

  static readonly COLORS = COLOR_CHOICES;
  static readonly PLACEMENT_MENU: readonly [string, Side][] = [
    ['vpravo', Side.RIGHT], ['vľavo', Side.LEFT], ['hore', Side.TOP], ['dole', Side.BOTTOM],
  ];

  protected createPins(): Pin[] {
    this.pinIn = inputPin(this, 'IN', 0, 1, Side.LEFT);
    return [this.pinIn];
  }

  placeInput(side: Side): void {
    const cell = this.getSheet().getComponentCell();
    this.pinIn.setLayoutX(placementOffsetX(side, 2, 0) * cell);
    this.pinIn.setLayoutY(placementOffsetY(side, 2) * cell);
    this.pinIn.setSide(side);
    this.pinIn.getWireEnd()?.refreshPosition();
  }

  getInputPin(): Pin {
    return this.pinIn;
  }

  simulate(): void {
    this.applyInputState(this.isHigh(this.pinIn), this.getSheet().clock.now());
  }

  /**
   * Lit while the input is 1. After the input falls, the LED goes off at once if it has been lit
   * for at least 100 ms; a shorter pulse keeps it lit until 100 ms after its rising edge.
   * Every LOW→HIGH edge restarts the count. Public for unit tests.
   */
  applyInputState(high: boolean, now: number): void {
    if (high) {
      if (!this.wasHigh) {
        this.wasHigh = true;
        this.litSinceMs = now;
      }
      this.setLitState(true);
      return;
    }
    if (this.wasHigh) this.wasHigh = false;
    this.setLitState(this.on && now - this.litSinceMs < INPUT_HOLD_MS);
  }

  private setLitState(lit: boolean): void {
    if (lit !== this.on) {
      this.on = lit;
      this.visualChanged();
    }
  }

  reset(): void {
    this.setPinForce(this.pinIn, 'NOT_CONNECTED');
    this.wasHigh = false;
    this.litSinceMs = 0;
    this.setLitState(false);
  }

  isLit(): boolean {
    return this.on;
  }

  getLedColor(): string {
    return this.ledColor;
  }

  setColor(color: string): void {
    this.ledColor = color;
    this.visualChanged();
  }

  override saveProperties(): Map<string, string> {
    return new Map([
      ['color', this.ledColor],
      ['pinSide', this.pinIn.getExitSide().name],
    ]);
  }

  override loadProperties(properties: Map<string, string>): void {
    const color = properties.get('color');
    if (color !== undefined) {
      const found = COLOR_CHOICES.find(([name]) => name === color)?.[1];
      this.setColor(found ?? colorWeb(color));
    }
    const side = properties.get('pinSide');
    if (side !== undefined) {
      try {
        this.placeInput(Side.valueOf(side));
      } catch {
        /* IllegalArgumentException ignored */
      }
    }
  }

  getGridWidth() { return 2; }
  getGridHeight() { return 2; }
  getName() { return 'LED'; }
  getShortDescription() { return 'LED dióda - svieti pri logickej 1; pravým tlačidlom zvoľ umiestnenie vývodu a farbu'; }
}

// ==================================================================== Input (switch)

export class Input extends GateSymbol {
  readonly javaClassName = PKG + 'Input';
  private outPin!: Pin;
  private on = false;

  static readonly PLACEMENT_MENU: readonly [string, Side][] = [
    ['Vývod vpravo', Side.RIGHT], ['Vývod vľavo', Side.LEFT], ['Vývod hore', Side.TOP], ['Vývod dole', Side.BOTTOM],
  ];

  protected createPins(): Pin[] {
    this.outPin = outputPin(this, 'O', 2, 1, Side.RIGHT);
    return [this.outPin];
  }

  placeOutput(side: Side): void {
    const cell = this.getSheet().getComponentCell();
    this.outPin.setLayoutX(placementOffsetX(side, 2, 2) * cell);
    this.outPin.setLayoutY(placementOffsetY(side, 2) * cell);
    this.outPin.setSide(side);
    this.outPin.getWireEnd()?.refreshPosition();
  }

  getOutputPin(): Pin {
    return this.outPin;
  }

  simulate(): void {
    this.setPin(this.outPin, this.on ? 'HIGH' : 'LOW');
  }

  reset(): void {
    this.setPinForce(this.outPin, 'NOT_CONNECTED');
  }

  /** Left click on the square. */
  toggle(): void {
    this.setOn(!this.on);
  }

  setOn(value: boolean): void {
    this.on = value;
    this.visualChanged();
    if (this.getSheet().isSimulationRunning()) this.simulate();
  }

  isOn(): boolean {
    return this.on;
  }

  override saveProperties(): Map<string, string> {
    return new Map([
      ['pinSide', this.outPin.getExitSide().name],
      ['state', this.on ? '1' : '0'],
    ]);
  }

  override loadProperties(properties: Map<string, string>): void {
    const side = properties.get('pinSide');
    if (side !== undefined) {
      try {
        this.placeOutput(Side.valueOf(side));
      } catch {
        /* ignored */
      }
    }
    const state = properties.get('state');
    if (state !== undefined) this.setOn(state === '1');
  }

  getGridWidth() { return 2; }
  getGridHeight() { return 2; }
  getName() { return 'INP'; }
  getShortDescription() { return 'Prepínač - klikom prepni, pravým tlačidlom vyber umiestnenie vývodu O (vpravo/vľavo/hore/dole)'; }
}

// ==================================================================== PushButton

export class PushButton extends GateSymbol {
  readonly javaClassName = PKG + 'PushButton';
  private pinIn!: Pin;
  private pinOut!: Pin;
  private pressed = false;
  private toggleMode = false;
  private label = '';

  protected createPins(): Pin[] {
    this.pinIn = inputPin(this, 'I', 0, 1, Side.LEFT);
    this.pinOut = outputPin(this, 'O', 1, 0, Side.TOP);
    this.pinOut.getOwnedPotential().setType('WEAK_OUT');
    return [this.pinIn, this.pinOut];
  }

  simulate(): void {
    if (this.pressed && this.isLow(this.pinIn)) this.setPin(this.pinOut, 'LOW');
    else this.setPin(this.pinOut, 'HIGH');
  }

  reset(): void {
    this.pressed = false;
    this.setPinForce(this.pinIn, 'NOT_CONNECTED');
    this.setPinForce(this.pinOut, 'NOT_CONNECTED');
    this.visualChanged();
  }

  /** Primary mouse press on the plunger. */
  mousePressed(): void {
    if (this.toggleMode) this.setPressedState(!this.pressed);
    else this.setPressedState(true);
  }

  /** Primary mouse release on the plunger. */
  mouseReleased(): void {
    if (!this.toggleMode) this.setPressedState(false);
  }

  setPressedState(value: boolean): void {
    this.pressed = value;
    this.visualChanged();
    if (this.getSheet().isSimulationRunning()) this.simulate();
  }

  isPressedState(): boolean {
    return this.pressed;
  }

  setToggle(value: boolean): void {
    if (this.toggleMode === value) return;
    this.toggleMode = value;
    if (!this.toggleMode && this.pressed) this.setPressedState(false);
  }

  isToggle(): boolean {
    return this.toggleMode;
  }

  setLabel(value: string | null): void {
    this.label = value ?? '';
    this.visualChanged();
  }

  getLabel(): string {
    return this.label;
  }

  override saveProperties(): Map<string, string> {
    const m = new Map<string, string>();
    if (this.label.length > 0) m.set('label', this.label);
    return m;
  }

  override loadProperties(properties: Map<string, string>): void {
    const label = properties.get('label');
    if (label !== undefined) this.setLabel(label);
  }

  getGridWidth() { return 2; }
  getGridHeight() { return 2; }
  getName() { return 'BTN'; }
  getShortDescription() { return 'Tlačidlo - ľavým tlačidlom stlačíš (0/1), pravým tlačidlom Toggle a Label'; }
}

// ==================================================================== MatrixKeyboard

const KB_ROWS = 4;
const KB_COLS = 4;
const KEY_GRID = 2;
const DEFAULT_LABELS = '0123456789ABCDEF';

export class MatrixKeyboard extends GateSymbol {
  readonly javaClassName = PKG + 'MatrixKeyboard';
  static readonly ROWS = KB_ROWS;
  static readonly COLS = KB_COLS;
  static readonly KEY_GRID = KEY_GRID;

  private pinIn: Pin[] = [];
  private pinOut: Pin[] = [];
  private keyOn: boolean[][] = [];
  private keyLabels: string[][] = [];
  private pressedRow = -1;
  private pressedCol = -1;
  private toggleMode = false;

  protected createPins(): Pin[] {
    this.keyOn = Array.from({ length: KB_ROWS }, () => Array<boolean>(KB_COLS).fill(false));
    this.keyLabels = Array.from({ length: KB_ROWS }, (_, row) =>
      Array.from({ length: KB_COLS }, (_, col) => DEFAULT_LABELS.charAt((KB_ROWS - 1 - row) * KB_COLS + col)),
    );
    const pins: Pin[] = [];
    this.pinIn = [];
    for (let row = 0; row < KB_ROWS; row++) {
      const p = inputPin(this, 'R' + row, 1, 1 + row * KEY_GRID + KEY_GRID / 2, Side.LEFT);
      this.pinIn.push(p);
      pins.push(p);
    }
    this.pinOut = [];
    for (let col = 0; col < KB_COLS; col++) {
      const p = outputPin(this, 'C' + col, 1 + col * KEY_GRID + KEY_GRID / 2, 1, Side.TOP);
      p.getOwnedPotential().setType('WEAK_OUT');
      this.pinOut.push(p);
      pins.push(p);
    }
    return pins;
  }

  isActiveKey(row: number, col: number): boolean {
    return (this.pressedRow === row && this.pressedCol === col) || this.keyOn[row][col];
  }

  simulate(): void {
    for (let col = 0; col < KB_COLS; col++) {
      this.setPin(this.pinOut[col], this.anyLowInColumn(col) ? 'LOW' : 'HIGH');
    }
  }

  private anyLowInColumn(col: number): boolean {
    for (let row = 0; row < KB_ROWS; row++) {
      if (this.isActiveKey(row, col) && this.isLow(this.pinIn[row])) return true;
    }
    return false;
  }

  reset(): void {
    this.pressedRow = -1;
    this.pressedCol = -1;
    for (const row of this.keyOn) row.fill(false);
    for (let row = 0; row < KB_ROWS; row++) this.setPinForce(this.pinIn[row], 'NOT_CONNECTED');
    for (let col = 0; col < KB_COLS; col++) this.setPinForce(this.pinOut[col], 'NOT_CONNECTED');
    this.visualChanged();
  }

  /** Primary press on key (row, col). */
  mousePressed(row: number, col: number): void {
    if (this.toggleMode) {
      this.keyOn[row][col] = !this.keyOn[row][col];
      this.visualChanged();
      this.notifyStateChanged();
    } else {
      this.setPressed(row, col);
    }
  }

  /** Primary release on key (row, col). */
  mouseReleased(row: number, col: number): void {
    if (!this.toggleMode) this.releasePressed(row, col);
  }

  setPressed(row: number, col: number): void {
    if (row < 0 || row >= KB_ROWS || col < 0 || col >= KB_COLS) return;
    this.pressedRow = row;
    this.pressedCol = col;
    this.visualChanged();
    this.notifyStateChanged();
  }

  releasePressed(row: number, col: number): void {
    if (row < 0 || row >= KB_ROWS || col < 0 || col >= KB_COLS) return;
    if (this.pressedRow !== row || this.pressedCol !== col) return;
    this.pressedRow = -1;
    this.pressedCol = -1;
    this.keyOn[row][col] = false;
    this.visualChanged();
    this.notifyStateChanged();
  }

  setToggle(value: boolean): void {
    if (this.toggleMode === value) return;
    this.toggleMode = value;
    if (!this.toggleMode) {
      this.pressedRow = -1;
      this.pressedCol = -1;
      for (const row of this.keyOn) row.fill(false);
      this.visualChanged();
      this.notifyStateChanged();
    }
  }

  isToggle(): boolean {
    return this.toggleMode;
  }

  private notifyStateChanged(): void {
    if (this.getSheet().isSimulationRunning()) this.simulate();
  }

  isKeyOn(row: number, col: number): boolean {
    if (row < 0 || row >= KB_ROWS || col < 0 || col >= KB_COLS) return false;
    return this.keyOn[row][col];
  }

  setKeyLabel(row: number, col: number, value: string | null): void {
    if (row < 0 || row >= KB_ROWS || col < 0 || col >= KB_COLS) return;
    this.keyLabels[row][col] = value ?? '';
    this.visualChanged();
  }

  getKeyLabel(row: number, col: number): string {
    if (row < 0 || row >= KB_ROWS || col < 0 || col >= KB_COLS) return '';
    return this.keyLabels[row][col];
  }

  override saveProperties(): Map<string, string> {
    const m = new Map<string, string>();
    for (let row = 0; row < KB_ROWS; row++) {
      for (let col = 0; col < KB_COLS; col++) {
        const def = DEFAULT_LABELS.charAt((KB_ROWS - 1 - row) * KB_COLS + col);
        if (this.keyLabels[row][col] !== def) m.set('label' + (row * KB_COLS + col), this.keyLabels[row][col]);
      }
    }
    return m;
  }

  override loadProperties(properties: Map<string, string>): void {
    for (let row = 0; row < KB_ROWS; row++) {
      for (let col = 0; col < KB_COLS; col++) {
        const label = properties.get('label' + (row * KB_COLS + col));
        if (label !== undefined) this.setKeyLabel(row, col, label);
      }
    }
  }

  getGridWidth() { return KB_COLS * KEY_GRID + 1; }
  getGridHeight() { return KB_ROWS * KEY_GRID + 1; }
  getName() { return 'KBD'; }
  getShortDescription() { return 'Klávesnica 4x4 - riadky R0-R3 (vľavo), stĺpce C0-C3 (hore); ľavým tlačidlom stlač, pravým tlačidlom Toggle a Label'; }
}

// ==================================================================== SevenSegmentDisplay

const SEGMENT_COUNT = 8;
export const CA_HOLD_MS = 100;
const SEG_PIN_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP', 'CA'];

export class SevenSegmentDisplay extends GateSymbol {
  readonly javaClassName = PKG + 'SevenSegmentDisplay';
  static readonly PIN_NAMES = SEG_PIN_NAMES;
  static readonly COLORS = COLOR_CHOICES;

  private segmentPins: Pin[] = [];
  private caPin!: Pin;
  private segmentColor: string = FX.RED;
  private litSegments: boolean[] = Array<boolean>(SEGMENT_COUNT).fill(false);
  private holdSnapshot: boolean[] = Array<boolean>(SEGMENT_COUNT).fill(false);
  private caWasEnabled = false;
  private caHoldActive = false;
  private caHoldDeadlineMs = 0;
  private powered = false;

  protected createPins(): Pin[] {
    this.segmentPins = [];
    const pins: Pin[] = [];
    for (let i = 0; i < SEG_PIN_NAMES.length; i++) {
      const pin = inputPin(this, SEG_PIN_NAMES[i], 0, 1 + i, Side.LEFT);
      pins.push(pin);
      if (i < SEGMENT_COUNT) this.segmentPins.push(pin);
      else this.caPin = pin;
    }
    return pins;
  }

  simulate(): void {
    const now = this.getSheet().clock.now();
    const caEnabled = this.isLow(this.caPin);

    if (caEnabled) {
      this.caWasEnabled = true;
      this.caHoldActive = false;
      this.caHoldDeadlineMs = 0;
      this.powered = true;
      const newLit: boolean[] = [];
      for (let i = 0; i < SEGMENT_COUNT; i++) newLit.push(this.isLow(this.segmentPins[i]));
      this.applyLitState(newLit, true);
      return;
    }

    if (this.caWasEnabled) {
      this.caWasEnabled = false;
      this.caHoldActive = true;
      this.caHoldDeadlineMs = now + CA_HOLD_MS;
      this.holdSnapshot = [...this.litSegments];
      this.powered = true;
      this.applyLitState(this.holdSnapshot, true);
      return;
    }

    if (this.caHoldActive) {
      if (now >= this.caHoldDeadlineMs) {
        this.caHoldActive = false;
        this.powered = false;
        this.applyLitState(Array<boolean>(SEGMENT_COUNT).fill(false), true);
      } else {
        this.powered = true;
        this.applyLitState(this.holdSnapshot, false);
      }
      return;
    }

    this.powered = false;
    this.applyLitState(Array<boolean>(SEGMENT_COUNT).fill(false), true);
  }

  /** Exposed for the ported unit test (SevenSegmentDisplayTest). */
  applyLitState(newLit: boolean[], powerChanged: boolean): void {
    let changed = powerChanged;
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      if (this.litSegments[i] !== newLit[i]) {
        this.litSegments[i] = newLit[i];
        changed = true;
      }
    }
    if (changed) this.visualChanged();
  }

  reset(): void {
    for (const pin of this.getPins()) this.setPinForce(pin, 'NOT_CONNECTED');
    this.litSegments = Array<boolean>(SEGMENT_COUNT).fill(false);
    this.holdSnapshot = Array<boolean>(SEGMENT_COUNT).fill(false);
    this.caWasEnabled = false;
    this.caHoldActive = false;
    this.caHoldDeadlineMs = 0;
    this.powered = false;
    this.visualChanged();
  }

  getLitSegments(): boolean[] {
    return [...this.litSegments];
  }

  isPowered(): boolean {
    return this.powered;
  }

  isCaHoldActive(): boolean {
    return this.caHoldActive;
  }

  getSegmentColor(): string {
    return this.segmentColor;
  }

  setColor(color: string): void {
    this.segmentColor = color;
    this.visualChanged();
  }

  override saveProperties(): Map<string, string> {
    return new Map([['color', this.segmentColor]]);
  }

  override loadProperties(properties: Map<string, string>): void {
    const color = properties.get('color');
    if (color !== undefined) {
      const found = COLOR_CHOICES.find(([name]) => name === color)?.[1];
      this.setColor(found ?? colorWeb(color));
    }
  }

  getGridWidth() { return 6; }
  getGridHeight() { return 10; }
  getName() { return '7-segment'; }
  getShortDescription() {
    return '7-segmentový displej - vstupy A-G, DP (desatinná bodka) a CA (spoločná anóda), segment svieti pri logickej 0 na vstupe aj na CA';
  }
}

// ==================================================================== Register8

export class Register8 extends GateSymbol {
  readonly javaClassName = PKG + 'Register8';
  private dataPins: Pin[] = [];
  private outputPins: Pin[] = [];
  private pinOE_!: Pin;
  private pinLE!: Pin;
  private latch = 0;
  /** `Vymeň D-Q`: data inputs on the right, outputs on the left (saved as `swapped`). */
  private swapped = false;

  /** Context menu item. */
  static readonly SWAP_MENU = 'Vymeň D-Q';

  protected createPins(): Pin[] {
    const pins: Pin[] = [];
    this.dataPins = [];
    for (let i = 0; i < 8; i++) {
      const p = inputPin(this, 'D' + i, 0, i + 1, Side.LEFT);
      this.dataPins.push(p);
      pins.push(p);
    }
    this.pinOE_ = inputPin(this, 'OE/', 0, 9, Side.LEFT);
    this.pinLE = inputPin(this, 'LE', 0, 10, Side.LEFT);
    pins.push(this.pinOE_, this.pinLE);
    this.outputPins = [];
    for (let i = 0; i < 8; i++) {
      const p = outputPin(this, 'Q' + i, 4, i + 1, Side.RIGHT);
      this.outputPins.push(p);
      pins.push(p);
    }
    return pins;
  }

  simulate(): void {
    if (this.isHigh(this.pinLE)) this.latch = this.readData();
    if (this.isLow(this.pinOE_)) this.driveOutputs(this.latch);
    else for (const p of this.outputPins) this.setPin(p, 'HIGH_IMPEDANCE');
  }

  /** Original quirk: states are reset without posting events. */
  reset(): void {
    for (const pin of this.getPins()) pin.setState('NOT_CONNECTED');
  }

  private readData(): number {
    let value = 0;
    for (let i = 0; i < 8; i++) if (this.isHigh(this.dataPins[i])) value |= 1 << i;
    return value & 0xff;
  }

  private driveOutputs(value: number): void {
    for (let i = 0; i < 8; i++) this.setPin(this.outputPins[i], (value & (1 << i)) !== 0 ? 'HIGH' : 'LOW');
  }

  getLatch(): number {
    return this.latch;
  }

  isSwapped(): boolean {
    return this.swapped;
  }

  toggleSwap(): void {
    this.swapped = !this.swapped;
    this.applySwap();
  }

  private applySwap(): void {
    const cell = this.getSheet().getComponentCell();
    for (let i = 0; i < 8; i++) {
      this.dataPins[i].setLayoutX(this.swapped ? this.getGridWidth() * cell : 0);
      this.dataPins[i].setSide(this.swapped ? Side.RIGHT : Side.LEFT);
      this.outputPins[i].setLayoutX(this.swapped ? 0 : this.getGridWidth() * cell);
      this.outputPins[i].setSide(this.swapped ? Side.LEFT : Side.RIGHT);
      this.dataPins[i].getWireEnd()?.refreshPosition();
      this.outputPins[i].getWireEnd()?.refreshPosition();
    }
    this.visualChanged();
  }

  override saveProperties(): Map<string, string> {
    const properties = new Map(super.saveProperties());
    properties.set('swapped', String(this.swapped));
    return properties;
  }

  override loadProperties(properties: Map<string, string>): void {
    super.loadProperties(properties);
    const swappedValue = properties.get('swapped');
    if (swappedValue !== undefined) {
      this.swapped = swappedValue.trim().toLowerCase() === 'true';
      this.applySwap();
    }
  }

  override getInstanceNamePrefix(): string {
    return 'REG';
  }

  getGridWidth() { return 4; }
  getGridHeight() { return 11; }
  getName() { return 'Register 8'; }
  getShortDescription() { return '8-bitový register (D-type latch) - LE=1 zapisuje dáta, OE/=0 povoľuje výstupy'; }
}

// ==================================================================== Ram8k

export class Ram8k extends GateSymbol {
  readonly javaClassName = PKG + 'Ram8k';
  private readonly memory = new Int8Array(8192);
  private addressPins: Pin[] = [];
  private dataPins: Pin[] = [];
  private pinWE_!: Pin;
  private pinOE_!: Pin;
  private pinE1_!: Pin;
  private pinE2!: Pin;

  protected createPins(): Pin[] {
    const pins: Pin[] = [];
    this.dataPins = [];
    for (let i = 0; i < 8; i++) {
      const p = new Pin(this, 'D' + i, 'INOUT', 0, i + 1, Side.LEFT);
      this.dataPins.push(p);
      pins.push(p);
    }
    this.pinWE_ = inputPin(this, 'WE/', 0, 9, Side.LEFT);
    this.pinOE_ = inputPin(this, 'OE/', 0, 10, Side.LEFT);
    this.pinE1_ = inputPin(this, 'E1/', 0, 11, Side.LEFT);
    this.pinE2 = inputPin(this, 'E2', 0, 12, Side.LEFT);
    pins.push(this.pinWE_, this.pinOE_, this.pinE1_, this.pinE2);
    this.addressPins = [];
    for (let i = 0; i < 13; i++) {
      const p = inputPin(this, 'A' + i, 5, i + 1, Side.RIGHT);
      this.addressPins.push(p);
      pins.push(p);
    }
    return pins;
  }

  simulate(): void {
    const chipEnabled = this.isLow(this.pinE1_) && this.isHigh(this.pinE2);
    if (!chipEnabled) {
      this.setDataImpedance();
      return;
    }
    if (this.isLow(this.pinWE_)) {
      this.memory[this.readAddress()] = this.readData();
      this.setDataImpedance();
    } else if (this.isLow(this.pinOE_)) {
      this.driveData(this.memory[this.readAddress()] & 0xff);
    } else {
      this.setDataImpedance();
    }
  }

  reset(): void {
    for (const pin of this.getPins()) pin.setState('NOT_CONNECTED');
  }

  private readAddress(): number {
    let address = 0;
    for (let i = 0; i < 13; i++) if (this.isHigh(this.addressPins[i])) address |= 1 << i;
    return address;
  }

  private readData(): number {
    let value = 0;
    for (let i = 0; i < 8; i++) if (this.isHigh(this.dataPins[i])) value |= 1 << i;
    return value & 0xff;
  }

  private driveData(value: number): void {
    for (let i = 0; i < 8; i++) this.setPin(this.dataPins[i], (value & (1 << i)) !== 0 ? 'HIGH' : 'LOW');
  }

  private setDataImpedance(): void {
    for (let i = 0; i < 8; i++) this.setPin(this.dataPins[i], 'HIGH_IMPEDANCE');
  }

  getMemory(): Int8Array {
    return this.memory;
  }

  /** Context menu item opening the live RAM content window. */
  static readonly CONTENT_MENU = 'Obsah';

  override getInstanceNamePrefix(): string {
    return 'RAM';
  }

  getGridWidth() { return 5; }
  getGridHeight() { return 14; }
  getName() { return 'RAM 8k'; }
  getShortDescription() { return '8kB RAM – E1/=0 & E2=1 zapne čip, WE/=0 zápis, OE/=0 čítanie'; }
}

// ==================================================================== Decoder38 / Encoder83

export class Decoder38 extends GateSymbol {
  readonly javaClassName = PKG + 'Decoder38';
  private pinA!: Pin;
  private pinB!: Pin;
  private pinC!: Pin;
  private pinG!: Pin;
  private outputs: Pin[] = [];

  protected createPins(): Pin[] {
    this.pinA = inputPin(this, 'A', 0, 1, Side.LEFT);
    this.pinB = inputPin(this, 'B', 0, 2, Side.LEFT);
    this.pinC = inputPin(this, 'C', 0, 3, Side.LEFT);
    this.pinG = inputPin(this, 'G', 0, 8, Side.LEFT);
    const pins = [this.pinA, this.pinB, this.pinC, this.pinG];
    this.outputs = [];
    for (let i = 0; i < 8; i++) {
      const p = outputPin(this, 'Y' + i, 4, i + 1, Side.RIGHT);
      this.outputs.push(p);
      pins.push(p);
    }
    return pins;
  }

  simulate(): void {
    if (this.isLow(this.pinG)) {
      for (const o of this.outputs) this.setPin(o, 'HIGH');
      return;
    }
    const address = (this.isHigh(this.pinC) ? 4 : 0) | (this.isHigh(this.pinB) ? 2 : 0) | (this.isHigh(this.pinA) ? 1 : 0);
    for (let i = 0; i < 8; i++) this.setPin(this.outputs[i], i === address ? 'LOW' : 'HIGH');
  }

  reset(): void {
    for (const o of this.outputs) o.setState('NOT_CONNECTED');
  }

  override getInstanceNamePrefix(): string {
    return 'DEK';
  }

  getGridWidth() { return 4; }
  getGridHeight() { return 9; }
  getName() { return 'DEK'; }
  getShortDescription() { return 'Dekodér 3→8 - G=1 vyberie výstup podľa CBA (aktívny 0), G=0 dá všetky výstupy do 1'; }
}

export class Encoder83 extends GateSymbol {
  readonly javaClassName = PKG + 'Encoder83';
  private pinEI!: Pin;
  private dataInputs: Pin[] = [];
  private outputEO!: Pin;
  private outputGS!: Pin;
  private outputA0!: Pin;
  private outputA1!: Pin;
  private outputA2!: Pin;

  protected createPins(): Pin[] {
    this.pinEI = inputPin(this, 'EI', 0, 1, Side.LEFT);
    const pins = [this.pinEI];
    this.dataInputs = [];
    for (let i = 0; i < 8; i++) {
      const p = inputPin(this, 'D' + i, 0, i + 2, Side.LEFT);
      this.dataInputs.push(p);
      pins.push(p);
    }
    this.outputEO = outputPin(this, 'EO', 4, 1, Side.RIGHT);
    this.outputGS = outputPin(this, 'GS', 4, 2, Side.RIGHT);
    this.outputA0 = outputPin(this, 'A0', 4, 4, Side.RIGHT);
    this.outputA1 = outputPin(this, 'A1', 4, 5, Side.RIGHT);
    this.outputA2 = outputPin(this, 'A2', 4, 6, Side.RIGHT);
    pins.push(this.outputEO, this.outputGS, this.outputA0, this.outputA1, this.outputA2);
    return pins;
  }

  simulate(): void {
    const all = (s: PinState) => {
      for (const p of [this.outputEO, this.outputGS, this.outputA0, this.outputA1, this.outputA2]) this.setPin(p, s);
    };
    if (this.isHigh(this.pinEI)) {
      all('HIGH');
      return;
    }
    let lowest = -1;
    for (let i = 0; i < 8; i++) {
      if (this.isLow(this.dataInputs[i])) {
        lowest = i;
        break;
      }
    }
    if (lowest < 0) {
      this.setPin(this.outputEO, 'LOW');
      this.setPin(this.outputGS, 'HIGH');
      this.setPin(this.outputA0, 'HIGH');
      this.setPin(this.outputA1, 'HIGH');
      this.setPin(this.outputA2, 'HIGH');
    } else {
      this.setPin(this.outputEO, 'HIGH');
      this.setPin(this.outputGS, 'LOW');
      this.setPin(this.outputA0, (lowest & 1) !== 0 ? 'HIGH' : 'LOW');
      this.setPin(this.outputA1, (lowest & 2) !== 0 ? 'HIGH' : 'LOW');
      this.setPin(this.outputA2, (lowest & 4) !== 0 ? 'HIGH' : 'LOW');
    }
  }

  /** Original uses setPin (not setPinForce) - kept. */
  reset(): void {
    for (const p of [this.outputEO, this.outputGS, this.outputA0, this.outputA1, this.outputA2]) this.setPin(p, 'NOT_CONNECTED');
  }

  override getInstanceNamePrefix(): string {
    return 'KOD';
  }

  getGridWidth() { return 4; }
  getGridHeight() { return 10; }
  getName() { return 'KOD'; }
  getShortDescription() {
    return 'Prioritný kóder 8→3 - EI=0: na A2A1A0 číslo najnižšieho vstupu s 0 (GS=0); bez nuly EO=0; EI=1 dá všetky výstupy do 1';
  }
}

/**
 * `RAMContentWindow.updateContent`: 16 bytes per row - left `%04X` address and `%02X` values,
 * right the ASCII characters (0x20-0x7E, others '.'), each value preceded by a space.
 */
export function ramContentText(memory: Int8Array): { hex: string; ascii: string } {
  const hex: string[] = [];
  const ascii: string[] = [];
  for (let addr = 0; addr < memory.length; addr += 16) {
    let h = addr.toString(16).toUpperCase().padStart(4, '0');
    let a = '';
    for (let i = 0; i < 16; i++) {
      const v = memory[addr + i] & 0xff;
      h += ' ' + v.toString(16).toUpperCase().padStart(2, '0');
      a += ' ' + (v >= 32 && v <= 126 ? String.fromCharCode(v) : '.');
    }
    hex.push(h + '\n');
    ascii.push(a + '\n');
  }
  return { hex: hex.join(''), ascii: ascii.join('') };
}

export type GateCtor = new (sheet: SchematicSheet) => GateSymbol;
