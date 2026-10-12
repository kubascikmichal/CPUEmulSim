/**
 * The schematic sheet (SchematicSheet view part, 0.9.4): SVG rendering of grid, wires, gates and
 * junctions, plus the original mouse interaction model (Movable, Pin, Wire, WireEnd, WireJunction,
 * bus rails, rubber band, zoom/pan, context menus). Wire geometry, drops and junction work live in
 * the engine; this file maps pointer events onto those calls in the original event order.
 */
import { schematic } from '@cpuemul/engine';
import { Menu, MenuItem, Divider, ListItemIcon } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DialogApi } from '../common/Dialogs';
import { RamContentWindow } from './RamContentWindow';
import { GateBody } from './symbols';

const {
  Pin, Wire, WireEnd, MultiInputGate, Led, Input, PushButton, MatrixKeyboard, SevenSegmentDisplay, Register8, Ram8k,
  RailBus, Side, Point2D, javaRound, WIRE_COLOR_CHOICES,
} = schematic;
type Sheet = schematic.SchematicSheet;
type GateT = schematic.GateSymbol;
type PinT = schematic.Pin;
type WireT = schematic.Wire;

/** Component cell (px) - bodies, pins and junction dots keep this size on the finer sheet grid. */
const C = schematic.SchematicSheet.COMPONENT_CELL;
const SCALE_DELTA = 1.1;
const DRAG_THRESHOLD = 4;

// ------------------------------------------------------------------ object ids for DOM lookup

const ids = new WeakMap<object, number>();
const byId = new Map<number, WeakRef<object>>();
let nextId = 1;
function idOf(o: object): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
    byId.set(id, new WeakRef(o));
  }
  return id;
}
function objOf<T>(id: string | undefined | null): T | null {
  if (!id) return null;
  return (byId.get(Number(id))?.deref() as T) ?? null;
}

// ------------------------------------------------------------------ context menu model

interface MenuEntry {
  label?: string;
  radio?: boolean;
  checked?: boolean;
  divider?: boolean;
  submenu?: MenuEntry[];
  action?: () => void;
}

// ------------------------------------------------------------------ gesture state

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'rubber'; start: schematic.Point2D; current: schematic.Point2D }
  | { kind: 'gate'; gate: GateT; offset: schematic.Point2D; lastGridX: number; lastGridY: number; startClient: [number, number]; dragging: boolean; pin: PinT | null; partTarget: Element | null }
  | { kind: 'wireEnd'; end: schematic.WireEnd; startClient: [number, number]; dragging: boolean }
  | { kind: 'wire'; wire: WireT; startClient: [number, number]; dragging: boolean }
  | { kind: 'junction'; junction: schematic.WireJunction; startClient: [number, number]; dragging: boolean }
  | { kind: 'resize'; bus: schematic.RailBus; top: boolean };

export interface SheetViewHandle {
  /** last mouse position on the grid (paste anchor) */
  lastMouseGrid(): schematic.Point2D | null;
}

