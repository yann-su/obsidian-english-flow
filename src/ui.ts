import { App, ButtonComponent, ItemView, Modal, Notice, PluginSettingTab, SecretComponent, Setting, WorkspaceLeaf, setIcon } from 'obsidian';
import type EnglishFlowPlugin from './main';
import { DEMO_ANALYSIS, MAX_ANSWER, selectionKind, type Analysis, type Expression, type Feedback, type Rating, type Source } from './model';
import { dueTasks, nextMemory, statistics, type ReviewTask } from './scheduler';
import { type Snapshot } from './storage';
import type { FlowSettings } from './settings';
import type { Accent } from './public-audio';

export const VIEW_TYPE = 'english-reading-flow-view';
export interface ExplanationAnchor {
  document: Document;
  rect: () => Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
}
type Tab = 'explain' | 'library' | 'practice' | 'review';
interface PracticeDraft { answer: string; feedback: Feedback | null; revealed: boolean; saved: boolean; saving: boolean }
function p(el: HTMLElement, text: string, cls = ''): HTMLElement { return el.createEl('p', { text, cls }); }
function section(el: HTMLElement, title: string, text: string): void { el.createEl('h4', { text: title }); p(el, text, 'ef-prose'); }
function directMeaning(text: string): string {
  return text.replace(/^(?:这句话|这段话|这个单词|这个词|这个短语|这个表达)(?:的意思是|意思是|意为|表示)[：:，,\s]*/, '').trim() || text;
}
function button(el: HTMLElement, label: string, action: () => Promise<void> | void, primary = false): ButtonComponent {
  const component = new ButtonComponent(el).setButtonText(label);
  if (primary) component.setCta();
  component.onClick(async () => {
    if (component.buttonEl.disabled) return;
    component.setDisabled(true);
    try { await action(); }
    catch (error) { new Notice(error instanceof Error ? error.message : '操作失败，请重试。', 8000); }
    finally { if (component.buttonEl.isConnected) component.setDisabled(false); }
  });
  return component;
}
function listenButton(el: HTMLElement, plugin: EnglishFlowPlugin, text: string, label: string, rate = .95, accent: Accent = 'us'): void {
  const control = new ButtonComponent(el);
  const target = control.buttonEl;
  target.addClass('ef-audio-button');
  let active = false;
  const paint = (state: 'idle' | 'loading' | 'playing' | 'ended') => {
    active = state === 'loading' || state === 'playing';
    const caption = state === 'loading' ? '加载中' : state === 'playing' ? '停止' : state === 'ended' ? `再听${label.replace(/^听|^朗读/, '')}` : label;
    control.setButtonText(caption);
    const icon = el.ownerDocument.createElement('span'); icon.classList.add('ef-audio-icon'); icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, active ? 'square' : 'volume-2'); target.prepend(icon);
    target.setAttribute('aria-label', state === 'playing' ? `停止${label}` : caption);
    target.setAttribute('aria-pressed', String(active)); target.dataset.playback = state;
    target.title = active ? '再次点击停止播放' : label;
  };
  paint('idle');
  control.onClick(() => {
    if (active) { plugin.speech.stop(); return; }
    void plugin.speech.play(text, el.ownerDocument, { rate, accent, changed: state => { if (target.isConnected) paint(state); } }).catch(e => plugin.report(e));
  });
}
async function pronunciationRow(el: HTMLElement, plugin: EnglishFlowPlugin, text: string, layout: () => void): Promise<void> {
  el.addClass('ef-pronunciation');
  const placeholder = el.createEl('span', { text: '音标加载中', cls: 'ef-phonetic ef-phonetic-pending' });
  listenButton(el, plugin, text, '美音', 1, 'us');
  listenButton(el, plugin, text, '英音', 1, 'uk');
  const result = await plugin.pronunciation.lookup(text);
  if (!el.isConnected) return;
  if (!result.entries.length) {
    placeholder.setText('音标暂不可用');
  } else {
    placeholder.setText(result.entries.find(e => e.phonetic)?.phonetic ?? '');
    placeholder.removeClass('ef-phonetic-pending'); placeholder.setAttribute('lang', 'en');
    if (result.sourceUrl) {
      const link = el.createEl('a', { text: '出处', cls: 'ef-pronunciation-source', attr: { href: result.sourceUrl, 'aria-label': '查看词典发音出处', target: '_blank', rel: 'noopener noreferrer' } });
      link.title = '音标出处 · Free Dictionary API / Wiktionary；发音默认有道';
    }
  }
  layout();
}
function textarea(el: HTMLElement, label: string, value: string, change: (value: string) => void): HTMLTextAreaElement {
  const container = el.createEl('label', { cls: 'ef-input-label', text: label });
  const input = container.createEl('textarea', { attr: { rows: '4', maxlength: String(MAX_ANSWER), placeholder: '先尝试用自己的话表达……' } });
  input.value = value;
  input.addEventListener('input', () => change(input.value));
  return input;
}

