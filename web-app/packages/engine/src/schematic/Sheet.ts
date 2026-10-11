/**
 * Port of `SchematicSim.Sheet.SchematicSheet` + `SheetLayersManager` - model part (v0.9.4).
 * Zoom/pan/rubber-band gestures live in the view; their effects call the methods here.
 */
import type { Bus, Clock } from '../bus/Bus';
import { systemClock } from '../bus/Bus';
import { GridSystem, Point2D } from './geometry';
import type { GateSymbol, SheetEvent } from './gates/GateSymbol';
import { Pin } from './Pin';
import { GridOccupancy, SheetItem, remove } from './SheetItem';
import { Simulator } from './Simulator';
import { Wire, WireEnd, WireJunction, flushLater, type WireColor } from './wire/Wire';

export type Selectable = SheetItem | Wire;

/**
 * What a wire drop landed on (the picked scene node, resolved to the nearest model ancestor).
 * `wireEnd` = an end of a wire (carries its junction, if any).
 */
export type DropTarget =
  | { kind: 'pin'; pin: Pin }
  | { kind: 'gate'; gate: GateSymbol }
  | { kind: 'junction'; junction: WireJunction }
  | { kind: 'wireEnd'; end: WireEnd }
  | { kind: 'wire'; wire: Wire }
  | { kind: 'background' }
  | { kind: 'none' };

interface CopiedGate {
  source: GateSymbol;
  factory: (sheet: SchematicSheet) => GateSymbol;
  properties: Map<string, string>;
  relX: number;
  relY: number;
}

/** A copied wire end: a pin (gate + index), or a junction / free end with its position. */
interface CopiedEnd {
  gate: GateSymbol | null;
  pinIndex: number;
  junction: boolean;
  position: Point2D;
}

interface CopiedWire {
  color: WireColor;
  ends: [CopiedEnd, CopiedEnd];
}

/** Distance (px) between a wire end drop and the nearest wire that still connects. */
const WIRE_DROP_TOLERANCE = 5;

/** Creates a gate the way the Java reflection `getConstructor(SchematicSheet).newInstance(sheet)` did. */
export function createGate<T extends GateSymbol>(ctor: new (sheet: SchematicSheet) => T, sheet: SchematicSheet): T {
  const gate = new ctor(sheet);
  gate.initialize();
  return gate;
}

export class SchematicSheet {
  /**
   * Fixed component drawing cell (px). The sheet grid (lines, wire and gate snapping) may be finer;
   * components keep their body size and pin spacing.
   */
  static readonly COMPONENT_CELL = 20;

  readonly simulator: Simulator;
  private readonly grid: GridSystem;
  private readonly occupancy = new GridOccupancy();

  private readonly gates: GateSymbol[] = [];
  private readonly wires: Wire[] = [];
  private readonly junctions: WireJunction[] = [];
  private readonly selected: Selectable[] = [];

  private addingItem: GateSymbol | null = null;
  private clipboardGates: CopiedGate[] = [];
  private clipboardWires: CopiedWire[] = [];
  private clipboardBaseX = 0;
  private clipboardBaseY = 0;

  private changed = false;
  private editingEnabled = true;
  private debugWires = false;
  private scale = 1;
  /** `Pin.creatingWire`: the wire being drawn. */
  private inProgressWire: Wire | null = null;

  /** View change notification (coalesced by the view). */
  version = 0;
  private readonly listeners: (() => void)[] = [];

  constructor(
    readonly widthPx: number,
    readonly heightPx: number,
    gridSizePx: number,
    readonly bus: Bus,
    readonly clock: Clock = systemClock,
  ) {
    this.grid = new GridSystem(gridSizePx);
    this.simulator = new Simulator(bus, clock);
  }

  // ---------------------------------------------------------------- change notification

  /** View notification only (does NOT mark the scheme modified - see {@link setChanged}). */
  markChanged(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void): () => void {
    this.listeners.push(l);
    return () => remove(this.listeners, l);
  }

