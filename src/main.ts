import { Editor, FileView, Notice, Platform, Plugin, TFile, parseYaml, requestUrl, stringifyYaml } from 'obsidian';
import { TutorClient } from './ai';
import { DEMO_SOURCE, MAX_SELECTION, type Source } from './model';
import { DEFAULT_SETTINGS, loadSettings, validateSettings, type FlowSettings } from './settings';
import { LearningStore, type FileStore } from './storage';
import { ExplanationPopover, FlowSettingsTab, FlowSettingsModal, FlowView, VIEW_TYPE, type ExplanationAnchor } from './ui';
import { PronunciationClient, SpeechPlayer } from './pronunciation';
import { PublicAudioClient } from './public-audio';
import { MobileSelectionAction, type MobileReadingSelection } from './mobile-selection';

export default class EnglishFlowPlugin extends Plugin {
  declare settings: FlowSettings;
  tutor!: TutorClient;
  pronunciation!: PronunciationClient;
  speech!: SpeechPlayer;
  readingPopover: ExplanationPopover | null = null;
  private selectionTimer: number | undefined;
  private selecting = false;
  private suppressSelectionChange = false;
  private lastPresentedSelection = '';
  private readingSelection: Source | null = null;
  private readingAnchor: ExplanationAnchor | null = null;
  private mobileSelectionAction: MobileSelectionAction | null = null;
  async onload(): Promise<void> {
    let validSettings = true;
    try { this.settings = loadSettings(await this.loadData()); }
    catch { validSettings = false; this.settings = loadSettings(DEFAULT_SETTINGS); new Notice('英语学习配置无效，已使用临时默认值。旧设置已保留，请在设置中核对学习目录后保存。', 10_000); }
    // Device identity and secret references are local configuration, never learning records.
    if (validSettings) await this.saveData(this.settings);
    this.tutor = new TutorClient(async request => {
      const response = await requestUrl({ ...request, throw: false });
      return { status: response.status, text: response.text };
    }, () => this.settings, name => this.app.secretStorage.getSecret(name));
    this.pronunciation = new PronunciationClient(async url => {
      const response = await requestUrl({ url, method: 'GET', throw: false });
      return { status: response.status, text: response.text };
    });
    this.speech = new SpeechPlayer(new PublicAudioClient(async url => {
      const response = await requestUrl({ url, method: 'GET', headers: { Accept: 'audio/mpeg' }, throw: false });
      const mime = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
      return { status: response.status, mime, data: response.arrayBuffer };
    }));
    this.registerView(VIEW_TYPE, leaf => new FlowView(leaf, this));
    this.addSettingTab(new FlowSettingsTab(this.app, this));
    this.addRibbonIcon('languages', '英语学习', () => { void this.openView('review').catch(e => this.report(e)); });
    this.addCommand({ id: 'explain-selection', name: '讲解选中的英语', hotkeys: [{ modifiers: ['Mod'], key: 'r' }], checkCallback: checking => {
      if (checking) return true;
      this.cancelAutoExplain();
      const source = this.selectedSource() ?? this.readingSelection;
      if (!source || source.path !== this.app.workspace.getActiveFile()?.path) { new Notice(Platform.isMobile ? '请先长按选中英语，再点「讲解选文」或执行本命令。' : '请先选中要讲解的单词、句子或段落，再按快捷键。'); return true; }
      void this.explainSource(source).catch(e => this.report(e));
      return true;
    } });
    for (const [id, name, tab] of [['daily-review', '每日复习', 'review'], ['expression-library', '我的表达库', 'library'], ['transfer-practice', '迁移练习', 'practice']] as const) {
      this.addCommand({ id, name, callback: () => { void this.openView(tab).catch(e => this.report(e)); } });
    }
    this.addCommand({ id: 'demo', name: '体验离线示例', callback: () => { void this.openDemo().catch(e => this.report(e)); } });
    this.addCommand({ id: 'settings', name: '打开英语学习设置', callback: () => this.openSettings() });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      if (!editor.getSelection().trim()) return;
      menu.addItem(item => item.setTitle('讲解选中的英语').setIcon('languages').onClick(() => {
        void this.explainSelection(editor, info.file?.path ?? '').catch(e => this.report(e));
      }));
    }));
    const dirty = (path: string) => {
      if (!path.startsWith(`${this.settings.folder}/`)) return;
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => { if (leaf.view instanceof FlowView) leaf.view.markDirty(); });
      this.readingPopover?.panel.markDirty();
    };
    this.registerEvent(this.app.vault.on('create', file => dirty(file.path)));
    this.registerEvent(this.app.vault.on('modify', file => dirty(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => dirty(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { dirty(file.path); dirty(oldPath); }));
    const foreground = () => {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
        if (leaf.view instanceof FlowView) void leaf.view.onForeground().catch(e => this.report(e));
      });
      if (this.readingPopover) void this.readingPopover.panel.onForeground().catch(e => this.report(e));
    };
    this.registerDomEvent(window, 'focus', foreground);
    this.registerDomEvent(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') foreground(); });
    const selected = (event: MouseEvent) => {
      this.selecting = false;
      this.cancelAutoExplain();
      this.suppressSelectionChange = event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey;
      if (this.suppressSelectionChange || !this.settings.autoExplain) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.ef-popover, input, textarea, button, .view-header, .inline-title')) { this.suppressSelectionChange = true; return; }
      if (target) this.queueAutoExplain(target);
    };
    this.registerDomEvent(document, 'mouseup', selected);
    this.registerDomEvent(document, 'pointerup', selected);
    this.registerDomEvent(document, 'selectionchange', () => {
      if (this.selecting || this.suppressSelectionChange || this.readingPopover || this.selectionTimer !== undefined || !this.settings.autoExplain) return;
      const view = this.app.workspace.getActiveViewOfType(FileView), selection = document.getSelection();
      if (!view || !selection?.anchorNode || !view.containerEl.contains(selection.anchorNode)) return;
      const target = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      if (target?.closest('input, textarea, button, .view-header, .inline-title, .ef-popover')) return;
      this.queueAutoExplain(view.containerEl, false);
    });
    this.registerDomEvent(document, 'keydown', () => { this.suppressSelectionChange = true; this.cancelAutoExplain(); });
    this.registerDomEvent(document, 'pointerdown', event => { this.selecting = true; this.suppressSelectionChange = event.metaKey || event.ctrlKey || event.altKey; this.cancelAutoExplain(); });
    this.registerDomEvent(document, 'pointercancel', () => { this.selecting = false; this.cancelAutoExplain(); });
    this.registerDomEvent(document, 'wheel', () => this.cancelAutoExplain(), { capture: true, passive: true });
    this.registerEvent(this.app.workspace.on('file-open', () => { this.cancelAutoExplain(); this.mobileSelectionAction?.clear(); this.readingSelection = null; this.readingAnchor = null; this.readingPopover?.close(); }));
    if (Platform.isMobile) this.mobileSelectionAction = new MobileSelectionAction(document, () => this.captureMobileSelection(), ({ source, anchor }) => {
      if (source.path !== this.app.workspace.getActiveFile()?.path) return;
      void this.explainSource(source, anchor).catch(e => this.report(e));
    });
  }
  onunload(): void { this.cancelAutoExplain(); this.mobileSelectionAction?.destroy(); this.mobileSelectionAction = null; this.readingPopover?.close(); this.speech?.stop(); }
  private captureMobileSelection(): MobileReadingSelection | null {
    const view = this.app.workspace.getActiveViewOfType(FileView);
    if (!view?.file || this.readingPopover) return null;
    const doc = view.containerEl.ownerDocument, selection = doc.getSelection();
    const excluded = 'input, textarea, button, .view-header, .inline-title, .ef-popover, .modal, .modal-container';
    const target = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection?.anchorNode?.parentElement;
    if (doc.querySelector('.modal-container, .modal') || doc.activeElement?.closest(excluded) || target?.closest(excluded)) return null;
    if (selection?.toString().trim() && selection.anchorNode && !view.containerEl.contains(selection.anchorNode)) return null;
    const source = this.selectedSource();
    if (!source || !/[a-z]/i.test(source.quote)) { this.readingSelection = null; this.readingAnchor = null; return null; }
    this.readingSelection = source;
    return { source, anchor: this.selectionAnchor() };
  }
  private cancelAutoExplain(): void { if (this.selectionTimer !== undefined) window.clearTimeout(this.selectionTimer); this.selectionTimer = undefined; }
  private queueAutoExplain(target: Node, explicitSelection = true): void {
    this.cancelAutoExplain();
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = undefined;
      // CodeMirror, native selections, and the active pane can settle after mouseup.
      const view = this.app.workspace.getActiveViewOfType(FileView);
      if (!this.settings.autoExplain || !view || !view.containerEl.contains(target)) return;
      const source = this.selectedSource();
      this.readingSelection = source;
      if (!source || !/[a-z]/i.test(source.quote) || this.app.workspace.getActiveFile()?.path !== source.path) return;
      if (!explicitSelection && JSON.stringify([source.path, source.quote]) === this.lastPresentedSelection) return;
      void this.explainSource(source, this.selectionAnchor()).catch(e => this.report(e));
    }, 180);
  }
  private selectionAnchor(): ExplanationAnchor {
    const view = this.app.workspace.getActiveViewOfType(FileView);
    const doc = view?.containerEl.ownerDocument ?? document;
    const selection = doc.defaultView?.getSelection();
    if (selection?.rangeCount && selection.anchorNode && view?.containerEl.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0).cloneRange();
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height || rect.bottom || rect.left) {
        let lastRect = rect;
        this.readingAnchor = { document: doc, rect: () => {
          const current = range.getBoundingClientRect();
          if (current.width || current.height || current.bottom || current.left) lastRect = current;
          return lastRect;
        } };
        return this.readingAnchor;
      }
    }
    if (this.readingAnchor?.document === doc) return this.readingAnchor;
    return { document: doc, rect: () => {
      const box = view?.containerEl.getBoundingClientRect();
      const left = (box?.left ?? 0) + 24, top = (box?.top ?? 0) + 64;
      return { left, right: left, top, bottom: top + 20 };
    } };
  }
  private selectedSource(): Source | null {
    const view = this.app.workspace.getActiveViewOfType(FileView);
    if (!view?.file) return null;
    const info = this.app.workspace.activeEditor;
    if (info?.file?.path === view.file.path && info.editor?.getSelection().trim()) {
      if (info.editor.getSelection().trim().length > MAX_SELECTION) { this.readingSelection = null; return null; }
      return this.editorSource(info.editor, view.file.path);
    }
    const doc = view.containerEl.ownerDocument, selection = doc.defaultView?.getSelection();
    const quote = selection?.toString().trim() ?? '';
    if (quote.length > MAX_SELECTION) { this.readingSelection = null; return null; }
    if (!quote || !selection?.anchorNode || !view.containerEl.contains(selection.anchorNode)) return null;
    return { path: view.file.path, quote, context: '', line: 0 };
  }
  report(error: unknown): void { new Notice(error instanceof Error ? error.message : '操作失败，请重试。', 8000); }
  store(demo = false): LearningStore {
    const vault = this.app.vault;
    const files: FileStore = {
      paths: () => vault.getMarkdownFiles().map(file => file.path),
      exists: path => vault.getAbstractFileByPath(path) !== null,
      read: async path => { const file = vault.getFileByPath(path); if (!file) throw new Error('学习文件不存在。'); return vault.read(file); },
      mkdir: async path => { await vault.createFolder(path); },
      create: async (path, text) => { await vault.create(path, text); }
    };
    return new LearningStore(files, { parse: parseYaml, stringify: stringifyYaml }, `${this.settings.folder}${demo ? '/Demo' : ''}`, this.settings.deviceId);
  }
  async configure(settings: FlowSettings): Promise<void> {
    this.cancelAutoExplain();
    const next = validateSettings(settings);
    await this.saveData(next);
    this.settings = next;
    this.tutor.clearCache();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof FlowView) await leaf.view.reset();
    if (this.readingPopover) await this.readingPopover.panel.reset();
  }
  openSettings(): void { new FlowSettingsModal(this.app, this).open(); }
  async openView(tab: 'explain' | 'library' | 'practice' | 'review', preserveDemo = false): Promise<FlowView> {
    this.readingPopover?.close();
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = (!Platform.isMobile ? this.app.workspace.getRightLeaf(false) : null) ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await leaf.loadIfDeferred();
    if (!(leaf.view instanceof FlowView)) throw new Error('无法打开英语学习面板。');
    await this.app.workspace.revealLeaf(leaf);
    if (!preserveDemo) leaf.view.useLiveMode();
    await leaf.view.navigate(tab);
    return leaf.view;
  }
  async explainSelection(editor: Editor, path: string): Promise<void> {
    await this.explainSource(this.editorSource(editor, path));
  }
  private editorSource(editor: Editor, path: string): Source {
    const quote = editor.getSelection().trim();
    if (!quote || quote.length > MAX_SELECTION) throw new Error('请先选中 1～8000 字符的英语内容，再执行讲解。');
    const start = editor.getCursor('from'), end = editor.getCursor('to');
    const lastLine = Math.min(editor.lineCount() - 1, end.line + 2);
    const flank = quote.length <= 120 ? 900 : 600;
    const before = editor.getRange({ line: Math.max(0, start.line - 2), ch: 0 }, start).slice(-flank);
    const after = editor.getRange(end, { line: lastLine, ch: editor.getLine(lastLine).length }).slice(0, flank);
    const context = `前文：\n${before}\n后文：\n${after}`;
    return { path, quote, line: start.line, context };
  }
  private openReadingPopover(source: Source, anchor: ExplanationAnchor): ExplanationPopover {
    this.cancelAutoExplain();
    this.mobileSelectionAction?.clear();
    this.readingPopover?.close();
    const popover = new ExplanationPopover(this, anchor, source, () => { if (this.readingPopover === popover) this.readingPopover = null; });
    this.readingPopover = popover;
    popover.open();
    return popover;
  }
  async explainSource(source: Source, anchor = this.selectionAnchor()): Promise<void> {
    this.lastPresentedSelection = JSON.stringify([source.path, source.quote]);
    await this.openReadingPopover(source, anchor).panel.explain(source);
  }
  async openDemo(): Promise<void> {
    const source = { path: '', line: 0, quote: DEMO_SOURCE, context: '' };
    await this.openReadingPopover(source, this.selectionAnchor()).panel.showDemo(source);
  }
  async openNote(path: string, line = 0): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('原文或卡片已移动、删除。卡片中仍保留当时的原句。');
    await this.app.workspace.getLeaf('tab').openFile(file, { eState: { line } });
  }
  async openSource(source: Source): Promise<void> {
    if (!source.path) { new Notice('这是离线示例，没有来源笔记。'); return; }
    const file = this.app.vault.getFileByPath(source.path);
    if (!file) throw new Error('原文已移动或删除。卡片中仍保留当时的原句。');
    if (/\.pdf$/i.test(file.path)) { await this.openNote(file.path); return; }
    const content = await this.app.vault.read(file), offset = content.indexOf(source.quote);
    const line = offset >= 0 ? content.slice(0, offset).split('\n').length - 1 : source.line;
    await this.openNote(source.path, line);
    if (offset < 0) new Notice('原文内容已有变化，已打开保存时的位置。');
  }
}
