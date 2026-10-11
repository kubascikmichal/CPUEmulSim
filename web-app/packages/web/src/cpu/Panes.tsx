/**
 * Registre, Kód, Pamäť and Konzola panes of the CPU window.
 */
import { byteRepresentation, MemoryTables, shortRepresentation, type Representation } from '@cpuemul/engine';
import { Box, Button, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FixedSizeList } from 'react-window';
import { COLORS } from '../common/theme';
import { createEditor, revealLine, setEditable, setLineStyles } from './codeEditor';
import { cpuController as ctl, type ReprKey } from './controller';

// ------------------------------------------------------------------ helpers

export function TitledPane(props: { title: ReactNode; graphic?: ReactNode; children: ReactNode; collapsed?: boolean; onToggle?: () => void }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, border: '1px solid #b9b9b9' }}>
      <Box
        onClick={props.onToggle}
        sx={{
          display: 'flex', alignItems: 'center', justifyContent: props.onToggle ? 'flex-start' : 'center', gap: 1, px: 1.5, minHeight: 24,
          background: 'linear-gradient(#f2f2f2,#dcdcdc)', borderBottom: '1px solid #b9b9b9', cursor: props.onToggle ? 'pointer' : 'default',
          fontSize: 13, userSelect: 'none',
        }}
      >
        {props.onToggle && <span style={{ fontSize: 9 }}>{props.collapsed ? '▶' : '▼'}</span>}
        <span>{props.title}</span>
        {props.graphic}
      </Box>
      {!props.collapsed && <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{props.children}</Box>}
    </Box>
  );
}

function ReprToggle({ reprKey, options, small }: { reprKey: ReprKey; options: Representation[]; small?: boolean }) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={ctl.reprs[reprKey]}
      // deselecting the active button re-selects it (onToggleGroupChange)
      onChange={(_, v: Representation | null) => v !== null && ctl.setRepr(reprKey, v)}
    >
      {options.map((o) => (
        <ToggleButton key={o} value={o} sx={{ fontSize: small ? 9 : 11, px: small ? 0.75 : 1.25 }}>
          {o}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

// ------------------------------------------------------------------ Registre

function RegisterField({ label, text, readOnly }: { label: string; text: string; readOnly?: boolean }) {
  // The original fields are editable (except CY) but edits are never written to the CPU.
  const [value, setValue] = useState(text);
  useEffect(() => setValue(text), [text]);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1.25, p: 0.5 }}>
      <Typography sx={{ fontSize: 13 }}>{label}</Typography>
      <TextField
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputProps={{ readOnly, 'data-testid': `reg-${label}`, style: { padding: '3px 6px', fontSize: 13 } }}
        sx={{ width: label.length <= 2 && ['CY', 'Z', 'IE'].includes(label) ? 30 : 130 }}
      />
    </Box>
  );
}

export function RegistersPane() {
  const r = ctl.session.memory.registers;
  const rep = ctl.reprs.registers;
  const b = (v: number) => byteRepresentation(v, rep);
  const s = (v: number) => shortRepresentation(v, rep);
  return (
    <TitledPane title="Registre">
      <Box sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 1.25, maxWidth: 180 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <ReprToggle reprKey="registers" options={['Dec', 'Hex', 'Bin', 'ASCII']} />
        </Box>
        <hr style={{ width: '100%', margin: 0 }} />
        <RegisterField label="A" text={b(r.a)} />
        <RegisterField label="B" text={b(r.b)} />
        <RegisterField label="C" text={b(r.c)} />
        <RegisterField label="D" text={b(r.d)} />
        <hr style={{ width: '100%', margin: 0 }} />
        <RegisterField label="PC" text={s(r.pc)} />
        <RegisterField label="SP" text={s(r.sp)} />
        <RegisterField label="MP" text={s(r.mp)} />
        <hr style={{ width: '100%', margin: 0 }} />
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1.25 }}>
          <Flag label="CY" value={r.cy} readOnly />
          <Flag label="Z" value={r.z} />
          <Flag label="IE" value={r.ie} />
        </Box>
      </Box>
    </TitledPane>
  );
}

