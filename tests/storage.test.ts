import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles, store, SOURCE, EXPRESSION, NOW, DEVICE, DEVICE_2, codec } from './helpers';
import { decodeFile, safeFolder } from '../src/storage';
import { memoryFor, statistics } from '../src/scheduler';

test('collection survives restart as Markdown and repeated collection reuses logical identity', async () => {
  const files = new MemoryFiles(), first = store(files);
  const created = await first.saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  assert.equal(created.created, true);
  const repeated = await store(files).saveExpression({ ...EXPRESSION, phrase: ' End UP doing something ' }, SOURCE, 'ai');
  assert.equal(repeated.created, false);
  assert.equal(created.card.id, repeated.card.id);
  const restored = await store(files).load();
  assert.deepEqual(restored.cards, [created.card]);
  assert.equal(restored.warnings.length, 0);
  assert.equal(files.paths().length, 1);
  assert.match(await files.read(restored.cardPaths[created.card.id]!), /## 阅读原文/);
});
test('simultaneous offline first collections converge without writing the same file', async () => {
  const a = new MemoryFiles(), b = new MemoryFiles();
  const first = await store(a).saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  const second = await store(b, DEVICE_2).saveExpression(EXPRESSION, { ...SOURCE, path: 'Elsewhere.md' }, 'ai', new Date(NOW.getTime() + 1000));
  assert.equal(first.card.id, second.card.id);
  assert.notEqual(a.paths()[0], b.paths()[0]);
  for (const [path, text] of b.entries) a.entries.set(path, text);
  const merged = await store(a).load();
  assert.equal(merged.cards.length, 1);
  assert.equal(merged.cards[0]?.source.path, SOURCE.path);
  assert.deepEqual(merged.warnings, []);
});
test('practice and cross-device review events remain separate and replay after restart', async () => {
  const files = new MemoryFiles(), one = store(files), two = store(files, DEVICE_2);
  const { card } = await one.saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  await one.practice(card, 'I ended up ordering takeout.', null, NOW);
  await one.review(card, 'recognition', 3, '最后做了某事', NOW);
  await two.review(card, 'production', 1, '', new Date(NOW.getTime() + 1000));
  const loaded = await store(files).load();
  assert.equal(loaded.records.length, 3);
  assert.equal(memoryFor(card, 'recognition', loaded.records).successes, 1);
  assert.equal(memoryFor(card, 'production', loaded.records).lapses, 1);
  assert.equal(statistics(loaded.cards, loaded.records, NOW, false).todayPractices, 1);
  assert.ok(files.paths().some(path => path.includes(`/Records/${DEVICE}/`)));
  assert.ok(files.paths().some(path => path.includes(`/Records/${DEVICE_2}/`)));
});
test('all learning files are in scope for the existing GitHub bridge; credentials are absent', async t => {
  let bridge;
  try { bridge = await import('../../obsidian-github-bridge/src/model'); }
  catch (e) { if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') { t.skip('邻近的 GitHub Bridge 源码未提供；其他测试可独立运行。'); return; } throw e; }
  const files = new MemoryFiles(), repo = store(files);
  const { card } = await repo.saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  await repo.review(card, 'recognition', 3, '记得', NOW);
  const scope = { extensions: bridge.DEFAULT_EXTENSIONS, excludedFolders: [], maxBytes: 10 * 1024 * 1024, configDir: '.obsidian' };
  for (const [path, text] of files.entries) {
    assert.equal(bridge.inScope(path, scope), true, path);
    assert.equal(path.endsWith('.md'), true);
    assert.doesNotMatch(text, /api[_-]?key|Authorization|secretName/i);
  }
});
test('demo captures are isolated from the normal collection', async () => {
  const files = new MemoryFiles();
  await store(files, DEVICE, 'English Flow/Demo').saveExpression(EXPRESSION, SOURCE, 'demo', NOW);
  assert.equal((await store(files).load()).cards.length, 0);
  assert.equal((await store(files, DEVICE, 'English Flow/Demo').load()).cards.length, 1);
});
test('broken data is preserved and reported; failed writes do not manufacture review events', async () => {
  const files = new MemoryFiles(), repo = store(files);
  const { card } = await repo.saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  files.entries.set('English Flow/Records/broken.md', '---\nenglish_flow: true\ntype: review\n---\n');
  let snapshot = await repo.load();
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.warnings.length, 1);
  files.failWrites = true;
  await assert.rejects(repo.review(card, 'recognition', 4, 'a', NOW), /disk full/);
  snapshot = await repo.load();
  assert.equal(snapshot.records.length, 0);
  assert.equal(files.entries.has('English Flow/Records/broken.md'), true);
});
test('duplicate synced event IDs count once', async () => {
  const files = new MemoryFiles(), repo = store(files);
  const { card } = await repo.saveExpression(EXPRESSION, SOURCE, 'ai', NOW);
  await repo.review(card, 'recognition', 3, '最后', NOW);
  const path = files.paths().find(p => p.includes('/Records/'))!;
  files.entries.set('English Flow/Records/copy.md', files.entries.get(path)!);
  const snapshot = await repo.load();
  assert.equal(snapshot.records.length, 1);
  assert.equal(statistics(snapshot.cards, snapshot.records, NOW, false).todayReviews, 1);
});
test('frontmatter does not break out when a source contains Markdown fences and headings', async () => {
  const files = new MemoryFiles();
  const source = { ...SOURCE, quote: '---\n# Heading\n```html\n<img onerror="oops">\n```' };
  await store(files).saveExpression(EXPRESSION, source, 'ai', NOW);
  const decoded = decodeFile(files.entries.values().next().value!, codec) as { source: typeof source };
  assert.equal(decoded.source.quote, source.quote);
});
test('unsafe and hidden data roots are rejected', () => {
  for (const path of ['../secret', '/absolute', '.obsidian', 'English/.cache', 'English//data', 'C:\\notes', 'CON', 'English/last.']) assert.throws(() => safeFolder(path), undefined, path);
  assert.equal(safeFolder('英语/学习记录'), '英语/学习记录');
});