export class LearningPanel {
  demo = false;
  private tab: Tab = 'explain';
  private snapshot: Snapshot = { cards: [], cardPaths: {}, records: [], warnings: [] };
  private source: Source | null = null;
  private analysis: Analysis | null = null;
  private analysisOrigin: 'demo' | 'ai' = 'ai';
  private pending = false;
  private epoch = 0;
  private error = '';
  private dirty = false;
  private search = '';
  private practiceCardId = '';
  private drafts = new Map<string, PracticeDraft>();
  private reviewTask: ReviewTask | null = null;
  private reviewAnswer = '';
  private reviewRevealed = false;
  private reviewForgot = false;
  private reviewRevision = '';
  private savingReview = false;
  private loadingTimer: number | undefined;
  private startedAt = 0;
  private elapsedMs: number | null = null;
  private fromCache = false;
  private collected = new Set<Expression>();
  constructor(readonly contentEl: HTMLElement, private plugin: EnglishFlowPlugin, private presentation: 'sidebar' | 'popover' = 'sidebar', private onLayout: () => void = () => {}) {}
  async onOpen(): Promise<void> { await this.refresh(); }
  async onClose(): Promise<void> { this.epoch++; this.stopTimer(); this.plugin.speech.stop(); }
  private stopTimer(): void {
    if (this.loadingTimer !== undefined) window.clearInterval(this.loadingTimer);
    this.loadingTimer = undefined;
  }
  markDirty(): void {
    this.dirty = true;
    const banner = this.contentEl.querySelector<HTMLElement>('.ef-dirty');
    if (banner) banner.hidden = false;
  }
  useLiveMode(): void {
    if (!this.demo) return;
    this.demo = false; this.source = null; this.analysis = null; this.analysisOrigin = 'ai';
    this.practiceCardId = ''; this.clearReview();
  }
  async onForeground(): Promise<void> {
    if (this.pending || this.savingReview || this.tab !== 'review') return;
    if (this.reviewAnswer || this.reviewRevealed) { this.markDirty(); return; }
    this.clearReview(); await this.refresh();
  }
  async reset(): Promise<void> {
    this.epoch++; this.stopTimer(); this.pending = false; this.analysis = null; this.source = null; this.elapsedMs = null;
    this.clearReview(); this.practiceCardId = ''; this.error = ''; this.drafts.clear();
    await this.refresh();
  }
  async navigate(tab: Tab): Promise<void> {
    this.plugin.speech.stop();
    if (this.pending) { new Notice('正在等待 AI 返回，请稍候。'); return; }
    this.tab = tab; this.error = '';
    this.clearReview();
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    if (this.tab !== 'explain') this.snapshot = await this.plugin.store(this.demo).load();
    this.dirty = false;
    this.render();
  }
  async showDemo(source: Source): Promise<void> {
    if (this.pending) { new Notice('正在等待 AI 返回，请稍候。'); return; }
    this.demo = true; this.tab = 'explain'; this.source = source;
    this.analysis = DEMO_ANALYSIS; this.analysisOrigin = 'demo'; this.error = '';
    this.elapsedMs = null;
    this.clearReview(); await this.refresh();
  }
  async explain(source: Source): Promise<void> {
    if (this.pending) { new Notice('已有讲解请求正在进行，请稍候。'); return; }
    this.demo = false; this.tab = 'explain'; this.source = source;
    this.analysis = null; this.analysisOrigin = 'ai'; this.pending = true; this.error = '';
    this.fromCache = this.plugin.tutor.isCached(source); this.elapsedMs = null; this.startedAt = Date.now();
    const epoch = ++this.epoch;
    this.render();
    this.stopTimer();
    this.loadingTimer = window.setInterval(() => {
      const elapsed = this.contentEl.querySelector<HTMLElement>('.ef-loading-time');
      if (elapsed) elapsed.setText(`已等待 ${Math.floor((Date.now() - this.startedAt) / 1000)} 秒`);
    }, 1000);
    try {
      const result = await this.plugin.tutor.explain(source);
      if (epoch !== this.epoch) return;
      this.analysis = result;
      this.elapsedMs = Date.now() - this.startedAt;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error = error instanceof Error ? error.message : '讲解失败，请重试。';
    } finally { if (epoch === this.epoch) { this.stopTimer(); this.pending = false; this.render(); } }
  }
  private render(): void {
    const el = this.contentEl; el.empty(); el.addClass('ef-view');
    const compact = this.presentation === 'popover' && !this.demo;
    if (compact && this.tab !== 'explain') {
      const top = el.createDiv({ cls: 'ef-heading' });
      button(top, '返回讲解', () => this.navigate('explain')).setDisabled(this.pending);
    }
    if (!compact) {
    const top = el.createDiv({ cls: 'ef-heading' });
    top.createEl('h2', { text: '英语学习' });
    p(top, this.demo ? '离线示例 · 固定讲解 · 独立数据' : '阅读、表达与每日复习', 'ef-muted');
    const nav = el.createDiv({ cls: 'ef-actions ef-nav' });
    for (const [tab, label] of [['explain', '阅读讲解'], ['library', '表达库'], ['practice', '迁移练习'], ['review', '每日复习']] as const) {
      const control = button(nav, label, () => this.navigate(tab));
      control.buttonEl.setAttribute('aria-pressed', String(this.tab === tab));
      control.setDisabled(this.pending);
    }
    const tools = el.createDiv({ cls: 'ef-actions' });
    button(tools, '设置', () => this.plugin.openSettings()).setDisabled(this.pending);
    button(tools, '刷新记录', async () => { this.clearReview(); await this.refresh(); }).setDisabled(this.pending);
    if (this.demo) button(tools, '退出示例', async () => { this.useLiveMode(); await this.navigate('review'); }).setDisabled(this.pending);
    else button(tools, '离线示例', () => this.plugin.openDemo()).setDisabled(this.pending);
    const dirty = el.createDiv({ cls: 'ef-dirty ef-actions' }); dirty.hidden = !this.dirty;
    p(dirty, '学习记录有变化，可点击上方「刷新记录」。', 'ef-muted');
    }
    if (this.error) p(el, this.error, 'ef-error').setAttribute('role', 'alert');
    if (this.snapshot.warnings.length) {
      const warnings = el.createEl('details', { cls: 'ef-warning' });
      warnings.createEl('summary', { text: `${this.snapshot.warnings.length} 个学习文件需要检查` });
      for (const warning of this.snapshot.warnings) p(warnings, warning);
    }
    const body = el.createDiv({ cls: 'ef-body' });
    if (this.tab === 'explain') {
      if (compact) this.renderReadingCard(body);
      else this.renderExplain(body);
    }
    else if (this.tab === 'library') this.renderLibrary(body);
    else if (this.tab === 'practice') this.renderPractice(body);
    else this.renderReview(body);
    this.onLayout();
  }
  private renderOriginal(el: HTMLElement): void {
    if (!this.source) return;
    const original = el.createEl('details');
    original.createEl('summary', { text: '查看原句与上下文' });
    p(original, this.source.quote, 'ef-quote');
    if (this.source.context) section(original, '附近上下文', this.source.context);
  }
  private readingActions(el: HTMLElement, item: Expression): void {
    const actions = el.createDiv({ cls: 'ef-card-actions' });
    const saved = this.collected.has(item);
    button(actions, saved ? '已收藏' : '收藏表达', () => this.collect(item, false)).setDisabled(saved);
    const practice = button(actions, '练一下 →', () => this.collect(item, true));
    practice.buttonEl.setAttribute('aria-label', '收藏并练习');
    practice.buttonEl.title = '收藏这个表达，并换一个情境练习';
  }
  private readingExample(el: HTMLElement, item: Expression): void {
    const usage = el.createDiv({ cls: 'ef-card-usage' });
    p(usage, item.pattern);
    const example = el.createDiv({ cls: 'ef-card-example' });
    const toolbar = example.createDiv({ cls: 'ef-example-toolbar' });
    toolbar.createEl('span', { text: '例句', cls: 'ef-card-label' });
    listenButton(toolbar, this.plugin, item.example, '朗读例句');
    listenButton(toolbar, this.plugin, item.example, '慢速', .75);
    p(example, item.example).setAttribute('lang', 'en');
  }
  private readingContext(el: HTMLElement): void {
    if (!this.source) return;
    const details = el.createEl('details', { cls: 'ef-card-details ef-card-context' });
    details.createEl('summary', { text: '原文与上下文' });
    p(details, this.source.quote, 'ef-quote').setAttribute('lang', 'en');
    if (this.source.context) p(details, this.source.context, 'ef-card-context-text');
  }
  private renderTranslation(el: HTMLElement): void {
    if (!this.analysis) return;
    const translation = el.createDiv({ cls: 'ef-card-translation' });
    translation.createEl('span', { text: '中文翻译', cls: 'ef-card-label' });
    p(translation, this.analysis.translation, 'ef-card-translation-text').setAttribute('lang', 'zh-CN');
    if (this.analysis.translationChunks?.length) {
      const chunks = el.createEl('details', { cls: 'ef-card-details ef-translation-chunks' });
      chunks.createEl('summary', { text: '怎么译出来的' });
      for (const item of this.analysis.translationChunks) {
        const row = chunks.createDiv({ cls: 'ef-translation-chunk' });
        p(row, item.english, 'ef-translation-english').setAttribute('lang', 'en');
        p(row, item.chinese, 'ef-translation-chinese').setAttribute('lang', 'zh-CN');
        if (item.note) p(row, item.note, 'ef-translation-note');
      }
    }
    const explanation = el.createEl('details', { cls: 'ef-card-details ef-card-explanation' });
    explanation.createEl('summary', { text: '意思讲解' });
    p(explanation, directMeaning(this.analysis.summary), 'ef-card-summary');
  }
  private renderReadingCard(el: HTMLElement): void {
    el.addClass('ef-reading-card');
    if (this.pending) {
      const loading = el.createDiv({ cls: 'ef-card-loading' });
      loading.createEl('span', { cls: 'ef-card-spinner', attr: { 'aria-hidden': 'true' } });
      p(loading, '正在理解这段内容…').setAttribute('role', 'status');
      p(el, '已等待 0 秒', 'ef-loading-time ef-card-label').setAttribute('aria-hidden', 'true');
      return;
    }
    if (!this.analysis) {
      if (!this.error) p(el, '选中英语，获取贴合原文的讲解。', 'ef-muted');
      const actions = el.createDiv({ cls: 'ef-card-actions' });
      if (this.source) button(actions, '重新讲解', () => this.explain(this.source!), true);
      button(actions, 'AI 设置', () => this.plugin.openSettings());
      return;
    }
    const kind = this.source ? selectionKind(this.source.quote) : 'passage';
    const first = this.analysis.expressions[0]!;
    if (kind === 'word') {
      const meaning = el.createDiv({ cls: 'ef-card-meaning' });
      p(meaning, directMeaning(first.meaning), 'ef-card-definition');
      this.readingExample(el, first);
      this.readingContext(el);
      this.readingActions(el, first);
      return;
    }
    this.renderTranslation(el);
    const paraphrase = el.createEl('details', { cls: 'ef-card-details' });
    paraphrase.createEl('summary', { text: '换成简单英语' });
    p(paraphrase, this.analysis.simpleEnglish).setAttribute('lang', 'en');
    const vocabulary = el.createDiv({ cls: 'ef-card-vocabulary' });
    vocabulary.createEl('span', { text: kind === 'sentence' ? '重点词汇' : '实用表达', cls: 'ef-card-label' });
    for (const item of this.analysis.expressions) {
      const term = vocabulary.createEl('details', { cls: 'ef-card-term' });
      const summary = term.createEl('summary');
      summary.createEl('span', { text: item.phrase, cls: 'ef-card-term-name', attr: { lang: 'en' } });
      summary.createEl('span', { text: item.meaning, cls: 'ef-card-term-meaning' });
      const pronunciation = term.createDiv();
      let loaded = false;
      term.addEventListener('toggle', () => {
        if (!term.open || loaded) return;
        loaded = true;
        void pronunciationRow(pronunciation, this.plugin, item.phrase, this.onLayout);
      });
      this.readingExample(term, item);
      this.readingActions(term, item);
    }
    if (this.analysis.grammar.length) {
      const grammar = el.createEl('details', { cls: 'ef-card-details' });
      grammar.createEl('summary', { text: '句子结构' });
      for (const item of this.analysis.grammar) { p(grammar, item.sentence, 'ef-quote'); p(grammar, item.explanation); p(grammar, item.pattern, 'ef-muted'); }
    }
    this.readingContext(el);
    const hint = p(el, '点开词汇，可以查看例句、收藏或练习', 'ef-card-hint');
    hint.setAttribute('aria-hidden', 'true');
  }
  private renderExplain(el: HTMLElement): void {
    if (this.presentation !== 'popover') this.renderOriginal(el);
    if (this.pending) {
      p(el, '正在获取讲解……', 'ef-muted').setAttribute('role', 'status');
      p(el, '已等待 0 秒', 'ef-muted ef-loading-time').setAttribute('aria-hidden', 'true');
      return;
    }
    if (!this.analysis) {
      section(el, '从正在读的内容开始', '选中一个词、句子或段落，按 ⌘R（Windows/Linux 为 Ctrl+R），讲解会在选词旁展开。也可以右键或使用命令面板。');
      p(el, '讲解会发送选中内容及附近最多 6000 字符到你配置的 AI 服务。收藏后的原句和练习保存在学习目录。', 'ef-muted');
      const actions = el.createDiv({ cls: 'ef-actions' });
      if (this.source) button(actions, '重试讲解', () => this.explain(this.source!), true);
      button(actions, '配置 AI 服务', () => this.plugin.openSettings());
      button(actions, '先体验离线示例', () => this.plugin.openDemo());
      return;
    }
    if (this.elapsedMs !== null) p(el, this.fromCache ? '已复用本次会话的讲解，无需再次请求' : `本次讲解用时 ${(this.elapsedMs / 1000).toFixed(1)} 秒`, 'ef-muted');
    const kind = this.source ? selectionKind(this.source.quote) : 'passage';
    if (kind === 'word') section(el, '这个单词的意思', this.analysis.summary);
    else this.renderTranslation(el);
    if (kind !== 'word') {
      const simple = el.createEl('details'); simple.createEl('summary', { text: '换成简单英语' }); p(simple, this.analysis.simpleEnglish, 'ef-prose');
    }
    el.createEl('h3', { text: kind === 'word' ? '用法与例句' : kind === 'sentence' ? '句中重点词汇' : '值得收下的表达' });
    const expressions = kind === 'word' ? this.analysis.expressions.slice(0, 1) : this.analysis.expressions;
    for (const item of expressions) {
      const row = el.createEl('article', { cls: 'ef-expression' });
      if (kind !== 'word') { row.createEl('h4', { text: item.phrase }); p(row, item.meaning); }
      p(row, item.pattern, 'ef-muted'); p(row, item.example, 'ef-example');
      const actions = row.createDiv({ cls: 'ef-actions' });
      button(actions, '收藏表达', () => this.collect(item, false));
      button(actions, '收藏并练习', () => this.collect(item, true), true);
    }
    if (kind !== 'word' && this.analysis.grammar.length) {
      const grammar = el.createEl('details'); grammar.createEl('summary', { text: '展开难句与语法讲解' });
      for (const item of this.analysis.grammar) { p(grammar, item.sentence, 'ef-quote'); p(grammar, item.explanation, 'ef-prose'); p(grammar, item.pattern, 'ef-example'); }
    }
    if (this.presentation === 'popover') this.renderOriginal(el);
  }
  private async collect(item: Expression, practice: boolean): Promise<void> {
    if (!this.source) return;
    this.plugin.speech.stop();
    const result = await this.plugin.store(this.demo).saveExpression(item, this.source, this.analysisOrigin);
    this.collected.add(item);
    new Notice(result.created ? '已收藏，原句也已保存。' : '表达已在收藏中，已复用原卡片。');
    if (practice) { this.practiceCardId = result.card.id; this.tab = 'practice'; }
    this.snapshot = await this.plugin.store(this.demo).load();
    this.render();
  }
  private renderLibrary(el: HTMLElement): void {
    p(el, `已收藏 ${this.snapshot.cards.length} 个表达。理解回忆与表达回忆分别安排。`, 'ef-muted');
    if (!this.snapshot.cards.length) { p(el, '从阅读讲解中收藏一个想掌握的表达，就可以开始练习和复习。'); return; }
    const label = el.createEl('label', { cls: 'ef-input-label', text: '搜索表达或含义' });
    const input = label.createEl('input', { attr: { type: 'search', placeholder: '输入关键词' } }); input.value = this.search;
    const list = el.createDiv();
    const draw = () => {
      list.empty();
      const query = this.search.toLowerCase().trim();
      const cards = this.snapshot.cards.filter(c => `${c.phrase} ${c.meaning}`.toLowerCase().includes(query));
      for (const item of cards.slice(0, 50)) {
        const row = list.createEl('article', { cls: 'ef-expression' });
        row.createEl('h4', { text: item.phrase }); p(row, item.meaning);
        const actions = row.createDiv({ cls: 'ef-actions' });
        button(actions, '迁移练习', async () => { this.practiceCardId = item.id; await this.navigate('practice'); }, true);
        button(actions, '查看卡片', () => this.plugin.openNote(this.snapshot.cardPaths[item.id]!));
        if (item.source.path) button(actions, '回到原文', () => this.plugin.openSource(item.source));
      }
      if (!cards.length) p(list, '没有匹配的表达。');
      if (cards.length > 50) p(list, `显示前 50 个，共 ${cards.length} 个；输入更多关键词缩小范围。`, 'ef-muted');
    };
    input.addEventListener('input', () => { this.search = input.value; draw(); }); draw();
  }
  private renderPractice(el: HTMLElement): void {
    if (!this.snapshot.cards.length) { p(el, '先在阅读讲解中收藏一个表达，再来用它说自己的话。'); return; }
    if (!this.snapshot.cards.some(c => c.id === this.practiceCardId)) this.practiceCardId = this.snapshot.cards[0]!.id;
    const label = el.createEl('label', { cls: 'ef-input-label', text: '练习哪个表达' });
    const select = label.createEl('select');
    for (const item of this.snapshot.cards) select.createEl('option', { text: item.phrase, value: item.id });
    select.value = this.practiceCardId; select.disabled = this.pending;
    select.addEventListener('change', () => { this.practiceCardId = select.value; this.render(); });
    const item = this.snapshot.cards.find(c => c.id === this.practiceCardId)!;
    let draft = this.drafts.get(item.id);
    if (!draft) { draft = { answer: '', feedback: null, revealed: false, saved: false, saving: false }; this.drafts.set(item.id, draft); }
    const current = draft;
    section(el, item.phrase, item.meaning); p(el, item.pattern, 'ef-muted');
    section(el, '换个情境，用一次', item.practicePrompt);
    p(el, '可以先说出来，再写下自己的表达。这次有提示的练习，和每日复习中的独立回忆分开记录。', 'ef-muted');
    const input = textarea(el, '你的表达', current.answer, value => {
      current.answer = value; current.feedback = null; current.saved = false;
      el.querySelector<HTMLElement>('.ef-practice-result')?.remove();
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }); input.disabled = this.pending || current.saving;
    const actions = el.createDiv({ cls: 'ef-actions' });
    const ensureAnswer = () => { if (!current.answer.trim()) throw new Error('请先尝试写一句，再查看参考或获取反馈。'); };
    button(actions, '查看参考表达', () => { ensureAnswer(); current.revealed = true; this.render(); }).setDisabled(this.pending || current.saving);
    button(actions, '保存练习', async () => {
      if (current.saved || current.saving || this.pending) return;
      ensureAnswer(); current.saving = true; this.render();
      try {
        await this.plugin.store(this.demo).practice(item, current.answer, current.feedback);
        current.saved = true; await this.refresh();
      } finally { current.saving = false; this.render(); }
    }).setDisabled(this.pending || current.saved || current.saving);
    if (!this.demo) button(actions, 'AI 反馈并保存', async () => {
      if (current.saved || current.saving || this.pending) return;
      ensureAnswer();
      this.pending = true; const epoch = ++this.epoch; this.error = ''; this.render();
      try {
        const result = await this.plugin.tutor.assess(item, current.answer);
        if (epoch !== this.epoch) return;
        current.feedback = result;
        await this.plugin.store(false).practice(item, current.answer, result);
        current.saved = true;
        this.snapshot = await this.plugin.store(false).load();
      } catch (e) { if (epoch === this.epoch) this.error = e instanceof Error ? e.message : '反馈失败。'; }
      finally { if (epoch === this.epoch) { this.pending = false; this.render(); } }
    }, true).setDisabled(this.pending || current.saved || current.saving);
    else p(el, '离线示例只提供固定参考，不会自动判断你的句子。', 'ef-muted');
    if (this.pending) p(el, '正在获取反馈，输入已保留……', 'ef-muted').setAttribute('role', 'status');
    if (current.revealed) section(el, '参考表达（答案可以不同）', item.referenceAnswer);
    if (current.feedback || current.saved) {
      const result = el.createDiv({ cls: 'ef-practice-result' });
      if (current.feedback) {
        section(result, current.feedback.verdict === 'correct' ? 'AI 判断：意思和用法合适' : 'AI 判断：还有需要修改的地方', current.feedback.meaning);
        if (current.feedback.corrections.length) { result.createEl('h4', { text: '需要修正的错误' }); const ul = result.createEl('ul'); current.feedback.corrections.forEach(c => ul.createEl('li', { text: c })); }
        if (current.feedback.naturalAlternative) section(result, '另一种自然说法（可选）', current.feedback.naturalAlternative);
        p(result, current.feedback.explanation, 'ef-prose');
      }
      if (current.saved) p(result, '这次练习已保存。', 'ef-success').setAttribute('role', 'status');
    }
  }
  private clearReview(): void {
    this.reviewTask = null; this.reviewAnswer = ''; this.reviewRevealed = false; this.reviewForgot = false; this.reviewRevision = '';
  }
  private revision(task: ReviewTask, snapshot: Snapshot): string {
    return snapshot.records.filter(r => r.type === 'review' && r.cardId === task.card.id && r.skill === task.skill).map(r => r.id).sort().join(',');
  }
  private renderReview(el: HTMLElement): void {
    const now = new Date(), stats = statistics(this.snapshot.cards, this.snapshot.records, now, this.demo);
    p(el, `今日复习 ${stats.todayReviews} / ${this.plugin.settings.dailyLimit} 次 · 迁移练习 ${stats.todayPractices} 次 · 到期 ${stats.due} 项`, 'ef-muted');
    if (stats.todayReviews) p(el, `今日自评为顺利或轻松想起：${stats.recalled} / ${stats.todayReviews} 次。`, 'ef-muted');
    if (this.snapshot.warnings.length) { p(el, '部分学习文件无法读取。请先检查上方文件提示并刷新，再继续复习，避免排程遗漏。', 'ef-warning'); return; }
    if (stats.todayReviews >= this.plugin.settings.dailyLimit) { section(el, '今天的复习额度已完成', '明天再继续。你仍然可以阅读或做迁移练习。'); return; }
    if (!this.reviewTask) {
      this.reviewTask = dueTasks(this.snapshot.cards, this.snapshot.records, now, this.demo)[0] ?? null;
      if (this.reviewTask) this.reviewRevision = this.revision(this.reviewTask, this.snapshot);
    }
    const task = this.reviewTask;
    if (!task) {
      section(el, '当前没有到期复习', this.snapshot.cards.length ? '稍后打开或刷新会重新检查到期内容；想不起来的内容会在约 10 分钟后再出现。' : '先从阅读讲解中收藏一个表达。');
      button(el, '刷新到期内容', () => this.refresh()); return;
    }
    p(el, task.skill === 'recognition' ? '理解回忆 · 先解释含义' : '表达回忆 · 先自己组织英语', 'ef-badge');
    if (task.skill === 'recognition') section(el, task.card.phrase, '这个表达是什么意思？可以用中文解释，再想一个使用场景。');
    else section(el, '用英语说出来', task.card.practicePrompt);
    const input = textarea(el, '先作答，再揭晓', this.reviewAnswer, value => { this.reviewAnswer = value; });
    input.disabled = this.reviewRevealed || this.savingReview;
    if (!this.reviewRevealed) {
      const actions = el.createDiv({ cls: 'ef-actions' });
      button(actions, '揭晓并自评', () => {
        if (!this.reviewAnswer.trim()) throw new Error('请先作答；想不起来可以点击旁边的按钮。');
        this.reviewRevealed = true; this.render();
      }, true);
      button(actions, '想不起来', () => { this.reviewRevealed = true; this.reviewForgot = true; this.render(); });
      return;
    }
    section(el, task.card.phrase, task.card.meaning);
    section(el, '搭配与例句', `${task.card.pattern}\n${task.card.example}`);
    if (task.skill === 'production') section(el, '参考表达（不要求逐字一致）', task.card.referenceAnswer);
    const original = el.createEl('details'); original.createEl('summary', { text: '回看阅读原句' }); p(original, task.card.source.quote, 'ef-quote');
    p(el, '根据揭晓前的回忆表现自评。自评后才保存记录并安排下一次。', 'ef-muted');
    const grades = el.createDiv({ cls: 'ef-actions ef-grades' });
    for (const [rating, label] of [[1, '忘记'], [2, '费力想起'], [3, '顺利想起'], [4, '轻松想起']] as const) {
      const next = nextMemory(task.memory, now.getTime(), rating);
      const due = rating === 1 ? '10 分钟后' : `${next.intervalDays} 天后`;
      button(grades, `${label} · ${due}`, () => this.rate(rating)).setDisabled(this.savingReview || (this.reviewForgot && rating !== 1));
    }
  }
  private async rate(rating: Rating): Promise<void> {
    if (!this.reviewTask || !this.reviewRevealed || this.savingReview) return;
    if (this.reviewForgot && rating !== 1) return;
    const task = this.reviewTask;
    this.savingReview = true;
    try {
      const store = this.plugin.store(this.demo), latest = await store.load();
      if (latest.warnings.length) throw new Error('有学习文件无法读取，请检查后刷新。');
      if (!latest.cards.some(c => c.id === task.card.id) || this.revision(task, latest) !== this.reviewRevision) {
        this.snapshot = latest; this.clearReview(); this.render();
        new Notice('这项复习已在其他地方更新，已重新计算队列。'); return;
      }
      if (statistics(latest.cards, latest.records, new Date(), this.demo).todayReviews >= this.plugin.settings.dailyLimit) {
        this.snapshot = latest; this.clearReview(); this.render(); return;
      }
      await store.review(task.card, task.skill, rating, this.reviewAnswer);
      this.clearReview();
      await this.refresh();
    } finally { this.savingReview = false; this.render(); }
  }
}

