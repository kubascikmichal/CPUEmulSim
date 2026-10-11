/**
 * CPU window controller - the UI half of `CPUController` (the headless half is
 * `CpuSession` in the engine). File handling, titles, unsaved prompts, accelerators,
 * keyboard forwarding to the CPU, settings and the Simulátor window toggle.
 */
import { Cpu, readLines, type Representation } from '@cpuemul/engine';
import type { EditorView } from '@codemirror/view';
import type { DialogApi } from '../common/Dialogs';
import { accelerator, arrowKey, typedCharacter } from '../common/keys';
import { getRuntime } from '../common/runtime';
import { FileApiError, readFile, saveLocally, writeFile } from '../files/api';
import { DraftAutosaver, type Draft } from '../files/drafts';
import { CODE_FILTERS, showFileDialog } from '../files/FileDialog';
import { schematicController } from '../schematic/controller';
import { blockComment, clearBreakpoints, setFontSize, setText } from './codeEditor';

export const PROGRAM_VERSION = '0.9.4';
export const WINDOW_TITLE = 'CPU Emulator v. ' + PROGRAM_VERSION;
const CODE_PANE_TEXT = 'Kód';

export type ReprKey = 'registers' | 'stackAddr' | 'stackData' | 'progAddr' | 'progData' | 'ramAddr' | 'ramData';

export interface ToastMessage {
  title: string;
  text: string;
  id: number;
}

export class CpuWindowController {
  readonly runtime = getRuntime();
  editor: EditorView | null = null;
  dialogs: DialogApi | null = null;
  user: string | null = null;

  // ---- observable UI state
  currentFile: string | null = null;
  fileSaved = true;
  codePaneTitle = CODE_PANE_TEXT;
  windowTitle = WINDOW_TITLE;
  fontSize = 9;
  logEnabled = false;
  toast: ToastMessage | null = null;
  reprs: Record<ReprKey, Representation> = {
    registers: 'Dec', stackAddr: 'Dec', stackData: 'Dec', progAddr: 'Dec', progData: 'Dec', ramAddr: 'Dec', ramData: 'Dec',
  };
  /** Window of the schematic simulator (null = hidden). */
  schematicWindow: Window | null = null;
  /** Called by Koniec after the prompts (logout); set by the auth layer. */
  onExit: (() => Promise<void>) | null = null;
  /** Opens/closes the schematic window; set by the schematic mount module. */
  toggleSchematicWindow: (() => void) | null = null;

  private readonly listeners: (() => void)[] = [];
  readonly drafts = new DraftAutosaver(
    () => this.user,
    'code',
    (): Draft | null =>
      !this.fileSaved && this.getCode().trim() !== ''
        ? { content: this.getCode(), currentFileName: this.currentFile, savedAt: Date.now() }
        : null,
  );

  get session() {
    return this.runtime.session;
  }

  subscribe(l: () => void): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  changed(): void {
    document.title = this.windowTitle;
    for (const l of [...this.listeners]) l();
  }

  getCode(): string {
    return this.editor?.state.doc.toString() ?? '';
  }

  /** Paragraph count of the editor (progress estimate of the parser). */
  private lineCount(): number {
    return this.editor?.state.doc.lines ?? 1;
  }

  // ---------------------------------------------------------------- editor events

  /** `codeEditor.richChanges()` subscriber: program invalidated, title gets "*" once. */
  onTextChange(): void {
    this.session.onCodeChanged();
    if (this.fileSaved) {
      this.codePaneTitle = this.codePaneTitle + '*';
      this.fileSaved = false;
    }
    this.drafts.schedule();
    this.changed();
  }

  // ---------------------------------------------------------------- execution buttons

  parse(): void {
    void this.session.parseCode(this.getCode(), this.lineCount(), false);
  }

  start(): void {
    void this.session.handleButtonStartAction(this.getCode(), this.lineCount());
  }

  step(): void {
    void this.session.handleButtonStepAction(this.getCode(), this.lineCount());
  }

  pause(): void {
    this.session.handleButtonPauseAction();
  }

  stop(): void {
    this.session.handleButtonStopAction();
  }

  reset(): void {
    this.session.handleButtonResetAction();
  }

  // ---------------------------------------------------------------- menu Súbor

