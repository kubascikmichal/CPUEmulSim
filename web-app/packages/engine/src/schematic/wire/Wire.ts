/**
 * Ports of `SchematicSim.Wire.{Joint, WireEnd, WireJunction, Wire}` (v0.9.4 wire model) - model part.
 *
 * A wire is ALWAYS one straight horizontal or vertical segment. Bends are separate wires meeting
 * at an ownerless junction hub (degree 2 = invisible joint, 3+ = visible dot). During creation or
 * while an end is dragged, an L-shaped preview is drawn ({@link Wire.getLines}).
 *
 * Kept in one module because the classes are mutually dependent. Logic is ported method by
 * method. JavaFX scene-graph membership (`getParent() != null`) is modelled by the explicit
 * `attached` flag (wires) and the sheet's junction registry (junctions); `Platform.runLater` by
 * {@link runLater} (an ordered queue drained after the current event, or by {@link flushLater}).
 * Mouse handlers live in the view and call the methods here.
 */
import { Potential } from '../electrical/Potential';
import { Point2D, type Side } from '../geometry';
import type { Pin } from '../Pin';
import type { SchematicSheet } from '../Sheet';
import { SheetItem, type Listener } from '../SheetItem';
import { SheetEvent } from '../gates/GateSymbol';

export type WireColor = string; // '#RRGGBB'
export const DEFAULT_WIRE_COLOR: WireColor = '#000000';
const DEBUG_Z_COLOR = '#808080';
const DEBUG_LOW_COLOR = '#0000FF';
const DEBUG_HIGH_COLOR = '#FF0000';

/** Tolerance for end alignment (positions are multiples of the grid). */
const ALIGN_EPS = 0.5;

// ==================================================================== runLater

const laterQueue: (() => void)[] = [];
let laterScheduled = false;

/** `Platform.runLater`: runs after the current event handler, in posting order. */
export function runLater(fn: () => void): void {
  laterQueue.push(fn);
  if (laterScheduled) return;
  laterScheduled = true;
  queueMicrotask(() => {
    laterScheduled = false;
    flushLater();
  });
}

/** Runs every pending {@link runLater} task now (tests, loader, the end of a view gesture). */
export function flushLater(): void {
  let guard = 0;
  while (laterQueue.length > 0 && guard++ < 100000) laterQueue.shift()!();
}

// ==================================================================== Joint

export class Joint extends SheetItem {
  constructor(
    sheet: SchematicSheet,
    private readonly wire: Wire | null,
  ) {
    super(sheet);
  }

  /** The wire this joint belongs to (null for a {@link WireJunction}). */
  getWire(): Wire | null {
    return this.wire;
  }

  getConnectionPoint(): Point2D {
    return new Point2D(this.getLayoutX(), this.getLayoutY());
  }

  getExitSide(): Side | null {
    return null;
  }
}

// ==================================================================== WireEnd

export class WireEnd extends Joint {
  private pin: Pin | null = null;
  private junction: WireJunction | null = null;
  private lastPosX = -1;
  private lastPosY = -1;

  /** Grabbed wire end (dragged off its pin), null if none. */
  private static grabbedEnd: WireEnd | null = null;
  /** Pin the end was grabbed from - to return to it after a micro-drag. */
  private static grabSourcePin: Pin | null = null;

  /** The owner of the pin moved: follow the pin. */
  private readonly pinPositionChangeListener: Listener = () => {
    if (this.lastPosX === -1) {
      this.lastPosX = this.getLayoutX();
      this.lastPosY = this.getLayoutY();
    }
    const p = this.pin!.getSceneGridPosition();
    this.setLayoutX(p.x);
    this.setLayoutY(p.y);
    this.getWire().onEndMoved(this, this.getLayoutX() - this.lastPosX, this.getLayoutY() - this.lastPosY);
    this.lastPosX = this.getLayoutX();
    this.lastPosY = this.getLayoutY();
  };

  /** The junction moved: follow it. */
  private readonly junctionPositionChangeListener: Listener = () => {
    if (this.junction === null) return;
    const deltaX = this.junction.getLayoutX() - this.lastPosX;
    const deltaY = this.junction.getLayoutY() - this.lastPosY;
    this.setLayoutX(this.junction.getLayoutX());
    this.setLayoutY(this.junction.getLayoutY());
    WireJunction.markDirty(this.junction);
    this.getWire().onJunctionMoved(this, deltaX, deltaY);
    this.lastPosX = this.getLayoutX();
    this.lastPosY = this.getLayoutY();
  };

  constructor(sheet: SchematicSheet, wire: Wire) {
    super(sheet, wire);
  }

  override getWire(): Wire {
    return super.getWire()!;
  }

  /**
   * Drag start on this end (DRAG_DETECTED). On a pin: grab the end (preview, the other end stays);
   * on a junction: a new branch from it; free: a junction is founded here and a branch drawn from it.
   */
  beginDrag(): void {
    if (!this.getSheet().isEditingEnabled()) return;
    if (this.pin !== null) {
      WireEnd.beginGrab(this);
    } else if (this.junction !== null) {
      this.getSheet().beginWireCreation(this.junction);
    } else {
      const start = WireJunction.at(this.getSheet(), this.getConnectionPoint());
      this.connect(start);
      this.getSheet().beginWireCreation(start);
    }
  }

  // ---------------------------------------------------------------- grab

  static beginGrab(end: WireEnd | null): void {
    if (WireEnd.grabbedEnd !== null || end === null) return;
    WireEnd.grabbedEnd = end;
    WireEnd.grabSourcePin = end.pin;
    if (end.pin !== null) end.disconnect();

    const wire = end.getWire();
    const index = wire.getEnds()[0] === end ? 0 : 1;
    wire.mouseTransparent = true;
    wire.opacity = 0.5;
    wire.beginPreview(1 - index, wire.isHorizontal());
  }