export class FlowView extends ItemView {
  readonly panel: LearningPanel;
  constructor(leaf: WorkspaceLeaf, plugin: EnglishFlowPlugin) {
    super(leaf); this.panel = new LearningPanel(this.contentEl, plugin);
  }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return '英语学习'; }
  getIcon(): string { return 'languages'; }
  get demo(): boolean { return this.panel.demo; }
  set demo(value: boolean) { this.panel.demo = value; }
  async onOpen(): Promise<void> { await this.panel.onOpen(); }
  async onClose(): Promise<void> { await this.panel.onClose(); }
  markDirty(): void { this.panel.markDirty(); }
  useLiveMode(): void { this.panel.useLiveMode(); }
  async onForeground(): Promise<void> { await this.panel.onForeground(); }
  async reset(): Promise<void> { await this.panel.reset(); }
  async navigate(tab: Tab): Promise<void> { await this.panel.navigate(tab); }
  async explain(source: Source): Promise<void> { await this.panel.explain(source); }
  async showDemo(source: Source): Promise<void> { await this.panel.showDemo(source); }
}
export class ExplanationPopover {
  readonly element: HTMLDivElement;
  readonly contentEl: HTMLDivElement;
  readonly panel: LearningPanel;
  private opened = false;
  private disposers: (() => void)[] = [];
  private previousFocus: Element | null = null;
  private pronunciationEl: HTMLElement;
  constructor(private plugin: EnglishFlowPlugin, private anchor: ExplanationAnchor, private source: Source, private closed: () => void) {
    const doc = anchor.document;
    this.element = doc.createElement('div'); this.element.classList.add('ef-popover');
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'false');
    this.element.setAttribute('aria-label', '选词旁的英语讲解');
    const kind = selectionKind(source.quote);
    this.element.dataset.kind = kind;
    const header = this.element.createDiv({ cls: 'ef-popover-header' });
    const heading = header.createDiv({ cls: 'ef-popover-heading' });
    heading.createEl('strong', { text: kind === 'word' ? source.quote : kind === 'sentence' ? '句子讲解' : '段落讲解', cls: 'ef-popover-title' });
    const close = button(header, '×', () => this.close(true)).buttonEl;
    close.addClass('ef-popover-close'); close.setAttribute('aria-label', '关闭讲解'); close.title = '关闭 · Esc';
    this.pronunciationEl = this.element.createDiv({ cls: 'ef-popover-pronunciation' });
    this.contentEl = this.element.createDiv({ cls: 'ef-popover-content' });
    this.panel = new LearningPanel(this.contentEl, plugin, 'popover', () => this.position());
  }
  open(): void {
    if (this.opened) return;
    const doc = this.anchor.document, win = doc.defaultView;
    this.previousFocus = doc.activeElement;
    doc.body.append(this.element); this.opened = true;
    if (this.element.dataset.kind === 'word') void pronunciationRow(this.pronunciationEl, this.plugin, this.source.quote, () => this.position());
    else listenButton(this.pronunciationEl, this.plugin, this.source.quote, '朗读原句');
    const pointer = (event: Event) => { if (event.target && !this.element.contains(event.target as Node)) this.close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || doc.querySelector('.modal-container, .modal')) return;
      event.preventDefault(); event.stopPropagation(); this.close(true);
    };
    const scroll = (event: Event) => { if (!event.target || !this.element.contains(event.target as Node)) this.close(); };
    const resize = () => this.position();
    doc.addEventListener('pointerdown', pointer, true);
    doc.addEventListener('keydown', key, true);
    doc.addEventListener('scroll', scroll, true);
    win?.addEventListener('resize', resize);
    win?.visualViewport?.addEventListener('resize', resize);
    win?.visualViewport?.addEventListener('scroll', resize);
    this.disposers = [
      () => doc.removeEventListener('pointerdown', pointer, true),
      () => doc.removeEventListener('keydown', key, true),
      () => doc.removeEventListener('scroll', scroll, true),
      () => win?.removeEventListener('resize', resize),
      () => win?.visualViewport?.removeEventListener('resize', resize),
      () => win?.visualViewport?.removeEventListener('scroll', resize)
    ];
    const Observer = win?.ResizeObserver;
    if (Observer) {
      const observer = new Observer(resize);
      observer.observe(this.element);
      this.disposers.push(() => observer.disconnect());
    }
    this.position();
  }
  private position(): void {
    if (!this.opened) return;
    const win = this.anchor.document.defaultView;
    const viewport = win?.visualViewport;
    const viewportWidth = viewport?.width ?? win?.innerWidth ?? 1024, viewportHeight = viewport?.height ?? win?.innerHeight ?? 768;
    const viewportLeft = viewport?.offsetLeft ?? 0, viewportTop = viewport?.offsetTop ?? 0;
    const width = Math.max(0, Math.min(this.element.dataset.kind === 'word' ? 380 : 440, viewportWidth - 24));
    this.element.style.width = `${width}px`;
    this.element.style.maxHeight = `${Math.max(80, viewportHeight - 24)}px`;
    let rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
    try { rect = this.anchor.rect(); }
    catch { rect = { left: 24, right: 24, top: 80, bottom: 100 }; }
    const height = Math.min(this.element.getBoundingClientRect().height || 320, Math.max(80, viewportHeight - 24));
    const left = Math.max(viewportLeft + 12, Math.min(Number.isFinite(rect.left) ? rect.left : viewportLeft + 24, viewportLeft + viewportWidth - width - 12));
    const anchorBottom = Number.isFinite(rect.bottom) ? rect.bottom : 100;
    const anchorTop = Number.isFinite(rect.top) ? rect.top : anchorBottom;
    let top = anchorBottom + 8;
    if (top + height > viewportTop + viewportHeight - 12) top = anchorTop - height - 8;
    top = Math.max(viewportTop + 12, Math.min(top, viewportTop + viewportHeight - height - 12));
    this.element.style.left = `${left}px`; this.element.style.top = `${top}px`;
  }
  close(restoreFocus = false): void {
    if (!this.opened) return;
    this.opened = false;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    void this.panel.onClose();
    this.element.remove(); this.closed();
    if (restoreFocus && this.previousFocus?.isConnected && 'focus' in this.previousFocus) (this.previousFocus as HTMLElement).focus({ preventScroll: true });
  }
}

