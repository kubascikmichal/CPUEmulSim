/**
 * CodeMirror 6 setup replacing the RichTextFX `CodeArea` of the original
 * (CodeEditorFactory + BreakpointFactory + RichTextFXHelpers + CPUEmul_style.css).
 */
import { isInstructionLine, stripComments } from '@cpuemul/engine';
import { history, historyKeymap, insertNewline, insertTab, standardKeymap } from '@codemirror/commands';
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { COLORS } from '../common/theme';

// ------------------------------------------------------------------ syntax highlighting (CodeEditorFactory)

const KEYWORDS_ARITHMETIC_AND_LOGIC = ['ADD', 'ADC', 'ADI', 'SUB', 'SUC', 'SBI', 'AND', 'ANI', 'ORR', 'ORI', 'XOR', 'XRI', 'INC', 'INX', 'DEC', 'DCX', 'CMP', 'CMI'];
const KEYWORDS_SHIFT_AND_ROTATE = ['SHL', 'SHR', 'SCR', 'RTL', 'RCL', 'RTR', 'RCR'];
const KEYWORDS_MOVE = ['MOV', 'MVI', 'MXI', 'MVX', 'MMR', 'LMI', 'LMR', 'SMI', 'SMR', 'INN', 'OUT', 'PUS', 'POP', 'STR', 'LDR'];
const KEYWORDS_BRANCH = ['JMP', 'JZR', 'JNZ', 'JCY', 'JNC', 'CAL', 'CZR', 'CNZ', 'CCY', 'CNC', 'RET', 'JL', 'JG', 'JE', 'JLE', 'JGE', 'JNE', 'JNL', 'JNG', 'CL', 'CG', 'CE', 'CLE', 'CGE', 'CNE', 'CNL', 'CNG'];
const KEYWORDS_SPECIAL = ['EIT', 'DIT', 'SCALL', 'BYTE'];

const kw = (words: string[]) => `\\b(?:${words.join('|')})\\b`;
const KEYWORD_PATTERN = new RegExp(
  `(${kw(KEYWORDS_ARITHMETIC_AND_LOGIC)})|(${kw(KEYWORDS_SHIFT_AND_ROTATE)})|(${kw(KEYWORDS_MOVE)})|(${kw(KEYWORDS_BRANCH)})|(${kw(KEYWORDS_SPECIAL)})`,
  'gi',
);
/** Same label rule as the parser: `\w+:` at the start of the line. */
const LABEL_PATTERN = /^\s*(\w+:)/;
const LABEL_MARK = 5;
const COMMENT_MARK = 6;
const CLASSES = ['cm-kw-arith', 'cm-kw-shift', 'cm-kw-move', 'cm-kw-branch', 'cm-kw-special', 'cm-asm-label', 'cm-asm-comment'];
const MARKS = CLASSES.map((c) => Decoration.mark({ class: c }));

function highlight(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      // the parser's comment rule: `;` inside quotes is not a comment
      const code = stripComments(line.text);
      let start = 0;
      const label = LABEL_PATTERN.exec(code);
      if (label !== null) {
        start = label[0].length;
        builder.add(line.from + start - label[1].length, line.from + start, MARKS[LABEL_MARK]);
      }
      KEYWORD_PATTERN.lastIndex = start;
      let m: RegExpExecArray | null;
      while ((m = KEYWORD_PATTERN.exec(code)) !== null) {
        const group = m.findIndex((g, i) => i > 0 && g !== undefined) - 1;
        builder.add(line.from + m.index, line.from + m.index + m[0].length, MARKS[group]);
      }
      if (code.length < line.text.length) builder.add(line.from + code.length, line.to, MARKS[COMMENT_MARK]);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlight(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = highlight(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ------------------------------------------------------------------ breakpoints (BreakpointFactory)

class BreakpointMarker extends GutterMarker {
  override toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-bp-box';
    const dot = document.createElement('div');
    dot.className = 'cm-bp-dot';
    box.appendChild(dot);
    return box;
  }
}
class EmptyBreakpointMarker extends GutterMarker {
  override toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-bp-box';
    return box;
  }
}
const BREAKPOINT = new BreakpointMarker();
const NO_BREAKPOINT = new EmptyBreakpointMarker();

const toggleBreakpointEffect = StateEffect.define<{ pos: number; on: boolean }>({
  map: (v, mapping) => ({ pos: mapping.mapPos(v.pos), on: v.on }),
});
const clearBreakpointsEffect = StateEffect.define<null>();

export const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearBreakpointsEffect)) set = RangeSet.empty;
      if (e.is(toggleBreakpointEffect)) {
        if (e.value.on) set = set.update({ add: [BREAKPOINT.range(e.value.pos)] });
        else set = set.update({ filter: (from) => from !== e.value.pos });
      }
    }
    // one marker per line (two lines merged by a deletion keep a single break)
    const seen = new Set<number>();
    return set.update({
      filter: (from) => {
        const line = tr.state.doc.lineAt(from).number;
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      },
    });
  },
});

