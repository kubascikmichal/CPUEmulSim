/**
 * In-app replacement of the native `FileChooser` over the user's account files (deviation D2).
 * Keeps the original dialog titles, extension filters (description + pattern) and suggested name.
 */
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { DialogApi } from '../common/Dialogs';
import { downloadFile, FileApiError, fileExists, isValidFileName, listFiles, type StoredFile } from './api';

export interface ExtensionFilter {
  description: string;
  extension: string; // e.g. "asm"
}

export const CODE_FILTERS: ExtensionFilter[] = [
  { description: 'ASM', extension: 'asm' },
  { description: 'TXT', extension: 'txt' },
];
export const SCHX_FILTERS: ExtensionFilter[] = [{ description: 'SCHX', extension: 'schx' }];

interface Props {
  mode: 'open' | 'save';
  title: string;
  filters: ExtensionFilter[];
  initialFileName: string | null;
  container?: () => HTMLElement;
  close: (name: string | null) => void;
  dialogs: DialogApi;
}

function FileDialogView({ mode, title, filters, initialFileName, container, close, dialogs }: Props) {
  const [filterIndex, setFilterIndex] = useState(() => {
    const ext = initialFileName?.split('.').pop()?.toLowerCase();
    const i = filters.findIndex((f) => f.extension === ext);
    return i >= 0 ? i : 0;
  });
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(initialFileName ?? '');
  const filter = filters[filterIndex];

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    listFiles([filter.extension])
      .then((f) => !cancelled && setFiles(f))
      .catch(() => !cancelled && setError('Zoznam súborov sa nepodarilo načítať.'));
    return () => {
      cancelled = true;
    };
  }, [filter.extension]);

  const finalName = useMemo(() => {
    const n = name.trim();
    if (n === '') return '';
    return n.includes('.') ? n : `${n}.${filter.extension}`;
  }, [name, filter.extension]);

  const confirm = async (chosen = finalName) => {
    if (chosen === '') return;
    if (!isValidFileName(chosen)) {
      setError('Neplatný názov súboru.');
      return;
    }
    if (mode === 'open') {
      if (!files?.some((f) => f.name === chosen)) {
        setError('Súbor neexistuje.');
        return;
      }
      close(chosen);
      return;
    }
    try {
      if (await fileExists(chosen)) {
        const answer = await dialogs.alert({
          kind: 'CONFIRMATION',
          title: 'Potvrdenie',
          header: `Súbor ${chosen} už existuje. Prajete si ho nahradiť?`,
          buttons: ['Áno', 'Nie'],
        });
        if (answer !== 'Áno') return;
      }
    } catch (e) {
      if (e instanceof FileApiError) setError('Súbor sa nepodarilo overiť.');
      return;
    }
    close(chosen);
  };

  return (
    <Dialog open onClose={() => close(null)} container={container} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Box sx={{ height: 300, overflow: 'auto', border: '1px solid #ccc', mb: 2 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Názov</TableCell>
                <TableCell align="right">Veľkosť</TableCell>
                <TableCell>Zmenené</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(files ?? []).map((f) => (
                <TableRow
                  key={f.name}
                  hover
                  selected={f.name === finalName}
                  onClick={() => setName(f.name)}
                  onDoubleClick={() => void confirm(f.name)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>{f.name}</TableCell>
                  <TableCell align="right">{f.size}</TableCell>
                  <TableCell>{new Date(f.modifiedAt).toLocaleString('sk-SK')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <TextField
            label="Názov súboru"
            value={name}
            autoFocus
            onChange={(e) => {
              setError(null);
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirm();
            }}
            sx={{ flex: 1 }}
          />
          <Select value={filterIndex} onChange={(e) => setFilterIndex(Number(e.target.value))} size="small">
            {filters.map((f, i) => (
              <MenuItem key={f.description} value={i}>
                {f.description} (*.{f.extension})
              </MenuItem>
            ))}
          </Select>
        </Box>
        {error && (
          <Typography color="error" sx={{ mt: 1, fontSize: 13 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {/* account workspace → user's computer (the file in the list matching the name field) */}
        <Button
          sx={{ mr: 'auto' }}
          disabled={!files?.some((f) => f.name === finalName)}
          onClick={() =>
            void downloadFile(finalName, container?.().ownerDocument ?? document).catch(() => setError('Súbor sa nepodarilo stiahnuť.'))
          }
        >
          Stiahnuť do počítača
        </Button>
        <Button onClick={() => void confirm()} disabled={finalName === ''}>
          {mode === 'open' ? 'Otvoriť' : 'Uložiť'}
        </Button>
        <Button onClick={() => close(null)}>Zrušiť</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Shows the dialog; resolves with the chosen file name or null. */
export function showFileDialog(
  dialogs: DialogApi,
  options: Omit<Props, 'close' | 'dialogs'>,
): Promise<string | null> {
  return dialogs.custom<string | null>((close) => <FileDialogView {...options} dialogs={dialogs} close={close} />);
}