  static moveGrabbed(x: number, y: number): boolean {
    if (WireEnd.grabbedEnd === null) return false;
    WireEnd.grabbedEnd.getWire().updateCreationDrag(x, y);
    return true;
  }

  /** End of the grab. Idempotent: restores the look, returns to the source pin after a micro-drag. */
  static finishGrab(): void {
    const end = WireEnd.grabbedEnd;
    if (end === null) return;
    WireEnd.grabbedEnd = null;
    const sourcePin = WireEnd.grabSourcePin;
    WireEnd.grabSourcePin = null;

    const wire = end.getWire();
    wire.endPreview();
    wire.mouseTransparent = false;
    wire.opacity = 1;

    if (!end.isConnected() && sourcePin !== null && !sourcePin.isOccupied()) {
      const p = sourcePin.getSceneGridPosition();
      const grid = wire.getSheet().getGrid().getSizeMin();
      if (end.getConnectionPoint().distance(p.x, p.y) <= grid / 2.0) end.connect(sourcePin);
    }
    wire.scheduleSettle(end);
  }

  static getGrabbedEnd(): WireEnd | null {
    return WireEnd.grabbedEnd;
  }

  static isGrabbing(wire: Wire): boolean {
    return WireEnd.grabbedEnd !== null && WireEnd.grabbedEnd.getWire() === wire;
  }

  /** Drops any grab without side effects (sheet cleared / tests). */
  static resetGrab(): void {
    WireEnd.grabbedEnd = null;
    WireEnd.grabSourcePin = null;
  }

  // ---------------------------------------------------------------- connect / disconnect

  isConnected(): boolean {
    return this.pin !== null || this.junction !== null;
  }

  connect(target: Pin | WireJunction | null): void {
    if (target instanceof WireJunction) this.connectToJunction(target);
    else if (target !== null) this.connectToPin(target);
  }

  private connectToPin(target: Pin): void {
    if (this.pin === null && this.junction === null) {
      if (!target.isOccupied()) {
        this.pin = target;
        this.pin.setWireEnd(this);
        const owner = this.pin.getOwner();
        owner.onLayoutX(this.pinPositionChangeListener);
        owner.onLayoutY(this.pinPositionChangeListener);

        const p = target.getSceneGridPosition();
        this.setLayoutX(p.x);
        this.setLayoutY(p.y);
        this.lastPosX = this.getLayoutX();
        this.lastPosY = this.getLayoutY();

        this.getWire().updateGeometry();
        this.getWire().updatePotentialNetwork();
      }
    } else {
      this.disconnect();
      this.connectToPin(target);
    }
  }

  private connectToJunction(target: WireJunction): void {
    if (this.pin === null && this.junction === null) {
      this.junction = target;
      target.addWireEnd(this);
      this.junction.onLayoutX(this.junctionPositionChangeListener);
      this.junction.onLayoutY(this.junctionPositionChangeListener);

      const p = target.getConnectionPoint();
      this.setLayoutX(p.x);
      this.setLayoutY(p.y);
      this.lastPosX = this.getLayoutX();
      this.lastPosY = this.getLayoutY();

      WireJunction.markDirty(target);
      this.getWire().updateGeometry();
      this.getWire().updatePotentialNetwork();
    } else {
      this.disconnect();
      this.connectToJunction(target);
    }
  }

  getPin(): Pin | null {
    return this.pin;
  }

  getJunction(): WireJunction | null {
    return this.junction;
  }

  /** Re-position after the pin itself moved on its owner (pin placement menu, Register8 swap). */
  refreshPosition(): void {
    if (this.pin === null) return;
    if (this.lastPosX === -1) {
      this.lastPosX = this.getLayoutX();
      this.lastPosY = this.getLayoutY();
    }
    const p = this.pin.getSceneGridPosition();
    this.setLayoutX(p.x);
    this.setLayoutY(p.y);
    this.getWire().onEndMoved(this, this.getLayoutX() - this.lastPosX, this.getLayoutY() - this.lastPosY);
    this.lastPosX = this.getLayoutX();
    this.lastPosY = this.getLayoutY();
  }

  override getExitSide(): Side | null {
    return this.pin !== null ? this.pin.getExitSide() : null;
  }

  override delete(): void {
    this.disconnect();
    this.getWire().delete();
  }

  /**
   * Disconnect from the pin or junction. The junction is marked dirty - the reconcile decides
   * whether it is destroyed or the remaining wires merge into one straight line.
   */
  disconnect(): void {
    if (this.pin !== null) {
      const pinToUpdate = this.pin;
      const owner = this.pin.getOwner();
      owner.offLayoutX(this.pinPositionChangeListener);
      owner.offLayoutY(this.pinPositionChangeListener);
      this.pin.clearWireEnd();
      this.pin = null;
      this.getWire().updatePotentialNetwork();
      if (this.getSheet().isSimulationRunning()) this.getSheet().addEvent(new SheetEvent(pinToUpdate));
    } else if (this.junction !== null) {
      this.junction.offLayoutX(this.junctionPositionChangeListener);
      this.junction.offLayoutY(this.junctionPositionChangeListener);
      const orphanedJunction = this.junction;
      this.junction.removeWireEnd(this);
      this.junction = null;
      WireJunction.markDirty(orphanedJunction);
      orphanedJunction.refreshConnectedWires();
      this.getWire().updatePotentialNetwork();
    }
  }
}

// ==================================================================== WireJunction

export class WireJunction extends Joint {
  /** Collinearity tolerance (coordinates are exact grid multiples). */
  private static readonly EPS = 1e-6;

