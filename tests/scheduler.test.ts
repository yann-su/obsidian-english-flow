import test from 'node:test';
import assert from 'node:assert/strict';
import { dueTasks, memoryFor, nextMemory, statistics } from '../src/scheduler';
import { savedCard, store, MemoryFiles, NOW } from './helpers';
import { localDay } from '../src/model';

test('a new expression has independent recognition and production tasks', async () => {
  const card = await savedCard();
  const tasks = dueTasks([card], [], NOW, false);
  assert.equal(tasks.length, 2);
  assert.deepEqual(new Set(tasks.map(t => t.skill)), new Set(['production', 'recognition']));
});
test('forgetting retries in ten minutes and practice does not advance memory', async () => {
  const files = new MemoryFiles(), repo = store(files), card = await savedCard(files);
  await repo.practice(card, 'something', null, NOW);
  let snapshot = await repo.load();
  assert.equal(memoryFor(card, 'production', snapshot.records).reviews, 0);
  await repo.review(card, 'production', 1, '', NOW);
  snapshot = await repo.load();
  assert.equal(memoryFor(card, 'production', snapshot.records).due, NOW.getTime() + 600_000);
  assert.equal(dueTasks([card], snapshot.records, new Date(NOW.getTime() + 599_999), false).some(t => t.skill === 'production'), false);
  assert.equal(dueTasks([card], snapshot.records, new Date(NOW.getTime() + 600_000), false).some(t => t.skill === 'production'), true);
});
test('reviews replay deterministically after multi-device event order changes', async () => {
  const files = new MemoryFiles(), repo = store(files), card = await savedCard(files);
  await repo.review(card, 'recognition', 3, 'a', NOW);
  await repo.review(card, 'recognition', 4, 'b', new Date(NOW.getTime() + 86_400_000));
  const { records } = await repo.load();
  const a = memoryFor(card, 'recognition', records), b = memoryFor(card, 'recognition', [...records].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.intervalDays, 8);
  assert.equal(a.reviews, 2);
  assert.equal(memoryFor(card, 'production', records).reviews, 0);
});
test('intervals and ease remain bounded after prolonged success or difficulty', async () => {
  const card = await savedCard(); let state = memoryFor(card, 'recognition', []);
  for (let i = 0; i < 1000; i++) state = nextMemory(state, NOW.getTime(), 4);
  assert.equal(state.intervalDays, 365); assert.ok(state.ease <= 3.2);
  for (let i = 0; i < 1000; i++) state = nextMemory(state, NOW.getTime(), 1);
  assert.equal(state.ease, 1.3); assert.equal(state.successes, 0);
});
test('daily totals reset on the device local date and use distinct review records', async () => {
  const files = new MemoryFiles(), repo = store(files), card = await savedCard(files);
  const before = new Date(2026, 9, 31, 23, 59), after = new Date(2026, 10, 1, 0, 1);
  await repo.review(card, 'recognition', 3, 'a', before);
  await repo.practice(card, 'b', null, after);
  const snapshot = await repo.load();
  assert.notEqual(localDay(before), localDay(after));
  assert.equal(statistics(snapshot.cards, snapshot.records, before, false).todayReviews, 1);
  assert.equal(statistics(snapshot.cards, snapshot.records, after, false).todayReviews, 0);
  assert.equal(statistics(snapshot.cards, snapshot.records, after, false).todayPractices, 1);
});
