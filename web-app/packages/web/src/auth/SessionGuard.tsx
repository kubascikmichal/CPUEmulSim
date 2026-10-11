/**
 * Session handling for the CPU window (new, required by LDAP):
 *  - verifies the session on load (no session → /login),
 *  - keepalive on real user activity in either window (throttled to 1/min),
 *  - session expiry → modal re-login dialog over the page; all state is kept (D6),
 *  - offers to restore browser drafts after login (D2),
 *  - Koniec → logout (D9); closing the tab with unsaved work → browser prompt.
 */
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDialogs } from '../common/Dialogs';
import { getRuntime } from '../common/runtime';
import { loadDraft, type Draft } from '../files/drafts';
import { schematicController } from '../schematic/controller';
import type { CpuWindowController } from '../cpu/controller';
import { setText } from '../cpu/codeEditor';
import { authFetch, loginRequest, logoutRequest, type SessionInfo } from './api';

const KEEPALIVE_MIN_INTERVAL_MS = 60_000;

export function SessionGuard({ controller, children }: { controller: CpuWindowController; children: ReactNode }) {
  const dialogs = useDialogs();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [expired, setExpired] = useState(false);
  const lastKeepalive = useRef(0);

  // ---- initial session check
  useEffect(() => {
    authFetch('/api/auth/session')
      .then(async (res) => {
        if (res.status === 401) {
          window.location.replace('/login');
          return;
        }
        setInfo(await res.json());
      })
      .catch(() => window.location.replace('/login'));
  }, []);

  // ---- wire user / logout into the controllers
  useEffect(() => {
    if (info === null) return;
    controller.user = info.user.username;
    schematicController.user = info.user.username;
    controller.onExit = async () => {
      await logoutRequest();
      window.location.replace('/login');
    };
  }, [info, controller]);

  // ---- keepalive on user activity (both windows)
  const activity = useCallback(() => {
    const now = Date.now();
    if (now - lastKeepalive.current < KEEPALIVE_MIN_INTERVAL_MS) return;
    lastKeepalive.current = now;
    authFetch('/api/auth/keepalive', { method: 'POST' })
      .then((res) => {
        if (res.status === 401) setExpired(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    const targets: Window[] = [window];
    const attach = (w: Window) => {
      w.addEventListener('keydown', activity, true);
      w.addEventListener('pointerdown', activity, true);
    };
    attach(window);
    window.addEventListener('cpuemul:session-expired', onExpired);
    (window as Window & { cpuEmulAttachActivity?: (w: Window) => void }).cpuEmulAttachActivity = (w) => {
      targets.push(w);
      attach(w);
      w.addEventListener('cpuemul:session-expired', onExpired);
    };
    return () => {
      for (const w of targets) {
        w.removeEventListener('keydown', activity, true);
        w.removeEventListener('pointerdown', activity, true);
      }
      window.removeEventListener('cpuemul:session-expired', onExpired);
    };
  }, [activity]);

  // ---- unsaved work → browser prompt when the tab is closed
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const unsaved = (!controller.fileSaved && controller.getCode().trim() !== '') || getRuntime().session.sheet.hasChanged();
      if (unsaved) {
        void controller.drafts.flush();
        void schematicController.drafts.flush();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [controller]);

  // ---- draft restore (once after login)
  const restored = useRef(false);
  useEffect(() => {
    if (info === null || restored.current) return;
    restored.current = true;
    const user = info.user.username;
    void (async () => {
      const ask = (d: Draft, what: string) =>
        dialogs.alert({
          kind: 'CONFIRMATION',
          title: 'Obnovenie',
          header: `Našli sa neuložené zmeny z ${new Date(d.savedAt).toLocaleString('sk-SK')}. Prajete si ich obnoviť?`,
          content: what,
          buttons: ['Obnoviť', 'Zahodiť'],
        });
      const code = await loadDraft(user, 'code');
      if (code !== null) {
        if ((await ask(code, 'Kód')) === 'Obnoviť' && controller.editor) {
          setText(controller.editor, code.content);
          controller.currentFile = code.currentFileName;
          controller.codePaneTitle = (code.currentFileName ? 'Kód - ' + code.currentFileName : 'Kód') + '*';
          controller.fileSaved = false;
          controller.changed();
        } else {
          await controller.drafts.discard();
        }
      }
      const scheme = await loadDraft(user, 'schematic');
      if (scheme !== null) {
        if ((await ask(scheme, 'Schéma')) === 'Obnoviť') schematicController.restoreDraft(scheme);
        else await schematicController.drafts.discard();
      }
    })();
  }, [info, dialogs, controller]);

  if (info === null) return null;
  return (
    <>
      {children}
      {expired && <ReloginDialog username={info.user.username} onDone={() => setExpired(false)} />}
    </>
  );
}

function ReloginDialog({ username, onDone }: { username: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const result = await loginRequest(username, password);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message);
  };
  return (
    <Dialog open disableEscapeKeyDown>
      <DialogTitle>Prihlásenie</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, mb: 2 }}>Platnosť relácie vypršala. Prihláste sa znova.</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 300 }}>
          <TextField label="Používateľské meno" value={username} disabled />
          <TextField
            label="Heslo"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          {error && <Typography color="error" sx={{ fontSize: 13 }}>{error}</Typography>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy || password === ''} onClick={() => void submit()}>
          Prihlásiť
        </Button>
      </DialogActions>
    </Dialog>
  );
}