function Flag({ label, value, readOnly }: { label: string; value: boolean; readOnly?: boolean }) {
  const [text, setText] = useState(value ? '1' : '0');
  useEffect(() => setText(value ? '1' : '0'), [value]);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Typography sx={{ fontSize: 13 }}>{label}&nbsp;</Typography>
      <TextField
        value={text}
        onChange={(e) => setText(e.target.value)}
        inputProps={{ readOnly, 'data-testid': `flag-${label}`, style: { padding: '3px 4px', fontSize: 13, width: 18 } }}
      />
    </Box>
  );
}

// ------------------------------------------------------------------ Kód

export function CodePane() {
  const host = useRef<HTMLDivElement>(null);
  const v = ctl.session.view;

  useLayoutEffect(() => {
    if (host.current === null || ctl.editor !== null) return;
    ctl.editor = createEditor(
      host.current,
      {
        onTextChange: () => ctl.onTextChange(),
        onBreakpointsChange: (lines) => ctl.session.setBreakpointLines(lines),
      },
      ctl.fontSize,
    );
  }, []);

  useEffect(() => {
    if (ctl.editor === null) return;
    setEditable(ctl.editor, v.editorEditable);
    if (!v.editorEditable) ctl.editor.focus();
  }, [v.editorEditable]);

  useEffect(() => {
    if (ctl.editor !== null) setLineStyles(ctl.editor, { executionLine: v.executionLine, errorLines: v.errorLines });
  }, [v.executionLine, v.errorLines]);

  useEffect(() => {
    if (ctl.editor !== null && v.executionLine >= 0) revealLine(ctl.editor, v.executionLine);
  }, [v.executionLineReveal, v.executionLine]);

  return (
    <TitledPane title={ctl.codePaneTitle}>
      <Box sx={{ display: 'flex', gap: 1.25, p: 1.25 }}>
        <Button onClick={() => void ctl.openFile()}>Načítať</Button>
        <Button onClick={() => void ctl.saveCode(false)}>Uložiť</Button>
        <Button onClick={() => ctl.unbreakAll()} sx={{ width: 104 }}>
          UnBreak All
        </Button>
      </Box>
      <Box ref={host} sx={{ flex: 1, minHeight: 0, borderTop: '1px solid #ddd', '& .cm-editor': { height: '100%' } }} data-testid="code-editor" />
    </TitledPane>
  );
}

// ------------------------------------------------------------------ Pamäť

const ROW_HEIGHT = 22;

function MemoryTable(props: {
  rows: number;
  addressOf: (row: number) => number;
  dataOf: (row: number) => number;
  changed?: (row: number) => boolean;
  head?: (row: number) => boolean;
  addrRep: Representation;
  dataRep: Representation;
  scrollToRow?: number;
  scrollToken?: number;
  testId: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const list = useRef<FixedSizeList>(null);
  const [height, setHeight] = useState(200);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight - ROW_HEIGHT));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // TableView.scrollTo(index): the row becomes the first visible row
    if (props.scrollToRow !== undefined) list.current?.scrollToItem(Math.max(0, props.scrollToRow), 'start');
  }, [props.scrollToRow, props.scrollToken]);

  return (
    <Box ref={outer} sx={{ flex: 1, minHeight: 0, border: '1px solid #c8c8c8', fontSize: 12 }} data-testid={props.testId}>
      <Box sx={{ display: 'flex', height: ROW_HEIGHT, alignItems: 'center', background: 'linear-gradient(#f5f5f5,#e2e2e2)', borderBottom: '1px solid #c8c8c8' }}>
        <Box sx={{ width: 70, px: 1, borderRight: '1px solid #c8c8c8', textAlign: 'center' }}>Addr</Box>
        <Box sx={{ flex: 1, px: 1, textAlign: 'center' }}>Data</Box>
      </Box>
      <FixedSizeList ref={list} height={Math.max(0, height)} width="100%" itemCount={props.rows} itemSize={ROW_HEIGHT}>
        {({ index, style }) => {
          const bg = props.head?.(index) ? COLORS.stackHead : props.changed?.(index) ? COLORS.dataChanged : index % 2 ? '#f9f9f9' : '#fff';
          const addr = props.addressOf(index);
          return (
            <Box style={style} sx={{ display: 'flex', alignItems: 'center', background: bg }}>
              <Box sx={{ width: 70, px: 1 }}>{props.addrRep === 'Hex' ? shortRepresentation(addr, 'Hex') : addr}</Box>
              <Box sx={{ flex: 1, px: 1 }}>{byteRepresentation(props.dataOf(index), props.dataRep)}</Box>
            </Box>
          );
        }}
      </FixedSizeList>
    </Box>
  );
}

