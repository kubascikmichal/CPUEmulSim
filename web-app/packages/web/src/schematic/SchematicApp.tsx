/**
 * Schematic simulator window (SchematicController.buildToolbar / buildStatusBar + ItemPicker).
 */
import { schematic, type CPUState } from '@cpuemul/engine';
import { Box, Button, Switch, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialogs } from '../common/Dialogs';
import { useSubscription } from '../common/hooks';
import { typedCharacter } from '../common/keys';
import { getRuntime } from '../common/runtime';
import type { CpuWindowController } from '../cpu/controller';
import { schematicController } from './controller';
import { SheetView, type SheetViewHandle } from './SheetView';
import { PALETTE } from './symbols';

/** setButtons(CPUStates) of the schematic window. */
function buttonStates(state: CPUState) {
  switch (state) {
    case 'Running':
      return { startText: 'Spustiť [F5]', start: false, step: false, pause: true, stop: true, reset: false };
    case 'Paused':
      return { startText: 'Pokračovať [F5]', start: true, step: true, pause: false, stop: true, reset: false };
    case 'Waiting':
      return { startText: 'Spustiť [F5]', start: false, step: false, pause: false, stop: true, reset: false };
    default:
      return { startText: 'Spustiť [F5]', start: true, step: true, pause: false, stop: false, reset: true };
  }
}

const icon = (name: string) => <img src={`/icons/${name}.png`} width={16} height={16} alt="" draggable={false} />;