  // ---------------------------------------------------------------- basic accessors

  getGrid(): GridSystem {
    return this.grid;
  }

  getComponentCell(): number {
    return SchematicSheet.COMPONENT_CELL;
  }

  getOccupancy(): GridOccupancy {
    return this.occupancy;
  }

  getAppliedScale(): number {
    return this.scale;
  }

  setAppliedScale(scale: number): void {
    this.scale = scale;
    this.markChanged();
  }

  hasChanged(): boolean {
    return this.changed;
  }

  clearChange(): void {
    this.changed = false;
  }

  /** Java `markChanged()` / palette drag-enter: marks the scheme modified. */
  setChanged(): void {
    this.changed = true;
  }

  getGates(): GateSymbol[] {
    return [...this.gates];
  }

  getWires(): Wire[] {
    return [...this.wires];
  }

  getJunctions(): WireJunction[] {
    return [...this.junctions];
  }

  getInProgressWire(): Wire | null {
    return this.inProgressWire;
  }

  // ---------------------------------------------------------------- items (SheetLayersManager)

  private nextGateId(): number {
    for (let id = 0; ; id++) {
      if (!this.gates.some((g) => g.getId() === 'g' + id)) return id;
    }
  }

  addItem(item: GateSymbol | Wire): boolean {
    this.changed = true;
    if (item instanceof Wire) {
      item.setDebugColored(this.debugWires);
      item.attached = true;
      this.wires.push(item);
      this.markChanged();
      return true;
    }
    const prefix = item.getInstanceNamePrefix();
    if (prefix !== null && item.getInstanceName() === null) item.setInstanceName(this.nextComponentName(prefix));
    if (item.getId() === null) item.setId('g' + this.nextGateId());
    this.gates.push(item);
    this.markChanged();
    return true;
  }

  /** Smallest unused number for the prefix among the components on the sheet (REG1, REG2, ...). */
  private nextComponentName(prefix: string): string {
    const used = new Set<number>();
    for (const gate of this.gates) {
      const name = gate.getInstanceName();
      if (name !== null && name.startsWith(prefix)) {
        const suffix = name.substring(prefix.length);
        if (/^\d+$/.test(suffix)) used.add(Number.parseInt(suffix, 10));
      }
    }
    let index = 1;
    while (used.has(index)) index++;
    return prefix + index;
  }

  removeItem(item: SheetItem | Wire): boolean {
    this.changed = true;
    let result = false;
    if (item instanceof Wire) {
      item.attached = false;
      remove(this.wires, item);
      result = true;
    } else if (item instanceof WireJunction) {
      item.delete();
      result = true;
    } else if (isGate(item)) {
      this.occupancy.free(item);
      remove(this.gates, item);
      result = true;
    }
    this.markChanged();
    return result;
  }

  registerJunction(j: WireJunction): void {
    if (!this.junctions.includes(j)) this.junctions.push(j);
    this.markChanged();
  }

  unregisterJunction(j: WireJunction): void {
    remove(this.junctions, j);
    this.markChanged();
  }

  clearSheet(): void {
    if (this.inProgressWire !== null) this.inProgressWire = null;
    WireEnd.resetGrab();
    [...this.wires].forEach((w) => w.delete());
    [...this.gates].forEach((g) => g.delete());
    this.occupancy.clear();
  }

  // ---------------------------------------------------------------- palette drop (drag from ItemPicker)

  /** MOUSE_DRAG_ENTERED on the sheet with a palette item. */
  beginAdding(factory: (sheet: SchematicSheet) => GateSymbol): GateSymbol | null {
    if (!this.isEditingEnabled()) return null;
    this.changed = true;
    if (this.addingItem !== null) return this.addingItem;
    this.addingItem = factory(this);
    this.addItem(this.addingItem);
    return this.addingItem;
  }

  getAddingItem(): GateSymbol | null {
    return this.addingItem;
  }

