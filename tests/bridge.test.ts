import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles, store, SOURCE, EXPRESSION, NOW, DEVICE_2 } from './helpers';
import { memoryFor } from '../src/scheduler';

test('existing GitHub Bridge engine transports offline collections and reviews between two devices without conflicts', async t => {
  let bridge;
  try { bridge = await import('../../obsidian-github-bridge/tests/helpers'); }
  catch (e) { if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') { t.skip('需要邻近的 GitHub Bridge 源码运行集成检查。'); return; } throw e; }
  const aFiles = new MemoryFiles(), bFiles = new MemoryFiles();
  const aStore = store(aFiles), bStore = store(bFiles, DEVICE_2);
  const aCard = (await aStore.saveExpression(EXPRESSION, SOURCE, 'ai', NOW)).card;
  const bCard = (await bStore.saveExpression(EXPRESSION, { ...SOURCE, path: 'Phone.md' }, 'ai', new Date(NOW.getTime() + 1000))).card;
  await aStore.review(aCard, 'recognition', 3, '最后做了某事', NOW);
  await bStore.review(bCard, 'production', 2, 'I ended up cooking.', NOW);
  const remote = new bridge.MemoryRemote();
  const a = await bridge.device(remote, Object.fromEntries(aFiles.entries));
  const b = await bridge.device(remote, Object.fromEntries(bFiles.entries));
  assert.equal((await a.engine.run()).conflicts, 0);
  assert.equal((await b.engine.run()).conflicts, 0);
  assert.equal((await a.engine.run()).conflicts, 0);
  const restore = async (device: typeof a) => {
    const files = new MemoryFiles();
    for (const [path, bytes] of device.local.files) files.entries.set(path, new TextDecoder().decode(bytes));
    return store(files).load();
  };
  const one = await restore(a), two = await restore(b);
  assert.equal(one.cards.length, 1); assert.equal(two.cards.length, 1);
  assert.equal(one.records.length, 2); assert.equal(two.records.length, 2);
  assert.deepEqual(one.warnings, []); assert.deepEqual(two.warnings, []);
  for (const skill of ['recognition', 'production'] as const) assert.deepEqual(memoryFor(one.cards[0]!, skill, one.records), memoryFor(two.cards[0]!, skill, two.records));
  const publications = remote.publications;
  await a.engine.run(); await b.engine.run();
  assert.equal(remote.publications, publications);
});
