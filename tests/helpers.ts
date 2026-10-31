import yaml from 'js-yaml';
import { DEMO_ANALYSIS, type Card, type Source } from '../src/model';
import { LearningStore, type FileStore } from '../src/storage';
export const DEVICE = '10000000-0000-4000-8000-000000000001';
export const DEVICE_2 = '20000000-0000-4000-8000-000000000002';
export const NOW = new Date('2026-10-31T10:00:00.000Z');
export const SOURCE: Source = { path: 'Reading/Coffee.md', line: 3, quote: 'I ended up meeting a friend for coffee.', context: 'I was tired after work.' };
export const EXPRESSION = DEMO_ANALYSIS.expressions[0]!;
export const codec = { parse: (text: string) => yaml.load(text), stringify: (value: unknown) => yaml.dump(value, { noRefs: true, lineWidth: -1 }) };
export class MemoryFiles implements FileStore {
  entries = new Map<string, string>();
  folders = new Set<string>();
  failWrites = false;
  paths(): string[] { return [...this.entries.keys()]; }
  exists(path: string): boolean { return this.entries.has(path) || this.folders.has(path); }
  async read(path: string): Promise<string> { const text = this.entries.get(path); if (text === undefined) throw new Error('missing'); return text; }
  async mkdir(path: string): Promise<void> { if (this.exists(path)) throw new Error('exists'); this.folders.add(path); }
  async create(path: string, text: string): Promise<void> { if (this.failWrites) throw new Error('disk full'); if (this.exists(path)) throw new Error('exists'); this.entries.set(path, text); }
}
export function store(files = new MemoryFiles(), deviceId = DEVICE, root = 'English Flow'): LearningStore { return new LearningStore(files, codec, root, deviceId); }
export async function savedCard(files = new MemoryFiles()): Promise<Card> { return (await store(files).saveExpression(EXPRESSION, SOURCE, 'ai', NOW)).card; }
