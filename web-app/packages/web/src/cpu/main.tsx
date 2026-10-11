import { CssBaseline, ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { SessionGuard } from '../auth/SessionGuard';
import { DialogHost } from '../common/Dialogs';
import { getRuntime } from '../common/runtime';
import { theme } from '../common/theme';
import { installSchematicWindowSupport } from '../schematic/mount';
import { CpuApp } from './CpuApp';
import { cpuController } from './controller';

getRuntime();
installSchematicWindowSupport(cpuController);

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <DialogHost>
      <SessionGuard controller={cpuController}>
        <CpuApp />
      </SessionGuard>
    </DialogHost>
  </ThemeProvider>,
);
