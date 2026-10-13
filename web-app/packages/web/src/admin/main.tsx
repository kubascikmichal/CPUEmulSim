import { CssBaseline, ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { theme } from '../common/theme';
import { AdminApp } from './AdminApp';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <AdminApp />
  </ThemeProvider>,
);
