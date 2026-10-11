/**
 * Port of `SchematicSim.Electrical.Potential` and `PinType`.
 *
 * A potential joins two network points (pins); joining potentials builds a binary tree whose
 * root holds the resolved value of the net. The algorithm (type propagation, value resolution,
 * short-circuit detection with a RANDOM value on conflict) is ported unchanged.
 */
import { mathRandom, type RandomSource } from '../../util/JavaRandom';

export type PinType = 'NC' | 'IN' | 'OUT' | 'IO' | 'TRI_OUT' | 'WEAK_OUT';
export type PotentialValue = 'HIGH' | 'LOW' | 'NC';

/** Highlight kinds (Connectable constants). */
export const HIGHLIGHT = { INFO: 0, OK: 1, COMMON_POTENTIAL: 2, COMMON_POTENTIAL_OTHER: 3, WARNING: 4 } as const;

/** Electrical end point of a potential (only Pin implements it, as in the original). */
export interface Connectable {
  getPotential(): Potential | null;
  highlight(type: number): void;
  unhighlight(type: number): void;
}

/** Owner lookup used by {@link Potential.getGatesWithInputs} (Pin → its gate). */
export interface PinLike<G> extends Connectable {
  getOwner(): G;
}

/** Source of `Math.random()` for short circuits (injectable for deterministic tests). */
let random: RandomSource = mathRandom;
export function setElectricalRandom(source: RandomSource): void {
  random = source;
}
export function electricalRandom(): number {
  return random.nextDouble();
}

export class Potential {
  private node1: Connectable | null;
  private node2: Connectable | null;
  private parent1: Potential | null = null;
  private parent2: Potential | null = null;
  private child: Potential | null = null;
  private value: PotentialValue = 'NC';
  /** Cached random level of a floating (NC) net - see {@link getFloatingValue}. */
  private floatingHigh: boolean | null = null;
  private type: PinType = 'NC';

  private shortCircuit = false;
  private readonly shortedNodes: Connectable[] = [];
  private readonly valueListeners: (() => void)[] = [];

  constructor(node1: Connectable | null, node2: Connectable | null) {
    this.node1 = node1;
    this.node2 = node2;
    this.update();
  }

  /** Root of the tree this potential belongs to. */
  getPotential(): Potential {
    if (this.child !== null) return this.child.getPotential();
    return this;
  }

  getConnectedNodes(listToFill: Connectable[]): void {
    if (this.parent1 === null && this.parent2 === null) {
      if (this.node1 !== null) listToFill.push(this.node1);
      if (this.node2 !== null) listToFill.push(this.node2);
    } else {
      this.parent1?.getConnectedNodes(listToFill);
      this.parent2?.getConnectedNodes(listToFill);
    }
  }

  /** Fills the set with gates having an input (IN, IO, WEAK_OUT) on this net. */
  getGatesWithInputs<G>(setToFill: Set<G>): void {
    if (this.parent1 === null && this.parent2 === null) {
      const isInput = this.type === 'IN' || this.type === 'IO' || this.type === 'WEAK_OUT';
      if (isInput && isPin<G>(this.node1)) setToFill.add(this.node1.getOwner());
      if (isInput && isPin<G>(this.node2)) setToFill.add(this.node2.getOwner());
    } else {
      this.parent1?.getGatesWithInputs(setToFill);
      this.parent2?.getGatesWithInputs(setToFill);
    }
  }

  update(): void {
    if (this.parent1 !== null) this.parent1.child = null;
    if (this.parent2 !== null) this.parent2.child = null;

    if (this.node1 !== null) this.parent1 = this.node1.getPotential();
    if (this.node2 !== null) this.parent2 = this.node2.getPotential();

    if (this.parent1 === this) this.parent1 = null;
    if (this.parent2 === this) this.parent2 = null;

    if (this.parent1 !== null) this.parent1.child = this;
    if (this.parent2 !== null) this.parent2.child = this;

    const oldChild = this.child;
    this.child = null;

    this.updateType();
    this.setValue('NC');
    this.floatingHigh = null;

    if (oldChild !== null) oldChild.update();
  }

