/**
 * JavaFX colour handling used by component properties: named colours used by the original,
 * `Color.web()` parsing and the `#RRGGBB` serialisation used in `.schx` files.
 */

/** JavaFX named colours used by the original application (exact JavaFX values). */
export const FX = {
  RED: '#FF0000',
  GREEN: '#008000',
  BLUE: '#0000FF',
  YELLOW: '#FFFF00',
  ORANGE: '#FFA500',
  BLACK: '#000000',
  WHITE: '#FFFFFF',
  DARKGRAY: '#A9A9A9',
  GRAY: '#808080',
  LIME: '#00FF00',
} as const;

/** Colour choices of LED / 7-segment context menus (label → colour), in menu order. */
export const COLOR_CHOICES: readonly [string, string][] = [
  ['Červená', FX.RED],
  ['Zelená', FX.GREEN],
  ['Modrá', FX.BLUE],
  ['Žltá', FX.YELLOW],
  ['Oranžová', FX.ORANGE],
];

/** Colour choices of the wire context menu (label → colour), in menu order. */
export const WIRE_COLOR_CHOICES: readonly [string, string][] = [
  ['Čierna', FX.BLACK],
  ['Červená', FX.RED],
  ['Zelená', FX.GREEN],
  ['Modrá', FX.BLUE],
  ['Žltá', FX.YELLOW],
  ['Oranžová', FX.ORANGE],
  ['Šedá', FX.GRAY],
];

/**
 * `javafx.scene.paint.Color.web(String)` for the forms that can occur in files: `#rgb`, `#rrggbb`,
 * `#rrggbbaa`, `0x…`, and the named colours above. Throws like Java on anything else.
 * @returns normalised `#RRGGBB` (alpha is not serialised by the original)
 */
export function colorWeb(input: string): string {
  let s = input.trim().toLowerCase();
  const named = (FX as Record<string, string>)[s.toUpperCase()];
  if (named) return named;
  if (s.startsWith('#')) s = s.substring(1);
  else if (s.startsWith('0x')) s = s.substring(2);
  else throw new Error('IllegalArgumentException: Invalid color specification');
  if (!/^[0-9a-f]+$/.test(s)) throw new Error('IllegalArgumentException: Invalid color specification');
  if (s.length === 3 || s.length === 4) {
    s = s.substring(0, 3).split('').map((c) => c + c).join('');
  } else if (s.length === 6 || s.length === 8) {
    s = s.substring(0, 6);
  } else {
    throw new Error('IllegalArgumentException: Invalid color specification');
  }
  return '#' + s.toUpperCase();
}