  /** MOUSE_DRAG_RELEASED: the gate is kept (no occupancy check since 0.9.4) and released. */
  finishAdding(): GateSymbol | null {
    const item = this.addingItem;
    if (item === null) return null;
    this.addingItem = null;
    this.occupancy.occupy(item);
    this.releaseGate(item);
    return item;
  }

  /** MOUSE_DRAG_EXITED: discard. */
  cancelAdding(): void {
    if (this.addingItem !== null) {
      this.addingItem.delete();
      this.addingItem = null;
    }
  }

  // ---------------------------------------------------------------- component drag (Movable)

  /** A drag step of a component started (Movable MOUSE_DRAGGED). */
  beginComponentDrag(): void {
    SheetItem.componentDragging = true;
  }

  /**
   * Primary-button release on a gate: junctions postponed during the drag are resolved
   * (Movable), then free wire ends under the moved pins are connected (GateSymbol).
   */
  releaseGate(gate: GateSymbol): void {
    if (SheetItem.componentDragging) {
      SheetItem.componentDragging = false;
      for (const junction of this.getJunctions()) WireJunction.markDirty(junction);
      WireJunction.processNow();
    }
    if (!this.isEditingEnabled()) return;
    const moved: GateSymbol[] = [];
    if (gate.isSelected()) moved.push(...this.getSelectedGates());
    if (!moved.includes(gate)) moved.push(gate);
    const pins: Pin[] = [];
    for (const g of moved) pins.push(...g.getPins());
    Wire.connectFreeEndsToPins(this, pins);
  }

  // ---------------------------------------------------------------- wires in progress (Pin.creatingWire)

  /** `Pin.beginWireCreation`: new wire from a pin or a junction, with the L preview anchored there. */
  beginWireCreation(source: Pin | WireJunction): Wire {
    const wire = new Wire(source);
    wire.mouseTransparent = true;
    wire.opacity = 0.5;
    this.inProgressWire = wire;
    this.addItem(wire);
    const anchor = wire.getEnds()[0].getConnectionPoint();
    wire.getEnds()[1].moveToPx(anchor.x, anchor.y);
    wire.beginPreview(0, null);
    return wire;
  }

  /**
   * `Pin.finishInProgressWire`: preview off, geometry settled. An unfinished drag keeps the wire
   * with a free end; only a zero-length wire (release at the creation spot) is removed. Idempotent.
   */
  finishInProgressWire(): void {
    const wire = this.inProgressWire;
    if (wire === null) return;
    this.inProgressWire = null;

    wire.endPreview();
    wire.mouseTransparent = false;
    wire.opacity = 1;

    if (!wire.attached) {
      this.markChanged();
      return;
    }
    wire.completeCreation();

    if (!wire.areBothEndsConnected()) {
      const start = wire.getEnds()[0].getConnectionPoint();
      const finish = wire.getEnds()[1].getConnectionPoint();
      if (start.distance(finish) < 1e-6) wire.delete();
    }
    for (const end of wire.getEnds()) {
      const junction = end.getJunction();
      if (junction !== null) WireJunction.markDirty(junction);
    }
    this.markChanged();
  }

  /** Drag step of the wire in progress or of a grabbed end. */
  dragWire(sheetXY: Point2D): void {
    if (this.inProgressWire !== null) this.inProgressWire.updateCreationDrag(sheetXY.x, sheetXY.y);
    else WireEnd.moveGrabbed(sheetXY.x, sheetXY.y);
  }

  /** `Pin.onMouseDragReleased`: the drag was released over `pin` (`source` = pin the drag began on). */
  dropOnPin(pin: Pin, source: Pin | null): void {
    const creating = this.inProgressWire;
    if (creating !== null) {
      if (pin !== source) creating.catchFreeEnd().connect(pin);
      else creating.delete();
    } else if (WireEnd.getGrabbedEnd() !== null) {
      if (pin !== source) WireEnd.getGrabbedEnd()!.connect(pin);
    }
  }

