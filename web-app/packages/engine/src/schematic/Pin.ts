/**
 * Port of `SchematicSim.Pin.Pin` (+ InputPin / OutputPin) - model part.
 * A pin carries its own leaf {@link Potential} and is the direct end point of a wire.
 */
import { HIGHLIGHT, Potential, type Connectable, type PinType } from './electrical/Potential';
import type { GateSymbol } from './gates/GateSymbol';
import { Point2D, type Side } from './geometry';
import type { WireEnd } from './wire/Wire';

export type Direction = 'INPUT' | 'OUTPUT' | 'INOUT';
export type PinState = 'HIGH' | 'LOW' | 'HIGH_IMPEDANCE' | 'NOT_CONNECTED';

export class Pin implements Connectable {
  private readonly potential: Potential;
  private state: PinState = 'NOT_CONNECTED';
  private connectedWireEnd: WireEnd | null = null;
  private readonly activeHighlights = [false, false, false, false, false];

  /** Position relative to the owner (px). */
  private layoutX: number;
  private layoutY: number;

  constructor(
    private readonly owner: GateSymbol,
    readonly name: string,
    readonly direction: Direction,
    readonly gridOffsetX: number,
    readonly gridOffsetY: number,
    private side: Side,
  ) {
    this.potential = new Potential(this, null);
    this.potential.setType(defaultTypeFor(direction));
    const gridPx = owner.getSheet().getComponentCell();
    this.layoutX = gridOffsetX * gridPx;
    this.layoutY = gridOffsetY * gridPx;
  }

  getOwner(): GateSymbol {
    return this.owner;
  }

  getName(): string {
    return this.name;
  }

  getState(): PinState {
    return this.state;
  }

  /** Does NOT change the potential - GateSymbol.setPin posts the change event. */
  setState(state: PinState): void {
    this.state = state;
  }

  isConnected(): boolean {
    return this.connectedWireEnd !== null;
  }

  getPotential(): Potential | null {
    // null while the pin's own Potential is being constructed (it calls back here)
    return this.potential !== undefined ? this.potential.getPotential() : null;
  }

  /** The pin's own leaf potential (value changes are written here). */
  getOwnedPotential(): Potential {
    return this.potential;
  }

  getLayoutX(): number {
    return this.layoutX;
  }

  getLayoutY(): number {
    return this.layoutY;
  }

  setLayoutX(x: number): void {
    this.layoutX = x;
    this.owner.getSheet().markChanged();
  }

  setLayoutY(y: number): void {
    this.layoutY = y;
    this.owner.getSheet().markChanged();
  }

  /** Position in sheet coordinates (`getSceneGridPosition() / appliedScale` in the original). */
  getSceneGridPosition(): Point2D {
    return new Point2D(this.owner.getLayoutX() + this.layoutX, this.owner.getLayoutY() + this.layoutY);
  }

  getExitSide(): Side {
    return this.side;
  }

  setSide(side: Side): void {
    this.side = side;
  }

  isOccupied(): boolean {
    return this.connectedWireEnd !== null;
  }

  setWireEnd(end: WireEnd): void {
    this.connectedWireEnd = end;
  }

  getWireEnd(): WireEnd | null {
    return this.connectedWireEnd;
  }

  clearWireEnd(): void {
    this.connectedWireEnd = null;
  }

  highlight(type: number): void {
    this.activeHighlights[type] = true;
    this.owner.getSheet().markChanged();
  }

  unhighlight(type: number): void {
    this.activeHighlights[type] = false;
    this.owner.getSheet().markChanged();
  }

  /** Colour/opacity of the highlight halo (Pin.updateHighlight). */
  getHighlight(): { color: string; opacity: number } {
    const h = this.activeHighlights;
    if (h[HIGHLIGHT.WARNING]) return { color: 'red', opacity: 0.8 };
    if (h[HIGHLIGHT.COMMON_POTENTIAL] || h[HIGHLIGHT.COMMON_POTENTIAL_OTHER]) return { color: 'yellow', opacity: 0.5 };
    if (h[HIGHLIGHT.OK]) return { color: 'green', opacity: 0.5 };
    if (h[HIGHLIGHT.INFO]) return { color: 'orange', opacity: 0.5 };
    return { color: 'white', opacity: 0 };
  }
}

function defaultTypeFor(d: Direction): PinType {
  switch (d) {
    case 'INPUT':
      return 'IN';
    case 'OUTPUT':
      return 'OUT';
    default:
      return 'IO';
  }
}