  private readonly connectedEnds: WireEnd[] = [];
  private removed = false;
  /** Visual: the dot is shown (and the junction is pickable) only with 3+ wires. */
  private visible = false;

  private static readonly dirtyJunctions = new Set<WireJunction>();
  private static processing = false;
  private static reconcileScheduled = false;

  constructor(sheet: SchematicSheet) {
    super(sheet, null);
    this.updateVisibility();
  }

  /** New junction at the position, inserted into the junctions layer. */
  static at(sheet: SchematicSheet, x: number | Point2D, y?: number): WireJunction {
    const px = typeof x === 'number' ? x : x.x;
    const py = typeof x === 'number' ? y! : x.y;
    const junction = new WireJunction(sheet);
    junction.setLayoutX(px);
    junction.setLayoutY(py);
    sheet.registerJunction(junction);
    return junction;
  }

  /** Nearest existing junction around the point (invisible bends included). */
  static findNear(sheet: SchematicSheet, point: Point2D, tolerance: number): WireJunction | null {
    let best: WireJunction | null = null;
    let bestDist = Number.MAX_VALUE;
    for (const junction of sheet.getJunctions()) {
      if (junction.removed) continue;
      const dist = junction.getConnectionPoint().distance(point);
      if (dist <= tolerance && dist < bestDist) {
        bestDist = dist;
        best = junction;
      }
    }
    return best;
  }

  /** Click on a visible junction: selects the wires meeting there (`ctrl` = chain, `shift` = toggle). */
  selectWires(ctrl: boolean, shift: boolean): void {
    const sheet = this.getSheet();
    const wires = this.getConnectedWires();
    if (ctrl && !shift) {
      if (wires.length > 0) {
        sheet.clearSelect();
        for (const wire of wires[0].collectChain()) sheet.addSelect(wire);
      }
    } else if (shift) {
      for (const wire of wires) {
        if (wire.isSelected()) sheet.removeSelect(wire);
        else sheet.addSelect(wire);
      }
    } else {
      sheet.clearSelect();
      for (const wire of wires) sheet.addSelect(wire);
    }
  }

  /** Drag from the junction = a new branch. */
  beginDrag(): void {
    if (!this.getSheet().isEditingEnabled()) return;
    this.getSheet().beginWireCreation(this);
  }

