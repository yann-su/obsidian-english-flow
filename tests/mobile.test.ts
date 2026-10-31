import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHost } from './host.mjs';
import { DEMO_ANALYSIS } from '../src/model';

const bundlePromise = build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'], platform: 'browser', format: 'cjs', target: 'es2022', write: false }).then(r => r.outputFiles![0]!.text);
const responder = async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) });
const waitForSelection = async () => { await new Promise(resolve => setTimeout(resolve, 150)); };
function note(host: Awaited<ReturnType<typeof createHost>>, content = 'contribution Listing order is random 中文') {
  const win = host.dom.window, doc = win.document;
  const el = doc.createElement('div'); el.textContent = content; doc.body.append(el);
  host.app.workspace.activeFileView = { file: { path: 'Reading.md' }, containerEl: el };
  win.Range.prototype.getBoundingClientRect = () => ({ left: 32, right: 132, top: 120, bottom: 140, width: 100, height: 20 });
  const select = (start: number, end: number) => {
    const range = doc.createRange(); range.setStart(el.firstChild, start); range.setEnd(el.firstChild, end);
    win.getSelection().removeAllRanges(); win.getSelection().addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
  };
  const control = () => doc.querySelector<HTMLButtonElement>('.ef-mobile-selection-action')!;
  return { win, doc, el, select, control };
}

test('mobile selection waits for a manual tap and survives iOS collapsing selection before click', async () => {
  const host = await createHost(await bundlePromise, { settings: { model: 'test-model' } }, responder, undefined, undefined, { mobile: true });
  try {
    const { doc, win, select, control } = note(host);
    host.app.workspace.activeFileView.file.path = 'paper.pdf';
    select(0, 12); await waitForSelection();
    assert.equal(control().hidden, false);
    assert.equal(control().textContent, '讲解选文');
    assert.equal(host.requests.length + host.pronunciationRequests.length + host.audioRequests.length, 0);
    assert.equal(host.plugin.readingPopover, null);
    control().dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
    control().dispatchEvent(new win.Event('touchstart', { bubbles: true }));
    control().focus();
    win.getSelection().removeAllRanges();
    doc.dispatchEvent(new win.Event('selectionchange'));
    await waitForSelection();
    assert.equal(control().hidden, false);
    control().click(); await host.settle();
    assert.equal(control().hidden, true);
    assert.equal(host.requests.length, 1);
    const data = JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData;
    assert.equal(data.selection, 'contribution');
    assert.equal(data.surroundingContext, '');
    assert.equal(doc.querySelector('.ef-popover').style.left, '32px');
    assert.equal(doc.querySelectorAll('.modal').length, 0);
    assert.equal(host.app.workspace.getLeavesOfType('english-reading-flow-view').length, 0);
    assert.equal(host.plugin.settings.autoExplain, false);
  } finally { await host.close(); }
});

test('mobile captures the settled editor selection and can translate a sentence without a DOM range', async () => {
  const host = await createHost(await bundlePromise, { settings: { model: 'test-model' } }, responder, undefined, undefined, { mobile: true });
  try {
    const text = 'Listing order is random';
    const { win, doc, el, control } = note(host, text);
    let selected = 'Listing';
    host.app.workspace.activeEditor = { file: { path: 'Reading.md' }, editor: {
      getSelection: () => selected, getCursor: (side: string) => ({ line: 0, ch: side === 'from' ? 0 : selected.length }),
      lineCount: () => 1, getLine: () => text, getRange: (from: { ch: number }, to: { ch: number }) => text.slice(from.ch, to.ch)
    } };
    el.dispatchEvent(new win.Event('touchend', { bubbles: true }));
    await Promise.resolve(); selected = text;
    doc.dispatchEvent(new win.Event('selectionchange'));
    await waitForSelection();
    assert.equal(control().hidden, false); assert.equal(host.requests.length, 0);
    control().click(); await host.settle();
    const data = JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData;
    assert.equal(data.selection, text);
    assert.match(data.surroundingContext, /前文/);
    assert.equal(doc.querySelector('.ef-card-translation-text').textContent, DEMO_ANALYSIS.translation);
  } finally { await host.close(); }
});

