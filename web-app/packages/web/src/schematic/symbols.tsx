/**
 * SVG drawings of the schematic components - geometry ported from each component's `drawBody()`
 * (component cell = 20 px, independent of the 10 px sheet grid). Pins, selection frames and wires
 * are drawn by SheetView.
 */
import { schematic } from '@cpuemul/engine';
import type { ReactNode } from 'react';

const {
  AndGate, NandGate, OrGate, NorGate, XorGate, MultiInputGate, NotGate, BusBuffer, Led, Input, PushButton,
  MatrixKeyboard, SevenSegmentDisplay, Register8, Ram8k, Decoder38, Encoder83, RailBus, RAIL_THICKNESS,
} = schematic;

type Gate = schematic.GateSymbol;

const C = schematic.SchematicSheet.COMPONENT_CELL; // component cell (20 px)
/** Component outline width (0.9.4: 3 px; Input 2 px). */
const SW = 3;
const WHITESMOKE = '#F5F5F5';
const DARKGRAY = '#A9A9A9';
const SEGMENT_OFF = 'rgb(220,220,220)';
const TEXT = { fontFamily: 'system-ui, sans-serif', fontSize: 13 } as const;

function Label(props: { x: number; y: number; children: string; size?: number; fill?: string; anchor?: 'start' | 'middle' }) {
  return (
    <text
      x={props.x}
      y={props.y}
      fontFamily={TEXT.fontFamily}
      fontSize={props.size ?? TEXT.fontSize}
      fill={props.fill ?? '#000'}
      textAnchor={props.anchor ?? 'start'}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      {props.children}
    </text>
  );
}

function multiInput(g: InstanceType<typeof MultiInputGate>): ReactNode {
  const w = g.getGridWidth() * C;
  const h = g.getGridHeight() * C;
  const bubble = C / 4;
  const bodyW = g.negated() ? w - 2 * bubble : w;
  return (
    <>
      <rect width={bodyW} height={h} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />
      <Label x={bodyW / 2} y={h / 2 + 5} anchor="middle">
        {g.getSymbolText()}
      </Label>
      {g.negated() && <circle cx={w - bubble} cy={g.outputRow() * C} r={bubble} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />}
    </>
  );
}

/** Body box with a title: the instance name (REG1, RAM1, ...) replaces the default title once set. */
function titledBox(gate: Gate, width: number, height: number, defaultTitle: string, labels: [string, number, number][]): ReactNode {
  const title = gate.getInstanceName() ?? defaultTitle;
  return (
    <>
      <rect width={width * C} height={height * C} fill="#fff" stroke="#000" strokeWidth={SW} />
      <Label x={(width * C) / 2} y={-C * 0.2} size={C * 0.6} anchor="middle">
        {title}
      </Label>
      {labels.map(([text, x, y]) => (
        <Label key={text + x + y} x={x} y={y}>
          {text}
        </Label>
      ))}
    </>
  );
}

function sevenSegment(g: InstanceType<typeof SevenSegmentDisplay>): ReactNode {
  const c = C;
  const shift = 0.7 * c;
  const t = 0.5 * c;
  const hx1 = 1.0 * c + shift, hx2 = 3.6 * c + shift;
  const ay = 0.9 * c + shift, gy = 4.3 * c + shift, dy = 7.7 * c + shift;
  const vx1 = 0.7 * c + shift, vx2 = 3.9 * c + shift;
  const upperTop = 1.35 * c + shift, upperBottom = 3.8 * c + shift;
  const lowerTop = 4.8 * c + shift, lowerBottom = 7.25 * c + shift;
  const half = t / 2;
  const hBar = (x1: number, x2: number, y: number) =>
    `${x1 + half},${y - half} ${x2 - half},${y - half} ${x2},${y} ${x2 - half},${y + half} ${x1 + half},${y + half} ${x1},${y}`;
  const vBar = (x: number, y1: number, y2: number) =>
    `${x - half},${y1 + half} ${x - half},${y2 - half} ${x},${y2} ${x + half},${y2 - half} ${x + half},${y1 + half} ${x},${y1}`;
  const shapes = [
    hBar(hx1, hx2, ay), vBar(vx2, upperTop, upperBottom), vBar(vx2, lowerTop, lowerBottom), hBar(hx1, hx2, dy),
    vBar(vx1, lowerTop, lowerBottom), vBar(vx1, upperTop, upperBottom), hBar(hx1, hx2, gy),
  ];
  const lit = g.getLitSegments();
  const fill = (i: number) => (g.isPowered() && lit[i] ? g.getSegmentColor() : SEGMENT_OFF);
  return (
    <>
      <rect width={6 * c} height={10 * c} fill="#fff" stroke="#000" strokeWidth={SW} />
      {shapes.map((points, i) => (
        <polygon key={i} points={points} fill={fill(i)} />
      ))}
      <circle cx={4.35 * c + shift} cy={dy} r={0.28 * c} fill={fill(7)} />
      {SevenSegmentDisplay.PIN_NAMES.map((name, i) => (
        <Label key={name} x={c * 0.53} y={(1 + i) * c + c * 0.2} size={c * 0.55} anchor="middle">
          {name}
        </Label>
      ))}
    </>
  );
}

