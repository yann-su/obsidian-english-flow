import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHost } from '../tests/host.mjs';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert.equal(manifest.id, 'english-reading-flow');
assert.equal(manifest.isDesktopOnly, false);
const bundle = await readFile('dist/main.js', 'utf8');
assert.doesNotMatch(bundle, /require\(["'](?:node:|fs["']|electron["'])/);
const host = await createHost(bundle);
try {
  await host.plugin.openDemo();
  await host.click('收藏并练习');
  host.input('I ended up ordering takeout.');
  await host.click('保存练习');
  await host.click('每日复习');
  host.input('I was going to cook, but I ended up ordering takeout.');
  await host.click('揭晓并自评');
  await host.click('顺利想起');
  const data = await host.plugin.store(true).load();
  assert.equal(data.cards.length, 1);
  assert.equal(data.records.length, 2);
  assert.equal(host.requests.length, 0);
  console.log(`Packaged runtime ${manifest.version}: loads, collects, saves practice and schedules review; no network calls.`);
} finally { await host.close(); }
