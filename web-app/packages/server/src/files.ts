/**
 * Per-user file store on the filesystem (approved deviation D2): `${dataDir}/users/<userKey>/files/`.
 * Flat list, names unique case-insensitively, atomic writes, quotas. Content is stored as the raw
 * UTF-8 bytes the client sent (identical to what the desktop application writes).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export class FileStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface FileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

const EXTENSIONS = ['asm', 'txt', 'schx'];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Server-side file name rules. */
export function validateFileName(name: string): void {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes < 1 || bytes > 255) throw new FileStoreError(400, 'invalid_name');
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) throw new FileStoreError(400, 'invalid_name');
  if (/^[ .]|[ .]$/.test(name) || RESERVED.test(name)) throw new FileStoreError(400, 'invalid_name');
  const ext = name.split('.').pop()!.toLowerCase();
  if (!name.includes('.') || !EXTENSIONS.includes(ext)) throw new FileStoreError(400, 'invalid_name');
}

/** Stable, injective directory key for a username: lowercase, [a-z0-9_-] kept, everything else %XX. */
export function userKey(username: string): string {
  let out = '';
  for (const byte of Buffer.from(username.toLowerCase(), 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[a-z0-9_-]/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export class FileStore {
  constructor(
    private readonly dataDir: string,
    private readonly limits: { maxFileBytes: number; maxUserBytes: number; maxUserFiles: number },
  ) {}

  private dirOf(username: string): string {
    const root = resolve(this.dataDir, 'users');
    const dir = resolve(root, userKey(username), 'files');
    if (!dir.startsWith(root + sep)) throw new FileStoreError(400, 'invalid_user');
    return dir;
  }

  private async entries(username: string): Promise<FileInfo[]> {
    const dir = this.dirOf(username);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: FileInfo[] = [];
    for (const name of names) {
      if (name.startsWith('.tmp-')) continue;
      const st = await stat(join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, modifiedAt: st.mtime.toISOString() });
    }
    return out;
  }

  /** Existing stored name matching case-insensitively, or null. */
  private async resolveName(username: string, name: string): Promise<string | null> {
    const lower = name.toLowerCase();
    return (await this.entries(username)).find((e) => e.name.toLowerCase() === lower)?.name ?? null;
  }

  async list(username: string, extensions: string[]): Promise<FileInfo[]> {
    const exts = new Set(extensions.map((e) => e.toLowerCase()));
    return (await this.entries(username))
      .filter((e) => exts.size === 0 || exts.has(e.name.split('.').pop()!.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'sk'));
  }

  async read(username: string, name: string): Promise<Buffer> {
    validateFileName(name);
    const stored = await this.resolveName(username, name);
    if (stored === null) throw new FileStoreError(404, 'not_found');
    return readFile(join(this.dirOf(username), stored));
  }

  async exists(username: string, name: string): Promise<boolean> {
    validateFileName(name);
    return (await this.resolveName(username, name)) !== null;
  }

  /** Number of files and bytes stored by the user. */
  async usage(username: string): Promise<{ files: number; bytes: number }> {
    const entries = await this.entries(username);
    return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) };
  }

  /** Deletes the user's whole workspace (`users/<userKey>/`). */
  async removeUser(username: string): Promise<void> {
    const root = resolve(this.dataDir, 'users');
    const dir = resolve(root, userKey(username));
    if (!dir.startsWith(root + sep)) throw new FileStoreError(400, 'invalid_user');
    await rm(dir, { recursive: true, force: true });
  }

  async write(username: string, name: string, content: Buffer): Promise<void> {
    validateFileName(name);
    if (content.length > this.limits.maxFileBytes) throw new FileStoreError(413, 'quota_exceeded');

    const entries = await this.entries(username);
    const existing = entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) ?? null;
    const otherBytes = entries.filter((e) => e !== existing).reduce((sum, e) => sum + e.size, 0);
    const count = entries.length + (existing ? 0 : 1);
    if (otherBytes + content.length > this.limits.maxUserBytes || count > this.limits.maxUserFiles) {
      throw new FileStoreError(413, 'quota_exceeded');
    }

    const dir = this.dirOf(username);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, '.tmp-' + randomBytes(8).toString('hex'));
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (existing && existing.name !== name) await unlink(join(dir, existing.name)).catch(() => {});
    await rename(tmp, join(dir, name));
  }
}