test('mobile clears stale or invalid selections and never looks up input fields or a previous note', async () => {
  const host = await createHost(await bundlePromise, { settings: { model: 'test-model' } }, responder, undefined, undefined, { mobile: true });
  try {
    const { win, doc, el, select, control } = note(host, 'contribution 中文');
    select(0, 12); await waitForSelection(); assert.equal(control().hidden, false);
    win.getSelection().removeAllRanges(); doc.dispatchEvent(new win.Event('selectionchange'));
    await waitForSelection(); assert.equal(control().hidden, true);
    select(13, 15); await waitForSelection(); assert.equal(control().hidden, true);
    const input = doc.createElement('textarea'); input.value = 'contribution'; el.append(input); input.focus();
    select(0, 12); await waitForSelection(); assert.equal(control().hidden, true);
    input.blur(); select(0, 12); await waitForSelection(); assert.equal(control().hidden, false);
    host.app.workspace.activeEditor = { file: { path: 'Reading.md' }, editor: {
      getSelection: () => 'contribution', getCursor: (side: string) => ({ line: 0, ch: side === 'from' ? 0 : 12 }),
      lineCount: () => 1, getLine: () => 'contribution 中文', getRange: () => ''
    } };
    const outside = doc.createElement('span'); outside.textContent = 'Outside the note'; doc.body.append(outside);
    const outsideRange = doc.createRange(); outsideRange.selectNodeContents(outside);
    win.getSelection().removeAllRanges(); win.getSelection().addRange(outsideRange);
    doc.dispatchEvent(new win.Event('selectionchange')); await waitForSelection();
    assert.equal(control().hidden, true);
    host.app.workspace.activeEditor = null; select(0, 12); await waitForSelection(); assert.equal(control().hidden, false);
    control().dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
    const next = doc.createElement('div'); next.textContent = 'A different note'; doc.body.append(next);
    host.app.workspace.activeFileView = { file: { path: 'Other.md' }, containerEl: next };
    control().click(); await host.settle(); assert.equal(host.requests.length, 0);
    host.app.workspace.emit('file-open', { path: 'Other.md' });
    doc.dispatchEvent(new win.Event('selectionchange')); await waitForSelection();
    assert.equal(control().hidden, true);
    assert.equal(host.requests.length + host.pronunciationRequests.length + host.audioRequests.length, 0);
  } finally { await host.close(); }
});

test('mobile touch action follows the visible top and the reading card stays above the keyboard', async () => {
  const host = await createHost(await bundlePromise, { settings: { model: 'test-model' } }, responder, undefined, undefined, {
    mobile: true, visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 }
  });
  try {
    const { win, doc, select, control } = note(host);
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 844, configurable: true });
    select(0, 12); await waitForSelection();
    assert.equal(control().style.getPropertyValue('--ef-mobile-viewport-top'), '0px');
    const viewport = win.visualViewport;
    viewport.height = 400; viewport.offsetTop = 44; viewport.dispatchEvent(new win.Event('resize'));
    assert.equal(control().style.getPropertyValue('--ef-mobile-viewport-top'), '44px');
    control().click(); await host.settle();
    const card = doc.querySelector('.ef-popover');
    assert.equal(card.style.width, '366px'); assert.equal(card.style.maxHeight, '376px');
    assert.ok(parseFloat(card.style.top) >= 56); assert.ok(parseFloat(card.style.top) + 320 <= 432);
    viewport.height = 280; viewport.offsetTop = 60; viewport.dispatchEvent(new win.Event('resize'));
    assert.equal(card.style.maxHeight, '256px'); assert.equal(card.style.top, '72px');
    assert.ok(host.plugin.readingPopover);
  } finally { await host.close(); }
});

test('mobile cleanup cancels pending selection UI and desktop remains shortcut-only by default', async () => {
  const bundle = await bundlePromise;
  const mobile = await createHost(bundle, {}, responder, undefined, undefined, { mobile: true });
  try {
    const { doc, select } = note(mobile);
    select(0, 12); mobile.plugin.onunload(); await waitForSelection();
    assert.equal(doc.querySelector('.ef-mobile-selection-action'), null); assert.equal(mobile.requests.length, 0);
  } finally { await mobile.close(); }
  const desktop = await createHost(bundle, {}, responder);
  try {
    const { doc, select } = note(desktop);
    select(0, 12); await waitForSelection();
    assert.equal(doc.querySelector('.ef-mobile-selection-action'), null); assert.equal(desktop.requests.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(desktop.commands.get('explain-selection').hotkeys)), [{ modifiers: ['Mod'], key: 'r' }]);
  } finally { await desktop.close(); }
});
