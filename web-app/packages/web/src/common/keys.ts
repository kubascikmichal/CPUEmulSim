/**
 * Keyboard mapping from DOM events to what the original received from JavaFX.
 */
import type { CpuKey } from '@cpuemul/engine';

/** JavaFX `KeyCode.impl_getCode()` of the arrow keys (forwarded on KEY_PRESSED). */
const ARROWS: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

export function arrowKey(e: KeyboardEvent): CpuKey | null {
  const code = ARROWS[e.key];
  return code === undefined ? null : { kind: 'arrow', code };
}

/**
 * JavaFX KEY_TYPED character for a DOM keydown, or null if the key produces no typed character.
 * Enter → "\r", Backspace → "\b", Tab → "\t", Esc → ESC, Delete → DEL, Ctrl+letter → control char.
 */
export function typedCharacter(e: KeyboardEvent): string | null {
  if (e.isComposing || e.key === 'Dead') return null;
  switch (e.key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\b';
    case 'Tab': return '\t';
    case 'Escape': return '\u001b';
    case 'Delete': return '\u007f';
  }
  if (e.key.length !== 1 && [...e.key].length !== 1) return null;
  if (e.ctrlKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 0x1f);
  if (e.metaKey || (e.ctrlKey && !e.altKey)) return null;
  return e.key;
}

/** Accelerator id like "F5", "Ctrl+F9", "Ctrl+Shift+S", "Ctrl+/". */
export function accelerator(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.code === 'Slash' || key === '/') key = '/';
  parts.push(key);
  return parts.join('+');
}