  async newFile(): Promise<void> {
    if (!this.fileSaved && !(await this.continueIfUnsavedFile())) return;
    if (this.editor) setText(this.editor, '');
    this.codePaneTitle = CODE_PANE_TEXT;
    this.currentFile = null;
    this.fileSaved = true;
    this.windowTitle = 'CPU Emulator - nový program';
    await this.drafts.discard();
    this.changed();
  }

  async openFile(): Promise<void> {
    if (this.session.isExecuting()) this.stop();
    if (!this.fileSaved && !(await this.continueIfUnsavedFile())) return;

    const file = await showFileDialog(this.dialogs!, {
      mode: 'open',
      title: 'Otvoriť súbor...',
      filters: CODE_FILTERS,
      initialFileName: null,
    });
    if (file === null) return;
    let raw: string;
    try {
      raw = await readFile(file);
    } catch {
      return; // the original only printed the IOException
    }
    if (this.editor) {
      setText(this.editor, '');
      setText(this.editor, readLines(raw).map((l) => l + '\n').join(''));
    }
    this.currentFile = file;
    this.codePaneTitle = 'Kód - ' + file;
    this.fileSaved = true;
    this.windowTitle = 'CPU Emulator - ' + file;
    await this.drafts.discard();
    this.changed();
  }

  /** Downloads the editor content to the user's computer (current file name, else `program.asm`). */
  downloadCode(): void {
    saveLocally(this.currentFile ?? 'program.asm', this.getCode());
  }

  /** `saveCode(saveAs)` */
  async saveCode(saveAs: boolean): Promise<boolean> {
    let file = saveAs ? null : this.currentFile;
    if (this.currentFile === null || saveAs) {
      file = await showFileDialog(this.dialogs!, {
        mode: 'save',
        title: 'Uložiť' + (saveAs ? ' ako' : '') + '..',
        filters: CODE_FILTERS,
        initialFileName: this.currentFile,
      });
    }
    if (file === null) return false;
    try {
      await writeFile(file, this.getCode());
    } catch (e) {
      if (e instanceof FileApiError && e.status === 413) {
        await this.dialogs!.alert({
          kind: 'ERROR',
          title: 'Chyba',
          header: 'Súbor sa nepodarilo uložiť: prekročený limit úložiska.',
          buttons: ['OK'],
        });
      }
      return false;
    }
    this.currentFile = file;
    this.codePaneTitle = 'Kód - ' + file;
    this.fileSaved = true;
    this.windowTitle = 'CPU Emulator - ' + file;
    await this.drafts.discard();
    this.changed();
    return true;
  }

  /** `continueIfUnsavedFile` - code. */
  async continueIfUnsavedFile(): Promise<boolean> {
    if (this.getCode().trim() === '') return true;
    const buttons = [...(this.currentFile !== null ? ['Uložiť'] : []), 'Uložiť ako', 'Nie', 'Zrušiť'];
    const result = await this.dialogs!.alert({
      kind: 'CONFIRMATION',
      title: 'Potvrdenie',
      header: 'Zmeny vo vašom kóde neboli uložené',
      content: 'Prajete si uložiť zmeny?',
      buttons,
    });
    if (result === 'Zrušiť') return false;
    if (result === 'Uložiť ako') return this.saveCode(true);
    if (result === 'Uložiť') return this.saveCode(false);
    await this.drafts.discard();
    return true;
  }

  /** `continueIfUnsavedSchematic` (asked by the CPU window at exit). */
  private async continueIfUnsavedSchematic(): Promise<boolean> {
    const sheet = this.session.sheet;
    if (!sheet.hasChanged()) return true;
    const buttons = [...(schematicController.hasCurrentFile() ? ['Uložiť'] : []), 'Uložiť ako', 'Nie', 'Zrušiť'];
    const result = await this.dialogs!.alert({
      kind: 'CONFIRMATION',
      title: 'Potvrdenie',
      header: 'Zmeny v schéme neboli uložené',
      content: 'Prajete si uložiť zmeny?',
      buttons,
    });
    if (result === null || result === 'Zrušiť') return false;
    if (result === 'Uložiť ako') return schematicController.saveCircuit(true, this.dialogs!);
    if (result === 'Uložiť') return schematicController.saveCircuit(false, this.dialogs!);
    await schematicController.drafts.discard();
    return true;
  }