  getValue(): PotentialValue {
    return this.value;
  }

  /**
   * Stable random level of a floating ({@link PotentialValue} NC = High-Z) potential: while the
   * net stays floating the same generated value is returned, so inputs sensitive to the floating
   * state do not flicker on every simulation step. A defined 0/1 level discards it.
   *
   * @returns true if the floating potential randomly represents HIGH
   */
  getFloatingValue(): boolean {
    if (this.value !== 'NC') {
      this.floatingHigh = null;
      return this.value === 'HIGH';
    }
    if (this.floatingHigh === null) this.floatingHigh = electricalRandom() < 0.5;
    return this.floatingHigh;
  }

  addValueListener(listener: () => void): void {
    this.valueListeners.push(listener);
  }

  removeValueListener(listener: () => void): void {
    const i = this.valueListeners.indexOf(listener);
    if (i >= 0) this.valueListeners.splice(i, 1);
  }

  private notifyValueListeners(): void {
    for (const l of [...this.valueListeners]) l();
  }

  /** @returns true if set correctly, false on short circuit */
  setValue(newVal: PotentialValue): boolean {
    const p1 = this.parent1;
    const p2 = this.parent2;
    this.shortCircuit = (p1 !== null && p1.shortCircuit) || (p2 !== null && p2.shortCircuit);

    if (this.shortCircuit) {
      this.value = electricalRandom() < 0.5 ? 'LOW' : 'HIGH';
    } else if (p1 !== null && p2 !== null) {
      if (this.type === 'NC' || this.type === 'IN') {
        this.value = 'NC';
      } else if (p1.getValue() === 'NC' && p2.getValue() === 'NC') {
        this.value = 'NC';
      } else if (this.type === 'IO' || this.type === 'TRI_OUT') {
        if ((p1.type === 'IO' || p1.type === 'TRI_OUT') && (p2.type === 'IO' || p2.type === 'TRI_OUT')) {
          this.checkShortCircuit();
        } else if (p1.type === 'IO' || p1.type === 'TRI_OUT') {
          this.value = p1.value;
        } else {
          this.value = p2.value;
        }
      } else if (this.type === 'WEAK_OUT') {
        if (p1.type === 'WEAK_OUT' && p2.type === 'WEAK_OUT') {
          this.value = p1.value === 'LOW' || p2.value === 'LOW' ? 'LOW' : 'HIGH';
        } else if (p1.type === 'WEAK_OUT') {
          if (((p2.type === 'IO' || p2.type === 'TRI_OUT') && p2.getValue() !== 'NC') || p2.type === 'OUT') {
            this.value = p2.value;
          } else {
            this.value = p1.value;
          }
        } else if (((p1.type === 'IO' || p1.type === 'TRI_OUT') && p1.getValue() !== 'NC') || p1.type === 'OUT') {
          this.value = p1.value;
        } else {
          this.value = p2.value;
        }
      } else if (this.type === 'OUT') {
        const theOther = p1.type === 'OUT' ? p2.type : p1.type;
        if (theOther === 'OUT' || theOther === 'IO' || theOther === 'TRI_OUT') {
          this.checkShortCircuit();
        } else if (p1.type === 'OUT') {
          this.value = p1.value;
        } else {
          this.value = p2.value;
        }
      }
    } else if (p1 !== null) {
      this.value = p1.getValue();
    } else if (p2 !== null) {
      this.value = p2.getValue();
    } else {
      this.value = newVal;
    }

    if (this.value !== 'NC') this.floatingHigh = null;

    this.unhighlightShortCircuitNodes();
    if (this.shortCircuit && this.child === null) this.highlightShortCircuitNodes();

    this.notifyValueListeners();

    if (this.child !== null) return this.child.setValue(this.value);
    return !this.shortCircuit;
  }

  getType(): PinType {
    return this.type;
  }

