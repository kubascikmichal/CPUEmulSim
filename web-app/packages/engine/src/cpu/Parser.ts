/**
 * Port of `sk.uniza.fri.cp.CPUEmul.Parser` (a JavaFX Task<Program> in the original).
 *
 * Outcome mirrors the Task: success → Program; failure → the thrown exception. Besides
 * {@link InvalidCodeLinesException} the original can fail with other, uncaught exceptions
 * (e.g. NumberFormatException for label `INT0a`, IndexOutOfBoundsException for a line of only
 * commas/quotes); those are reproduced and reported as `{ ok:false, error }` with that type.
 */
import {
  IllegalArgumentException,
  IndexOutOfBoundsException,
  J_DOT,
  J_WS,
  javaTrim,
  parseIntJava,
  readLines,
} from '../util/java';
import { instructionValueOf, rByteChar, type InstructionDef } from './InstructionSet';
import { Instruction, InvalidCodeLinesException, Program } from './Program';

/** `^\s*\w+:` found at the start of a line. */
const LABEL_PATTERN = new RegExp(`^${J_WS}*\\w+:`);
/** `(?m);.*$` - everything from `;` to the end of the line. */
const COMMENT_PATTERN = new RegExp(`;${J_DOT}*`, 'gu');
/** `[^\s"',]+|'.'` */
const INSTRUCTION_PATTERN = new RegExp(`[^ \\t\\n\\x0B\\f\\r"',]+|'${J_DOT}'`, 'gu');
const BYTE_CHAR = new RegExp(rByteChar, 'u');
const HEX_CONSTANT = new RegExp(`^0[xX]${J_DOT}+$`, 'u');
const INT_PREFIX = new RegExp(`^[iI][nN][tT]${J_DOT}*$`, 'u');

export type ParseResult =
  | { ok: true; program: Program }
  | { ok: false; error: InvalidCodeLinesException | Error };

/**
 * `Parser.isInstrucionLine` - does the line contain a (possibly malformed) instruction?
 * Used by the editor to snap breakpoints to instruction lines.
 */
export function isInstructionLine(line: string): boolean {
  line = line.replace(COMMENT_PATTERN, '');
  if (line.length === 0) return false;
  line = line.replace(new RegExp(LABEL_PATTERN.source, 'g'), '');
  if (line.length === 0) return false;
  line = javaTrim(line);
  // line.split("\\s*,\\s*|\\s+")[0]
  const first = line.split(new RegExp(`${J_WS}*,${J_WS}*|${J_WS}+`))[0];
  return instructionValueOf(first.toUpperCase()) !== null;
}

/** `Parser.parseConstant` - number in dec/bin/hex/oct or a character; -1 if unparseable. */
export function parseConstant(constant: string): number {
  if (HEX_CONSTANT.test(constant)) return parseIntJava(constant.substring(2), 16);
  if (/^[0-1]+b$/.test(constant)) return parseIntJava(constant.substring(0, constant.length - 1), 2);
  if (/^0[0-7]+$/.test(constant)) return parseIntJava(constant, 8);
  if (/^(?:(^[1-9][0-9]*)|(^0$))$/.test(constant)) return parseIntJava(constant);
  if (BYTE_CHAR.test(constant)) return constant.charCodeAt(1);
  try {
    return parseIntJava(constant);
  } catch {
    return -1;
  }
}

/**
 * Parses assembler source.
 * @param code editor text
 * @param numberOfCodeLines editor paragraph count (progress estimate only)
 * @param onProgress `updateProgress(done, total)` equivalent
 */
