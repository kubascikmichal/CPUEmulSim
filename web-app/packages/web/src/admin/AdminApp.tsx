/**
 * User management page (`/admin`) for teachers (students only) and the administrator (everyone,
 * plus roles): list with online state, create, CSV import, rename, password, enable / disable, delete.
 */
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authFetch, logoutRequest, type SessionInfo } from '../auth/api';
import { useInterval } from '../common/hooks';
import { saveLocally } from '../files/api';
import { adminApi, AdminApiError, ERROR_TEXT, type ImportResult, type ManagedUser, type Role } from './api';

const REFRESH_MS = 15_000;
const ROLE_TEXT: Record<string, string> = { student: 'Študent', teacher: 'Učiteľ', admin: 'Administrátor' };

const formatDate = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' }));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('sk-SK', { maximumFractionDigits: 1 })} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('sk-SK', { maximumFractionDigits: 1 })} MB`;
}

const messageOf = (e: unknown) => (e instanceof AdminApiError ? e.message : ERROR_TEXT.unavailable);

type DialogState =
  | { kind: 'create' }
  | { kind: 'import' }
  | { kind: 'name'; user: ManagedUser }
  | { kind: 'password'; user: ManagedUser }
  | { kind: 'delete'; user: ManagedUser }
  | null;

export function AdminApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [actor, setActor] = useState<'admin' | 'teacher'>('teacher');
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const reload = useCallback(async () => {
    try {
      const data = await adminApi.list();
      setActor(data.actor);
      setUsers(data.users);
    } catch (e) {
      if (e instanceof AdminApiError && e.code === 'forbidden') window.location.replace('/');
      else setError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    authFetch('/api/auth/session')
      .then(async (res) => {
        if (res.status === 401) window.location.replace('/login');
        else setSession(await res.json());
      })
      .catch(() => setError(ERROR_TEXT.unavailable));
    void reload();
  }, [reload]);
  useInterval(() => void reload(), REFRESH_MS, dialog === null);

  /** Runs an action, shows its result and reloads the list. */
  const act = async (action: () => Promise<unknown>, done: string): Promise<boolean> => {
    setError(null);
    try {
      await action();
      setNotice(done);
      await reload();
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (users ?? []).filter((u) => q === '' || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
    return list.sort((a, b) => a.name.localeCompare(b.name, 'sk') || a.username.localeCompare(b.username, 'sk'));
  }, [users, filter]);
  const onlineCount = (users ?? []).filter((u) => u.online).length;
  const isAdmin = actor === 'admin';

  return (
    <Box sx={{ minHeight: '100vh', background: '#f4f4f4' }}>
      {/* header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 4, py: 2, borderBottom: '1px solid #c8c8c8', background: 'linear-gradient(#f7f7f7,#e5e5e5)' }}>
        <img src="/icons/cpu_icon.png" width={24} height={24} alt="" />
        <Typography sx={{ fontSize: 16, fontWeight: 500, flex: 1 }}>Správa používateľov</Typography>
        {session && (
          <Typography sx={{ fontSize: 13, color: '#555' }} data-testid="admin-whoami">
            {(() => {
              const role = ROLE_TEXT[session.user.role] ?? session.user.role;
              const who = session.user.displayName === role ? session.user.username : session.user.displayName;
              return `${who} (${role})`;
            })()}
          </Typography>
        )}
        <Button href="/">Emulátor</Button>
        <Button
          onClick={async () => {
            await logoutRequest();
            window.location.replace('/login');
          }}
        >
          Odhlásiť
        </Button>
      </Box>

      <Box sx={{ p: 4, maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {/* toolbar */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Button onClick={() => setDialog({ kind: 'create' })}>{isAdmin ? 'Nový používateľ...' : 'Nový študent...'}</Button>
          <Button onClick={() => setDialog({ kind: 'import' })}>Import študentov (CSV)...</Button>
          <Button onClick={() => void reload()}>Obnoviť</Button>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 13, color: '#555' }}>
            {users === null ? '' : `${users.length} ${isAdmin ? 'používateľov' : 'študentov'}, online ${onlineCount}`}
          </Typography>
          <TextField placeholder="Hľadať meno alebo používateľa" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ width: 260 }} inputProps={{ 'aria-label': 'Hľadať' }} />
        </Box>

        {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
        {notice && !error && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}

        {/* users */}
        <TableContainer sx={{ background: '#fff', border: '1px solid #ccc' }}>
          <Table size="small" aria-label="Používatelia">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 600, background: '#f2f2f2' } }}>
                <TableCell>Meno</TableCell>
                <TableCell>Používateľské meno</TableCell>
                {isAdmin && <TableCell>Rola</TableCell>}
                <TableCell>Stav</TableCell>
                <TableCell>Online</TableCell>
                <TableCell>Posledné prihlásenie</TableCell>
                <TableCell align="right">Súbory</TableCell>
                <TableCell align="right">Akcie</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((u) => (
                <TableRow key={u.username} hover data-testid={`user-${u.username}`} sx={{ opacity: u.enabled ? 1 : 0.6 }}>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>{u.username}</TableCell>
                  {isAdmin && (
                    <TableCell>
                      <Select
                        size="small"
                        value={u.role}
                        onChange={(e) => void act(() => adminApi.update(u.username, { role: e.target.value as Role }), `Rola používateľa ${u.username} zmenená.`)}
                        inputProps={{ 'aria-label': `Rola ${u.username}` }}
                        sx={{ fontSize: 12, '& .MuiSelect-select': { py: '2px' } }}
                      >
                        <MenuItem value="student">Študent</MenuItem>
                        <MenuItem value="teacher">Učiteľ</MenuItem>
                      </Select>
                    </TableCell>
                  )}
                  <TableCell sx={{ color: u.enabled ? '#2e7d32' : '#c62828' }}>{u.enabled ? 'Aktívny' : 'Zablokovaný'}</TableCell>
                  <TableCell title={u.lastActivityAt ? 'Posledná aktivita ' + formatDate(u.lastActivityAt) : undefined}>
                    {u.online ? <span style={{ color: '#2e7d32' }}>● online</span> : <span style={{ color: '#999' }}>○</span>}
                  </TableCell>
                  <TableCell>{formatDate(u.lastLoginAt)}</TableCell>
                  <TableCell align="right">
                    {u.fileCount} / {formatBytes(u.storageBytes)}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap', '& button': { ml: 1 } }}>
                    <Button onClick={() => setDialog({ kind: 'name', user: u })}>Meno</Button>
                    <Button onClick={() => setDialog({ kind: 'password', user: u })}>Heslo</Button>
                    <Button
                      onClick={() =>
                        void act(
                          () => adminApi.update(u.username, { enabled: !u.enabled }),
                          u.enabled ? `Účet ${u.username} je zablokovaný.` : `Účet ${u.username} je povolený.`,
                        )
                      }
                    >
                      {u.enabled ? 'Zablokovať' : 'Povoliť'}
                    </Button>
                    <Button onClick={() => setDialog({ kind: 'delete', user: u })} sx={{ color: '#c62828 !important' }}>
                      Zmazať
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {users !== null && visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 8 : 7} sx={{ color: '#777', textAlign: 'center', py: 4 }}>
                    {users.length === 0 ? 'Zatiaľ žiadni používatelia.' : 'Nič nevyhovuje hľadaniu.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>

      {dialog?.kind === 'create' && (
        <CreateDialog
          isAdmin={isAdmin}
          onClose={() => setDialog(null)}
          onSubmit={async (u) => (await act(() => adminApi.create(u), `Účet ${u.username} vytvorený.`)) && setDialog(null)}
        />
      )}
      {dialog?.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onImported={() => void reload()} />}
      {dialog?.kind === 'name' && (
        <FormDialog
          title={`Meno používateľa ${dialog.user.username}`}
          submitText="Uložiť"
          onClose={() => setDialog(null)}
          fields={[{ id: 'name', label: 'Meno a priezvisko', initial: dialog.user.name }]}
          onSubmit={async ({ name }) =>
            (await act(() => adminApi.update(dialog.user.username, { name }), `Meno používateľa ${dialog.user.username} zmenené.`)) && setDialog(null)
          }
        />
      )}
      {dialog?.kind === 'password' && (
        <FormDialog
          title={`Nové heslo pre ${dialog.user.name} (${dialog.user.username})`}
          submitText="Nastaviť heslo"
          onClose={() => setDialog(null)}
          note="Používateľ bude odhlásený a prihlási sa už len novým heslom."
          fields={[
            { id: 'password', label: 'Nové heslo (aspoň 8 znakov)', type: 'password' },
            { id: 'password2', label: 'Nové heslo znova', type: 'password' },
          ]}
          validate={({ password, password2 }) => (password !== password2 ? 'Heslá sa nezhodujú.' : null)}
          onSubmit={async ({ password }) =>
            (await act(() => adminApi.setPassword(dialog.user.username, password), `Heslo používateľa ${dialog.user.username} zmenené.`)) && setDialog(null)
          }
        />
      )}
      {dialog?.kind === 'delete' && (
        <Dialog open onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
          <DialogTitle>Zmazať používateľa</DialogTitle>
          <DialogContent>
            <Typography sx={{ fontSize: 13 }}>
              Naozaj zmazať účet <b>{dialog.user.name}</b> ({dialog.user.username}) a všetky jeho súbory ({dialog.user.fileCount})? Túto akciu nie je možné
              vrátiť.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialog(null)}>Zrušiť</Button>
            <Button
              sx={{ color: '#c62828 !important' }}
              onClick={async () => (await act(() => adminApi.remove(dialog.user.username), `Účet ${dialog.user.username} zmazaný.`)) && setDialog(null)}
            >
              Zmazať
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}

// ------------------------------------------------------------------ dialogs

interface Field {
  id: string;
  label: string;
  type?: string;
  initial?: string;
}

function FormDialog(props: {
  title: string;
  submitText: string;
  fields: Field[];
  note?: ReactNode;
  extra?: ReactNode;
  validate?: (values: Record<string, string>) => string | null;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((f) => [f.id, f.initial ?? ''])));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = props.fields.every((f) => values[f.id].trim() !== '');
  const submit = async () => {
    const p = props.validate?.(values) ?? null;
    setProblem(p);
    if (p !== null) return;
    setBusy(true);
    await props.onSubmit(values);
    setBusy(false);
  };
  return (
    <Dialog open onClose={props.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{props.title}</DialogTitle>
      <DialogContent>
        <Box
          component="form"
          id="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (filled && !busy) void submit();
          }}
          sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}
        >
          {props.fields.map((f, i) => (
            <TextField
              key={f.id}
              label={f.label}
              type={f.type ?? 'text'}
              value={values[f.id]}
              autoFocus={i === 0}
              autoComplete={f.type === 'password' ? 'new-password' : 'off'}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            />
          ))}
          {props.extra}
          {props.note && <Typography sx={{ fontSize: 12, color: '#666' }}>{props.note}</Typography>}
          {problem && <Typography sx={{ fontSize: 13, color: '#c62828' }}>{problem}</Typography>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Zrušiť</Button>
        <Button type="submit" form="admin-form" disabled={!filled || busy}>
          {props.submitText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CreateDialog(props: {
  isAdmin: boolean;
  onClose: () => void;
  onSubmit: (u: { username: string; name: string; password: string; role: Role }) => Promise<unknown>;
}) {
  const [teacher, setTeacher] = useState(false);
  return (
    <FormDialog
      title={props.isAdmin ? 'Nový používateľ' : 'Nový študent'}
      submitText="Vytvoriť"
      onClose={props.onClose}
      fields={[
        { id: 'name', label: 'Meno a priezvisko' },
        { id: 'username', label: 'Používateľské meno' },
        { id: 'password', label: 'Heslo (aspoň 8 znakov)', type: 'password' },
      ]}
      note="Používateľské meno: 3–32 znakov, písmená, číslice, bodka, podčiarkovník, pomlčka."
      extra={
        props.isAdmin && (
          <FormControlLabel control={<Checkbox checked={teacher} onChange={(e) => setTeacher(e.target.checked)} />} label="Učiteľ" />
        )
      }
      onSubmit={({ name, username, password }) => props.onSubmit({ name, username: username.trim(), password, role: teacher ? 'teacher' : 'student' })}
    />
  );
}

/** CSV with the created accounts and their passwords (UTF-8 with BOM so Excel shows diacritics). */
function passwordsCsv(created: ImportResult['created']): string {
  const q = (s: string) => (/[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return '﻿' + ['meno;pouzivatel;heslo', ...created.map((c) => [c.name, c.username, c.password].map(q).join(';'))].join('\r\n') + '\r\n';
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setResult(await adminApi.importCsv(csv));
      onImported();
    } catch (e) {
      setProblem(messageOf(e));
    }
    setBusy(false);
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Import študentov (CSV)</DialogTitle>
      <DialogContent>
        {result === null ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Typography sx={{ fontSize: 13 }}>
              Jeden študent na riadok: <code>meno;používateľské meno</code> (napr. <code>Ján Novák;jnovak</code>). Hlavička je nepovinná. Heslá sa vygenerujú
              a po importe si ich stiahnete.
            </Typography>
            <Box>
              <Button component="label">
                Vybrať súbor...
                <input
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  hidden
                  data-testid="import-file"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setCsv(await file.text());
                    e.target.value = '';
                  }}
                />
              </Button>
            </Box>
            <TextField
              multiline
              minRows={8}
              maxRows={16}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={'Ján Novák;jnovak\nEva Malá;emala'}
              inputProps={{ 'aria-label': 'Obsah CSV', style: { fontFamily: 'monospace', fontSize: 12 } }}
            />
            {problem && <Typography sx={{ fontSize: 13, color: '#c62828' }}>{problem}</Typography>}
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Alert severity={result.created.length > 0 ? 'success' : 'warning'}>
              Vytvorených účtov: {result.created.length}, preskočených riadkov: {result.skipped.length}.
              {result.created.length > 0 && ' Heslá sa zobrazujú iba teraz - stiahnite si ich.'}
            </Alert>
            {result.created.length > 0 && (
              <Box>
                <Button onClick={() => saveLocally('studenti-hesla.csv', passwordsCsv(result.created))}>Stiahnuť zoznam s heslami (CSV)</Button>
              </Box>
            )}
            {result.created.length > 0 && (
              <ResultTable
                label="Vytvorené účty"
                head={['Riadok', 'Meno', 'Používateľ', 'Heslo']}
                rows={result.created.map((c) => [String(c.line), c.name, c.username, <code key="p">{c.password}</code>])}
              />
            )}
            {result.skipped.length > 0 && (
              <ResultTable
                label="Preskočené riadky"
                head={['Riadok', 'Meno', 'Používateľ', 'Dôvod']}
                rows={result.skipped.map((s) => [String(s.line), s.name, s.username, ERROR_TEXT[s.error] ?? s.error])}
              />
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {result === null ? 'Zrušiť' : 'Zavrieť'}
        </Button>
        {result === null && (
          <Button onClick={() => void run()} disabled={busy || csv.trim() === ''}>
            {busy ? 'Importujem...' : 'Importovať'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function ResultTable({ label, head, rows }: { label: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <Box>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>{label}</Typography>
      <TableContainer sx={{ maxHeight: 240, border: '1px solid #ddd' }}>
        <Table size="small" stickyHeader aria-label={label}>
          <TableHead>
            <TableRow>
              {head.map((h) => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((c, j) => (
                  <TableCell key={j}>{c}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