  /** Menu `Koniec`: the original cancels the CPU thread first, then asks (D9: exit = logout). */
  async exitMenu(): Promise<void> {
    this.session.cancelCpuThread();
    await this.exit();
  }

  async exit(): Promise<boolean> {
    if (!this.fileSaved && !(await this.continueIfUnsavedFile())) return false;
    if (!(await this.continueIfUnsavedSchematic())) return false;
    await this.drafts.discard();
    await schematicController.drafts.discard();
    this.schematicWindow?.close();
    await this.onExit?.();
    return true;
  }

  // ---------------------------------------------------------------- editor helpers

  unbreakAll(): void {
    if (this.editor) clearBreakpoints(this.editor);
  }

  fontSmaller(): void {
    if (this.fontSize > 7) {
      this.fontSize--;
      if (this.editor) setFontSize(this.editor, this.fontSize);
      this.changed();
    }
  }

  fontLarger(): void {
    if (this.fontSize < 28) {
      this.fontSize++;
      if (this.editor) setFontSize(this.editor, this.fontSize);
      this.changed();
    }
  }

  /** Ctrl+F12 - times_CPU debug log (to the browser console). */
  toggleLog(): void {
    if (this.logEnabled) {
      this.logEnabled = false;
      Cpu.stopTimesDebug();
      this.toast = { title: 'DEBUG', text: 'Logovanie vypnuté', id: Date.now() };
    } else {
      this.logEnabled = true;
      Cpu.startTimesDebug((m) => console.info(m));
      this.toast = { title: 'DEBUG', text: 'Logovanie zapnuté', id: Date.now() };
    }
    this.changed();
  }

  setRepr(key: ReprKey, rep: Representation): void {
    this.reprs = { ...this.reprs, [key]: rep };
    this.changed();
  }

  // ---------------------------------------------------------------- settings menu

  setIntByLevel(byLevel: boolean): void {
    this.session.setIntByLevel(byLevel);
    this.changed();
  }

  setMicrostep(v: boolean): void {
    this.session.setMicrostep(v);
    this.changed();
  }

  setAllowUpdateGUI(v: boolean): void {
    this.runtime.scheduler.allowUpdateGUI = v;
    this.changed();
  }

  setGuiInterval(ms: number): void {
    this.runtime.scheduler.guiUpdateInterval = ms;
    this.changed();
  }

  // ---------------------------------------------------------------- keyboard (scene filters + accelerators)

  /** Capture-phase keydown of the CPU window. */
  handleKeyDown(e: KeyboardEvent): void {
    const v = this.session.view;
    const acc = accelerator(e);
    const fire = (enabled: boolean, action: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      if (enabled) action();
    };

    // scene event filters: forward keys to the CPU while a program runs
    if (this.session.isExecuting()) {
      const arrow = arrowKey(e);
      if (arrow !== null) {
        this.session.keyboardInput(arrow);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    switch (acc) {
      case 'F4': return fire(v.parseEnabled, () => this.parse());
      case 'F5': return fire(v.startEnabled, () => this.start());
      case 'F7': return fire(v.stepEnabled, () => this.step());
      case 'F9': return fire(v.pauseEnabled, () => this.pause());
      case 'F10': return fire(v.stopEnabled, () => this.stop());
      case 'F12': return fire(v.resetEnabled, () => this.reset());
      case 'Ctrl+/': return fire(true, () => this.editor && blockComment(this.editor));
      case 'Ctrl+F9': return fire(true, () => this.fontSmaller());
      case 'Ctrl+F10': return fire(true, () => this.fontLarger());
      case 'Ctrl+F12': return fire(true, () => this.toggleLog());
      case 'Ctrl+N': return fire(true, () => void this.newFile());
      case 'Ctrl+O': return fire(true, () => void this.openFile());
      case 'Ctrl+S': return fire(true, () => void this.saveCode(false));
      case 'Ctrl+Shift+S': return fire(true, () => void this.saveCode(true));
    }

    if (this.session.isExecuting()) {
      const ch = typedCharacter(e);
      if (ch !== null) {
        this.session.keyboardInput({ kind: 'typed', character: ch });
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }
}

export const cpuController = new CpuWindowController();