/** Zero-based editor line indices with a breakpoint. */
export function breakpointLines(state: EditorState): number[] {
  const lines: number[] = [];
  state.field(breakpointField).between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number - 1);
  });
  return lines.sort((a, b) => a - b);
}

function hasBreakpoint(state: EditorState, lineFrom: number): boolean {
  let found = false;
  state.field(breakpointField).between(lineFrom, lineFrom, (from) => {
    if (from === lineFrom) found = true;
  });
  return found;
}

/** Click on the gutter of a line: remove, or add on the nearest instruction line at/below it. */
function toggleBreakpoint(view: EditorView, lineFrom: number): void {
  const state = view.state;
  if (hasBreakpoint(state, lineFrom)) {
    view.dispatch({ effects: toggleBreakpointEffect.of({ pos: lineFrom, on: false }) });
    return;
  }
  let lineNo = state.doc.lineAt(lineFrom).number;
  while (!isInstructionLine(state.doc.line(lineNo).text)) {
    if (lineNo < state.doc.lines) lineNo++;
    else return;
  }
  const target = state.doc.line(lineNo).from;
  if (!hasBreakpoint(state, target)) view.dispatch({ effects: toggleBreakpointEffect.of({ pos: target, on: true }) });
}

export function clearBreakpoints(view: EditorView): void {
  view.dispatch({ effects: clearBreakpointsEffect.of(null) });
}

const breakpointGutter = gutter({
  class: 'cm-bp-gutter',
  markers: (v) => v.state.field(breakpointField),
  initialSpacer: () => NO_BREAKPOINT,
  lineMarker: (view, line) => (hasBreakpoint(view.state, line.from) ? null : NO_BREAKPOINT),
  domEventHandlers: {
    mousedown(view, line) {
      toggleBreakpoint(view, line.from);
      return true;
    },
  },
});

// ------------------------------------------------------------------ paragraph styles (execution / error / break)

export interface LineStyles {
  executionLine: number;
  errorLines: readonly number[];
}

const setLineStylesEffect = StateEffect.define<LineStyles>();

const lineStylesField = StateField.define<LineStyles>({
  create: () => ({ executionLine: -1, errorLines: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineStylesEffect)) value = e.value;
    return value;
  },
});

const execDeco = Decoration.line({ class: 'cm-execution-line' });
const errorDeco = Decoration.line({ class: 'cm-paragraph-error' });
const breakDeco = Decoration.line({ class: 'cm-break-line' });

const lineStyleDecorations = EditorView.decorations.compute([lineStylesField, breakpointField, 'doc'], (state) => {
  const { executionLine, errorLines } = state.field(lineStylesField);
  const byLine = new Map<number, Decoration[]>();
  const add = (index: number, d: Decoration) => {
    if (index < 0 || index >= state.doc.lines) return;
    const list = byLine.get(index) ?? [];
    list.push(d);
    byLine.set(index, list);
  };
  for (const l of errorLines) add(l, errorDeco);
  for (const l of breakpointLines(state)) add(l, breakDeco);
  add(executionLine, execDeco);
  const builder = new RangeSetBuilder<Decoration>();
  for (const index of [...byLine.keys()].sort((a, b) => a - b)) {
    const from = state.doc.line(index + 1).from;
    for (const d of byLine.get(index)!) builder.add(from, from, d);
  }
  return builder.finish();
});

export function setLineStyles(view: EditorView, styles: LineStyles): void {
  view.dispatch({ effects: setLineStylesEffect.of(styles) });
}

/** `codeEditor.moveTo(line, 0); requestFollowCaret()` */
export function revealLine(view: EditorView, lineIndex: number): void {
  if (lineIndex < 0 || lineIndex >= view.state.doc.lines) return;
  const pos = view.state.doc.line(lineIndex + 1).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'nearest' }) });
}

// ------------------------------------------------------------------ editor factory

export const editableCompartment = new Compartment();
export const fontCompartment = new Compartment();