export function MemoryPane() {
  const [tab, setTab] = useState(0);
  const mem = ctl.session.memory;
  const [toHead, setToHead] = useState(0);
  const headers = (a: ReprKey, d: ReprKey) => (
    <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1.25, m: 0.75 }}>
      <ReprToggle reprKey={a} options={['Dec', 'Hex']} small />
      <Box sx={{ borderLeft: '1px solid #ccc' }} />
      <ReprToggle reprKey={d} options={['Dec', 'Hex', 'Bin', 'ASCII']} small />
    </Box>
  );
  return (
    <TitledPane title="Pamäť">
      <Box sx={{ display: 'flex', borderBottom: '1px solid #c8c8c8' }}>
        {['Zásobník', 'Konštanty', 'RAM'].map((t, i) => (
          <Box
            key={t}
            onClick={() => setTab(i)}
            sx={{ px: 2, py: 0.75, cursor: 'pointer', fontSize: 13, borderBottom: tab === i ? '2px solid #0096c9' : '2px solid transparent', background: tab === i ? '#fff' : '#eee' }}
          >
            {t}
          </Box>
        ))}
      </Box>
      {tab === 0 && (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {headers('stackAddr', 'stackData')}
          <MemoryTable
            testId="table-stack"
            rows={65536}
            addressOf={MemoryTables.stackAddressOfRow}
            dataOf={(row) => mem.stack.newData[row]}
            changed={(row) => mem.stack.isChanged(row)}
            head={(row) => MemoryTables.stackAddressOfRow(row) === mem.stackHead}
            addrRep={ctl.reprs.stackAddr}
            dataRep={ctl.reprs.stackData}
            scrollToRow={mem.stackScrollRow}
            scrollToken={mem.version + toHead}
          />
          <Button
            fullWidth
            onClick={() => {
              mem.toStackHead(ctl.session.cpu);
              setToHead((x) => x + 1);
            }}
          >
            Na vrchol
          </Button>
        </Box>
      )}
      {tab === 1 && (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {headers('progAddr', 'progData')}
          <MemoryTable
            testId="table-const"
            rows={256}
            addressOf={(r) => r}
            dataOf={(row) => mem.progMemory.newData[row]}
            addrRep={ctl.reprs.progAddr}
            dataRep={ctl.reprs.progData}
          />
        </Box>
      )}
      {tab === 2 && (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {headers('ramAddr', 'ramData')}
          <MemoryTable
            testId="table-ram"
            rows={256}
            addressOf={(r) => r}
            dataOf={(row) => mem.ram.newData[row]}
            changed={(row) => mem.ram.isChanged(row)}
            addrRep={ctl.reprs.ramAddr}
            dataRep={ctl.reprs.ramData}
          />
        </Box>
      )}
    </TitledPane>
  );
}

// ------------------------------------------------------------------ Konzola

export function ConsoleView() {
  const box = useRef<HTMLDivElement>(null);
  const model = ctl.session.console;
  const [, setVersion] = useState(0);

  useEffect(() => {
    let raf = 0;
    const unsub = model.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion(model.version);
      });
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [model]);

  useEffect(() => {
    // requestFollowCaret: keep the caret paragraph visible
    const el = box.current;
    if (!el) return;
    const caretPar = el.querySelector(`[data-par="${model.getCurrentParagraph()}"]`) as HTMLElement | null;
    caretPar?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <Box ref={box} data-testid="console" sx={{ height: '100%', overflow: 'auto', p: 0.5, background: '#fff', fontSize: 13, userSelect: 'text' }}>
      {model.paragraphs().map((p, i) => (
        <div
          key={i}
          data-par={i}
          style={{ color: p.style.color, fontFamily: p.style.monospace ? 'monospace' : 'inherit', whiteSpace: 'pre', minHeight: '1.25em' }}
        >
          {p.text}
        </div>
      ))}
    </Box>
  );
}