export class FlowSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: EnglishFlowPlugin) { super(app, plugin); }
  display(): void { settingsForm(this.app, this.plugin, this.containerEl); }
}
export class FlowSettingsModal extends Modal {
  constructor(app: App, private plugin: EnglishFlowPlugin) { super(app); }
  onOpen(): void { this.setTitle('英语学习设置'); settingsForm(this.app, this.plugin, this.contentEl); }
}
function settingsForm(app: App, plugin: EnglishFlowPlugin, el: HTMLElement): void {
  el.empty();
  const draft: FlowSettings = { ...plugin.settings };
  new Setting(el).setName('学习目录').setDesc('普通 Markdown 目录，由现有 GitHub 插件同步。修改目录不会移动旧数据。')
    .addText(c => c.setValue(draft.folder).onChange(v => { draft.folder = v; }));
  new Setting(el).setName('选中即讲解').setDesc('默认关闭。手机选中英语后点「讲解选文」，电脑按 ⌘R；开启后才会自动查询。')
    .addToggle(c => c.setValue(draft.autoExplain).onChange(v => { draft.autoExplain = v; }));
  new Setting(el).setName('API Base URL').setDesc('兼容 Chat Completions 的服务，例如 https://api.openai.com/v1；也可填写完整接口地址。')
    .addText(c => c.setValue(draft.endpoint).onChange(v => { draft.endpoint = v; }));
  new Setting(el).setName('模型名称').setDesc('填写你的服务支持的文字模型名称。')
    .addText(c => c.setValue(draft.model).setPlaceholder('你的模型 ID').onChange(v => { draft.model = v; }));
  new Setting(el).setName('DeepSeek 快速讲解').setDesc('使用 DeepSeek 官方接口时默认关闭深度思考，减少等待；遇到复杂长句时可暂时关闭此项。')
    .addToggle(c => c.setValue(draft.deepseekFast).onChange(v => { draft.deepseekFast = v; }));
  new Setting(el).setName('API 凭据').setDesc('在此创建或选择凭据。每台设备分别配置；API Key 不写入笔记或插件 data.json。本机服务可留空。')
    .addComponent(container => new SecretComponent(app, container).setValue(draft.secretName).onChange(v => { draft.secretName = v ?? ''; }));
  new Setting(el).setName('JSON 模式').setDesc('服务支持时启用；不支持 response_format 的兼容服务可关闭。')
    .addToggle(c => c.setValue(draft.jsonMode).onChange(v => { draft.jsonMode = v; }));
  new Setting(el).setName('使用旧版 token 参数').setDesc('默认使用 max_completion_tokens。服务仅支持 max_tokens 时开启。')
    .addToggle(c => c.setValue(draft.legacyTokens).onChange(v => { draft.legacyTokens = v; }));
  new Setting(el).setName('每日复习额度').setDesc('5～100 次作答，理解与表达分别计数；按当前设备本地日期统计。')
    .addText(c => c.setValue(String(draft.dailyLimit)).onChange(v => { draft.dailyLimit = Number(v); }));
  const status = p(el, '', 'ef-muted'); status.setAttribute('role', 'status');
  button(el, '保存设置', async () => {
    try { await plugin.configure(draft); status.setText('设置已保存。'); status.removeClass('ef-error'); }
    catch (e) { status.setText(e instanceof Error ? e.message : '保存失败。'); status.addClass('ef-error'); }
  }, true);
  p(el, '讲解使用当前配置的 AI 服务。音标向 Free Dictionary API 查询；发音默认有道，失败时使用 Google 翻译公开朗读。点击声音按钮时只发送待朗读文字，不发送上下文或 API Key；音频仅缓存在本次会话内。', 'ef-muted');
}