  setType(newType: PinType): void {
    if (this.parent1 === null && this.parent2 === null) {
      this.type = newType;
      if (this.child !== null) this.child.updateType();
    } else {
      this.updateType();
    }
  }

  getChild(): Potential | null {
    return this.child;
  }

  /** Detach from parents and update children. */
  delete(): void {
    if (this.parent1 !== null) this.parent1.child = null;
    if (this.parent2 !== null) this.parent2.child = null;

    if (this.shortedNodes.length > 0) this.shortedNodes.forEach((n) => n.unhighlight(HIGHLIGHT.WARNING));

    if (this.child !== null) {
      this.child.update();
    } else if (this.shortCircuit) {
      this.parent1?.highlightShortCircuitNodes();
      this.parent2?.highlightShortCircuitNodes();
    }
  }

  /**
   * Silent detach from parents and child WITHOUT cascading recomputation of children. Used by the
   * whole-net rebuild (Wire.updatePotentialNetwork); the detached potential is dropped at once.
   */
  detach(): void {
    if (this.parent1 !== null) this.parent1.child = null;
    if (this.parent2 !== null) this.parent2.child = null;
    this.parent1 = null;
    this.parent2 = null;
    this.child = null;
    this.unhighlightShortCircuitNodes();
  }

  private updateType(): void {
    let type1: PinType = 'NC';
    let type2: PinType = 'NC';

    if (this.parent1 !== null || this.parent2 !== null) {
      if (this.parent1 !== null) type1 = this.parent1.getType();
      if (this.parent2 !== null) type2 = this.parent2.getType();

      if (type1 === 'OUT' || type2 === 'OUT') this.type = 'OUT';
      else if (type1 === 'WEAK_OUT' || type2 === 'WEAK_OUT') this.type = 'WEAK_OUT';
      else if (type1 === 'TRI_OUT' || type2 === 'TRI_OUT') this.type = 'TRI_OUT';
      else if (type1 === 'IO' || type2 === 'IO') this.type = 'IO';
      else if (type1 === 'IN' || type2 === 'IN') this.type = 'IN';
      else this.type = 'NC';
    } else {
      this.type = 'NC';
    }

    if (this.child !== null) this.child.updateType();
  }

  private highlightShortCircuitNodes(): void {
    if (this.shortCircuit) {
      this.getOutputNodes(this.shortedNodes);
      this.shortedNodes.forEach((n) => n.highlight(HIGHLIGHT.WARNING));
    }
  }

  private unhighlightShortCircuitNodes(): void {
    if (this.shortedNodes.length > 0) {
      this.shortedNodes.forEach((n) => n.unhighlight(HIGHLIGHT.WARNING));
      this.shortedNodes.length = 0;
    }
  }

  private checkShortCircuit(): void {
    const p1 = this.parent1!;
    const p2 = this.parent2!;
    if (p1.value !== 'NC' && p2.value !== 'NC') {
      if (p1.value !== p2.value) {
        this.shortCircuit = true;
        this.value = electricalRandom() < 0.5 ? 'LOW' : 'HIGH';
        return;
      }
      this.value = p1.value;
    } else if (p1.value !== 'NC') {
      this.value = p1.value;
    } else if (p2.value !== 'NC') {
      this.value = p2.value;
    }
    this.shortCircuit = false;
  }

  private getOutputNodes(listForNodes: Connectable[]): void {
    if (this.parent1 === null && this.parent2 === null) {
      if (this.node1 !== null && (this.type === 'OUT' || this.type === 'IO')) listForNodes.push(this.node1);
      if (this.node2 !== null && (this.type === 'OUT' || this.type === 'IO')) listForNodes.push(this.node2);
    } else {
      this.parent1?.getOutputNodes(listForNodes);
      this.parent2?.getOutputNodes(listForNodes);
    }
  }
}

function isPin<G>(node: Connectable | null): node is PinLike<G> {
  return node !== null && typeof (node as PinLike<G>).getOwner === 'function';
}
