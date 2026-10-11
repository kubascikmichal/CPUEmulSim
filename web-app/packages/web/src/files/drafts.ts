/**
 * Browser autosave of unsaved work (approved deviation D2): drafts in IndexedDB, keyed by
 * `<username>/code` and `<username>/schematic`. Drafts are only written while there are unsaved
 * changes and are never sent to the server.
 */
export interface Draft {
  content: string;
  currentFileName: string | null;
  savedAt: number;
}

const DB_NAME = 'cpuemul-drafts';
const STORE = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export type DraftKind = 'code' | 'schematic';

const key = (user: string, kind: DraftKind) => `${user}/${kind}`;

export async function saveDraft(user: string, kind: DraftKind, draft: Draft): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(draft, key(user, kind)));
  } catch (e) {
    console.warn('draft not saved', e);
  }
}

export async function loadDraft(user: string, kind: DraftKind): Promise<Draft | null> {
  try {
    return ((await tx('readonly', (s) => s.get(key(user, kind)))) as Draft | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function deleteDraft(user: string, kind: DraftKind): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(key(user, kind)));
  } catch {
    /* ignore */
  }
}

/** Debounced draft writer: `schedule()` on every change, `cancel()` + delete when clean. */
export class DraftAutosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly user: () => string | null,
    private readonly kind: DraftKind,
    private readonly snapshot: () => Draft | null,
  ) {}

  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1000);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const user = this.user();
    const draft = this.snapshot();
    if (user === null) return;
    if (draft === null) await deleteDraft(user, this.kind);
    else await saveDraft(user, this.kind, draft);
  }

  async discard(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const user = this.user();
    if (user !== null) await deleteDraft(user, this.kind);
  }
}
