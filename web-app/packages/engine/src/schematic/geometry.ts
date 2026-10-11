/** `javafx.geometry.Point2D` subset with Java semantics (exact `equals`, `distance`). */
export class Point2D {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  add(p: Point2D): Point2D {
    return new Point2D(this.x + p.x, this.y + p.y);
  }

  subtract(p: Point2D): Point2D {
    return new Point2D(this.x - p.x, this.y - p.y);
  }

  multiply(f: number): Point2D {
    return new Point2D(this.x * f, this.y * f);
  }

  distance(p: Point2D): number;
  distance(x: number, y: number): number;
  distance(a: Point2D | number, b?: number): number {
    const px = typeof a === 'number' ? a : a.x;
    const py = typeof a === 'number' ? b! : a.y;
    const dx = this.x - px;
    const dy = this.y - py;
    return Math.sqrt(dx * dx + dy * dy);
  }

  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  /** Java Point2D.equals - exact double comparison (with -0.0 != 0.0 like Double.equals? no: uses ==). */
  equals(p: Point2D): boolean {
    return this.x === p.x && this.y === p.y;
  }
}

export type SideName = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';

/** Port of `SchematicSim.Side`. */
export class Side {
  static readonly LEFT = new Side('LEFT', -1, 0);
  static readonly RIGHT = new Side('RIGHT', 1, 0);
  static readonly TOP = new Side('TOP', 0, -1);
  static readonly BOTTOM = new Side('BOTTOM', 0, 1);

  private constructor(
    readonly name: SideName,
    x: number,
    y: number,
  ) {
    this.vectorValue = new Point2D(x, y);
  }

  private readonly vectorValue: Point2D;

  vector(): Point2D {
    return this.vectorValue;
  }

  isHorizontal(): boolean {
    return this === Side.LEFT || this === Side.RIGHT;
  }

  /** `Side.valueOf(name)` - throws like Java IllegalArgumentException for unknown names. */
  static valueOf(name: string): Side {
    const s = (Side as unknown as Record<string, Side>)[name];
    if (!(s instanceof Side)) throw new Error('No enum constant Side.' + name);
    return s;
  }
}

/** Port of `GridSystem` (coordinate conversion only; the background is drawn by the view). */
export class GridSystem {
  constructor(
    readonly sizeX: number,
    readonly sizeY: number = sizeX,
  ) {}

  getSizeMin(): number {
    return Math.min(this.sizeX, this.sizeY);
  }

  getSizeMax(): number {
    return Math.max(this.sizeX, this.sizeY);
  }

  gridToPixel(gridX: number, gridY: number): Point2D {
    return new Point2D(gridX * this.sizeX, gridY * this.sizeY);
  }

  pixelToGrid(x: number, y: number): Point2D {
    return new Point2D(x / this.sizeX, y / this.sizeY);
  }
}

/** Java `Math.round(double)` - rounds half up (towards +∞), returns long. */
export const javaRound = (v: number): number => Math.floor(v + 0.5);