  /** Dot visible (and pickable) only with three or more wires; fewer = invisible bend. */
  updateVisibility(): void {
    const visible = this.connectedEnds.length >= 3;
    if (visible !== this.visible) {
      this.visible = visible;
      this.getSheet().markChanged();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ---------------------------------------------------------------- dirty set + reconcile

  /** Marks the junction for recomputation, deferred to the end of the current event (runLater). */
  static markDirty(junction: WireJunction | null): void {
    if (junction === null || junction.removed) return;
    if (WireJunction.dirtyJunctions.has(junction)) return;
    WireJunction.dirtyJunctions.add(junction);
    if (WireJunction.reconcileScheduled) return;
    WireJunction.reconcileScheduled = true;
    runLater(() => {
      WireJunction.reconcileScheduled = false;
      WireJunction.processNow();
    });
  }

  /** Immediate recomputation of all marked junctions. */
  static processNow(): void {
    if (WireJunction.processing) return;
    WireJunction.processing = true;
    try {
      let guard = 0;
      while (WireJunction.dirtyJunctions.size > 0 && guard++ < 1000) {
        const junction = WireJunction.dirtyJunctions.values().next().value!;
        WireJunction.dirtyJunctions.delete(junction);
        WireJunction.reconcile(junction);
      }
    } finally {
      WireJunction.processing = false;
    }
  }

  private static reconcile(junction: WireJunction): void {
    if (junction.removed) return;

    // drop dead ends (their wire no longer exists) - JavaFX: end.getWire() == null never happens
    // for a detached wire either, so nothing is removed here in practice
    const degree = junction.connectedEnds.length;
    if (degree <= 1) {
      WireJunction.destroy(junction);
      return;
    }

    if (degree === 2) {
      const end1 = junction.connectedEnds[0];
      const end2 = junction.connectedEnds[1];
      const wire1 = end1.getWire();
      const wire2 = end2.getWire();

      if (wire1 === wire2) {
        junction.updateVisibility();
        return;
      }

      const dir1 = legDirection(junction, end1, wire1);
      const dir2 = legDirection(junction, end2, wire2);

      if (dir1.magnitude() < WireJunction.EPS) {
        WireJunction.removeZeroLength(junction, wire1, end1);
        return;
      }
      if (dir2.magnitude() < WireJunction.EPS) {
        WireJunction.removeZeroLength(junction, wire2, end2);
        return;
      }

      const cross = dir1.x * dir2.y - dir1.y * dir2.x;
      const dot = dir1.x * dir2.x + dir1.y * dir2.y;
      if (Math.abs(cross) <= WireJunction.EPS && dot < 0) {
        WireJunction.merge(junction, wire1, end1, wire2, end2);
        return;
      }
    }

    junction.updateVisibility();
  }

  /** Removes a zero-length wire; collapses a coincident junction at its other end. */
  private static removeZeroLength(junction: WireJunction, wire: Wire, end: WireEnd): void {
    if (WireJunction.isTemporary(wire)) {
      junction.updateVisibility();
      return;
    }
    const other = wire.getEnds()[0] === end ? wire.getEnds()[1] : wire.getEnds()[0];
    const otherJunction = other.getJunction();

    wire.delete();

    if (
      otherJunction !== null &&
      otherJunction !== junction &&
      !otherJunction.isRemoved() &&
      otherJunction.getConnectionPoint().distance(junction.getConnectionPoint()) < WireJunction.EPS
    ) {
      WireJunction.collapseJunction(junction, otherJunction);
    }
    WireJunction.markDirty(junction);
  }

  private static collapseJunction(target: WireJunction, source: WireJunction): void {
    if (target === source || target.isRemoved() || source.isRemoved()) return;
    for (const end of [...source.getConnectedEnds()]) {
      end.disconnect();
      end.connect(target);
    }
    WireJunction.destroy(source);
    WireJunction.markDirty(target);
  }

  /** Wire being dragged/created, or a component drag in progress - must not be removed/merged now. */
  private static isTemporary(wire: Wire | null): boolean {
    return (
      wire === null ||
      wire.getSheet().getInProgressWire() === wire ||
      wire.isPreview() ||
      WireEnd.isGrabbing(wire) ||
      SheetItem.componentDragging
    );
  }

  /** Merges two collinear wires: `keep` stays, `drop` is removed and its far target taken over. */
  private static merge(junction: WireJunction, keep: Wire, keepEnd: WireEnd, drop: Wire, dropEnd: WireEnd): void {
    if (WireJunction.isTemporary(keep) || WireJunction.isTemporary(drop)) return;
    if (keep === drop) return;

    const dropOther = drop.getEnds()[0] === dropEnd ? drop.getEnds()[1] : drop.getEnds()[0];
    const target: Pin | WireJunction | null = dropOther.getPin() !== null ? dropOther.getPin() : dropOther.getJunction();
    const targetPos = dropOther.getConnectionPoint();

    dropOther.disconnect();
    dropEnd.disconnect();
    drop.delete();

    keepEnd.disconnect();
    WireJunction.destroy(junction);
    if (target !== null) keepEnd.connect(target);
    else keepEnd.moveToPx(targetPos.x, targetPos.y);
    keep.updateGeometry();
  }

  /** Destroys the junction - frees all its ends and removes it from the sheet. */
  static destroy(junction: WireJunction | null): void {
    if (junction === null || junction.removed) return;
    junction.removed = true;
    WireJunction.dirtyJunctions.delete(junction);
    for (const end of [...junction.connectedEnds]) end.disconnect();
    junction.connectedEnds.length = 0;
    junction.getSheet().unregisterJunction(junction);
  }

  /** Clears the static reconcile state (sheet cleared / tests). */
  static resetPending(): void {
    WireJunction.dirtyJunctions.clear();
  }

  // ---------------------------------------------------------------- connected ends

  addWireEnd(end: WireEnd): void {
    if (!this.connectedEnds.includes(end)) this.connectedEnds.push(end);
    this.updateVisibility();
  }

  removeWireEnd(end: WireEnd): void {
    const i = this.connectedEnds.indexOf(end);
    if (i >= 0) this.connectedEnds.splice(i, 1);
    this.updateVisibility();
  }

  getConnectedEnds(): WireEnd[] {
    return this.connectedEnds;
  }

  /** Wires touching this junction (each once). */
  getConnectedWires(): Wire[] {
    const wires: Wire[] = [];
    for (const end of [...this.connectedEnds]) {
      const wire = end.getWire();
      if (!wires.includes(wire)) wires.push(wire);
    }
    return wires;
  }

  /** Pass-through bend of exactly two wires (Ctrl+click chain selection crosses it). */
  isCrossable(): boolean {
    return !this.removed && this.connectedEnds.length === 2;
  }

  // ---------------------------------------------------------------- potentials

  /** Pin this junction is electrically connected to through wires, skipping the wire `avoid`. */
  findConnectedPin(avoid: Wire | null = null, visited: Set<WireJunction> = new Set()): Pin | null {
    if (visited.has(this)) return null;
    visited.add(this);

    for (const end of [...this.connectedEnds]) {
      if (avoid !== null && end.getWire() === avoid) continue;
      const direct = end.getPin();
      if (direct !== null) return direct;

      const wire = end.getWire();
      for (const other of wire.getEnds()) {
        if (other === end) continue;
        const pin = other.getPin();
        if (pin !== null) return pin;
        const otherJunction = other.getJunction();
        if (otherJunction !== null && otherJunction !== this) {
          const found = otherJunction.findConnectedPin(avoid, visited);
          if (found !== null) return found;
        }
      }
    }
    return null;
  }

  /** Rebuilds the potentials of the net around the first connected wire. */
  refreshConnectedWires(): void {
    for (const end of [...this.connectedEnds]) {
      end.getWire().updatePotentialNetwork();
      return;
    }
  }

  getPotential(): Potential | null {
    const pin = this.findConnectedPin();
    return pin !== null ? pin.getPotential() : null;
  }

  isOccupied(): boolean {
    return false;
  }

  override delete(): void {
    WireJunction.destroy(this);
  }

  isRemoved(): boolean {
    return this.removed;
  }
}

function legDirection(junction: WireJunction, end: WireEnd, wire: Wire): Point2D {
  const other = wire.getEnds()[0] === end ? wire.getEnds()[1] : wire.getEnds()[0];
  return new Point2D(other.getLayoutX() - junction.getLayoutX(), other.getLayoutY() - junction.getLayoutY());
}

// ==================================================================== Wire

export class Wire {
  private static defaultColor: WireColor = DEFAULT_WIRE_COLOR;

  private color: WireColor = Wire.defaultColor;
  private potential: Potential | null = null;
  private debugColored = false;
  private selected = false;
  private selectable = true;
  /** Scene-graph membership (JavaFX `getParent() != null`). */
  attached = false;
  mouseTransparent = false;
  opacity = 1;

  private readonly ends: [WireEnd, WireEnd];

  /** Orientation of an aligned wire (true = horizontal). */
  private horizontal = true;

  private preview = false;
  /** Locked preview axis (null = not locked yet - waits for the initial move direction). */
  private previewAxis: boolean | null = null;
  /** Index of the end anchored during the preview (the free end follows the cursor). */
  private previewAnchor = 1;

  private settleScheduled = false;
  private pendingSettleEnd: WireEnd | null = null;

  /** Drawn geometry: the line and (preview only) the second L arm. */
  private line: [Point2D, Point2D] = [new Point2D(0, 0), new Point2D(0, 0)];
  private lineB: [Point2D, Point2D] | null = null;

  /** `new Wire(Pin)`, `new Wire(WireJunction)` or `new Wire(SchematicSheet)`. */
  constructor(start: Pin | SchematicSheet | WireJunction) {
    const sheet = start instanceof WireJunction ? start.getSheet() : isPin(start) ? start.getOwner().getSheet() : start;
    this.ends = [new WireEnd(sheet, this), new WireEnd(sheet, this)];
    this.updateGeometry();
    if (start instanceof WireJunction || isPin(start)) this.ends[0].connect(start);
  }

  getSheet(): SchematicSheet {
    return this.ends[0].getSheet();
  }

  static setDefaultColor(c: WireColor): void {
    Wire.defaultColor = c;
  }

  static getDefaultColor(): WireColor {
    return Wire.defaultColor;
  }

  changeColor(newColor: WireColor): void {
    this.color = newColor;
    this.getSheet().markChanged();
  }

  getColor(): WireColor {
    return this.color;
  }

  setDebugColored(enabled: boolean): void {
    this.debugColored = enabled;
    this.getSheet().markChanged();
  }

  /** Current stroke: debug colour by state, or the user colour. */
  getCurrentColor(): WireColor {
    if (!this.debugColored) return this.color;
    if (this.potential === null) return DEBUG_Z_COLOR;
    switch (this.potential.getValue()) {
      case 'HIGH':
        return DEBUG_HIGH_COLOR;
      case 'LOW':
        return DEBUG_LOW_COLOR;
      default:
        return DEBUG_Z_COLOR;
    }
  }

  getEnds(): [WireEnd, WireEnd] {
    return this.ends;
  }

  /** The free end while a wire is being created. */
  catchFreeEnd(): WireEnd {
    return this.ends[1];
  }

  areBothEndsConnected(): boolean {
    return this.ends[0].isConnected() && this.ends[1].isConnected();
  }

  /** Junction the wire was started from (null for a wire started on a pin). */
  getStartJunction(): WireJunction | null {
    return this.ends[0].getJunction();
  }

  isHorizontal(): boolean {
    return this.horizontal;
  }

  isPreview(): boolean {
    return this.preview;
  }

  /** Lines to draw: the wire, plus the second L arm during a locked preview. */
  getLines(): [Point2D, Point2D][] {
    return this.lineB === null ? [this.line] : [this.line, this.lineB];
  }

  // ---------------------------------------------------------------- L preview

  beginPreview(anchorIndex: number, axis: boolean | null): void {
    this.preview = true;
    this.previewAnchor = anchorIndex;
    this.previewAxis = axis;
    this.updateGeometry();
  }

  endPreview(): void {
    if (!this.preview) return;
    if (this.previewAxis !== null) this.horizontal = this.previewAxis;
    this.preview = false;
    this.previewAxis = null;
    this.lineB = null;
    this.updateGeometry();
  }

  /** Moves the free end during a drag; locks the axis on the first move of ≥ 3 px. */
  updateCreationDrag(x: number, y: number): void {
    if (!this.preview) return;
    const freeEnd = this.ends[1 - this.previewAnchor];
    freeEnd.moveToPx(x, y);
    if (this.previewAxis === null) {
      const anchor = this.ends[this.previewAnchor].getConnectionPoint();
      const deltaX = Math.abs(x - anchor.x);
      const deltaY = Math.abs(y - anchor.y);
      if (Math.max(deltaX, deltaY) >= 3) this.previewAxis = deltaX >= deltaY;
    }
    this.updateGeometry();
  }

  // ---------------------------------------------------------------- geometry

  updateGeometry(): void {
    const p0 = this.ends[0].getConnectionPoint();
    const p1 = this.ends[1].getConnectionPoint();

    if (this.preview) {
      const anchor = this.ends[this.previewAnchor].getConnectionPoint();
      const free = this.ends[1 - this.previewAnchor].getConnectionPoint();
      if (this.previewAxis === null) {
        this.line = [anchor, free];
        this.lineB = null;
      } else {
        const corner = this.previewAxis ? new Point2D(free.x, anchor.y) : new Point2D(anchor.x, free.y);
        this.line = [anchor, corner];
        this.lineB = [corner, free];
      }
    } else {
      this.line = [p0, p1];
      this.lineB = null;
      if (sameCoordinate(p0.y, p1.y)) this.horizontal = true;
      else if (sameCoordinate(p0.x, p1.x)) this.horizontal = false;
    }
    this.getSheet().markChanged();
  }

  // ---------------------------------------------------------------- movement cascade

  /**
   * One end moved (its pin's component moved). The perpendicular component of the move is passed
   * on to a junction at the other end; a free end absorbs the whole move; two pinned ends that
   * fell out of line are settled later.
   */
  onEndMoved(end: WireEnd, deltaX: number, deltaY: number): void {
    if (this.preview || (deltaX === 0 && deltaY === 0)) {
      this.updateGeometry();
      return;
    }
    const other = this.otherEnd(end);
    if (!other.isConnected()) {
      other.moveToPx(other.getLayoutX() + deltaX, other.getLayoutY() + deltaY);
    } else if (other.getJunction() !== null) {
      let moveX = 0;
      let moveY = 0;
      if (this.horizontal) moveY = deltaY;
      else moveX = deltaX;
      if (moveX !== 0 || moveY !== 0) {
        const j = other.getJunction()!;
        j.moveToPx(j.getLayoutX() + moveX, j.getLayoutY() + moveY);
      }
    } else {
      const perpMoved = this.horizontal ? deltaY !== 0 : deltaX !== 0;
      if (perpMoved) this.scheduleSettle(end);
    }
    this.updateGeometry();
  }

  /** The junction this wire ends on moved. */
  onJunctionMoved(end: WireEnd, deltaX: number, deltaY: number): void {
    if (this.preview) {
      this.updateGeometry();
      return;
    }
    const other = this.otherEnd(end);
    if (!other.isConnected()) other.moveToPx(other.getLayoutX() + deltaX, other.getLayoutY() + deltaY);
    else this.scheduleSettle(end);
    this.updateGeometry();
  }

  private otherEnd(end: WireEnd): WireEnd {
    return this.ends[0] === end ? this.ends[1] : this.ends[0];
  }

  // ---------------------------------------------------------------- settle

  /** Deferred settle after an end moved (runLater); repeated calls coalesce. */
  scheduleSettle(end: WireEnd): void {
    if (this.preview) return;
    if (WireEnd.isGrabbing(this)) return;
    if (this.getSheet().getInProgressWire() === this) return;
    this.pendingSettleEnd = end;
    if (this.settleScheduled) return;
    this.settleScheduled = true;
    runLater(() => this.runSettle());
  }

  private runSettle(): void {
    this.settleScheduled = false;
    let moving = this.pendingSettleEnd;
    this.pendingSettleEnd = null;

    if (!this.attached) return;
    if (this.preview || WireEnd.isGrabbing(this) || this.getSheet().getInProgressWire() === this) return;
    if (moving === null || moving.getWire() !== this) moving = this.ends[1];

    this.settleGeometry(moving);
    WireJunction.processNow();
  }

  /** Aligned = recompute only; both anchored off-axis = split at a bend; one free = align it. */
  private settleGeometry(moving: WireEnd): void {
    if (!this.attached || this.preview) return;
    if (WireEnd.isGrabbing(this) || this.getSheet().getInProgressWire() === this) return;

    const fixed = this.otherEnd(moving);
    const movingPoint = moving.getConnectionPoint();
    const fixedPoint = fixed.getConnectionPoint();

    if (sameCoordinate(movingPoint.y, fixedPoint.y) || sameCoordinate(movingPoint.x, fixedPoint.x)) {
      this.horizontal = sameCoordinate(movingPoint.y, fixedPoint.y);
      this.updateGeometry();
      return;
    }
    if (moving.isConnected() && fixed.isConnected()) {
      this.splitAtConflict(moving);
      return;
    }
    if (!moving.isConnected() && !fixed.isConnected()) {
      this.updateGeometry();
      return;
    }
    this.alignFreeEnd(moving.isConnected() ? fixed : moving);
  }

  private alignFreeEnd(freeEnd: WireEnd): void {
    const anchor = this.otherEnd(freeEnd);
    const anchorPoint = anchor.getConnectionPoint();
    const freePoint = freeEnd.getConnectionPoint();
    const deltaX = freePoint.x - anchorPoint.x;
    const deltaY = freePoint.y - anchorPoint.y;
    this.horizontal = Math.abs(deltaX) >= Math.abs(deltaY);

    const grid = this.getSheet().getGrid().getSizeMin();
    if (this.horizontal) freeEnd.moveToPx(snapToGrid(freePoint.x, grid), anchorPoint.y);
    else freeEnd.moveToPx(anchorPoint.x, snapToGrid(freePoint.y, grid));
    this.updateGeometry();
  }

  private splitAtConflict(moving: WireEnd): WireJunction | null {
    const fixed = this.otherEnd(moving);
    const movingPoint = moving.getConnectionPoint();
    const fixedPoint = fixed.getConnectionPoint();
    const corner = this.horizontal ? new Point2D(movingPoint.x, fixedPoint.y) : new Point2D(fixedPoint.x, movingPoint.y);

    if (corner.distance(movingPoint) < ALIGN_EPS || corner.distance(fixedPoint) < ALIGN_EPS) {
      if (sameCoordinate(movingPoint.y, fixedPoint.y)) this.horizontal = true;
      else if (sameCoordinate(movingPoint.x, fixedPoint.x)) this.horizontal = false;
      this.updateGeometry();
      return null;
    }
    return this.splitAt(moving, corner);
  }

  /**
   * Splits the wire at `corner`: the moving end is re-attached to a new junction there and a new
   * wire connects the junction to the moving end's former target (or position).
   */
  splitAt(movingEnd: WireEnd, corner: Point2D): WireJunction {
    const target: Pin | WireJunction | null = movingEnd.getPin() !== null ? movingEnd.getPin() : movingEnd.getJunction();
    const oldPosition = movingEnd.getConnectionPoint();

    movingEnd.disconnect();

    const junction = WireJunction.at(this.getSheet(), corner.x, corner.y);
    movingEnd.connect(junction);

    const newWire = new Wire(this.getSheet());
    newWire.changeColor(this.color);
    this.getSheet().addItem(newWire);
    const start = newWire.ends[0];
    const finish = newWire.ends[1];
    start.connect(junction);
    if (target !== null) finish.connect(target);
    else finish.moveToPx(oldPosition.x, oldPosition.y);

    const a = start.getConnectionPoint();
    const b = finish.getConnectionPoint();
    newWire.horizontal = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);

    this.updateGeometry();
    newWire.updateGeometry();
    this.updatePotentialNetwork();
    return junction;
  }

  /**
   * Splits this wire at `position` (an end dropped on it, or a branch dragged from its middle).
   * The point is snapped to the grid and onto the wire's axis.
   *
   * @returns the junction, or null if the point is too close to an end
   */
  splitAtPoint(position: Point2D): WireJunction | null {
    if (this.preview) return null;
    const p0 = this.ends[0].getConnectionPoint();
    const p1 = this.ends[1].getConnectionPoint();
    const isHorizontalLine = sameCoordinate(p0.y, p1.y);
    const isVerticalLine = sameCoordinate(p0.x, p1.x);
    if (!isHorizontalLine && !isVerticalLine) return null;

    const grid = this.getSheet().getGrid().getSizeMin();
    const snapX = snapToGrid(position.x, grid);
    const snapY = snapToGrid(position.y, grid);

    const cut = isHorizontalLine
      ? new Point2D(clamp(snapX, Math.min(p0.x, p1.x), Math.max(p0.x, p1.x)), p0.y)
      : new Point2D(p0.x, clamp(snapY, Math.min(p0.y, p1.y), Math.max(p0.y, p1.y)));

    const distance0 = cut.distance(p0);
    const distance1 = cut.distance(p1);
    if (Math.min(distance0, distance1) < grid / 2.0) return null;

    const movingEnd = distance0 >= distance1 ? this.ends[0] : this.ends[1];
    return this.splitAt(movingEnd, cut);
  }

  /**
   * Finishes creation: preview off, free ends snapped, geometry settled. A drop in empty space
   * in an L position keeps both arms as two wires.
   */
  completeCreation(): void {
    this.endPreview();
    const grid = this.getSheet().getGrid().getSizeMin();
    for (const end of this.ends) {
      if (!end.isConnected()) end.moveToPx(snapToGrid(end.getLayoutX(), grid), snapToGrid(end.getLayoutY(), grid));
    }
    if (!this.materializeElbow(grid)) this.settleGeometry(this.ends[1]);
    WireJunction.processNow();
  }

  private materializeElbow(grid: number): boolean {
    const anchor = this.ends[0];
    const free = this.ends[1];
    if (!anchor.isConnected() || free.isConnected()) return false;

    const dropPoint = free.getConnectionPoint();
    const corner = this.horizontal
      ? new Point2D(dropPoint.x, anchor.getLayoutY())
      : new Point2D(anchor.getLayoutX(), dropPoint.y);

    if (corner.distance(anchor.getLayoutX(), anchor.getLayoutY()) < ALIGN_EPS) return false;
    if (corner.distance(dropPoint) < grid / 2.0) return false;

    const junction = WireJunction.at(this.getSheet(), corner.x, corner.y);
    free.moveToPx(corner.x, corner.y);
    free.connect(junction);

    const tail = new Wire(this.getSheet());
    tail.changeColor(this.color);
    this.getSheet().addItem(tail);
    tail.ends[0].connect(junction);
    tail.ends[1].moveToPx(dropPoint.x, dropPoint.y);
    tail.updateGeometry();
    this.updateGeometry();
    return true;
  }

  /** Recompute after completion with free ends snapped to the grid (paste). */
  settleToGrid(): void {
    this.endPreview();
    const grid = this.getSheet().getGrid().getSizeMin();
    for (const end of this.ends) {
      if (!end.isConnected()) end.moveToPx(snapToGrid(end.getLayoutX(), grid), snapToGrid(end.getLayoutY(), grid));
    }
    this.settleGeometry(this.ends[1]);
    WireJunction.processNow();
  }

  /**
   * Connects free wire ends lying under pins of moved components (within half a grid cell).
   * Called after a component was dropped.
   */
  static connectFreeEndsToPins(sheet: SchematicSheet, pins: Iterable<Pin>): void {
    const tolerance = sheet.getGrid().getSizeMin() / 2.0;
    const wires = sheet.getWires();
    for (const pin of pins) {
      if (pin.isOccupied()) continue;
      const pinPos = pin.getSceneGridPosition();
      for (const wire of wires) {
        if (!wire.attached || wire.isPreview() || wire === sheet.getInProgressWire()) continue;
        for (const end of wire.getEnds()) {
          if (end.isConnected()) continue;
          const dx = end.getLayoutX() - pinPos.x;
          const dy = end.getLayoutY() - pinPos.y;
          if (dx * dx + dy * dy <= tolerance * tolerance) {
            end.connect(pin);
            wire.scheduleSettle(end);
            break;
          }
        }
        if (pin.isOccupied()) break;
      }
    }
  }

  // ---------------------------------------------------------------- selection

  /** Mouse press on the wire (`onEnd` = on one of its ends): double-click on an end deletes it. */
  press(clickCount: number, onEnd: boolean, ctrl: boolean, shift: boolean): void {
    const sheet = this.getSheet();
    if (clickCount >= 2 && onEnd && sheet.isEditingEnabled()) {
      this.delete();
      return;
    }
    if (ctrl && !shift) {
      sheet.clearSelect();
      for (const chainWire of this.collectChain()) sheet.addSelect(chainWire);
    } else if (shift) {
      if (this.isSelected()) sheet.removeSelect(this);
      else sheet.addSelect(this);
    } else {
      sheet.clearSelect();
      sheet.addSelect(this);
    }
  }

  /** Drag started on the wire body: split it (or reuse a nearby junction) and start a branch. */
  beginBranchDrag(sheetXY: Point2D): boolean {
    const sheet = this.getSheet();
    if (!sheet.isEditingEnabled() || this.preview) return false;
    const grid = sheet.getGrid().getSizeMin();
    let junction = WireJunction.findNear(sheet, sheetXY, grid / 2.0);
    if (junction === null) junction = this.splitAtPoint(sheetXY);
    if (junction === null) return false;
    sheet.beginWireCreation(junction);
    return true;
  }

  /** Chain between anchors: crosses invisible bends (exactly two wires). */
  collectChain(): Wire[] {
    const result: Wire[] = [this];
    const visited = new Set<Wire>([this]);
    const queue: Wire[] = [this];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const end of current.ends) {
        const junction = end.getJunction();
        if (junction === null || !junction.isCrossable()) continue;
        for (const neighbour of junction.getConnectedWires()) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          result.push(neighbour);
          queue.push(neighbour);
        }
      }
    }
    return result;
  }

  distanceToPoint(position: Point2D): number {
    if (this.preview) return Number.MAX_VALUE;
    const p0 = this.ends[0].getConnectionPoint();
    const p1 = this.ends[1].getConnectionPoint();
    return distanceToSegment(position.x, position.y, p0.x, p0.y, p1.x, p1.y);
  }

  delete(): void {
    this.selected = false;
    if (!this.attached) return;
    this.getSheet().removeSelect(this);
    for (const end of this.ends) end.disconnect();
    this.getSheet().removeItem(this);
    WireJunction.processNow();
  }

  select(): void {
    this.selected = true;
    this.getSheet().markChanged();
  }

  deselect(): void {
    this.selected = false;
    this.getSheet().markChanged();
  }

  isSelected(): boolean {
    return this.selected;
  }

  isSelectable(): boolean {
    return this.selectable;
  }

  setSelectable(v: boolean): void {
    this.selectable = v;
  }

  // ---------------------------------------------------------------- potentials

  updatePotential(): void {
    let start: Pin | null = null;
    let end: Pin | null = null;
    start = this.getEndPin(this.ends[0]);
    end = this.getEndPin(this.ends[1]);
    this.placePotential(start, end);
  }

  private placePotential(start: Pin | null, end: Pin | null): void {
    if (this.potential !== null) {
      this.potential.detach();
      this.potential = null;
    }
    if (start !== null && end !== null) this.potential = new Potential(start, end);

    const toUpdate = start !== null ? start : end;
    if (toUpdate !== null && this.getSheet().isSimulationRunning()) this.getSheet().addEvent(new SheetEvent(toUpdate));
    this.getSheet().markChanged();
  }

  /**
   * Rebuilds the potentials of every wire of the net around this one (through junctions):
   * resolve all pins, silently detach old potentials, then grow new ones from the drivers.
   */
  updatePotentialNetwork(): void {
    // 1) the net's wires through junctions (BFS)
    const visited = new Set<Wire>([this]);
    const queue: Wire[] = [this];
    while (queue.length > 0) {
      const wire = queue.shift()!;
      for (const end of wire.ends) {
        const junction = end.getJunction();
        if (junction === null) continue;
        for (const other of junction.getConnectedEnds()) {
          const next = other.getWire();
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
    }

    // 2) resolve the pins of every wire (pure query)
    const resolved = new Map<Wire, [Pin | null, Pin | null]>();
    for (const w of visited) resolved.set(w, [w.getEndPin(w.ends[0]), w.getEndPin(w.ends[1])]);

    // 3) silent detach of old potentials
    for (const w of visited) {
      if (w.potential !== null) {
        w.potential.detach();
        w.potential = null;
      }
    }

    // 4) index pin -> wires
    const byPin = new Map<Pin, Wire[]>();
    for (const [w, pins] of resolved) {
      for (const p of pins) {
        if (p === null) continue;
        let list = byPin.get(p);
        if (list === undefined) {
          list = [];
          byPin.set(p, list);
        }
        list.push(w);
      }
    }

    // 5) grow from drivers, then the rest
    const placed = new Set<Wire>();
    const placeQueue: Wire[] = [];
    for (const w of visited) {
      if (touchesDriver(resolved.get(w)!) && !placed.has(w)) {
        placed.add(w);
        placeQueue.push(w);
      }
    }
    while (placeQueue.length > 0) {
      const w = placeQueue.shift()!;
      const pins = resolved.get(w)!;
      w.placePotential(pins[0], pins[1]);
      for (const p of pins) {
        if (p === null) continue;
        for (const neighbour of byPin.get(p)!) {
          if (!placed.has(neighbour)) {
            placed.add(neighbour);
            placeQueue.push(neighbour);
          }
        }
      }
    }
    for (const w of visited) {
      if (!placed.has(w)) {
        placed.add(w);
        const pins = resolved.get(w)!;
        w.placePotential(pins[0], pins[1]);
      }
    }
  }

  /** Pin of the end (directly, or through the junction while skipping this wire). */
  private getEndPin(end: WireEnd): Pin | null {
    if (end.getPin() !== null) return end.getPin();
    if (end.getJunction() !== null) return end.getJunction()!.findConnectedPin(this);
    return null;
  }
}

// ==================================================================== helpers

function isPin(x: unknown): x is Pin {
  return typeof x === 'object' && x !== null && typeof (x as Pin).getOwnedPotential === 'function';
}

function touchesDriver(pins: [Pin | null, Pin | null]): boolean {
  for (const p of pins) {
    if (p === null) continue;
    const type = p.getOwnedPotential().getType();
    if (type !== 'IN' && type !== 'NC') return true;
  }
  return false;
}

function sameCoordinate(a: number, b: number): boolean {
  return Math.abs(a - b) < ALIGN_EPS;
}

function snapToGrid(value: number, grid: number): number {
  return javaRoundD(value / grid) * grid;
}

/** Java `Math.round(double)` (half up). */
function javaRoundD(v: number): number {
  return Math.floor(v + 0.5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