export function SheetView(props: {
  sheet: Sheet;
  dialogs: DialogApi;
  container: () => HTMLElement;
  onCoordinates: (text: string) => void;
  onZoom: (percent: number) => void;
  handleRef: React.MutableRefObject<SheetViewHandle | null>;
  paletteDrag: React.MutableRefObject<{ factory: (s: Sheet) => GateT } | null>;
}) {
  const { sheet, dialogs, container } = props;
  const G = sheet.getGrid().sizeX; // sheet grid (10 px): snapping of gates, wires, paste
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef<Gesture>({ kind: 'none' });
  const lastMouse = useRef<schematic.Point2D | null>(null);
  const lastPress = useRef<{ t: number; x: number; y: number; count: number }>({ t: 0, x: 0, y: 0, count: 0 });
  const [hoverWire, setHoverWire] = useState<WireT | null>(null);
  const [hoverPin, setHoverPin] = useState<PinT | null>(null);
  const [rubber, setRubber] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; onHidden?: () => void } | null>(null);
  const [ramWindows, setRamWindows] = useState<schematic.Ram8k[]>([]);
  const [, setVersion] = useState(0);

  // re-render on model changes (coalesced per frame)
  useEffect(() => {
    let raf = 0;
    const win = viewport.current?.ownerDocument.defaultView ?? window;
    const unsub = sheet.subscribe(() => {
      if (raf) return;
      raf = win.requestAnimationFrame(() => {
        raf = 0;
        setVersion(sheet.version);
      });
    });
    return () => {
      unsub();
      if (raf) win.cancelAnimationFrame(raf);
    };
  }, [sheet]);

  // RAM content windows of components that left the sheet (delete, New, Open) are closed
  useEffect(() => {
    if (ramWindows.some((r) => !sheet.getGates().includes(r))) setRamWindows((list) => list.filter((r) => sheet.getGates().includes(r)));
  });

  props.handleRef.current = { lastMouseGrid: () => (lastMouse.current ? sheet.getGrid().pixelToGrid(lastMouse.current.x, lastMouse.current.y) : null) };

  // ---------------------------------------------------------------- coordinates

  const toSheet = useCallback((clientX: number, clientY: number) => {
    const r = viewport.current!.getBoundingClientRect();
    const v = viewRef.current;
    return new Point2D((clientX - r.left - v.tx) / v.scale, (clientY - r.top - v.ty) / v.scale);
  }, []);

  /** enforceContentInView: the sheet always covers the viewport. */
  const clamp = useCallback(
    (v: { scale: number; tx: number; ty: number }) => {
      const el = viewport.current;
      if (!el) return v;
      const cw = sheet.widthPx * v.scale;
      const ch = sheet.heightPx * v.scale;
      const fix = (t: number, excess: number) => (excess < 0 ? 0 : t > 0 ? 0 : t < -excess ? -excess : t);
      return { scale: v.scale, tx: fix(v.tx, cw - el.clientWidth), ty: fix(v.ty, ch - el.clientHeight) };
    },
    [sheet],
  );

  const updateView = (v: { scale: number; tx: number; ty: number }) => {
    const c = clamp(v);
    viewRef.current = c;
    setView(c);
    sheet.setAppliedScale(c.scale);
  };

  useLayoutEffect(() => {
    const el = viewport.current!;
    const ro = new ResizeObserver(() => updateView(viewRef.current));
    ro.observe(el);
    // zoom with the mouse wheel - the grid point under the cursor stays fixed
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const v = viewRef.current;
      const factor = e.deltaY < 0 ? SCALE_DELTA : 1 / SCALE_DELTA;
      const newScale = v.scale * factor;
      if (newScale < 0.3 || newScale > 3) return;
      const anchor = toSheet(e.clientX, e.clientY);
      const r = el.getBoundingClientRect();
      updateView({ scale: newScale, tx: e.clientX - r.left - anchor.x * newScale, ty: e.clientY - r.top - anchor.y * newScale });
      props.onZoom(Math.trunc(newScale * 100));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- palette drag (ItemPicker → sheet)

  const paletteMove = (e: React.PointerEvent) => {
    const pd = props.paletteDrag.current;
    if (pd === null) return false;
    let item = sheet.getAddingItem();
    if (item === null) item = sheet.beginAdding(pd.factory);
    if (item === null) return true;
    // item centred under the cursor (Movable.nodeOffset == -1 branch), snapped to the sheet grid
    const p = toSheet(e.clientX, e.clientY);
    let gx = javaRound((p.x - (item.getGridWidth() * C) / 2) / G);
    let gy = javaRound((p.y - (item.getGridHeight() * C) / 2) / G);
    ({ gx, gy } = clampGrid(item, gx, gy));
    if (gx !== item.getGridPosX() || gy !== item.getGridPosY()) item.moveTo(gx, gy);
    return true;
  };

  /** Movable clamping: grid position in sheet-grid units, size in component cells. */
  const clampGrid = (item: { getGridWidth(): number; getGridHeight(): number }, gx: number, gy: number) => {
    const w = item.getGridWidth() * C;
    const h = item.getGridHeight() * C;
    if (gx < 0) gx = 0;
    else if (gx * G + w > sheet.widthPx) gx = Math.trunc(javaRound(sheet.widthPx - w) / G);
    if (gy < 0) gy = 0;
    else if (gy * G + h > sheet.heightPx) gy = Math.trunc(javaRound(sheet.heightPx - h) / G);
    return { gx, gy };
  };

  // ---------------------------------------------------------------- pointer dispatcher

  const targetOf = (el: Element | null) => {
    const find = (attr: string) => el?.closest(`[${attr}]`)?.getAttribute(attr) ?? null;
    return {
      pin: objOf<PinT>(find('data-pin')),
      gate: objOf<GateT>(find('data-gate')),
      wire: objOf<WireT>(find('data-wire')),
      junction: objOf<schematic.WireJunction>(find('data-junction')),
      end: objOf<schematic.WireEnd>(find('data-end')),
      part: el?.closest('[data-part]') ?? null,
      background: el?.closest('[data-background]') !== null && el?.closest('[data-gate],[data-wire],[data-junction]') === null,
    };
  };

  /** The model object a drop landed on (Sheet.resolveWireDrop). */
  const dropTargetOf = (t: ReturnType<typeof targetOf>): schematic.DropTarget => {
    if (t.pin) return { kind: 'pin', pin: t.pin };
    if (t.gate) return { kind: 'gate', gate: t.gate };
    if (t.junction) return { kind: 'junction', junction: t.junction };
    if (t.end) return { kind: 'wireEnd', end: t.end };
    if (t.wire) return { kind: 'wire', wire: t.wire };
    if (t.background) return { kind: 'background' };
    return { kind: 'none' };
  };

  const openMenu = (clientX: number, clientY: number, entries: MenuEntry[], onHidden?: () => void) =>
    setMenu({ x: clientX, y: clientY, entries, onHidden });

  /** JavaFX click count: presses within 500 ms and 4 px of each other. */
  const clickCount = (e: React.PointerEvent) => {
    const now = performance.now();
    const lp = lastPress.current;
    const count = now - lp.t < 500 && Math.abs(e.clientX - lp.x) <= DRAG_THRESHOLD && Math.abs(e.clientY - lp.y) <= DRAG_THRESHOLD ? lp.count + 1 : 1;
    lastPress.current = { t: now, x: e.clientX, y: e.clientY, count };
    return count;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // context menus are portals: their events bubble here through the React tree, but must not be
    // treated as sheet presses (pointer capture would steal the menu item's click)
    if (!(e.currentTarget as Element).contains(e.target as Node)) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const t = targetOf(e.target as Element);
    const p = toSheet(e.clientX, e.clientY);
    const primary = e.button === 0;
    const secondary = e.button === 2;
    const ctrl = e.ctrlKey || e.metaKey;

    // ---- context menus (secondary button); a secondary drag never pans
    if (secondary) {
      if (t.pin && t.pin.getOwner() instanceof RailBus) {
        const bus = t.pin.getOwner() as schematic.RailBus;
        const tap = bus.getTaps().find((x) => x.pin === t.pin);
        if (tap) openMenu(e.clientX, e.clientY, [{ label: 'Zmazať', action: () => bus.deleteTap(tap) }]);
        return;
      }
      if (t.gate) gateContextMenu(t.gate, t.part, e);
      else if (t.wire && sheet.isEditingEnabled()) wireContextMenu(t.wire, e);
      return;
    }
    if (!primary) return;
    const clicks = clickCount(e);

    // ---- interactive parts that act on press
    const part = t.part?.getAttribute('data-part');
    if ((part === 'resize' || part === 'resize-top') && t.gate instanceof RailBus) {
      gesture.current = { kind: 'resize', bus: t.gate, top: part === 'resize-top' };
      return;
    }
    if (t.gate instanceof PushButton && part === 'plunger') t.gate.mousePressed();
    if (t.gate instanceof MatrixKeyboard && part === 'key') {
      t.gate.mousePressed(Number(t.part!.getAttribute('data-row')), Number(t.part!.getAttribute('data-col')));
    }

    // ---- gates and their pins (Movable + HighlightGroup)
    if (t.gate) {
      selectOnPress(t.gate, e.shiftKey);
      gesture.current = {
        kind: 'gate', gate: t.gate, offset: new Point2D(p.x - t.gate.getLayoutX(), p.y - t.gate.getLayoutY()),
        lastGridX: t.gate.getGridPosX(), lastGridY: t.gate.getGridPosY(), startClient: [e.clientX, e.clientY], dragging: false,
        pin: t.pin, partTarget: t.part,
      };
      return;
    }

    // ---- visible junction: selects the wires meeting there; a drag starts a branch
    if (t.junction) {
      t.junction.selectWires(ctrl, e.shiftKey);
      gesture.current = { kind: 'junction', junction: t.junction, startClient: [e.clientX, e.clientY], dragging: false };
      return;
    }

    // ---- wire (its MOUSE_PRESSED filter handles ends too: double-click on an end deletes it)
    if (t.wire) {
      t.wire.press(clicks, t.end !== null, ctrl, e.shiftKey);
      if (!t.wire.attached) return;
      gesture.current = t.end
        ? { kind: 'wireEnd', end: t.end, startClient: [e.clientX, e.clientY], dragging: false }
        : { kind: 'wire', wire: t.wire, startClient: [e.clientX, e.clientY], dragging: false };
      return;
    }

    // ---- background: rubber band (Shift) or pan (only a press on empty space pans)
    if (e.shiftKey && sheet.isEditingEnabled()) {
      gesture.current = { kind: 'rubber', start: p, current: p };
      setRubber({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (t.background) gesture.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
  };

  /** HighlightGroup MOUSE_PRESSED: Shift toggles, plain press selects (keeping an existing selection). */
  const selectOnPress = (item: schematic.Selectable, shift: boolean) => {
    if (shift) {
      if (item.isSelected()) sheet.removeSelect(item);
      else sheet.addSelect(item);
    } else if (!item.isSelected()) {
      sheet.clearSelect();
      sheet.addSelect(item);
    }
  };

  const beyondThreshold = (start: [number, number], e: React.PointerEvent) =>
    Math.abs(e.clientX - start[0]) > DRAG_THRESHOLD || Math.abs(e.clientY - start[1]) > DRAG_THRESHOLD;

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toSheet(e.clientX, e.clientY);
    lastMouse.current = p;
    const grid = sheet.getGrid().pixelToGrid(p.x, p.y);
    props.onCoordinates(Math.trunc(grid.x) + 'x' + Math.trunc(grid.y));

    if (paletteMove(e)) return;
    const g = gesture.current;

    // a wire being drawn, or a grabbed end, follows the cursor (L preview)
    if (sheet.isWireDragActive()) {
      sheet.dragWire(p);
      return;
    }

    switch (g.kind) {
      case 'pan': {
        const v = viewRef.current;
        updateView({ scale: v.scale, tx: v.tx + e.clientX - g.lastX, ty: v.ty + e.clientY - g.lastY });
        g.lastX = e.clientX;
        g.lastY = e.clientY;
        return;
      }
      case 'rubber':
        g.current = p;
        setRubber({ x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) });
        return;
      case 'resize':
        if (g.top) g.bus.resizeTopTo(p.y - g.bus.getLayoutY());
        else g.bus.resizeTo(p.y - g.bus.getLayoutY());
        return;
      case 'junction':
        if (g.dragging || !beyondThreshold(g.startClient, e)) return;
        g.dragging = true;
        g.junction.beginDrag(); // DRAG_DETECTED: new branch
        if (sheet.isWireDragActive()) sheet.dragWire(p);
        return;
      case 'wireEnd':
        if (g.dragging || !beyondThreshold(g.startClient, e)) return;
        g.dragging = true;
        g.end.beginDrag(); // DRAG_DETECTED: grab / branch from junction / branch from free end
        if (sheet.isWireDragActive()) sheet.dragWire(p);
        return;
      case 'wire':
        if (g.dragging || !beyondThreshold(g.startClient, e)) return;
        g.dragging = true;
        g.wire.beginBranchDrag(p); // DRAG_DETECTED on the body: split + branch
        if (sheet.isWireDragActive()) sheet.dragWire(p);
        return;
      case 'gate': {
        if (!g.dragging && !beyondThreshold(g.startClient, e)) return;
        if (!g.dragging) {
          g.dragging = true;
          // Pin DRAG_DETECTED: an occupied pin grabs its wire end, a free pin starts a new wire
          if (g.pin && sheet.isEditingEnabled()) {
            if (g.pin.getWireEnd() !== null) WireEnd.beginGrab(g.pin.getWireEnd());
            else sheet.beginWireCreation(g.pin);
            sheet.dragWire(p);
            return;
          }
        }
        if (g.pin) return; // the pin consumes its drags
        if (!sheet.isEditingEnabled()) return;
        moveGate(g, p);
        return;
      }
    }
  };

  /** Movable.onMouseDragged (snapping to the sheet grid). */
  const moveGate = (g: Extract<Gesture, { kind: 'gate' }>, p: schematic.Point2D) => {
    const item = g.gate;
    sheet.beginComponentDrag();
    let gx = javaRound((p.x - g.offset.x) / G);
    let gy = javaRound((p.y - g.offset.y) / G);
    if (item.getGridPosX() === gx && item.getGridPosY() === gy) return;
    ({ gx, gy } = clampGrid(item, gx, gy));
    if (item.isSelected()) {
      const dx = gx - g.lastGridX;
      const dy = gy - g.lastGridY;
      for (const other of sheet.getSelectedGates()) if (other !== item) other.moveByGrid(dx, dy);
    }
    item.moveTo(gx, gy);
    g.lastGridX = gx;
    g.lastGridY = gy;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const pd = props.paletteDrag.current;
    if (pd !== null) {
      props.paletteDrag.current = null;
      sheet.finishAdding();
      return;
    }
    const g = gesture.current;
    gesture.current = { kind: 'none' };
    const doc = viewport.current!.ownerDocument;
    const under = doc.elementFromPoint(e.clientX, e.clientY);
    const t = targetOf(under);
    const p = toSheet(e.clientX, e.clientY);

    // releases on interactive parts (delivered to the press target in JavaFX)
    if (g.kind === 'gate' && g.gate instanceof PushButton && g.partTarget?.getAttribute('data-part') === 'plunger') g.gate.mouseReleased();
    if (g.kind === 'gate' && g.gate instanceof MatrixKeyboard && g.partTarget?.getAttribute('data-part') === 'key') {
      g.gate.mouseReleased(Number(g.partTarget.getAttribute('data-row')), Number(g.partTarget.getAttribute('data-col')));
    }

    if (sheet.isWireDragActive()) {
      // MOUSE_DRAG_RELEASED on a pin → scene MOUSE_RELEASED filter → the source's MOUSE_RELEASED
      if (t.pin) sheet.dropOnPin(t.pin, g.kind === 'gate' ? g.pin : null);
      if (!sheet.resolveWireDrop(dropTargetOf(t), p)) sheet.releaseWireDrag();
      return;
    }

    switch (g.kind) {
      case 'rubber': {
        setRubber(null);
        if (!e.shiftKey) return;
        const x1 = Math.min(g.start.x, g.current.x), y1 = Math.min(g.start.y, g.current.y);
        const x2 = Math.max(g.start.x, g.current.x), y2 = Math.max(g.start.y, g.current.y);
        const hit = (b: { x1: number; y1: number; x2: number; y2: number }) => b.x1 <= x2 && b.x2 >= x1 && b.y1 <= y2 && b.y2 >= y1;
        for (const gate of sheet.getGates()) if (hit(gateBounds(gate))) sheet.addSelect(gate);
        for (const wire of sheet.getWires()) if (hit(wireBounds(wire))) sheet.addSelect(wire);
        return;
      }
      case 'gate': {
        // MOUSE_CLICKED (press and release on the same node - even after moving, as in JavaFX)
        const sameNode = g.partTarget !== null && (under === g.partTarget || g.partTarget.contains(under));
        if (g.gate instanceof Input && g.partTarget?.getAttribute('data-part') === 'input' && sameNode) g.gate.toggle();
        if (g.gate instanceof RailBus && g.partTarget?.getAttribute('data-part') === 'rail' && sameNode) railMenu(g.gate, e);
        // Movable release (postponed junction work) + GateSymbol.snapPinsToFreeEnds
        sheet.releaseGate(g.gate);
        return;
      }
      case 'pan':
        // background MOUSE_CLICKED (primary, no Shift) clears the selection
        if (!e.shiftKey && t.background) sheet.clearSelect();
        return;
    }
  };

  // ---------------------------------------------------------------- menus

  const railMenu = (bus: schematic.RailBus, e: React.PointerEvent) => {
    if (sheet.getInProgressWire() !== null) return;
    const localY = toSheet(e.clientX, e.clientY).y - bus.getLayoutY();
    openMenu(
      e.clientX,
      e.clientY,
      [
        { label: 'Všetky', action: () => bus.createAllTaps() },
        { divider: true },
        ...bus.signalNames().map((name, bit) => ({ label: name, radio: true, checked: false, action: () => void bus.createTap(bit, localY) })),
      ],
    );
  };

  const wireContextMenu = (wire: WireT, e: React.PointerEvent) => {
    const current = wire.getColor().toUpperCase();
    openMenu(e.clientX, e.clientY, [
      {
        label: 'Farba vodiča',
        submenu: WIRE_COLOR_CHOICES.map(([label, color]) => ({
          label, radio: true, checked: color.toUpperCase() === current, action: () => wire.setChainColor(color),
        })),
      },
    ]);
  };

  const gateContextMenu = (gate: GateT, part: Element | null, e: React.PointerEvent) => {
    const editing = sheet.isEditingEnabled();
    if (gate instanceof Register8) {
      openMenu(e.clientX, e.clientY, [{ label: Register8.SWAP_MENU, action: () => gate.toggleSwap() }]);
    } else if (gate instanceof Ram8k) {
      openMenu(e.clientX, e.clientY, [
        { label: Ram8k.CONTENT_MENU, action: () => setRamWindows((list) => (list.includes(gate) ? list : [...list, gate])) },
      ]);
    } else if (gate instanceof MultiInputGate) {
      openMenu(e.clientX, e.clientY, MultiInputGate.MENU.map((m) => ({ label: m.label, action: () => gate.setInputCount(m.count) })));
    } else if (gate instanceof Led && part?.getAttribute('data-part') === 'led') {
      if (!editing) return;
      const ledSide = gate.getInputPin().getExitSide().name;
      // the checked colour is the LED's actual colour (none if it is not one of the menu colours)
      const ledColor = gate.getLedColor().toUpperCase();
      openMenu(e.clientX, e.clientY, [
        {
          label: 'Vývod',
          submenu: Led.PLACEMENT_MENU.map(([label, side]) => ({
            label, radio: true, checked: ledSide === side.name, action: () => gate.placeInput(side),
          })),
        },
        { divider: true },
        {
          label: 'Farba LED',
          submenu: Led.COLORS.map(([label, color]) => ({
            label, radio: true, checked: color.toUpperCase() === ledColor, action: () => gate.setColor(color),
          })),
        },
      ]);
    } else if (gate instanceof Input && part?.getAttribute('data-part') === 'input') {
      if (!editing) return;
      openMenu(e.clientX, e.clientY, Input.PLACEMENT_MENU.map(([label, side]) => ({ label, action: () => gate.placeOutput(side) })));
    } else if (gate instanceof SevenSegmentDisplay) {
      if (!editing) return;
      const current = SevenSegmentDisplay.COLORS.findIndex(([, c]) => c === gate.getSegmentColor());
      openMenu(e.clientX, e.clientY, SevenSegmentDisplay.COLORS.map(([label, color], i) => ({ label, radio: true, checked: i === current, action: () => gate.setColor(color) })));
    } else if (gate instanceof PushButton && part?.getAttribute('data-part') === 'plunger') {
      openMenu(e.clientX, e.clientY, [
        { label: 'Toggle', checked: gate.isToggle(), action: () => gate.setToggle(!gate.isToggle()) },
        { divider: true },
        {
          label: 'Label…',
          action: () =>
            void dialogs.textInput({ title: 'Label tlačidla', content: 'Zadaj jedno písmeno:', initial: gate.getLabel(), maxLength: 1 }).then((v) => v !== null && gate.setLabel(v)),
        },
      ]);
    } else if (gate instanceof MatrixKeyboard && part?.getAttribute('data-part') === 'key') {
      const row = Number(part.getAttribute('data-row'));
      const col = Number(part.getAttribute('data-col'));
      openMenu(e.clientX, e.clientY, [
        { label: 'Toggle', checked: gate.isToggle(), action: () => gate.setToggle(!gate.isToggle()) },
        { divider: true },
        {
          label: 'Label…',
          action: () =>
            void dialogs
              .textInput({ title: 'Label klávesy', content: 'Zadaj jedno písmeno:', initial: gate.getKeyLabel(row, col), maxLength: 1 })
              .then((v) => v !== null && gate.setKeyLabel(row, col, v)),
        },
      ]);
    }
  };

  // ---------------------------------------------------------------- rendering

  const gates = sheet.getGates();
  const wires = sheet.getWires();
  const junctions = sheet.getJunctions();

  return (
    <div
      ref={viewport}
      style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%', background: '#e8e8e8', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (props.paletteDrag.current !== null) sheet.cancelAdding(); // MOUSE_DRAG_EXITED
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="sheet"
    >
      <svg
        width={sheet.widthPx}
        height={sheet.heightPx}
        style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        <defs>
          <pattern id="grid" width={G} height={G} patternUnits="userSpaceOnUse">
            <path d={`M ${G} 0 L 0 0 0 ${G}`} fill="none" stroke="#D3D3D3" strokeOpacity={0.5} strokeWidth={1} />
          </pattern>
          <filter id="pinGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>
        <g data-background>
          <rect width={sheet.widthPx} height={sheet.heightPx} fill="#fff" />
          <rect width={sheet.widthPx} height={sheet.heightPx} fill="url(#grid)" />
        </g>
        {/* layer order: background, wires, gates, junctions (SheetLayersManager) */}
        <g>
          {wires.map((w) => (
            <WireView key={idOf(w)} wire={w} hovered={hoverWire === w} onHover={setHoverWire} />
          ))}
        </g>
        <g>
          {gates.map((g) => (
            <GateView key={idOf(g)} gate={g} hoverPin={hoverPin} onHoverPin={setHoverPin} />
          ))}
        </g>
        <g>
          {/* only junctions of 3+ wires are drawn (and pickable); 2 = an invisible bend */}
          {junctions
            .filter((j) => j.isVisible())
            .map((j) => (
              <JunctionView key={idOf(j)} junction={j} />
            ))}
        </g>
        {rubber && <rect x={rubber.x} y={rubber.y} width={rubber.w} height={rubber.h} fill="none" stroke="#000" strokeDasharray="4 4" strokeWidth={1.5} pointerEvents="none" />}
      </svg>
      {ramWindows.map((ram, i) => (
        <RamContentWindow key={idOf(ram)} ram={ram} offset={i} onClose={() => setRamWindows((list) => list.filter((r) => r !== ram))} />
      ))}
      {menu && (
        <ContextMenuView
          menu={menu}
          container={container}
          close={() => {
            menu.onHidden?.();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function gateBounds(g: GateT) {
  const x = g.getLayoutX(), y = g.getLayoutY();
  return { x1: x - C / 2, y1: y - C / 2, x2: x + g.getGridWidth() * C + C / 2, y2: y + g.getGridHeight() * C + C / 2 };
}

function wireBounds(w: WireT) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const line of w.getLines()) {
    for (const p of line) {
      x1 = Math.min(x1, p.x - 1); y1 = Math.min(y1, p.y - 1); x2 = Math.max(x2, p.x + 1); y2 = Math.max(y2, p.y + 1);
    }
  }
  return { x1, y1, x2, y2 };
}

function GateView({ gate, hoverPin, onHoverPin }: { gate: GateT; hoverPin: PinT | null; onHoverPin: (p: PinT | null) => void }) {
  const w = gate.getGridWidth() * C;
  const h = gate.getGridHeight() * C;
  const r = C / 8; // pin core 2.5 px
  return (
    <g data-gate={idOf(gate)} transform={`translate(${gate.getLayoutX()},${gate.getLayoutY()})`} style={{ cursor: 'default' }}>
      <GateBody gate={gate} />
      {gate.getPins().map((pin) => {
        const hl = hoverPin === pin ? { color: 'orange', opacity: 0.5 } : pin.getHighlight();
        const effective = pin.getHighlight().opacity > 0 ? pin.getHighlight() : hl;
        return (
          <g key={idOf(pin)} data-pin={idOf(pin)} transform={`translate(${pin.getLayoutX()},${pin.getLayoutY()})`} onPointerEnter={() => onHoverPin(pin)} onPointerLeave={() => onHoverPin(null)}>
            <rect x={-C / 2} y={-C / 2} width={C} height={C} fill="transparent" />
            {effective.opacity > 0 && <circle r={r * 1.8} fill={effective.color} opacity={effective.opacity} filter="url(#pinGlow)" pointerEvents="none" />}
            <circle r={r} fill="rgb(60,60,60)" />
          </g>
        );
      })}
      {/* selection outline 2 px outside the body (Item.applySelectionBounds) */}
      {gate.isSelected() && <rect x={-2} y={-2} width={w + 4} height={h + 4} fill="none" stroke="#000" strokeWidth={2} strokeDasharray="10 5" strokeLinecap="round" opacity={0.8} pointerEvents="none" />}
    </g>
  );
}

function WireView({ wire, hovered, onHover }: { wire: WireT; hovered: boolean; onHover: (w: WireT | null) => void }) {
  const color = wire.getCurrentColor();
  const lines = wire.getLines();
  // selection = 1, hover = 0.7: a dashed inverse-colour overlay ABOVE the line (the line keeps its colour)
  const highlight = wire.isSelected() ? 1 : hovered ? 0.7 : 0;
  const invert = invertColor(wire.getColor());
  const points = lines.map(([a]) => `${a.x},${a.y}`).concat(`${lines[lines.length - 1][1].x},${lines[lines.length - 1][1].y}`).join(' ');
  return (
    <g
      data-wire={idOf(wire)}
      opacity={wire.opacity}
      style={{ pointerEvents: wire.mouseTransparent ? 'none' : 'auto' }}
      onPointerEnter={() => onHover(wire)}
      onPointerLeave={() => onHover(null)}
    >
      {/* wide transparent hit stroke - the 2 px line alone is hard to hit */}
      <polyline points={points} fill="none" stroke="transparent" strokeWidth={8} />
      {lines.map(([a, b], i) => (
        <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2} strokeLinecap="round" />
      ))}
      {highlight > 0 && (
        <polyline points={points} fill="none" stroke={invert} strokeWidth={1} strokeDasharray="6 4" strokeLinecap="round" opacity={highlight} pointerEvents="none" />
      )}
      {/* wire ends: invisible one-cell hit areas (drag = grab / branch, double-click = delete) */}
      {wire.getEnds().map((end) => (
        <rect key={idOf(end)} data-end={idOf(end)} x={end.getLayoutX() - C / 2} y={end.getLayoutY() - C / 2} width={C} height={C} fill="transparent" />
      ))}
    </g>
  );
}

function JunctionView({ junction }: { junction: schematic.WireJunction }) {
  const [hover, setHover] = useState(false);
  const r = C / 7;
  return (
    <circle
      data-junction={idOf(junction)}
      cx={junction.getLayoutX()}
      cy={junction.getLayoutY()}
      r={hover ? r * 1.2 : r}
      fill="#000"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    />
  );
}

function invertColor(hex: string): string {
  const n = parseInt(hex.substring(1), 16);
  return '#' + (0xffffff - n).toString(16).padStart(6, '0');
}

function ContextMenuView({ menu, container, close }: { menu: { x: number; y: number; entries: MenuEntry[] }; container: () => HTMLElement; close: () => void }) {
  const [sub, setSub] = useState<{ anchor: HTMLElement; entries: MenuEntry[] } | null>(null);
  const render = (entries: MenuEntry[], closeAll: () => void): ReactNode[] =>
    entries.map((m, i) =>
      m.divider ? (
        <Divider key={i} />
      ) : (
        <MenuItem
          key={i}
          onClick={(ev) => {
            if (m.submenu) {
              setSub({ anchor: ev.currentTarget, entries: m.submenu });
              return;
            }
            closeAll();
            m.action?.();
          }}
        >
          <ListItemIcon sx={{ minWidth: '20px !important' }}>{m.checked ? (m.radio ? '●' : '✓') : ''}</ListItemIcon>
          {m.label}
          {m.submenu ? ' ▸' : ''}
        </MenuItem>
      ),
    );
  return (
    <>
      <Menu open anchorReference="anchorPosition" anchorPosition={{ top: menu.y, left: menu.x }} onClose={close} container={container} transitionDuration={0}>
        {render(menu.entries, close)}
      </Menu>
      {sub && (
        <Menu
          open
          anchorEl={sub.anchor}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          onClose={() => setSub(null)}
          container={container}
          transitionDuration={0}
        >
          {render(sub.entries, () => {
            setSub(null);
            close();
          })}
        </Menu>
      )}
    </>
  );
}

export { Wire, Pin, Side };
