/**
 * Port of `SchematicSim.Gates.GateSymbol` (model part) + `SheetEvent` / `SheetChangeEvent`.
 *
 * Construction differs from Java only technically: Java calls the abstract `createPins()` from
 * the base constructor; in TypeScript subclass fields would be re-initialised after that, so the
 * sheet calls {@link GateSymbol.initialize} right after `new` (see `createGate`).
 */
import type { PotentialValue } from '../electrical/Potential';
import { Pin, type PinState } from '../Pin';
import type { SchematicSheet } from '../Sheet';
import { SheetItem } from '../SheetItem';

export abstract class GateSymbol extends SheetItem {
  private pins: Pin[] = [];
  private id: string | null = null;
  /** Instance name on the sheet (e.g. REG1) - null for components without a name. */
  private instanceName: string | null = null;

  constructor(sheet: SchematicSheet) {
    super(sheet);
  }

  /** = the part of the Java constructor after `super(sheet)`. Subclasses extend it (call super first). */
  initialize(): void {
    this.pins = this.createPins();
  }

  protected abstract createPins(): Pin[];
  abstract simulate(): void;
  abstract reset(): void;
  abstract getGridWidth(): number;
  abstract getGridHeight(): number;
  abstract getName(): string;
  abstract getShortDescription(): string;
  /** Fully qualified Java class name - used by the `.schx` format. */
  abstract readonly javaClassName: string;

  getId(): string | null {
    return this.id;
  }

  setId(id: string): void {
    this.id = id;
  }

  getPins(): Pin[] {
    return this.pins;
  }

  protected replacePins(pins: Pin[]): void {
    this.pins = pins;
  }

  /** Prefix of the automatic instance name (REG, DEK, KOD, RAM) - null for unnamed components. */
  getInstanceNamePrefix(): string | null {
    return null;
  }

  getInstanceName(): string | null {
    return this.instanceName;
  }

  setInstanceName(instanceName: string): void {
    this.instanceName = instanceName;
    this.visualChanged();
  }

  saveProperties(): Map<string, string> {
    if (this.instanceName === null) return new Map();
    return new Map([['name', this.instanceName]]);
  }

  loadProperties(properties: Map<string, string>): void {
    const name = properties.get('name');
    if (name !== undefined) this.setInstanceName(name);
  }

  // ---------------------------------------------------------------- simulation helpers

  /** Unconnected → false; floating (NC) net → its stable random level (Potential.getFloatingValue). */
  isHigh(inputPin: Pin | null): boolean {
    if (inputPin === null || !inputPin.isConnected()) return false;
    const potential = inputPin.getPotential();
    const value: PotentialValue = potential?.getValue() ?? 'NC';
    if (value === 'HIGH') {
      inputPin.setState('HIGH');
      return true;
    } else if (value === 'LOW') {
      inputPin.setState('LOW');
    } else {
      const high = potential !== null && potential.getFloatingValue();
      inputPin.setState(high ? 'HIGH' : 'LOW');
      return high;
    }
    return false;
  }

  isLow(inputPin: Pin | null): boolean {
    if (inputPin === null || !inputPin.isConnected()) return false;
    const potential = inputPin.getPotential();
    const value: PotentialValue = potential?.getValue() ?? 'NC';
    if (value === 'LOW') {
      inputPin.setState('LOW');
      return true;
    } else if (value === 'HIGH') {
      inputPin.setState('HIGH');
    } else {
      const low = !(potential !== null && potential.getFloatingValue());
      inputPin.setState(low ? 'LOW' : 'HIGH');
      return low;
    }
    return false;
  }

  setPin(pin: Pin, state: PinState): void {
    if (pin.getState() !== state) {
      pin.setState(state);
      this.postChangeEvent(pin, state);
    }
  }

  setPinForce(pin: Pin, state: PinState): void {
    pin.setState(state);
    this.postChangeEvent(pin, state);
  }

  private postChangeEvent(pin: Pin, state: PinState): void {
    const value: PotentialValue = state === 'HIGH' ? 'HIGH' : state === 'LOW' ? 'LOW' : 'NC';
    this.getSheet().addEvent(new SheetChangeEvent(pin, value));
  }

  override delete(): void {
    super.delete();
    for (const pin of this.pins) {
      const end = pin.getWireEnd();
      if (end !== null) end.getWire().delete();
    }
  }

  /** Notifies the view that visual state changed (LED lit etc.). */
  protected visualChanged(): void {
    this.getSheet().markChanged();
  }
}

/** Port of `SheetEvent`: re-simulate gates with inputs on the pin's net. */
export class SheetEvent {
  constructor(readonly pin: Pin | null) {}

  process(gatesToUpdate: Set<GateSymbol>): void {
    if (this.pin !== null) this.pin.getPotential()?.getGatesWithInputs(gatesToUpdate);
  }
}

/** Port of `SheetChangeEvent`: new value of an output pin. */
export class SheetChangeEvent extends SheetEvent {
  constructor(
    pin: Pin,
    readonly value: PotentialValue,
  ) {
    super(pin);
  }

  override process(gatesToUpdate: Set<GateSymbol>): void {
    const pin = this.pin;
    if (pin === null) return;
    const owned = pin.getOwnedPotential();
    const aggregate = pin.getPotential();
    if (aggregate === null) return;
    const oldValue = aggregate.getValue();
    if (owned.setValue(this.value)) {
      if (oldValue !== aggregate.getValue()) aggregate.getGatesWithInputs(gatesToUpdate);
    }
  }
}
