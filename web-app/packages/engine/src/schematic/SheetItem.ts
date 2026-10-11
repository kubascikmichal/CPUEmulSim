/**
 * Ports of `HighlightGroup` + `Movable` + `Item` (model part) and `GridOccupancy`.
 *
 * JavaFX nodes are replaced by plain objects with `layoutX/layoutY`. Like JavaFX properties,
 * `layoutX` and `layoutY` notify their listeners separately and only on change - the original
 * wire-following logic (WireEnd / WireSegment listeners) depends on that granularity.
 */
import type { SchematicSheet } from './Sheet';
import { Point2D } from './geometry';

export type Listener = () => void;

export abstract class SheetItem {
  /**
   * `Movable.componentDragging`: a component is being dragged. While set, junctions neither
   * remove zero-length wires nor merge collinear ones - resolved on mouse release.
   */
  static componentDragging = false;

  private layoutXValue = 0;
  private layoutYValue = 0;
  private readonly layoutXListeners: Listener[] = [];
  private readonly layoutYListeners: Listener[] = [];

  private gridPosX = 0;
  private gridPosY = 0;
  private selectable = true;
  private selected = false;

  /** Visual-only flags mirrored from JavaFX nodes (wire in progress etc.). */
  mouseTransparent = false;
  opacity = 1;

  constructor(protected sheetRef: SchematicSheet | null) {}

  getSheet(): SchematicSheet {
    return this.sheetRef!;
  }

  // ---------------------------------------------------------------- layout

  getLayoutX(): number {
    return this.layoutXValue;
  }

  getLayoutY(): number {
    return this.layoutYValue;
  }

  setLayoutX(x: number): void {
    if (x === this.layoutXValue) return;
    this.layoutXValue = x;
    for (const l of [...this.layoutXListeners]) l();
    this.sheetRef?.markChanged();
  }

  setLayoutY(y: number): void {
    if (y === this.layoutYValue) return;
    this.layoutYValue = y;
    for (const l of [...this.layoutYListeners]) l();
    this.sheetRef?.markChanged();
  }

  onLayoutX(l: Listener): void {
    this.layoutXListeners.push(l);
  }

  onLayoutY(l: Listener): void {
    this.layoutYListeners.push(l);
  }

  offLayoutX(l: Listener): void {
    remove(this.layoutXListeners, l);
  }

  offLayoutY(l: Listener): void {
    remove(this.layoutYListeners, l);
  }

  // ---------------------------------------------------------------- Movable

  moveByPx(deltaX: number, deltaY: number): void {
    const grid = this.getSheet().getGrid();
    this.gridPosX += Math.trunc(Math.round(deltaX) / grid.sizeX);
    this.gridPosY += Math.trunc(Math.round(deltaY) / grid.sizeY);
    this.setLayoutX(this.getLayoutX() + deltaX);
    this.setLayoutY(this.getLayoutY() + deltaY);
  }

  moveByGrid(deltaX: number, deltaY: number): void {
    this.gridPosX += deltaX;
    this.gridPosY += deltaY;
    const p = this.getSheet().getGrid().gridToPixel(this.gridPosX, this.gridPosY);
    this.setLayoutX(p.x);
    this.setLayoutY(p.y);
  }

  /** `moveTo(double, double)` - pixel position, grid position unchanged. */
  moveToPx(x: number, y: number): void {
    this.setLayoutX(x);
    this.setLayoutY(y);
  }

  /** `moveTo(int, int)` - grid position. */
  moveTo(gridX: number, gridY: number): void {
    this.gridPosX = gridX;
    this.gridPosY = gridY;
    const p = this.getSheet().getGrid().gridToPixel(gridX, gridY);
    this.setLayoutX(p.x);
    this.setLayoutY(p.y);
  }

  getGridPosX(): number {
    return this.gridPosX;
  }

  getGridPosY(): number {
    return this.gridPosY;
  }

  getGridPos(): Point2D {
    return new Point2D(this.gridPosX, this.gridPosY);
  }

  setGridPos(x: number, y: number): void {
    this.gridPosX = x;
    this.gridPosY = y;
  }

  // ---------------------------------------------------------------- HighlightGroup / Selectable

  select(): void {
    this.selected = true;
    this.sheetRef?.markChanged();
  }

  deselect(): void {
    this.selected = false;
    this.sheetRef?.markChanged();
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

  /** HighlightGroup.delete + Movable.delete */
  delete(): void {
    this.selected = false;
    this.getSheet().removeItem(this);
  }
}

export function remove<T>(list: T[], item: T): boolean {
  const i = list.indexOf(item);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Port of `GridOccupancy`. */
export class GridOccupancy {
  private readonly occupied = new Set<string>();

  isFree(gridX: number, gridY: number, width: number, height: number): boolean {
    for (let x = gridX; x < gridX + width; x++) {
      for (let y = gridY; y < gridY + height; y++) {
        if (this.occupied.has(key(x, y))) return false;
      }
    }
    return true;
  }

  occupy(gate: { getGridPos(): Point2D; getGridWidth(): number; getGridHeight(): number }): void {
    this.forEachCell(gate, (k) => this.occupied.add(k));
  }

  free(gate: { getGridPos(): Point2D; getGridWidth(): number; getGridHeight(): number }): void {
    this.forEachCell(gate, (k) => this.occupied.delete(k));
  }

  clear(): void {
    this.occupied.clear();
  }

  private forEachCell(
    gate: { getGridPos(): Point2D; getGridWidth(): number; getGridHeight(): number },
    op: (k: string) => void,
  ): void {
    const p = gate.getGridPos();
    for (let x = 0; x < gate.getGridWidth(); x++) {
      for (let y = 0; y < gate.getGridHeight(); y++) op(key(p.x + x, p.y + y));
    }
  }
}

const key = (x: number, y: number) => `${x},${y}`;
