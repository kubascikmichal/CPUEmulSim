/**
 * Port of `enumInstructionsSet` and `Regexes`.
 *
 * Java `String.matches(regex)` is a full match, so every pattern is anchored `^(?:…)$`.
 * Java `(?i)` (ASCII-only case folding) → JS flag `i` without `u`, which also folds ASCII only.
 * Java `\p{XDigit}` → `[0-9A-Fa-f]`; Java `.` → {@link J_DOT} matched per code point (flag `u`).
 */
import { J_DOT } from '../util/java';

const full = (source: string, flags = ''): RegExp => new RegExp(`^(?:${source})$`, flags);

// Regexes.java (each alternative already carries ^…$ in the original)
const rByteDec = '^([0-1]?\\d?\\d|2[0-4]\\d|25[0-5])$';
const rByteHex = '^0[xX][0-9A-Fa-f]{1,2}$';
const rByteOct = '^0([0-2]?[0-7]{1,2}|3[0-7]{0,2})$';
const rByteBin = '^[0-1]{1,8}b$';
export const rByteChar = `^'${J_DOT}'$`;
const rByte = [rByteDec, rByteHex, rByteBin, rByteOct, rByteChar].join('|');

const rShortDec = '^([0-5]?\\d?\\d?\\d?\\d|6[0-4]\\d\\d\\d|65[0-4]\\d\\d|655[0-2]\\d|6553[0-5])$';
const rShortHex = '^0[xX][0-9A-Fa-f]{1,4}$';
const rShortOct = '^0([0-7]{1,5}|1[0-7]{0,5})$';
const rShortBin = '^[0-1]{1,16}b$';
const rShort = [rShortDec, rShortHex, rShortBin, rShortOct].join('|');

const REG = full('A|B|C|D', 'i');
const BYTE = full(rByte, 'u');
const SHORT = full(rShort, 'u');
const SHIFT = full('[1-8]');
const LABEL = full('\\w+');

export interface InstructionDef {
  readonly name: InstructionType;
  readonly numOfParameters: 0 | 1 | 2;
  readonly firstRegex?: RegExp;
  readonly secondRegex?: RegExp;
  readonly usesLabel: boolean;
}

const defs = {
  // arithmetic & logic
  ADD: [REG, REG], ADC: [REG, REG], ADI: [REG, BYTE],
  SUB: [REG, REG], SUC: [REG, REG], SBI: [REG, BYTE],
  AND: [REG, REG], ANI: [REG, BYTE], ORR: [REG, REG], ORI: [REG, BYTE],
  XOR: [REG, REG], XRI: [REG, BYTE],
  INC: [REG], INX: [full('S|M', 'i')], DEC: [REG], DCX: [full('S|M', 'i')],
  CMP: [REG, REG], CMI: [REG, BYTE],
  // shift & rotate
  SHL: [REG, SHIFT], SHR: [REG, SHIFT], SCR: [REG, SHIFT], RTL: [REG, SHIFT],
  RCL: [REG, SHIFT], RTR: [REG, SHIFT], RCR: [REG, SHIFT],
  // data transfer
  MOV: [REG, REG], MVI: [REG, BYTE], MXI: [full('S|M', 'i'), SHORT],
  MVX: [full('S|M|C', 'i'), full('A|S|M', 'i')], MMR: [REG, REG],
  LMI: [REG, SHORT], LMR: [REG], SMI: [SHORT, REG], SMR: [REG],
  INN: [REG, SHORT], OUT: [SHORT, REG],
  PUS: [full('A|B|C|D|F|M', 'i')], POP: [full('A|B|C|D|F|M', 'i')],
  STR: [REG, REG], LDR: [REG, REG],
  // branching (label)
  JMP: 'L', JZR: 'L', JNZ: 'L', JCY: 'L', JNC: 'L', JL: 'L', JG: 'L', JE: 'L', JLE: 'L',
  JGE: 'L', JNE: 'L', JNL: 'L', JNG: 'L',
  CAL: 'L', CZR: 'L', CNZ: 'L', CCY: 'L', CNC: 'L', CL: 'L', CG: 'L', CE: 'L', CLE: 'L',
  CGE: 'L', CNE: 'L', CNL: 'L', CNG: 'L',
  RET: [],
  // special
  EIT: [], DIT: [], SCALL: [full('KPR|KEY|DSP', 'i')], BYTE: [BYTE],
} as const satisfies Record<string, readonly RegExp[] | 'L'>;

export type InstructionType = keyof typeof defs;

const table = new Map<string, InstructionDef>();
for (const [name, spec] of Object.entries(defs)) {
  const def: InstructionDef =
    spec === 'L'
      ? { name: name as InstructionType, numOfParameters: 1, firstRegex: LABEL, usesLabel: true }
      : {
          name: name as InstructionType,
          numOfParameters: spec.length as 0 | 1 | 2,
          firstRegex: spec[0],
          secondRegex: spec[1],
          usesLabel: false,
        };
  table.set(name, def);
}

/** Java `enumInstructionsSet.valueOf(name)` - null instead of IllegalArgumentException. */
export function instructionValueOf(name: string): InstructionDef | null {
  return table.get(name) ?? null;
}

export const INSTRUCTION_NAMES: readonly InstructionType[] = Object.keys(defs) as InstructionType[];