export function parse(
  code: string,
  numberOfCodeLines: number,
  onProgress?: (done: number, total: number) => void,
): ParseResult {
  try {
    return { ok: true, program: new ParserRun(code, numberOfCodeLines, onProgress).call() };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

class ParserRun {
  private hasError = false;
  private readonly instructions: Instruction[] = [];
  private readonly lineIndexToInstructionIndex = new Map<number, number>();
  private readonly progMemory: number[] = [];
  private readonly interruptionLabels = new Map<number, number>();
  private readonly labels = new Map<string, number>();
  private readonly instructionsWithLabels: number[] = [];
  private errors: string[] = [];
  private errorLines: number[] = [];

  constructor(
    private code: string,
    private readonly numOfCodeLines: number,
    private readonly onProgress?: (done: number, total: number) => void,
  ) {}

  call(): Program {
    let lineIndex = 0;
    this.code = this.code.replace(COMMENT_PATTERN, '');

    for (let line of readLines(this.code)) {
      this.onProgress?.(lineIndex + 1, this.numOfCodeLines);

      const labelMatch = LABEL_PATTERN.exec(line);
      if (labelMatch) {
        let label = labelMatch[0];
        label = javaTrim(label.substring(0, label.length - 1));

        if (!this.labels.has(label)) {
          if (INT_PREFIX.test(label)) {
            if (/^[iI][nN][tT](?:[0]\d|[1][012345]|[0][abcdef])$/.test(label)) {
              const intNumber = /^int0[0-9A-Fa-f]$/.test(label)
                ? parseIntJava(label.substring(4, 5), 16)
                : parseIntJava(label.substring(3, 5), 10); // throws for "INT0a" - uncaught, as in Java
              if (!this.interruptionLabels.has(intNumber)) {
                this.interruptionLabels.set(intNumber, this.instructions.length);
              } else {
                this.addError('Návestie pre prerušenie ' + label + ' už existuje', lineIndex);
              }
            }
          }
          this.labels.set(label, this.instructions.length);
        } else {
          this.addError('Návestie ' + label + ' už existuje', lineIndex);
        }

        line = line.substring(labelMatch[0].length);
      }

      line = javaTrim(line);
      if (line.length === 0) {
        lineIndex++;
        continue;
      }

      const instructionParts = line.match(INSTRUCTION_PATTERN) ?? [];
      // instructionParts.get(0) on an empty list throws IndexOutOfBoundsException (not caught)
      if (instructionParts.length === 0) throw new IndexOutOfBoundsException('Index: 0, Size: 0');

      try {
        this.parseInstruction(instructionParts, lineIndex);
      } catch (e) {
        if (!(e instanceof IllegalArgumentException)) throw e;
        this.addError("Neplatná inštrukcia '" + instructionParts[0] + "'", lineIndex);
      }

      lineIndex++;
    }

    this.onProgress?.(this.numOfCodeLines, this.numOfCodeLines);

    if (!this.hasError && this.labels.size > 0) this.transformLabelsToIndexes();

    if (!this.hasError) {
      return new Program(this.instructions, this.progMemory, this.lineIndexToInstructionIndex,
        this.interruptionLabels);
    }
    throw new InvalidCodeLinesException([...this.errorLines], [...this.errors]);
  }

  private parseInstruction(parts: string[], lineIndex: number): void {
    const def = instructionValueOf(parts[0].toUpperCase());
    if (def === null) throw new IllegalArgumentException('No enum constant ' + parts[0]);

    if (def.numOfParameters !== parts.length - 1) {
      this.addError("Zlý počet parametrov inštrukcie '" + parts[0] + "', požadovaný počet '" +
        def.numOfParameters + "'", lineIndex);
      return;
    }

    let parametersError = false;
    if (def.numOfParameters > 0 && !def.firstRegex!.test(parts[1])) {
      this.addError("Nesprávny prvý parameter inštrukcie '" + parts[0] + "'", lineIndex);
      parametersError = true;
    }
    if (def.numOfParameters > 1 && !def.secondRegex!.test(parts[2])) {
      this.addError("Nesprávny druhý parameter inštrukcie '" + parts[0] + "'", lineIndex);
      parametersError = true;
    }

    if (def.name === 'MVX') {
      if (/^C$/i.test(parts[1]) && /^A$/i.test(parts[2])) {
        this.addError("Nesprávny druhý parameter inštrukcie '" + parts[0] + "', povolené sú iba reg. S,M", lineIndex);
        parametersError = true;
      } else if (/^(?:S|M)$/i.test(parts[1]) && /^(?:S|M)$/i.test(parts[2])) {
        this.addError("Nesprávny druhý parameter inštrukcie '" + parts[0] + "', povolený je iba reg. A", lineIndex);
        parametersError = true;
      }
    }

    if (parametersError) return;

    this.addToProgram(def, parts);

    if (def.usesLabel) this.instructionsWithLabels.push(this.instructions.length - 1);
    this.lineIndexToInstructionIndex.set(lineIndex, this.instructions.length - 1);
  }

  private addToProgram(def: InstructionDef, parts: string[]): void {
    switch (def.numOfParameters) {
      case 0:
        this.instructions.push(new Instruction(def));
        break;
      case 1:
        if (def.name === 'BYTE') {
          this.progMemory.push(((parseConstant(parts[1]) << 24) >> 24));
        } else {
          this.instructions.push(new Instruction(def, parts[1]));
        }
        break;
      case 2:
        this.instructions.push(new Instruction(def, parts[1], parts[2]));
        break;
    }
  }

  private transformLabelsToIndexes(): void {
    for (const indexOfInstruction of this.instructionsWithLabels) {
      const inst = this.instructions[indexOfInstruction];
      const label = inst.firstParameter;
      if (label !== null) {
        const jumpIndex = this.labels.get(label);
        if (jumpIndex !== undefined) {
          inst.firstParameter = String(jumpIndex);
        } else {
          this.addError("Neplatné návestie '" + label + "'", this.getLineOfInstruction(indexOfInstruction));
        }
      } else {
        this.addError('Chyba v inštrukcií', this.getLineOfInstruction(indexOfInstruction));
      }
    }
  }

  private getLineOfInstruction(instructionIndex: number): number {
    const entries = [...this.lineIndexToInstructionIndex.entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, index] of entries) if (index === instructionIndex) return line;
    return -1;
  }

  private addError(err: string, lineIndex: number): void {
    if (!this.hasError) {
      this.errors = [];
      this.errorLines = [];
    }
    this.errors.push('[' + (lineIndex + 1) + '] ' + err);
    this.errorLines.push(lineIndex);
    this.hasError = true;
  }
}