  /**
   * Scene-level MOUSE_RELEASED filter (`setupWireToWireHandler`) for a wire in progress or a
   * grabbed end. Resolution order: pin/gate (left to their own handlers) → junction → free end
   * of another wire → wire (split) → nearest wire around an empty-space drop → nothing.
   *
   * @returns true if the release was consumed (source handlers must not run)
   */
  resolveWireDrop(target: DropTarget, sheetXY: Point2D): boolean {
    const inProgress = this.inProgressWire;
    const grabbed = WireEnd.getGrabbedEnd();
    if (inProgress === null && grabbed === null) return false;

    const own = inProgress !== null ? inProgress : grabbed!.getWire();
    const freeEnd = inProgress !== null ? inProgress.catchFreeEnd() : grabbed!;

    if (target.kind === 'pin' || target.kind === 'gate') return false;

    const gridMin = this.grid.getSizeMin();
    const snapPoint = new Point2D(Math.round(sheetXY.x / gridMin) * gridMin, Math.round(sheetXY.y / gridMin) * gridMin);

    // 1) junction (visible, or an end of a wire sitting on a junction)
    let junctionTarget: WireJunction | null = null;
    if (target.kind === 'junction') junctionTarget = target.junction.isRemoved() ? null : target.junction;
    else if (target.kind === 'wireEnd') junctionTarget = target.end.getJunction();
    if (junctionTarget === null) junctionTarget = WireJunction.findNear(this, sheetXY, gridMin / 2.0);
    if (junctionTarget !== null) {
      if (inProgress !== null && junctionTarget === inProgress.getStartJunction()) {
        this.finishInProgressWire();
        return true;
      }
      if (junctionTarget === freeEnd.getJunction()) return false;
      freeEnd.connect(junctionTarget);
      this.finishWireDrop(inProgress);
      return true;
    }

    // 2) free end of another wire nearby = shared junction
    const shared = this.findFreeEndNear(own, snapPoint, gridMin / 2.0);
    if (shared !== null) {
      freeEnd.connect(shared);
      this.finishWireDrop(inProgress);
      return true;
    }

    // 3) dropped right on a wire = split there
    if (target.kind === 'wire') {
      if (target.wire === own) {
        this.finishInProgressWire();
        WireEnd.finishGrab();
        return false;
      }
      const junction = target.wire.splitAtPoint(sheetXY);
      if (junction !== null) {
        freeEnd.connect(junction);
        this.finishWireDrop(inProgress);
        return true;
      }
    }

    // 4) empty space near a wire
    if (target.kind === 'background') {
      const nearest = this.findNearestWire(own, sheetXY);
      if (nearest !== null) {
        const junction = nearest.splitAtPoint(sheetXY);
        if (junction !== null) {
          freeEnd.connect(junction);
          this.finishWireDrop(inProgress);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Source MOUSE_RELEASED handlers (Pin / WireEnd / WireJunction / Wire): finish the wire in
   * progress or the grab. Call after {@link resolveWireDrop} when it did not consume the release.
   */
  releaseWireDrag(): void {
    if (this.inProgressWire !== null) this.finishInProgressWire();
    else WireEnd.finishGrab();
  }

  isWireDragActive(): boolean {
    return this.inProgressWire !== null || WireEnd.getGrabbedEnd() !== null;
  }

  private findFreeEndNear(exclude: Wire, point: Point2D, tolerance: number): WireJunction | null {
    for (const wire of this.getWires()) {
      if (wire === exclude || wire.isPreview()) continue;
      for (const end of wire.getEnds()) {
        if (end.isConnected()) continue;
        if (end.getConnectionPoint().distance(point) <= tolerance) {
          const junction = WireJunction.at(this, point.x, point.y);
          end.connect(junction);
          return junction;
        }
      }
    }
    return null;
  }

  private findNearestWire(exclude: Wire, sheetXY: Point2D): Wire | null {
    let bestWire: Wire | null = null;
    let bestDist = Number.MAX_VALUE;
    for (const wire of this.getWires()) {
      if (wire === exclude) continue;
      const dist = wire.distanceToPoint(sheetXY);
      if (dist < bestDist) {
        bestDist = dist;
        bestWire = wire;
      }
    }
    if (bestWire === null || bestDist > WIRE_DROP_TOLERANCE) return null;
    return bestWire;
  }

  private finishWireDrop(inProgress: Wire | null): void {
    if (inProgress !== null) this.finishInProgressWire();
    else WireEnd.finishGrab();
  }

  /** Runs postponed geometry work now (the view calls it at the end of a gesture; tests after steps). */
  settle(): void {
    flushLater();
  }

  // ---------------------------------------------------------------- selection

  addSelect(item: Selectable): boolean {
    if (!this.selected.includes(item)) {
      item.select();
      this.selected.push(item);
      return true;
    }
    return false;
  }

  removeSelect(item: Selectable): boolean {
    item.deselect();
    return remove(this.selected, item);
  }

  clearSelect(): void {
    this.selected.forEach((s) => s.deselect());
    this.selected.length = 0;
  }

  getSelected(): Selectable[] {
    return [...this.selected];
  }

  deleteSelect(): void {
    if (!this.isEditingEnabled()) return;
    [...this.selected].forEach((s) => s.delete());
    for (let i = this.selected.length - 1; i >= 0; i--) {
      if (!this.isAttached(this.selected[i])) this.selected.splice(i, 1);
    }
  }

  private isAttached(item: Selectable): boolean {
    if (item instanceof Wire) return item.attached;
    if (isGate(item)) return this.gates.includes(item);
    return true;
  }

  getSelectedGates(): GateSymbol[] {
    return this.selected.filter(isGate);
  }

  // ---------------------------------------------------------------- copy / paste

  /**
   * Ctrl+C. Gates are copied with their properties (except the instance name) and relative grid
   * offsets. Selected wires are copied with all end kinds (pin, junction) as a closure over
   * junctions: neighbours of copied junctions are added, wires left hanging alone are dropped.
   */
  copySelection(): void {
    if (!this.isEditingEnabled()) return;
    const gates = this.getSelectedGates();
    const selectedWires = this.selected.filter((s): s is Wire => s instanceof Wire);
    this.clipboardGates = [];
    this.clipboardWires = [];
    if (gates.length === 0) return;

    let minX = Number.MAX_SAFE_INTEGER;
    let minY = Number.MAX_SAFE_INTEGER;
    for (const g of gates) {
      minX = Math.min(minX, g.getGridPosX());
      minY = Math.min(minY, g.getGridPosY());
    }
    this.clipboardBaseX = minX;
    this.clipboardBaseY = minY;
    for (const g of gates) {
      const ctor = g.constructor as new (sheet: SchematicSheet) => GateSymbol;
      const properties = new Map(g.saveProperties());
      properties.delete('name');
      this.clipboardGates.push({
        source: g,
        factory: (sheet) => createGate(ctor, sheet),
        properties,
        relX: g.getGridPosX() - minX,
        relY: g.getGridPosY() - minY,
      });
    }

    for (const wire of this.collectCopyableWires(selectedWires)) {
      this.clipboardWires.push({ color: wire.getColor(), ends: [copyEnd(wire.getEnds()[0]), copyEnd(wire.getEnds()[1])] });
    }
  }

  private isWireCopyable(wire: Wire, copiedGates: Set<GateSymbol>): boolean {
    for (const end of wire.getEnds()) {
      const pin = end.getPin();
      if (pin !== null) {
        if (!copiedGates.has(pin.getOwner())) return false;
      } else if (end.getJunction() === null) {
        return false;
      }
    }
    return true;
  }

  private collectCopyableWires(selectedWires: Wire[]): Wire[] {
    const copiedGates = new Set<GateSymbol>(this.clipboardGates.map((c) => c.source));
    const result: Wire[] = [];
    for (const wire of selectedWires) {
      if (wire.attached && this.isWireCopyable(wire, copiedGates)) result.push(wire);
    }

    const dropped = new Set<Wire>();
    let changed = true;
    while (changed) {
      changed = false;

      const add: Wire[] = [];
      for (const wire of result) {
        for (const end of wire.getEnds()) {
          const junction = end.getJunction();
          if (junction === null) continue;
          for (const neighbour of junction.getConnectedWires()) {
            if (!result.includes(neighbour) && !dropped.has(neighbour) && !add.includes(neighbour) && this.isWireCopyable(neighbour, copiedGates)) {
              add.push(neighbour);
            }
          }
        }
      }
      if (add.length > 0) {
        result.push(...add);
        changed = true;
      }

      const removeList: Wire[] = [];
      for (const junction of junctionsOf(result)) {
        const atJunction = junction.getConnectedWires();
        let lone: Wire | null = null;
        let inside = 0;
        for (const wire of atJunction) {
          if (result.includes(wire)) {
            inside++;
            lone = wire;
          }
        }
        if (atJunction.length >= 2 && inside === 1 && !removeList.includes(lone!)) removeList.push(lone!);
      }
      if (removeList.length > 0) {
        for (const w of removeList) {
          remove(result, w);
          dropped.add(w);
        }
        changed = true;
      }
    }
    return result;
  }

  /**
   * Ctrl+V at the last mouse grid position (or 2,2). Junction ends are resolved in a second pass,
   * sharing one junction per position (like {@link SchemeLoader}); finished wires settle to the grid.
   */
  pasteClipboard(mouseGrid: Point2D | null): void {
    if (!this.isEditingEnabled()) return;
    if (this.clipboardGates.length === 0 && this.clipboardWires.length === 0) return;

    const target = mouseGrid ?? new Point2D(2, 2);
    const targetX = Math.round(target.x);
    const targetY = Math.round(target.y);

    const cloneBySource = new Map<GateSymbol, GateSymbol>();
    this.clearSelect();
    for (const copied of this.clipboardGates) {
      const clone = copied.factory(this);
      this.addItem(clone);
      clone.moveTo(targetX + copied.relX, targetY + copied.relY);
      clone.loadProperties(copied.properties);
      this.occupancy.occupy(clone);
      this.addSelect(clone);
      cloneBySource.set(copied.source, clone);
    }

    const deltaPx = (targetX - this.clipboardBaseX) * this.grid.sizeX;
    const deltaPy = (targetY - this.clipboardBaseY) * this.grid.sizeY;

    const hubByKey = new Map<number, WireJunction>();
    const pastedWires: Wire[] = [];
    const pendingEnds: { end: WireEnd; x: number; y: number }[] = [];

    for (const copied of this.clipboardWires) {
      const pins: (Pin | null)[] = [null, null];
      let resolvable = true;
      for (let i = 0; i < 2; i++) {
        if (copied.ends[i].gate === null) continue;
        pins[i] = clonePin(copied.ends[i], cloneBySource);
        if (pins[i] === null) {
          resolvable = false;
          break;
        }
      }
      if (!resolvable) continue;

      const wire = new Wire(this);
      this.addItem(wire);
      wire.changeColor(copied.color);
      pastedWires.push(wire);

      const ends = wire.getEnds();
      for (let i = 0; i < 2; i++) {
        const source = copied.ends[i];
        if (source.gate !== null) {
          ends[i].connect(pins[i]);
        } else {
          const x = source.position.x + deltaPx;
          const y = source.position.y + deltaPy;
          ends[i].moveToPx(x, y);
          if (source.junction) pendingEnds.push({ end: ends[i], x, y });
        }
      }
    }

    for (const pending of pendingEnds) this.resolveJunctionEnd(pending, pastedWires, hubByKey);
    for (const wire of pastedWires) wire.settleToGrid();
  }

  private resolveJunctionEnd(pending: { end: WireEnd; x: number; y: number }, pastedWires: Wire[], hubByKey: Map<number, WireJunction>): void {
    const key = junctionKey(pending.x, pending.y);
    const position = new Point2D(pending.x, pending.y);

    const shared = hubByKey.get(key);
    if (shared !== undefined && !shared.isRemoved()) {
      pending.end.connect(shared);
      return;
    }
    for (const wire of pastedWires) {
      if (wire === pending.end.getWire()) continue;
      for (const end of wire.getEnds()) {
        const existing = end.getJunction();
        if (existing !== null && junctionKey(existing.getLayoutX(), existing.getLayoutY()) === key) {
          hubByKey.set(key, existing);
          pending.end.connect(existing);
          return;
        }
      }
    }
    const grid = this.grid.getSizeMin();
    for (const wire of pastedWires) {
      if (wire === pending.end.getWire()) continue;
      if (wire.distanceToPoint(position) <= grid / 2.0) {
        const created = wire.splitAtPoint(position);
        if (created !== null) {
          hubByKey.set(key, created);
          pending.end.connect(created);
          return;
        }
      }
    }
    const standalone = WireJunction.at(this, pending.x, pending.y);
    hubByKey.set(key, standalone);
    pending.end.connect(standalone);
  }

  // ---------------------------------------------------------------- simulation

  powerOn(): void {
    if (!this.simulator.isRunning()) this.simulator.start(this.getGates());
  }

  powerOff(): void {
    this.simulator.stop();
  }

  isSimulationRunning(): boolean {
    return this.simulator.isRunning();
  }

  addEvent(event: SheetEvent): void {
    this.simulator.addEvent(event);
  }

  isEditingEnabled(): boolean {
    return this.editingEnabled;
  }

  setEditingEnabled(enabled: boolean): void {
    this.editingEnabled = enabled;
    this.markChanged();
  }

  isDebugWires(): boolean {
    return this.debugWires;
  }

  setDebugWires(debug: boolean): void {
    this.debugWires = debug;
    for (const wire of this.wires) wire.setDebugColored(debug);
  }
}

function isGate(item: unknown): item is GateSymbol {
  return item instanceof SheetItem && typeof (item as GateSymbol).getPins === 'function';
}

function copyEnd(end: WireEnd): CopiedEnd {
  const pin = end.getPin();
  if (pin !== null) {
    const owner = pin.getOwner();
    return { gate: owner, pinIndex: owner.getPins().indexOf(pin), junction: false, position: new Point2D(end.getLayoutX(), end.getLayoutY()) };
  }
  const junction = end.getJunction();
  if (junction !== null) {
    return { gate: null, pinIndex: -1, junction: true, position: new Point2D(junction.getLayoutX(), junction.getLayoutY()) };
  }
  return { gate: null, pinIndex: -1, junction: false, position: new Point2D(end.getLayoutX(), end.getLayoutY()) };
}

function junctionsOf(wires: Wire[]): WireJunction[] {
  const junctions: WireJunction[] = [];
  for (const wire of wires) {
    for (const end of wire.getEnds()) {
      const junction = end.getJunction();
      if (junction !== null && !junctions.includes(junction)) junctions.push(junction);
    }
  }
  return junctions;
}

/** Position key for sharing a junction between the ends of different wires (Java `Math.round`). */
export function junctionKey(x: number, y: number): number {
  return Math.floor(x + 0.5) * 1000003 + Math.floor(y + 0.5);
}

function clonePin(source: CopiedEnd, cloneBySource: Map<GateSymbol, GateSymbol>): Pin | null {
  if (source.gate === null) return null;
  const clone = cloneBySource.get(source.gate);
  if (clone === undefined) return null;
  if (source.pinIndex < 0 || source.pinIndex >= clone.getPins().length) return null;
  return clone.getPins()[source.pinIndex];
}
