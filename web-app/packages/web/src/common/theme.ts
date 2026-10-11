import { createTheme } from '@mui/material/styles';

/** Compact desktop look close to the JavaFX default (Modena) sizes. */
export const theme = createTheme({
  typography: { fontSize: 12, fontFamily: 'system-ui, "Segoe UI", Ubuntu, Cantarell, "DejaVu Sans", sans-serif' },
  spacing: 4,
  components: {
    MuiButton: {
      defaultProps: { size: 'small', variant: 'outlined', disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', minWidth: 0, color: '#222', borderColor: '#b5b5b5', background: 'linear-gradient(#fdfdfd, #e8e8e8)', padding: '2px 8px', lineHeight: 1.4 },
      },
    },
    MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', padding: '1px 6px', lineHeight: 1.3 } } },
    MuiMenuItem: { styleOverrides: { root: { fontSize: 13, minHeight: 26, paddingTop: 2, paddingBottom: 2 } } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiDialogTitle: { styleOverrides: { root: { fontSize: 15, padding: '10px 16px' } } },
  },
});

/** Original CSS colours (CPUEmul_style.css). */
export const COLORS = {
  arithmetic: 'purple',
  shift: '#80632a',
  move: '#348038',
  branch: '#144e80',
  special: '#638000',
  label: '#804000',
  comment: 'cadetblue',
  caretLine: '#f2f9fc',
  executionLine: '#caffca',
  errorLine: '#ffb1ae',
  breakLine: '#ff8331',
  lineNoBg: '#ddd',
  lineNoFg: '#666',
  dataChanged: '#fdadbd',
  stackHead: '#7eb6fd',
};