export function SchematicApp({ win, cpu }: { win: Window; cpu: CpuWindowController }) {
  const dialogs = useDialogs();
  const { session } = getRuntime();
  const sheet = session.sheet;
  const container = useCallback(() => win.document.body, [win]);
  const handle = useRef<SheetViewHandle | null>(null);
  const paletteDrag = useRef<{ factory: (s: schematic.SchematicSheet) => schematic.GateSymbol } | null>(null);
  const [coords, setCoords] = useState('0x0');
  const [zoom, setZoom] = useState(100);
  const [dragging, setDragging] = useState<string | null>(null);

  useSubscription(useCallback((l) => sheet.simulator.onRunningChange(l), [sheet]), win);
  useSubscription(useCallback((l) => schematicController.subscribe(l), []), win);
  // the original binds the buttons to the CPU that existed when the window was built
  useSubscription(useCallback((l) => session.schematicCpu.onStateChange(l), [session]), win);

  useEffect(() => {
    win.document.title = schematicController.getTitle();
  });

  const buttons = buttonStates(session.schematicCpu.getState());
  const running = sheet.isSimulationRunning();

  // ---- keyboard (registerKeyboardHandlers + Ctrl+C / Ctrl+V accelerators)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')) return;
      const actions: Record<string, [boolean, () => void]> = {
        F5: [buttons.start, () => cpu.start()],
        F7: [buttons.step, () => cpu.step()],
        F9: [buttons.pause, () => cpu.pause()],
        F10: [buttons.stop, () => cpu.stop()],
        F12: [buttons.reset, () => cpu.reset()],
      };
      const a = !e.ctrlKey && !e.altKey && !e.metaKey ? actions[e.key] : undefined;
      if (a) {
        e.preventDefault();
        if (a[0]) a[1]();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        sheet.copySelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        sheet.pasteClipboard(handle.current?.lastMouseGrid() ?? null);
        return;
      }
      if (session.isExecuting()) {
        const ch = typedCharacter(e);
        if (ch !== null) {
          session.keyboardInput({ kind: 'typed', character: ch });
          e.preventDefault();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"], input')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        sheet.deleteSelect();
        e.preventDefault();
      }
    };
    win.addEventListener('keydown', down, true);
    win.addEventListener('keyup', up, true);
    return () => {
      win.removeEventListener('keydown', down, true);
      win.removeEventListener('keyup', up, true);
    };
  }, [win, buttons.start, buttons.step, buttons.pause, buttons.stop, buttons.reset, cpu, sheet, session]);

  // ---- palette drag lifetime (release anywhere ends it)
  useEffect(() => {
    const up = () => {
      if (paletteDrag.current !== null) {
        paletteDrag.current = null;
        sheet.cancelAdding();
      }
      setDragging(null);
      win.document.body.style.cursor = '';
    };
    win.addEventListener('pointerup', up);
    return () => win.removeEventListener('pointerup', up);
  }, [win, sheet]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
      {/* toolbar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: '1px solid #c8c8c8', background: 'linear-gradient(#f7f7f7,#e5e5e5)' }}>
        <Tooltip title="Vymazať plochu" PopperProps={{ container }}>
          <Button startIcon={icon('empty-trash')} onClick={() => void schematicController.handleClearBoardAction(dialogs, container)}>
            Nový
          </Button>
        </Tooltip>
        <Tooltip title="Načítať schému zo súboru" PopperProps={{ container }}>
          <Button startIcon={icon('open')} onClick={() => void schematicController.handleLoadAction(dialogs, container)}>
            Otvoriť
          </Button>
        </Tooltip>
        <Tooltip title="Uložiť schému" PopperProps={{ container }}>
          <Button startIcon={icon('save')} onClick={() => void schematicController.saveCircuit(false, dialogs, container)}>
            Uložiť
          </Button>
        </Tooltip>
        <Tooltip title="Uložiť schému do iného súboru" PopperProps={{ container }}>
          <Button startIcon={icon('save-as')} onClick={() => void schematicController.saveCircuit(true, dialogs, container)}>
            Uložiť ako
          </Button>
        </Tooltip>
        <Tooltip title="Stiahnuť schému do počítača" PopperProps={{ container }}>
          <Button startIcon={icon('save-as')} onClick={() => schematicController.downloadCircuit(win.document)}>
            Stiahnuť
          </Button>
        </Tooltip>
        <Typography sx={{ fontSize: 13, whiteSpace: 'pre' }}>{' | '}</Typography>
        <Typography sx={{ fontSize: 13, whiteSpace: 'pre' }}>{'  |  '}</Typography>
        <Typography sx={{ fontSize: 13 }}>On/Off:</Typography>
        <Tooltip title="Zapnúť / vypnúť simuláciu" PopperProps={{ container }}>
          <Switch size="small" checked={running} onChange={(e) => (e.target.checked ? sheet.powerOn() : sheet.powerOff())} inputProps={{ 'aria-label': 'On/Off' }} />
        </Tooltip>
        <Typography sx={{ fontSize: 13, whiteSpace: 'pre' }}>{'  |  '}</Typography>
        <Typography sx={{ fontSize: 13 }}>Debug:</Typography>
        <Tooltip title="Prefarbiť vodiče podľa logického stavu (Z sivá, 0 modrá, 1 červená)" PopperProps={{ container }}>
          <Switch size="small" checked={sheet.isDebugWires()} onChange={(e) => sheet.setDebugWires(e.target.checked)} inputProps={{ 'aria-label': 'Debug' }} />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={icon('play')} disabled={!buttons.start} onClick={() => cpu.start()}>{buttons.startText}</Button>
        <Button startIcon={icon('step-over')} disabled={!buttons.step} onClick={() => cpu.step()}>Krok [F7]</Button>
        <Button startIcon={icon('pause')} disabled={!buttons.pause} onClick={() => cpu.pause()}>Pauza [F9]</Button>
        <Button startIcon={icon('stop')} disabled={!buttons.stop} onClick={() => cpu.stop()}>Stop [F10]</Button>
        <Button startIcon={icon('reset')} disabled={!buttons.reset} onClick={() => cpu.reset()}>Reset [F12]</Button>
      </Box>

      {/* palette | sheet (SplitPane 0.13) */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Box sx={{ width: '13%', minWidth: 90, overflowY: 'auto', borderRight: '3px solid #d6d6d6', background: '#fff', p: 1 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
            {PALETTE.map((item) => (
              <Box
                key={item.label}
                data-palette={item.label}
                onPointerDown={(e) => {
                  e.preventDefault();
                  const start = [e.clientX, e.clientY];
                  const move = (ev: PointerEvent) => {
                    if (Math.abs(ev.clientX - start[0]) + Math.abs(ev.clientY - start[1]) < 4) return;
                    win.removeEventListener('pointermove', move);
                    paletteDrag.current = { factory: (s) => schematic.createGate(item.ctor, s) };
                    setDragging(item.label);
                    win.document.body.style.cursor = 'grabbing';
                  };
                  win.addEventListener('pointermove', move);
                  win.addEventListener('pointerup', () => win.removeEventListener('pointermove', move), { once: true });
                }}
                sx={{ cursor: dragging === item.label ? 'grabbing' : 'grab', opacity: dragging === item.label ? 0.6 : 1, textAlign: 'center', userSelect: 'none' }}
              >
                <Typography sx={{ fontSize: 13 }}>{item.label}</Typography>
                <img src={`/icons/${item.icon}.png`} alt={item.label} draggable={false} style={{ display: 'block', marginTop: 5 }} />
              </Box>
            ))}
          </Box>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <SheetView
            sheet={sheet}
            dialogs={dialogs}
            container={container}
            onCoordinates={setCoords}
            onZoom={setZoom}
            handleRef={handle}
            paletteDrag={paletteDrag}
          />
        </Box>
      </Box>

      {/* status bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5, borderTop: '1px solid #d0d0d0', fontSize: 13 }}>
        <Typography sx={{ fontSize: 13 }} data-testid="coords">{coords}</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 13, mr: 4 }}>{running ? 'Simulácia beží' : 'Simulácia zastavená'}</Typography>
        <Typography sx={{ fontSize: 13 }}>{zoom}%</Typography>
      </Box>
    </Box>
  );
}