export function fontSizeTheme(pt: number): Extension {
  return EditorView.theme({ '&': { fontSize: `${pt}pt` } });
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'monospace', lineHeight: 1.25 },
  '.cm-content': { caretColor: '#000' },
  '.cm-gutters': { backgroundColor: '#fff', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': {
    fontFamily: 'monospace',
    padding: '0 5px',
    backgroundColor: COLORS.lineNoBg,
    color: COLORS.lineNoFg,
  },
  '.cm-bp-gutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-bp-box': { width: '20px', height: '100%', minHeight: '1.25em', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-bp-dot': { width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'red' },
  '.cm-activeLine': { backgroundColor: COLORS.caretLine },
  '.cm-line.cm-paragraph-error': { backgroundColor: COLORS.errorLine },
  '.cm-line.cm-break-line': { backgroundColor: COLORS.breakLine },
  '.cm-line.cm-execution-line': { backgroundColor: `${COLORS.executionLine} !important` },
  '.cm-kw-arith, .cm-kw-shift, .cm-kw-move, .cm-kw-branch, .cm-kw-special': { fontWeight: 'bold' },
  '.cm-kw-arith': { color: COLORS.arithmetic },
  '.cm-kw-shift': { color: COLORS.shift },
  '.cm-kw-move': { color: COLORS.move },
  '.cm-kw-branch': { color: COLORS.branch },
  '.cm-kw-special': { color: COLORS.special },
  '.cm-asm-label': { color: COLORS.label, fontWeight: 'bold' },
  '.cm-asm-comment': { color: COLORS.comment },
});

export interface EditorCallbacks {
  /** Text changed (not style-only). */
  onTextChange: () => void;
  /** Breakpoint set changed. */
  onBreakpointsChange: (lines: number[]) => void;
}

export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks, fontPt: number): EditorView {
  let lastBreaks = '';
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        breakpointGutter,
        lineNumbers(),
        history(),
        highlightActiveLine(),
        highlighter,
        breakpointField,
        lineStylesField,
        lineStyleDecorations,
        editableCompartment.of(EditorView.editable.of(true)),
        fontCompartment.of(fontSizeTheme(fontPt)),
        baseTheme,
        // RichTextFX CodeArea behaviour: plain newline (no auto-indent), Tab inserts a tab;
        // only standard editing / navigation and undo-redo - no extra editor commands
        keymap.of([
          { key: 'Enter', run: insertNewline },
          { key: 'Tab', run: insertTab },
          ...standardKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callbacks.onTextChange();
          const breaks = breakpointLines(u.state).join(',');
          if (breaks !== lastBreaks) {
            lastBreaks = breaks;
            callbacks.onBreakpointsChange(breakpointLines(u.state));
          }
        }),
      ],
    }),
  });
}

export function setEditable(view: EditorView, editable: boolean): void {
  view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) });
}

export function setFontSize(view: EditorView, pt: number): void {
  view.dispatch({ effects: fontCompartment.reconfigure(fontSizeTheme(pt)) });
}

export function setText(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/**
 * `CPUController.blockComment()` - ported including its use of UTF-8 byte indices with char
 * offsets (`str.getBytes()[i]`); out-of-range access aborts like the original exception.
 */
export function blockComment(view: EditorView): void {
  const sel = view.state.selection.main;
  let start = sel.from;
  const end = sel.to;
  const str = view.state.doc.toString();
  const bytes = new TextEncoder().encode(str);
  const byteAt = (i: number) => {
    if (i < 0 || i >= bytes.length) throw new RangeError('ArrayIndexOutOfBoundsException');
    return bytes[i];
  };
  const NL = 10;
  const SEMI = 59;
  try {
    for (let i = start; i >= 0; i--) {
      if (byteAt(i) === NL) {
        start = i + 1;
        break;
      }
      if (i === 0) start = 0;
    }

    let komentar = true;
    if (byteAt(start) === SEMI) {
      for (let i = start; i < end - 1; i++) {
        if (byteAt(i) === NL && byteAt(i + 1) !== SEMI) {
          komentar = false;
          break;
        }
      }
    } else {
      komentar = false;
    }

    let replacement: string;
    if (komentar) {
      if (byteAt(end - 1) === NL) replacement = str.substring(start + 1, end - 1).replace(/\n;/g, '\n') + '\n';
      else replacement = str.substring(start + 1, end).replace(/\n;/g, '\n');
    } else if (byteAt(end - 1) === NL) {
      replacement = ';' + str.substring(start, end - 1).replace(/\n/g, '\n;') + '\n';
    } else {
      replacement = ';' + str.substring(start, end).replace(/\n/g, '\n;');
    }
    view.dispatch({ changes: { from: start, to: end, insert: replacement }, selection: { anchor: start + replacement.length } });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
}
