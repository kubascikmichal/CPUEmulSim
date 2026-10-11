/**
 * Promise-based modal dialogs replacing JavaFX `Alert` / `TextInputDialog` / the Swing About
 * dialog. Each window (CPU, schematic) has its own host, as each JavaFX stage owned its dialogs.
 */
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export type AlertKind = 'CONFIRMATION' | 'ERROR' | 'INFORMATION';

export interface AlertOptions {
  kind: AlertKind;
  title: string;
  header?: string | null;
  content?: string | null;
  /** Button labels in display order. */
  buttons: string[];
}

interface TextInputOptions {
  title: string;
  content: string;
  initial: string;
  maxLength: number;
}

export interface DialogApi {
  /** Resolves with the chosen button label, or null when closed with Escape / window close. */
  alert(options: AlertOptions): Promise<string | null>;
  /** `TextInputDialog.showAndWait()` - resolves with the text (OK) or null (Cancel). */
  textInput(options: TextInputOptions): Promise<string | null>;
  about(): Promise<void>;
  /** Any custom modal (e.g. the file dialog); `close(value)` resolves the promise. */
  custom<T>(render: (close: (value: T) => void) => ReactNode): Promise<T>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialogs(): DialogApi {
  const api = useContext(DialogContext);
  if (api === null) throw new Error('DialogHost missing');
  return api;
}

type Entry = { id: number; node: (close: (v: unknown) => void) => ReactNode; resolve: (v: unknown) => void };

/** Icon glyphs approximating the JavaFX Alert graphics. */
const KIND_ICON: Record<AlertKind, string> = { CONFIRMATION: '?', ERROR: '✖', INFORMATION: 'i' };
const KIND_COLOR: Record<AlertKind, string> = { CONFIRMATION: '#2a6ebb', ERROR: '#c62828', INFORMATION: '#2a6ebb' };

export function DialogHost({ children, container }: { children: ReactNode; container?: () => HTMLElement }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);

  const open = useCallback(<T,>(node: (close: (v: T) => void) => ReactNode) => {
    return new Promise<T>((resolve) => {
      const id = nextId.current++;
      setEntries((list) => [
        ...list,
        { id, node: node as Entry['node'], resolve: resolve as (v: unknown) => void },
      ]);
    });
  }, []);

  const closeEntry = (entry: Entry, value: unknown) => {
    setEntries((list) => list.filter((e) => e.id !== entry.id));
    entry.resolve(value);
  };

  const api = useRef<DialogApi>({
    alert: (o) =>
      open<string | null>((close) => (
        // JavaFX: a dialog can be closed "abnormally" (Esc / window close) only when it has
        // exactly one button - the multi-button confirmation dialogs require a choice
        <Dialog open onClose={() => (o.buttons.length === 1 ? close(null) : undefined)} container={container} maxWidth="sm">
          <DialogTitle>{o.title}</DialogTitle>
          <DialogContent sx={{ display: 'flex', gap: 2, minWidth: 360 }}>
            <Box sx={{ flex: 1 }}>
              {o.header && (
                <Typography sx={{ fontSize: 14, mb: 2, borderBottom: '1px solid #ddd', pb: 1 }}>{o.header}</Typography>
              )}
              {o.content && <Typography sx={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{o.content}</Typography>}
            </Box>
            <Box
              aria-hidden
              sx={{
                width: 36, height: 36, borderRadius: '50%', bgcolor: KIND_COLOR[o.kind], color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 20,
              }}
            >
              {KIND_ICON[o.kind]}
            </Box>
          </DialogContent>
          <DialogActions>
            {o.buttons.map((b, i) => (
              <Button key={b} autoFocus={i === 0} onClick={() => close(b)}>
                {b}
              </Button>
            ))}
          </DialogActions>
        </Dialog>
      )),
    textInput: (o) =>
      open<string | null>((close) => <TextInputDialog options={o} container={container} close={close} />),
    about: () =>
      open<void>((close) => (
        <Dialog open onClose={() => close()} container={container}>
          <DialogTitle>O programe</DialogTitle>
          <DialogContent sx={{ width: 256, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 13 }}>CPU emulátor a logický simulátor</Typography>
            <Typography sx={{ fontSize: 13 }}>Pôvodný autor: Tomáš Hianik</Typography>
            <Typography sx={{ fontSize: 13 }}>(bakalárska práca v r.2017)</Typography>
            <Typography sx={{ fontSize: 13 }}>Úpravy: Ondrej Karpiš a AI</Typography>
          </DialogContent>
          <DialogActions sx={{ justifyContent: 'center' }}>
            <Button autoFocus onClick={() => close()}>
              Ok
            </Button>
          </DialogActions>
        </Dialog>
      )),
    custom: (render) => open(render),
  });

  return (
    <DialogContext.Provider value={api.current}>
      {children}
      {entries.map((e) => (
        <Box key={e.id}>{e.node((v) => closeEntry(e, v))}</Box>
      ))}
    </DialogContext.Provider>
  );
}

function TextInputDialog({
  options,
  container,
  close,
}: {
  options: TextInputOptions;
  container?: () => HTMLElement;
  close: (v: string | null) => void;
}) {
  const [value, setValue] = useState(options.initial);
  return (
    <Dialog open onClose={() => close(null)} container={container}>
      <DialogTitle>{options.title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', alignItems: 'center', gap: 2, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13 }}>{options.content}</Typography>
        <TextField
          autoFocus
          value={value}
          onChange={(e) => {
            // TextFormatter: reject changes making the text longer than allowed
            if (e.target.value.length <= options.maxLength) setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(value);
          }}
          inputProps={{ style: { width: 120 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close(value)}>OK</Button>
        <Button onClick={() => close(null)}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
