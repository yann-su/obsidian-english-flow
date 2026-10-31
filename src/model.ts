import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export type Origin = 'ai' | 'demo' | 'manual';
export type Skill = 'recognition' | 'production';
export type Rating = 1 | 2 | 3 | 4;
export interface Source { path: string; line: number; quote: string; context: string }
export type SelectionKind = 'word' | 'sentence' | 'passage';
export function selectionKind(text: string): SelectionKind {
  const quote = text.trim();
  if (quote.split(/\s+/).length === 1) return 'word';
  if (quote.length > 450 || /\n\s*\n/.test(quote) || (quote.match(/[.!?。！？]["”'’)]*(?:\s|$)/g)?.length ?? 0) > 1) return 'passage';
  return 'sentence';
}
export interface Expression {
  phrase: string; meaning: string; pattern: string; example: string;
  practicePrompt: string; referenceAnswer: string;
}
export interface Analysis {
  summary: string; simpleEnglish: string; translation: string;
  translationChunks?: { english: string; chinese: string; note: string }[];
  expressions: Expression[];
  grammar: { sentence: string; explanation: string; pattern: string }[];
}
export interface Card extends Expression {
  type: 'card'; version: 1; id: string; createdAt: string; origin: Origin; source: Source;
}
export interface ReviewRecord {
  type: 'review'; version: 1; id: string; cardId: string; at: string;
  skill: Skill; rating: Rating; answer: string; deviceId: string;
}
export interface Feedback {
  verdict: 'correct' | 'needs-work'; meaning: string;
  corrections: string[]; naturalAlternative: string; explanation: string;
}
export interface PracticeRecord {
  type: 'practice'; version: 1; id: string; cardId: string; at: string; deviceId: string;
  answer: string; feedback: Feedback | null;
}
export type LearningRecord = ReviewRecord | PracticeRecord;
export const MAX_SELECTION = 8000;
export const MAX_ANSWER = 3000;
export const DEMO_SOURCE = 'Although I was worn out after work, I ended up meeting a friend for coffee. It turned out to be just what I needed.';
export const DEMO_ANALYSIS: Analysis = {
  summary: '作者虽然下班后很累，最后还是和朋友喝了咖啡，并发现这正是自己需要的。',
  simpleEnglish: 'I was very tired after work. I still met a friend for coffee, and it helped me feel better.',
  translation: '虽然我下班后已经累坏了，最后还是和朋友去喝了咖啡。结果，这正是我当时需要的。',
  expressions: [
    { phrase: 'end up doing something', meaning: '最后做了某事，常带有出乎原先计划的意味。', pattern: 'end up + 动词 -ing', example: 'We ended up staying home because of the rain.', practicePrompt: '你本来打算做饭，最后却点了外卖。用英语表达这件事。', referenceAnswer: 'I was going to cook, but I ended up ordering takeout.' },
    { phrase: 'be worn out', meaning: '累坏了，精疲力尽。', pattern: 'be / feel worn out', example: 'I felt worn out after the long trip.', practicePrompt: '你走了一整天，现在特别累。用英语告诉朋友。', referenceAnswer: 'I’m worn out after walking all day.' },
    { phrase: 'turn out to be', meaning: '结果是；后来发现是。', pattern: 'turn out to be + 名词 / 形容词', example: 'The restaurant turned out to be really good.', practicePrompt: '原本没抱太大期待的一家餐馆，后来发现非常好。用英语说一句。', referenceAnswer: 'The restaurant turned out to be really good.' }
  ],
  grammar: [{ sentence: 'Although I was worn out after work, I ended up meeting a friend for coffee.', explanation: 'Although 引出让步背景「虽然很累」；逗号后是主句，说明实际发生的事。这个句型中不需要再加 but。', pattern: 'Although + 情况, + 实际发生的事。' }]
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式不是对象。');
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, max = 4000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`${label}缺失或超出长度限制。`);
  return value.trim();
}
export function date(value: unknown): string {
  const text = string(value, '时间', 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error('记录时间无效。');
  return new Date(text).toISOString();
}
export function expression(value: unknown): Expression {
  const v = object(value);
  return { phrase: string(v.phrase, '表达', 160), meaning: string(v.meaning, '含义', 1600), pattern: string(v.pattern, '搭配', 800), example: string(v.example, '例句', 1200), practicePrompt: string(v.practicePrompt, '迁移题', 1200), referenceAnswer: string(v.referenceAnswer, '参考答案', 1600) };
}
export function analysis(value: unknown): Analysis {
  const v = object(value);
  if (!Array.isArray(v.expressions) || !v.expressions.length || v.expressions.length > 5 || !Array.isArray(v.grammar) || v.grammar.length > 3) throw new Error('讲解缺少表达，或数量超出限制。');
  const result: Analysis = {
    summary: string(v.summary, '主旨', 4000), simpleEnglish: string(v.simpleEnglish, '简单英语', 4000), translation: string(v.translation, '翻译', 8000),
    expressions: v.expressions.map(expression),
    grammar: v.grammar.map(g => { const x = object(g); return { sentence: string(x.sentence, '原句', 4000), explanation: string(x.explanation, '语法讲解', 3000), pattern: string(x.pattern, '句型', 1000) }; })
  };
  if (v.translationChunks !== undefined) {
    if (!Array.isArray(v.translationChunks) || v.translationChunks.length > 4) throw new Error('分句翻译数量超出限制。');
    result.translationChunks = v.translationChunks.map(chunk => {
      const item = object(chunk);
      return { english: string(item.english, '分句原文', 2000), chinese: string(item.chinese, '分句译文', 2000), note: item.note === undefined ? '' : string(item.note, '翻译说明', 800, true) };
    });
  }
  return result;
}
export function feedback(value: unknown): Feedback {
  const v = object(value);
  if (v.verdict !== 'correct' && v.verdict !== 'needs-work') throw new Error('反馈判断无效。');
  if (!Array.isArray(v.corrections) || v.corrections.length > 5) throw new Error('纠错反馈格式无效。');
  return { verdict: v.verdict, meaning: string(v.meaning, '意思反馈', 2000), corrections: v.corrections.map(c => string(c, '纠错', 1000)), naturalAlternative: string(v.naturalAlternative, '表达建议', 2000, true), explanation: string(v.explanation, '反馈说明', 3000) };
}
export function source(value: unknown): Source {
  const v = object(value);
  if (!Number.isSafeInteger(v.line) || (v.line as number) < 0) throw new Error('来源行号无效。');
  return { path: string(v.path, '来源路径', 1000, true), line: v.line as number, quote: string(v.quote, '选中内容', MAX_SELECTION), context: string(v.context, '上下文', 6000, true) };
}
export function card(value: unknown): Card {
  const v = object(value);
  if (v.type !== 'card' || v.version !== 1 || !/^[a-f0-9]{64}$/.test(String(v.id)) || !['ai', 'demo', 'manual'].includes(String(v.origin))) throw new Error('表达卡片版本或标识无效。');
  return { ...expression(v), type: 'card', version: 1, id: v.id as string, createdAt: date(v.createdAt), origin: v.origin as Origin, source: source(v.source) };
}
export function record(value: unknown): LearningRecord {
  const v = object(value);
  if (v.version !== 1 || !/^[a-f0-9-]{36}$/.test(String(v.id)) || !/^[a-f0-9]{64}$/.test(String(v.cardId)) || !/^[a-f0-9-]{36}$/.test(String(v.deviceId))) throw new Error('学习记录标识无效。');
  const base = { version: 1 as const, id: v.id as string, cardId: v.cardId as string, at: date(v.at), deviceId: v.deviceId as string, answer: string(v.answer, '作答', MAX_ANSWER, true) };
  if (v.type === 'review' && ['recognition', 'production'].includes(String(v.skill)) && [1, 2, 3, 4].includes(v.rating as number)) return { ...base, type: 'review', skill: v.skill as Skill, rating: v.rating as Rating };
  if (v.type === 'practice') return { ...base, type: 'practice', feedback: v.feedback === null ? null : feedback(v.feedback) };
  throw new Error('学习记录格式无效。');
}
export function expressionId(value: Expression, origin: Origin): string {
  const normalize = (s: string) => s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  return bytesToHex(sha256(new TextEncoder().encode(`${origin === 'demo' ? 'demo:' : ''}${normalize(value.phrase)}\0${normalize(value.meaning)}`)));
}
export function uniqueId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}
