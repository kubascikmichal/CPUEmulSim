/**
 * Client of the account file store (`/api/files`, approved deviation D2).
 * All requests carry the CSRF header required by the server.
 */
export interface StoredFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export class FileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const HEADERS = { 'X-Requested-With': 'cpuemul' };

async function check(res: Response): Promise<Response> {
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('cpuemul:session-expired'));
  }
  if (!res.ok) {
    let code = 'error';
    try {
      code = (await res.json()).error ?? code;
    } catch {
      /* no body */
    }
    throw new FileApiError(res.status, code);
  }
  return res;
}

export async function listFiles(extensions: string[]): Promise<StoredFile[]> {
  const res = await check(await fetch(`/api/files?ext=${encodeURIComponent(extensions.join(','))}`, { headers: HEADERS }));
  return res.json();
}

/** Raw UTF-8 content. */
export async function readFile(name: string): Promise<string> {
  const res = await check(await fetch(`/api/files/${encodeURIComponent(name)}`, { headers: HEADERS }));
  return new TextDecoder('utf-8').decode(await res.arrayBuffer());
}

export async function fileExists(name: string): Promise<boolean> {
  const res = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'HEAD', headers: HEADERS });
  if (res.status === 404) return false;
  await check(res);
  return true;
}

export async function writeFile(name: string, content: string): Promise<void> {
  await check(
    await fetch(`/api/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      body: new TextEncoder().encode(content),
    }),
  );
}

/** Client-side mirror of the server's name rules (messages only; the server decides). */
export function isValidFileName(name: string): boolean {
  if (name.length === 0 || new TextEncoder().encode(name).length > 255) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  if (/^[ .]|[ .]$/.test(name)) return false;
  return /\.(asm|txt|schx)$/i.test(name);
}

/**
 * Saves text to the user's computer (browser download) under `name`. `doc` is the document of
 * the window the action came from (the schematic window is a separate browser window).
 */
export function saveLocally(name: string, content: string | ArrayBuffer, doc: Document = document): void {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Downloads a file from the account workspace to the user's computer (bytes unchanged). */
export async function downloadFile(name: string, doc: Document = document): Promise<void> {
  const res = await check(await fetch(`/api/files/${encodeURIComponent(name)}`, { headers: HEADERS }));
  saveLocally(name, await res.arrayBuffer(), doc);
}