/** Body drawing of a gate in its local coordinates. */
export function GateBody({ gate }: { gate: Gate }): ReactNode {
  if (gate instanceof AndGate || gate instanceof NandGate || gate instanceof OrGate || gate instanceof NorGate || gate instanceof XorGate) {
    return multiInput(gate);
  }
  if (gate instanceof NotGate) {
    const w = 2 * C, h = 2 * C, b = C / 4;
    return (
      <>
        <rect width={w - 2 * b} height={h} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />
        <Label x={(w - 2 * b) / 2 - 4} y={h / 2 + 5}>
          1
        </Label>
        <circle cx={w - b} cy={h / 2} r={b} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />
      </>
    );
  }
  if (gate instanceof BusBuffer) {
    const w = 2 * C, h = 2 * C;
    return (
      <>
        <polygon points={`0,0 0,${h} ${w},${h / 2}`} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />
        <circle cx={C} cy={C / 4} r={C / 4} fill={WHITESMOKE} stroke="#000" strokeWidth={SW} />
      </>
    );
  }
  if (gate instanceof Led) {
    return <circle data-part="led" cx={C} cy={C} r={C * 0.55} fill={gate.isLit() ? gate.getLedColor() : DARKGRAY} stroke="#000" strokeWidth={SW} />;
  }
  if (gate instanceof Input) {
    const size = C * 0.9;
    return (
      <>
        <rect data-part="input" x={C - size / 2} y={C - size / 2} width={size} height={size} fill="#fff" stroke="#000" strokeWidth={2} />
        <Label x={C} y={C + C * 0.21} size={C * 0.6} anchor="middle">
          {gate.isOn() ? '1' : '0'}
        </Label>
      </>
    );
  }
  if (gate instanceof PushButton) {
    return (
      <>
        <rect width={2 * C} height={2 * C} fill={WHITESMOKE} stroke="#808080" strokeWidth={SW} />
        <circle data-part="plunger" cx={C} cy={C} r={C * 0.6} fill={gate.isPressedState() ? DARKGRAY : '#000'} stroke="#fff" strokeWidth={SW} />
        <Label x={C} y={C + C * 0.25} size={C * 0.7} fill="#fff" anchor="middle">
          {gate.getLabel()}
        </Label>
      </>
    );
  }
  if (gate instanceof MatrixKeyboard) {
    const keys: ReactNode[] = [];
    for (let row = 0; row < MatrixKeyboard.ROWS; row++) {
      for (let col = 0; col < MatrixKeyboard.COLS; col++) {
        const bx = (1 + col * 2) * C;
        const by = (1 + row * 2) * C;
        keys.push(
          <g key={`${row}-${col}`}>
            <rect x={bx} y={by} width={2 * C} height={2 * C} fill={WHITESMOKE} stroke="#808080" strokeWidth={1.5} />
            <circle
              data-part="key"
              data-row={row}
              data-col={col}
              cx={bx + C}
              cy={by + C}
              r={C * 0.6}
              fill={gate.isActiveKey(row, col) ? DARKGRAY : '#000'}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <Label x={bx + C} y={by + C + C * 0.25} size={C * 0.7} fill="#fff" anchor="middle">
              {gate.getKeyLabel(row, col)}
            </Label>
          </g>,
        );
      }
    }
    return <>{keys}</>;
  }
  if (gate instanceof SevenSegmentDisplay) return sevenSegment(gate);
  if (gate instanceof Register8) {
    const labels: [string, number, number][] = [];
    const swapped = gate.isSwapped();
    for (let i = 0; i < 8; i++) {
      labels.push(['D' + (i + 1), swapped ? C * 2.6 : C * 0.4, (i + 1) * C + C * 0.25], ['Q' + (i + 1), swapped ? C * 0.4 : C * 2.6, (i + 1) * C + C * 0.25]);
    }
    labels.push(['OE/', C * 0.4, C * 9.3], ['LE', C * 0.4, C * 10.3]);
    return titledBox(gate, 4, 11, 'REGISTER', labels);
  }
  if (gate instanceof Ram8k) {
    const labels: [string, number, number][] = [];
    for (let i = 0; i < 8; i++) labels.push(['D' + i, C * 0.4, (i + 1) * C + C * 0.25]);
    ['WE/', 'OE/', 'E1/', 'E2'].forEach((t, i) => labels.push([t, C * 0.4, (9 + i) * C + C * 0.25]));
    for (let i = 0; i < 13; i++) labels.push(['A' + i, C * 3.6, (i + 1) * C + C * 0.25]);
    return titledBox(gate, 5, 14, 'RAM 8k×8', labels);
  }
  if (gate instanceof Decoder38) {
    const labels: [string, number, number][] = [];
    [1, 2, 3, 8].forEach((row, i) => labels.push([['A', 'B', 'C', 'G'][i], C * 0.4, row * C + C * 0.25]));
    for (let i = 0; i < 8; i++) labels.push(['Y' + i, C * 2.6, (i + 1) * C + C * 0.25]);
    return titledBox(gate, 4, 9, 'DECODER', labels);
  }
  if (gate instanceof Encoder83) {
    const labels: [string, number, number][] = [['EI', C * 0.4, C + C * 0.15]];
    for (let i = 0; i < 8; i++) labels.push(['D' + i, C * 0.4, (i + 2) * C + C * 0.25]);
    [1, 2, 4, 5, 6].forEach((row, i) => labels.push([['EO', 'GS', 'A0', 'A1', 'A2'][i], C * 2.6, row * C + C * 0.25]));
    return titledBox(gate, 4, 10, 'ENCODER', labels);
  }
  if (gate instanceof RailBus) {
    const thickness = Math.max(4, C * RAIL_THICKNESS);
    const cx = C; // RAIL_WIDTH * cell / 2
    const top = gate.getTopRow();
    return (
      <>
        <rect data-part="rail" x={cx - thickness / 2} y={top * C + C / 2} width={thickness} height={(gate.getRows() - top) * C - C} fill={gate.railColor} stroke="#000" strokeWidth={1} />
        <Label x={cx - C * 0.55} y={top * C - C * 0.15} size={C * 0.6} fill={gate.railColor}>
          {gate.getBusLabel()}
        </Label>
        {gate.getTaps().map((tap, i) => {
          const y = tap.pin.getLayoutY();
          return (
            <g key={i} style={{ pointerEvents: 'none' }}>
              <circle cx={cx} cy={y} r={C * 0.28} fill={gate.tapColor(tap)} stroke="#000" strokeWidth={1} />
              <Label x={cx + C * 0.6} y={y - C * 0.4} size={C * 0.5} fill={gate.railColor}>
                {tap.pin.getName()}
              </Label>
            </g>
          );
        })}
        {/* invisible resize handles centred on the drawn rail ends */}
        <circle data-part="resize" cx={cx} cy={gate.getRows() * C - C / 2} r={C * 0.35} fill="transparent" style={{ cursor: 'ns-resize' }} />
        <circle data-part="resize-top" cx={cx} cy={top * C + C / 2} r={C * 0.35} fill="transparent" style={{ cursor: 'ns-resize' }} />
      </>
    );
  }
  return <rect width={gate.getGridWidth() * C} height={gate.getGridHeight() * C} fill={WHITESMOKE} stroke="#000" />;
}

