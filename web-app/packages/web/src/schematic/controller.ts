/**
 * Port of `App.SchematicControl.SchematicController` (non-visual part): current file, window title,
 * clear / load / save flows with the original prompts. Shared by the schematic window and the CPU
 * window (unsaved-schematic prompt on Koniec).
 */
import { schematic } from '@cpuemul/engine';
import type { DialogApi } from '../common/Dialogs';
import { getRuntime } from '../common/runtime';
import { FileApiError, readFile, saveLocally, writeFile } from '../files/api';
import { DraftAutosaver, type Draft } from '../files/drafts';
import { SCHX_FILTERS, showFileDialog } from '../files/FileDialog';

export const SCHEMATIC_WINDOW_TITLE = 'Simulátor - Schéma';

class SchematicControllerImpl {
  private currentFile: string | null = null;
  private title = SCHEMATIC_WINDOW_TITLE;
  private readonly listeners: (() => void)[] = [];
  user: string | null = null;
  readonly drafts = new DraftAutosaver(
    () => this.user,
    'schematic',
    (): Draft | null =>
      this.sheet.hasChanged()
        ? { content: schematic.saveScheme(this.sheet), currentFileName: this.currentFile, savedAt: Date.now() }
        : null,
  );

  get sheet() {
    return getRuntime().session.sheet;
  }

  getTitle(): string {
    return this.title;
  }

  hasCurrentFile(): boolean {
    return this.currentFile !== null;
  }

  getCurrentFile(): string | null {
    return this.currentFile;
  }

  subscribe(l: () => void): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private setTitle(t: string): void {
    this.title = t;
    for (const l of [...this.listeners]) l();
  }

  /** Toolbar `Nový` (Vymazať plochu). */
  async handleClearBoardAction(dialogs: DialogApi, container?: () => HTMLElement): Promise<void> {
    if (!(await this.continueIfUnsavedFile(dialogs, container))) return;
    if (this.sheet.isSimulationRunning()) this.sheet.powerOff();
    this.sheet.clearSheet();
    this.setTitle(SCHEMATIC_WINDOW_TITLE);
    this.currentFile = null;
    this.sheet.clearChange();
    await this.drafts.discard();
  }

  /** Toolbar `Otvoriť` (Načítať schému zo súboru). */
  async handleLoadAction(dialogs: DialogApi, container?: () => HTMLElement): Promise<void> {
    if (!(await this.continueIfUnsavedFile(dialogs, container))) return;
    const file = await showFileDialog(dialogs, {
      mode: 'open',
      title: 'Načítať schému...',
      filters: SCHX_FILTERS,
      initialFileName: null,
      container,
    });
    if (file === null) return;

    if (this.sheet.isSimulationRunning()) this.sheet.powerOff();

    let text: string;
    try {
      text = await readFile(file);
    } catch {
      return;
    }
    if (schematic.loadScheme(text, this.sheet)) {
      this.setTitle(SCHEMATIC_WINDOW_TITLE + ' - ' + file);
      this.currentFile = file;
      this.sheet.clearChange();
      await this.drafts.discard();
    }
  }

  /** `continueIfUnsavedFile` of the schematic window. */
  async continueIfUnsavedFile(dialogs: DialogApi, container?: () => HTMLElement): Promise<boolean> {
    if (!this.sheet.hasChanged()) return true;
    const buttons = [...(this.currentFile !== null ? ['Uložiť'] : []), 'Uložiť ako', 'Nie', 'Zrušiť'];
    const result = await dialogs.alert({
      kind: 'CONFIRMATION',
      title: 'Potvrdenie',
      header: 'Zmeny vo vašej schéme neboli uložené',
      content: 'Prajete si uložiť zmeny?',
      buttons,
    });
    if (result === 'Zrušiť') return false;
    if (result === 'Uložiť ako') return this.saveCircuit(true, dialogs, container);
    if (result === 'Uložiť') return this.saveCircuit(false, dialogs, container);
    if (result === 'Nie') await this.drafts.discard();
    return true;
  }

  /** Downloads the schematic (`.schx`, same bytes as Save) to the user's computer. */
  downloadCircuit(doc: Document): void {
    saveLocally(this.currentFile ?? 'schema.schx', schematic.saveScheme(this.sheet), doc);
  }

  /** `saveCircuit(saveAs)` - plain Save overwrites the current file silently (0.9.4). */
  async saveCircuit(saveAs: boolean, dialogs: DialogApi, container?: () => HTMLElement): Promise<boolean> {
    let file = saveAs ? null : this.currentFile;
    if (this.currentFile === null || saveAs) {
      file = await showFileDialog(dialogs, {
        mode: 'save',
        title: 'Uložiť schému' + (saveAs ? ' ako' : '') + '...',
        filters: SCHX_FILTERS,
        initialFileName: this.currentFile,
        container,
      });
    }
    if (file === null) return false;

    try {
      await writeFile(file, schematic.saveScheme(this.sheet));
    } catch (e) {
      await dialogs.alert({
        kind: 'ERROR',
        title: 'Chyba',
        header:
          e instanceof FileApiError && e.status === 413
            ? 'Súbor sa nepodarilo uložiť: prekročený limit úložiska.'
            : 'Súbor sa nepodarilo uložiť.',
        buttons: ['OK'],
      });
      return false;
    }
    this.sheet.clearChange();
    this.setTitle(SCHEMATIC_WINDOW_TITLE + ' - ' + file);
    this.currentFile = file;
    await this.drafts.discard();
    return true;
  }

  /** Restore of a browser draft (deviation D2). */
  restoreDraft(draft: Draft): void {
    if (schematic.loadScheme(draft.content, this.sheet)) {
      this.currentFile = draft.currentFileName;
      this.setTitle(SCHEMATIC_WINDOW_TITLE + (draft.currentFileName ? ' - ' + draft.currentFileName : ''));
      this.sheet.setChanged();
    }
  }
}

export const schematicController = new SchematicControllerImpl();
