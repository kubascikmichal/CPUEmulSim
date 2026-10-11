/**
 * CPU emulator window (Main_CPUEmul.fxml): menu, toolbar, Registre | Kód | Pamäť split,
 * collapsible Konzola, status bar.
 */
import { Alert, Box, Button, Snackbar } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useDialogs } from '../common/Dialogs';
import { useSubscription } from '../common/hooks';
import { setInterruptErrorHandler } from '../common/runtime';
import { MenuBar, StatusBar, Toolbar } from './Chrome';
import { cpuController as ctl } from './controller';
import { CodePane, ConsoleView, MemoryPane, RegistersPane, TitledPane } from './Panes';

const RAIL = 20;
const REG_DEFAULT = 200;
const REG_MAX = 220;
const MEM_DEFAULT = 260;
const MEM_MAX = 300;
const ANIMATION_MS = 250;

/** Vertical button with rotated text that slides a side pane in/out (handleToggle*PaneAction). */
function Rail({ text, rotate, onClick }: { text: string; rotate: number; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        width: RAIL, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        background: 'linear-gradient(90deg,#fafafa,#e3e3e3)', border: '1px solid #b5b5b5', fontSize: 11,
      }}
    >
      <span style={{ transform: `rotate(${rotate}deg)`, whiteSpace: 'nowrap' }}>{text}</span>
    </Box>
  );
}

function useAnimatedWidth(initial: number) {
  const [width, setWidth] = useState(initial);
  const anim = useRef<number | null>(null);
  const animate = (to: number) => {
    if (anim.current !== null) return; // original: toggling ignored while an animation runs
    const from = width;
    const start = performance.now();
    const step = (t: number) => {
      const frac = Math.min(1, (t - start) / ANIMATION_MS);
      setWidth(from + (to - from) * frac);
      if (frac < 1) anim.current = requestAnimationFrame(step);
      else anim.current = null;
    };
    anim.current = requestAnimationFrame(step);
  };
  return { width, setWidth, animate };
}

function Splitter({ onDrag, vertical }: { onDrag: (delta: number) => void; vertical?: boolean }) {
  const start = (e: ReactPointerEvent) => {
    e.preventDefault();
    let last = vertical ? e.clientY : e.clientX;
    const move = (ev: PointerEvent) => {
      const pos = vertical ? ev.clientY : ev.clientX;
      onDrag(pos - last);
      last = pos;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <Box
      onPointerDown={start}
      sx={{ flex: '0 0 auto', [vertical ? 'height' : 'width']: 3, cursor: vertical ? 'row-resize' : 'col-resize', background: '#d6d6d6' }}
    />
  );
}

export function CpuApp() {
  const dialogs = useDialogs();
  const session = ctl.session;
  useSubscription(useCallback((l) => session.subscribe(l), [session]));
  useSubscription(useCallback((l) => ctl.subscribe(l), []));

  const reg = useAnimatedWidth(REG_DEFAULT);
  const mem = useAnimatedWidth(MEM_DEFAULT);
  const mainRef = useRef<HTMLDivElement>(null);
  const [consoleFraction, setConsoleFraction] = useState(1 - 0.71);
  const [consoleExpanded, setConsoleExpanded] = useState(true);
  const lastConsoleFraction = useRef(consoleFraction);

  useEffect(() => {
    ctl.dialogs = dialogs;
    setInterruptErrorHandler((message) =>
      void dialogs.alert({ kind: 'ERROR', title: 'Chyba', header: 'Chyba prerušenia', content: message, buttons: ['OK'] }),
    );
    session.sheet.simulator.onTimeout = () =>
      void dialogs.alert({ kind: 'ERROR', title: 'Chyba', content: 'Chyba simulácie. Príliš dlhá odozva.', buttons: ['Close'] });
    document.title = ctl.windowTitle;
  }, [dialogs, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')) return;
      ctl.handleKeyDown(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const toggleSide = (side: typeof reg, def: number) => {
    side.animate(Math.abs(side.width) > 3 ? 0 : def);
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
      <MenuBar />
      <Toolbar />
      <Box ref={mainRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', p: 0.5 }}>
        <Box sx={{ flex: consoleExpanded ? 1 - consoleFraction : 1, minHeight: 0, display: 'flex' }}>
          <Rail text="Registre" rotate={270} onClick={() => toggleSide(reg, REG_DEFAULT)} />
          <Box sx={{ width: reg.width, overflow: 'hidden', flex: '0 0 auto' }}>
            <Box sx={{ width: REG_DEFAULT, height: '100%' }}>
              <RegistersPane />
            </Box>
          </Box>
          <Splitter onDrag={(d) => reg.setWidth((w) => Math.max(0, Math.min(REG_MAX, w + d)))} />
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <CodePane />
          </Box>
          <Splitter onDrag={(d) => mem.setWidth((w) => Math.max(0, Math.min(MEM_MAX, w - d)))} />
          <Box sx={{ width: mem.width, overflow: 'hidden', flex: '0 0 auto' }}>
            <Box sx={{ width: Math.max(mem.width, 200), height: '100%' }}>
              <MemoryPane />
            </Box>
          </Box>
          <Rail text="Pamäť" rotate={90} onClick={() => toggleSide(mem, MEM_DEFAULT)} />
        </Box>
        {consoleExpanded && (
          <Splitter
            vertical
            onDrag={(d) => {
              const h = mainRef.current?.clientHeight ?? 600;
              setConsoleFraction((f) => Math.max(0.05, Math.min(0.95, f - d / h)));
            }}
          />
        )}
        <Box sx={{ flex: consoleExpanded ? consoleFraction : '0 0 auto', minHeight: 0 }}>
          <TitledPane
            title="Konzola"
            collapsed={!consoleExpanded}
            onToggle={() => {
              if (consoleExpanded) {
                lastConsoleFraction.current = consoleFraction;
                setConsoleExpanded(false);
              } else {
                setConsoleFraction(lastConsoleFraction.current);
                setConsoleExpanded(true);
              }
            }}
            graphic={
              <Button
                sx={{ fontSize: 10, py: 0, ml: 1 }}
                onClick={(e) => {
                  e.stopPropagation();
                  session.console.clear();
                }}
              >
                Vyčistiť
              </Button>
            }
          >
            <ConsoleView />
          </TitledPane>
        </Box>
      </Box>
      <StatusBar />
      <Snackbar
        key={ctl.toast?.id}
        open={ctl.toast !== null}
        autoHideDuration={5000}
        onClose={() => {
          ctl.toast = null;
          ctl.changed();
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert severity="warning" variant="outlined" sx={{ background: '#fff' }}>
          <strong>{ctl.toast?.title}</strong>
          <br />
          {ctl.toast?.text}
        </Alert>
      </Snackbar>
    </Box>
  );
}
