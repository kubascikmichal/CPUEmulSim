/**
 * The schematic window: a second browser window (D3) whose React tree is rendered by the CPU
 * window, so both windows share one JavaScript realm and one engine. `Simulátor` toggles it
 * (show ↔ hide); closing it only hides it - the circuit lives in the engine.
 */
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { DialogHost } from '../common/Dialogs';
import { getRuntime } from '../common/runtime';
import { theme } from '../common/theme';
import type { CpuWindowController } from '../cpu/controller';
import { SchematicApp } from './SchematicApp';

const WINDOW_NAME = 'cpuemul-schematic';
const FEATURES = 'width=1280,height=850';

declare global {
  interface Window {
    /** Called by schematic.html of the child window once its DOM is ready. */
    cpuEmulMountSchematic?: (child: Window) => void;
    cpuEmulAttachActivity?: (w: Window) => void;
  }
}

export function installSchematicWindowSupport(cpu: CpuWindowController): void {
  let root: Root | null = null;
  const { session } = getRuntime();

  // SchematicController constructor: editing only while the simulation is off
  session.sheet.simulator.onRunningChange((running) => session.sheet.setEditingEnabled(!running));

  window.cpuEmulMountSchematic = (child: Window) => {
    const container = child.document.getElementById('root')!;
    const cache = createCache({ key: 'sch', container: child.document.head });
    root = createRoot(container);
    root.render(
      <CacheProvider value={cache}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <DialogHost container={() => child.document.body}>
            <SchematicApp win={child} cpu={cpu} />
          </DialogHost>
        </ThemeProvider>
      </CacheProvider>,
    );
    window.cpuEmulAttachActivity?.(child);
    child.addEventListener('pagehide', () => {
      root?.unmount();
      root = null;
      cpu.schematicWindow = null;
    });
  };

  cpu.toggleSchematicWindow = () => {
    const w = cpu.schematicWindow;
    if (w !== null && !w.closed) {
      w.close();
      cpu.schematicWindow = null;
      return;
    }
    const child = window.open('/schematic', WINDOW_NAME, FEATURES);
    if (child === null) {
      void cpu.dialogs?.alert({
        kind: 'INFORMATION',
        title: 'Simulátor',
        header: 'Prehliadač zablokoval otvorenie okna simulátora. Povoľte prosím vyskakovacie okná pre túto stránku.',
        buttons: ['OK'],
      });
      return;
    }
    cpu.schematicWindow = child;
  };
}