/** Palette entries: order of SchematicController.registerItems, label and icon of getImage(). */
export const PALETTE: { label: string; icon: string; ctor: schematic.GateCtor }[] = [
  { label: 'AB', icon: 'bus', ctor: schematic.AddressBus16 },
  { label: 'DB', icon: 'bus', ctor: schematic.DataBus8 },
  { label: 'CB', icon: 'bus', ctor: schematic.ControlBus },
  { label: 'INP', icon: 'input', ctor: Input },
  { label: 'LED', icon: 'led', ctor: Led },
  { label: 'BTN', icon: 'tlacidlo', ctor: PushButton },
  { label: 'KBD', icon: 'klavesnica', ctor: MatrixKeyboard },
  { label: '7SEG', icon: '7segment', ctor: SevenSegmentDisplay },
  { label: 'NOT', icon: 'not', ctor: NotGate },
  { label: 'AND', icon: 'and', ctor: AndGate },
  { label: 'OR', icon: 'or', ctor: OrGate },
  { label: 'NAND', icon: 'nand', ctor: NandGate },
  { label: 'NOR', icon: 'nor', ctor: NorGate },
  { label: 'XOR', icon: 'xor', ctor: XorGate },
  { label: 'Buffer', icon: 'bus-buffer', ctor: BusBuffer },
  { label: 'REG', icon: 'register', ctor: Register8 },
  { label: '8kB RAM', icon: 'ram', ctor: Ram8k },
  { label: 'DEK', icon: 'dekoder', ctor: Decoder38 },
  { label: 'KOD', icon: 'koder', ctor: Encoder83 },
];
