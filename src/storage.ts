import { card, record, expression, expressionId, type Card, type Expression, type LearningRecord, type Origin, type Source, type Rating, type Skill, type Feedback, uniqueId } from './model';

export interface FileStore {
  paths(): string[]; read(path: string): Promise<string>; exists(path: string): boolean;
  mkdir(path: string): Promise<void>; create(path: string, text: string): Promise<void>;
}
export interface YamlCodec { parse(text: string): unknown; stringify(value: unknown): string }
export interface Snapshot { cards: Card[]; cardPaths: Record<string, string>; records: LearningRecord[]; warnings: string[] }
export function safeFolder(value: string): string {
  const path = value.trim().normalize('NFC');
  const parts = path.split('/');
  if (!path || path.length > 180 || parts.some(p => !p || p.startsWith('.') || /[\\:*?"<>|\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('学习目录必须是笔记库内的普通文件夹，例如 English Flow。');
  return path;
}
function prose(value: string): string { return value.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n'); }
export function encodeFile(value: Card | LearningRecord, yaml: YamlCodec): string {
  let body: string;
  if (value.type === 'card') body = `# ${value.phrase.replace(/\n/g, ' ')}\n\n## 含义\n${prose(value.meaning)}\n\n## 搭配\n${prose(value.pattern)}\n\n## 例句\n${prose(value.example)}\n\n## 阅读原文\n${prose(value.source.quote)}\n\n## 迁移练习\n${prose(value.practicePrompt)}\n\n## 参考表达\n${prose(value.referenceAnswer)}`;
  else body = `# ${value.type === 'review' ? '复习记录' : '迁移练习'}\n\n## 我的回答\n${prose(value.answer || '（未作答）')}${value.type === 'practice' && value.feedback ? `\n\n## 反馈\n${prose(value.feedback.meaning)}\n\n${prose(value.feedback.explanation)}` : ''}`;
  return `---\n${yaml.stringify({ english_flow: true, ...value }).trim()}\n---\n\n${body}\n`;
}
export function decodeFile(text: string, yaml: YamlCodec): unknown {
  if (text.length > 100_000) throw new Error('学习文件超出大小限制。');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) throw new Error('缺少学习数据属性。');
  const value = yaml.parse(match[1]);
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).english_flow !== true) throw new Error('不是学习记录。');
  return value;
}
export class LearningStore {
  readonly root: string;
  constructor(private files: FileStore, private yaml: YamlCodec, root: string, private deviceId: string) { this.root = safeFolder(root); }
  async load(): Promise<Snapshot> {
    const cards = new Map<string, Card>(), cardPaths: Record<string, string> = {}, records = new Map<string, LearningRecord>(), warnings: string[] = [];
    const paths = this.files.paths().filter(p => p.startsWith(`${this.root}/Expressions/`) || p.startsWith(`${this.root}/Records/`)).filter(p => p.endsWith('.md')).sort();
    for (const path of paths) {
      try {
        const value = decodeFile(await this.files.read(path), this.yaml) as Record<string, unknown>;
        if (value.type === 'card') {
          const item = card(value);
          // Concurrent first collections have distinct immutable files but share a logical ID.
          // Keep both source captures on disk; choose the oldest deterministically for the UI.
          const previous = cards.get(item.id);
          if (!previous || item.createdAt < previous.createdAt) { cards.set(item.id, item); cardPaths[item.id] = path; }
        } else {
          const entry = record(value);
          const previous = records.get(entry.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) warnings.push(`记录标识冲突：${path}`);
          else records.set(entry.id, entry);
        }
      } catch { warnings.push(`无法读取学习文件，已保留原文件：${path}`); }
    }
    return { cards: [...cards.values()], cardPaths, records: [...records.values()], warnings };
  }
  private async ensure(folder: string): Promise<void> {
    let current = '';
    for (const part of folder.split('/')) { current = current ? `${current}/${part}` : part; if (!this.files.exists(current)) { try { await this.files.mkdir(current); } catch (e) { if (!this.files.exists(current)) throw e; } } }
  }
  async saveExpression(value: Expression, source: Source, origin: Origin, now = new Date()): Promise<{ card: Card; created: boolean }> {
    const validated = expression(value), id = expressionId(validated, origin);
    const existing = this.files.paths().filter(p => p.startsWith(`${this.root}/Expressions/${id}-`) && p.endsWith('.md')).sort();
    if (existing.length) {
      const items = await Promise.all(existing.map(async path => card(decodeFile(await this.files.read(path), this.yaml))));
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (items.some(item => item.id !== id)) throw new Error('已存在的卡片标识与文件名不一致，请先检查学习目录。');
      return { card: items[0]!, created: false };
    }
    const path = `${this.root}/Expressions/${id}-${uniqueId()}.md`;
    const item = card({ ...validated, type: 'card', version: 1, id, createdAt: now.toISOString(), origin, source });
    await this.ensure(`${this.root}/Expressions`);
    await this.files.create(path, encodeFile(item, this.yaml));
    return { card: item, created: true };
  }
  private async append(entry: LearningRecord): Promise<LearningRecord> {
    const folder = `${this.root}/Records/${this.deviceId}`;
    await this.ensure(folder);
    const validated = record(entry);
    await this.files.create(`${folder}/${entry.at.replace(/[:.]/g, '-')}-${entry.id}.md`, encodeFile(validated, this.yaml));
    return validated;
  }
  async review(item: Card, skill: Skill, rating: Rating, answer: string, now = new Date()): Promise<LearningRecord> {
    return this.append({ type: 'review', version: 1, id: uniqueId(), cardId: item.id, at: now.toISOString(), deviceId: this.deviceId, skill, rating, answer });
  }
  async practice(item: Card, answer: string, feedback: Feedback | null, now = new Date()): Promise<LearningRecord> {
    return this.append({ type: 'practice', version: 1, id: uniqueId(), cardId: item.id, at: now.toISOString(), deviceId: this.deviceId, answer, feedback });
  }
}
