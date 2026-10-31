import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHost } from './host.mjs';
import { DEMO_ANALYSIS, type Analysis } from '../src/model';
const bundlePromise = build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'], platform: 'browser', format: 'cjs', target: 'es2022', write: false }).then(r => r.outputFiles![0]!.text);
const liveSettings = { model: 'test-model' };
const feedback = { verdict: 'correct', meaning: '表达了原本打算做饭、后来点了外卖的意思。', corrections: [], naturalAlternative: '', explanation: 'ended up 后用了 ordering，搭配合适。' };
const wordAnalysis: Analysis = {
  summary: '所查单词是 Listing，在此语境中表示列出的名单，即文末名单中各成员的排列。',
  simpleEnglish: 'a list of names', translation: '名单；列表', grammar: [],
  expressions: [{ phrase: 'Listing', meaning: '名单；列表', pattern: '名词 · a listing of names（姓名列表）', example: 'You can find her name in the listing.', practicePrompt: '你在活动名单中找到了朋友的名字，告诉朋友。', referenceAnswer: 'I found your name in the listing.' }]
};

test('the actual plugin UI runs explanation → collection → transfer → recall and restores after restart', async () => {
  const bundle = await bundlePromise, host = await createHost(bundle);
  try {
    assert.ok(host.commands.has('explain-selection'));
    assert.ok(host.commands.has('daily-review'));
    await host.plugin.openDemo();
    assert.match(host.view().contentEl.textContent, /离线示例/);
    await host.click('收藏并练习');
    host.input('I was going to cook, but I ended up ordering takeout.');
    await host.click('查看参考表达');
    await host.click('保存练习');
    let snapshot = await host.plugin.store(true).load();
    assert.equal(snapshot.cards.length, 1);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].type, 'practice');
    assert.equal(host.requests.length, 0);
    await host.click('每日复习');
    assert.doesNotMatch(host.view().contentEl.textContent, /end up doing something/);
    await host.click('揭晓并自评');
    assert.match(host.notices.at(-1), /请先作答/);
    host.input('I ended up ordering takeout.');
    await host.click('揭晓并自评');
    assert.equal(host.view().contentEl.querySelector('textarea').disabled, true);
    await host.click('顺利想起');
    snapshot = await host.plugin.store(true).load();
    assert.equal(snapshot.records.filter(r => r.type === 'review').length, 1);
    await host.click('想不起来');
    assert.equal(host.view().contentEl.querySelectorAll('.ef-grades button:disabled').length, 3);
    await host.click('忘记');
    assert.match(host.view().contentEl.textContent, /当前没有到期复习/);
    snapshot = await host.plugin.store(true).load();
    assert.equal(snapshot.records.filter(r => r.type === 'review').length, 2);
    assert.equal((await host.plugin.store(false).load()).cards.length, 0);
    await host.plugin.openView('review');
    await host.click('阅读讲解');
    assert.doesNotMatch(host.view().contentEl.textContent, /end up doing something/);
    assert.equal(host.view().demo, false);
    const restarted = await createHost(bundle, host.state);
    try {
      await restarted.plugin.openDemo(); await restarted.click('每日复习');
      assert.match(restarted.view().contentEl.textContent, /今日复习 2/);
      assert.equal(restarted.requests.length, 0);
    } finally { await restarted.close(); }
  } finally { await host.close(); }
});
test('real selection capture and AI feedback are wired through the configurable HTTP adapter', async () => {
  const bundle = await bundlePromise;
  const host = await createHost(bundle, { settings: liveSettings }, async r => {
    const task = JSON.parse(JSON.parse(r.body).messages[1].content).task;
    return { status: 200, text: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(task.startsWith('Give feedback') ? feedback : DEMO_ANALYSIS) } }] }) };
  });
  try {
    const text = 'Although I was worn out after work, I ended up meeting a friend for coffee.';
    host.state.files.set('Reading.md', text);
    const editor = {
      getSelection: () => 'worn out', getCursor: (side: string) => ({ line: 0, ch: side === 'from' ? 15 : 23 }), lineCount: () => 1, getLine: () => text,
      getRange: (from: { ch: number }, to: { ch: number }) => { assert.ok(to.ch <= text.length); return text.slice(from.ch, to.ch); }
    };
    await host.plugin.explainSelection(editor, 'Reading.md');
    assert.equal(host.requests.length, 1);
    const data = JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData;
    assert.equal(data.selection, 'worn out');
    assert.match(data.surroundingContext, /前文：\nAlthough I was /);
    assert.match(data.surroundingContext, /后文：\n after work/);
    host.view().contentEl.querySelector('details.ef-card-term').open = true;
    await host.click('收藏并练习');
    host.input('I ended up ordering takeout.');
    await host.click('AI 反馈并保存');
    assert.match(host.view().contentEl.textContent, /这次练习已保存/);
    assert.match(host.view().contentEl.textContent, /AI 判断：意思和用法合适/);
    const snapshot = await host.plugin.store(false).load();
    assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].type, 'practice');
    assert.equal(snapshot.records[0].feedback.verdict, 'correct');
    assert.equal(host.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(host.state.settings), /host-test-secret/);
    for (const file of host.state.files.values()) assert.doesNotMatch(file, /host-test-secret/);
  } finally { await host.close(); }
});
test('provider failure preserves the typed answer and permits saving without another request', async () => {
  const bundle = await bundlePromise;
  let count = 0;
  const host = await createHost(bundle, { settings: liveSettings }, async () => {
    count++;
    if (count > 1) return { status: 429, text: 'private service error' };
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) };
  });
  try {
    await (await host.plugin.openView('explain')).explain({ path: '', line: 0, quote: 'I ended up buying it.', context: '' });
    await host.click('收藏并练习'); host.input('My own sentence.');
    await host.click('AI 反馈并保存');
    assert.match(host.view().contentEl.textContent, /限流或额度不足/);
    assert.equal(host.view().contentEl.querySelector('textarea').value, 'My own sentence.');
    assert.equal((await host.plugin.store().load()).records.length, 0);
    await host.click('保存练习');
    assert.equal((await host.plugin.store().load()).records.length, 1);
    assert.equal(host.requests.length, 2);
  } finally { await host.close(); }
});
test('synced changes invalidate a stale review instead of silently advancing an old schedule', async () => {
  const bundle = await bundlePromise, host = await createHost(bundle);
  try {
    await host.plugin.openDemo(); await host.click('收藏并练习'); await host.click('每日复习');
    host.input('A sentence'); await host.click('揭晓并自评');
    const repo = host.plugin.store(true), snapshot = await repo.load();
    await repo.review(snapshot.cards[0], 'production', 3, 'From another device');
    await host.click('顺利想起');
    assert.match(host.notices.at(-1), /其他地方更新/);
    assert.equal((await repo.load()).records.length, 1);
  } finally { await host.close(); }
});
test('untrusted passage markup is rendered as text, and corrupted records pause review', async () => {
  const bundle = await bundlePromise, host = await createHost(bundle);
  try {
    await host.plugin.openDemo();
    await host.view().showDemo({ path: '', line: 0, quote: '<img src=x onerror=alert(1)>', context: '<script>bad()</script>' });
    assert.equal(host.view().contentEl.querySelectorAll('img, script').length, 0);
    await host.click('收藏并练习');
    host.state.files.set('English Flow/Demo/Records/broken.md', 'not a learning file');
    await host.click('每日复习');
    assert.match(host.view().contentEl.textContent, /请先检查上方文件提示/);
    assert.equal(host.view().contentEl.querySelectorAll('textarea').length, 0);
  } finally { await host.close(); }
});
test('rapidly clicking save and feedback cannot duplicate the same practice submission', async () => {
  const bundle = await bundlePromise;
  const host = await createHost(bundle, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) }));
  try {
    await (await host.plugin.openView('explain')).explain({ path: '', line: 0, quote: 'I ended up buying it.', context: '' });
    await host.click('收藏并练习'); host.input('I ended up buying it.');
    const controls = [...host.view().contentEl.querySelectorAll('button')];
    const save = controls.find(b => b.textContent === '保存练习')!;
    const feedbackButton = controls.find(b => b.textContent === 'AI 反馈并保存')!;
    save.click(); feedbackButton.click(); save.click(); await host.settle();
    assert.equal((await host.plugin.store().load()).records.length, 1);
    assert.equal(host.requests.length, 1);
  } finally { await host.close(); }
});
test('foreground refresh preserves an in-progress recall and daily limits stop additional tasks', async () => {
  const bundle = await bundlePromise, host = await createHost(bundle);
  try {
    await host.plugin.openDemo(); await host.click('收藏并练习'); await host.click('每日复习');
    host.input('Still thinking about my answer');
    await host.view().onForeground();
    assert.equal(host.view().contentEl.querySelector('textarea').value, 'Still thinking about my answer');
    host.plugin.settings.dailyLimit = 5;
    const repo = host.plugin.store(true), snapshot = await repo.load();
    for (let i = 0; i < 5; i++) await repo.review(snapshot.cards[0], 'recognition', 3, 'a');
    await host.click('每日复习');
    assert.match(host.view().contentEl.textContent, /今天的复习额度已完成/);
    assert.equal(host.view().contentEl.querySelectorAll('textarea').length, 0);
  } finally { await host.close(); }
});
test('selection opens an anchored card immediately without a modal or reading the learning collection', async () => {
  const bundle = await bundlePromise;
  let resolveResponse: (value: unknown) => void = () => {};
  const host = await createHost(bundle, { settings: liveSettings }, () => new Promise(resolve => { resolveResponse = resolve; }));
  try {
    const originalRead = host.app.vault.read;
    host.app.vault.read = async () => { throw new Error('The explanation path must not read learning files'); };
    const running = host.plugin.explainSource({ path: '', line: 0, quote: 'who', context: 'Who are you?' });
    assert.equal(host.dom.window.document.querySelectorAll('.ef-popover').length, 1);
    assert.equal(host.dom.window.document.querySelectorAll('.modal, .modal-container').length, 0);
    assert.equal(host.app.workspace.getLeavesOfType('english-reading-flow-view').length, 0);
    assert.match(host.view().contentEl.textContent, /正在理解/);
    assert.equal(host.requests.length, 1);
    resolveResponse({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) });
    await running;
    assert.ok(host.view().contentEl.querySelector('.ef-card-definition'));
    host.app.vault.read = originalRead;
    await host.plugin.explainSource({ path: '', line: 0, quote: 'who', context: 'Who are you?' });
    assert.equal(host.requests.length, 1);
    assert.doesNotMatch(host.view().contentEl.textContent, /本次讲解用时|无需再次请求/);
    assert.equal(host.dom.window.document.querySelectorAll('.ef-popover').length, 1);
  } finally { await host.close(); }
});
test('closing a loading explanation prevents late responses from redrawing a dismissed card', async () => {
  const bundle = await bundlePromise;
  let resolveResponse: (value: unknown) => void = () => {};
  const host = await createHost(bundle, { settings: liveSettings }, () => new Promise(resolve => { resolveResponse = resolve; }));
  try {
    const running = host.plugin.explainSource({ path: '', line: 0, quote: 'hello', context: '' });
    host.plugin.readingPopover.close();
    assert.equal(host.plugin.readingPopover, null);
    assert.equal(host.dom.window.document.querySelectorAll('.ef-popover').length, 0);
    resolveResponse({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) });
    await running;
    assert.equal(host.dom.window.document.querySelectorAll('.ef-popover').length, 0);
    assert.equal((await host.plugin.store().load()).records.length, 0);
  } finally { await host.close(); }
});
test('selected PDF text opens the explanation directly without an intermediate button and reuses the command cache', async () => {
  const bundle = await bundlePromise;
  const host = await createHost(bundle, { settings: { ...liveSettings, autoExplain: true } }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) }));
  try {
    const doc = host.dom.window.document;
    const pdf = doc.createElement('div'); const span = doc.createElement('span'); span.textContent = 'The dominant sequence transduction models'; pdf.append(span); doc.body.append(pdf);
    host.app.workspace.activeFileView = { file: { path: 'paper.pdf' }, containerEl: pdf };
    let selectionVisible = true;
    host.dom.window.Range.prototype.getBoundingClientRect = () => selectionVisible
      ? ({ left: 120, right: 175, top: 80, bottom: 100, width: 55, height: 20 })
      : ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    const range = doc.createRange(); range.setStart(span.firstChild, 4); range.setEnd(span.firstChild, 12);
    const selection = host.dom.window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    span.dispatchEvent(new host.dom.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    assert.equal(doc.querySelector('.ef-selection-action'), null);
    assert.equal(host.requests.length, 0);
    await new Promise(resolve => setTimeout(resolve, 200)); await host.settle();
    selectionVisible = false;
    assert.equal(doc.querySelectorAll('.ef-popover').length, 1);
    assert.equal(doc.querySelectorAll('.modal').length, 0);
    assert.equal(doc.querySelector('.ef-popover').style.left, '120px');
    assert.equal(doc.querySelector('.ef-popover').style.top, '108px');
    assert.equal(host.requests.length, 1);
    const sent = JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData;
    assert.equal(sent.selection, 'dominant');
    assert.equal(sent.surroundingContext, '');
    host.plugin.readingPopover.close();
    assert.equal(host.commands.get('explain-selection').checkCallback(true), true);
    host.commands.get('explain-selection').checkCallback(false); await host.settle();
    assert.equal(host.requests.length, 1);
    assert.doesNotMatch(host.view().contentEl.textContent, /无需再次请求/);
  } finally { await host.close(); }
});
test('automatic lookup respects its switch, cancels stale selections and ignores inputs and non-English selections', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(wordAnalysis) } }] }) }));
  try {
    const doc=host.dom.window.document, win=host.dom.window;
    const note=doc.createElement('div'), text=doc.createElement('span'); text.textContent='contribution 中文'; note.append(text); doc.body.append(note);
    const input=doc.createElement('input'); input.value='contribution'; note.append(input);
    host.app.workspace.activeFileView={file:{path:'Reading.md'},containerEl:note};
    win.Range.prototype.getBoundingClientRect=()=>({left:30,right:90,top:40,bottom:60,width:60,height:20});
    const select=(start:number,end:number)=>{const r=doc.createRange(); r.setStart(text.firstChild,start);r.setEnd(text.firstChild,end);win.getSelection().removeAllRanges();win.getSelection().addRange(r);};
    const up=(target:HTMLElement, options={})=>target.dispatchEvent(new win.MouseEvent('mouseup',{bubbles:true,button:0,...options}));
    host.plugin.settings.autoExplain=false; select(0,12);up(text);
    await new Promise(resolve=>setTimeout(resolve,200));assert.equal(host.requests.length,0);
    host.plugin.settings.autoExplain=true;
    up(text);doc.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,200));assert.equal(host.requests.length,0);
    up(input);select(13,15);up(text);
    await new Promise(resolve=>setTimeout(resolve,200));assert.equal(host.requests.length,0);
    select(0,12);up(text,{metaKey:true});
    await new Promise(resolve=>setTimeout(resolve,200));assert.equal(host.requests.length,0);
    up(text);select(0,4);up(text);
    await new Promise(resolve=>setTimeout(resolve,200));await host.settle();
    assert.equal(host.requests.length,1);
    assert.equal(JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData.selection,'cont');
    assert.equal(doc.querySelector('.ef-selection-action'),null);
  } finally {await host.close();}
});
test('a word card loads real phonetic data separately and plays recording only after the sound button is clicked', async () => {
  const dictionary=[{word:'contribution',phonetics:[{text:'/ˌkɑntɹɪˈbjuʃən/',audio:'https://api.dictionaryapi.dev/media/pronunciations/en/contribution-us.mp3'}],sourceUrls:['https://en.wiktionary.org/wiki/contribution']}];
  const host=await createHost(await bundlePromise,{settings:liveSettings},async()=>({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(wordAnalysis)}}]})}),async()=>({status:200,text:JSON.stringify(dictionary)}));
  const played:any[]=[];
  class AudioMock {onplaying:Function|null=null;onended:Function|null=null;onerror:Function|null=null;playbackRate=1;paused=false;constructor(public url:string){played.push(this);}async play(){this.onplaying?.();}pause(){this.paused=true;}removeAttribute(){}}
  host.dom.window.Audio=AudioMock;
  try {
    await host.plugin.explainSource({path:'Reading.md',line:0,quote:'contribution',context:'Private nearby paragraph'});await host.settle();
    const root=host.dom.window.document.querySelector('.ef-popover');
    assert.match(root.querySelector('.ef-phonetic').textContent,/ˌkɑntɹɪˈbjuʃən/);
    assert.equal(host.pronunciationRequests.length,1);assert.equal(played.length,0);
    const request=host.pronunciationRequests[0];assert.equal(request.method,'GET');assert.equal(request.headers,undefined);assert.equal(request.body,undefined);assert.doesNotMatch(request.url,/Private|secret/);
    const sound=root.querySelector('.ef-popover-pronunciation button');sound.click();await host.settle();
    assert.equal(played.length,1);assert.match(played[0].url,/^blob:/);assert.equal(sound.dataset.playback,'playing');
    assert.equal(host.audioRequests.length,1);assert.equal(new URL(host.audioRequests[0].url).hostname,'dict.youdao.com');
    assert.equal(new URL(host.audioRequests[0].url).searchParams.get('audio'),'contribution');
    assert.equal(host.audioRequests[0].headers.Authorization,undefined);assert.doesNotMatch(host.audioRequests[0].url,/Private|secret/);
    played[0].onended();await host.settle();assert.equal(sound.dataset.playback,'ended');assert.match(sound.textContent,/再听/);
    sound.click();await host.settle();host.plugin.readingPopover.close();await host.settle();assert.equal(played[1].paused,true);assert.equal(host.audioObjects.size,0);assert.equal(host.audioRequests.length,1);
  }finally{await host.close();}
});
test('phonetic loading never replaces a playing Youdao button or loses its stop action',async()=>{
  let finishDictionary:(value:unknown)=>void=()=>{};
  const host=await createHost(await bundlePromise,{settings:liveSettings},async()=>({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(wordAnalysis)}}]})}),()=>new Promise(resolve=>{finishDictionary=resolve;}));
  const played:any[]=[];
  host.dom.window.Audio=class{onplaying:Function|null=null;onended:Function|null=null;onerror:Function|null=null;paused=false;constructor(){played.push(this);}async play(){this.onplaying?.();}pause(){this.paused=true;}removeAttribute(){}};
  try{
    await host.plugin.explainSource({path:'Reading.md',line:0,quote:'contribution',context:''});
    const root=host.dom.window.document.querySelector('.ef-popover'),sound=root.querySelector('.ef-popover-pronunciation button');
    sound.click();await host.settle();assert.equal(sound.dataset.playback,'playing');
    finishDictionary({status:200,text:JSON.stringify([{word:'contribution',phonetics:[{text:'/test/',audio:''}]}])});await host.settle();
    assert.equal(root.querySelector('.ef-popover-pronunciation button'),sound);assert.equal(sound.dataset.playback,'playing');
    sound.click();await host.settle();assert.equal(played[0].paused,true);assert.equal(sound.dataset.playback,'idle');assert.equal(host.audioObjects.size,0);
  }finally{await host.close();}
});
test('automatic explanation waits for the active editor to settle even when the DOM selection is collapsed',async()=>{
  const host=await createHost(await bundlePromise,{settings:{...liveSettings,autoExplain:true}},async()=>({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(wordAnalysis)}}]})}));
  try{
    const doc=host.dom.window.document,note=doc.createElement('div');note.textContent='Equal contribution.';doc.body.append(note);
    note.dispatchEvent(new host.dom.window.MouseEvent('mouseup',{bubbles:true,button:0}));
    host.app.workspace.activeFileView={file:{path:'Reading.md'},containerEl:note};
    host.app.workspace.activeEditor={file:{path:'Reading.md'},editor:{getSelection:()=> 'contribution',getCursor:(side:string)=>({line:0,ch:side==='from'?6:18}),lineCount:()=>1,getLine:()=>note.textContent,getRange:(a:{ch:number},b:{ch:number})=>note.textContent.slice(a.ch,b.ch)}};
    await new Promise(resolve=>setTimeout(resolve,200));await host.settle();
    assert.equal(host.requests.length,1);assert.ok(host.plugin.readingPopover);
    assert.equal(JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData.selection,'contribution');
  }finally{await host.close();}
});
test('native selection changes also open a card without a mouseup or an extra confirmation button',async()=>{
  const host=await createHost(await bundlePromise,{settings:{...liveSettings,autoExplain:true}},async()=>({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(wordAnalysis)}}]})}));
  try{
    const doc=host.dom.window.document,note=doc.createElement('div');note.textContent='contribution';doc.body.append(note);
    host.app.workspace.activeFileView={file:{path:'Reading.md'},containerEl:note};
    const r=doc.createRange();r.selectNodeContents(note);doc.getSelection().removeAllRanges();doc.getSelection().addRange(r);
    doc.dispatchEvent(new host.dom.window.Event('selectionchange'));
    await new Promise(resolve=>setTimeout(resolve,200));await host.settle();
    assert.equal(host.requests.length,1);assert.ok(host.plugin.readingPopover);
    assert.equal(doc.querySelector('.ef-selection-action'),null);
    doc.dispatchEvent(new host.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    doc.dispatchEvent(new host.dom.window.Event('selectionchange'));
    await new Promise(resolve=>setTimeout(resolve,200));await host.settle();
    assert.equal(host.plugin.readingPopover,null);assert.equal(host.requests.length,1);
  }finally{await host.close();}
});
test('the default requires Mod+R: selection alone makes no request and an empty selection shows guidance', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(wordAnalysis)}}]})}));
  try {
    const command = host.commands.get('explain-selection');
    assert.equal(JSON.stringify(command.hotkeys), JSON.stringify([{ modifiers: ['Mod'], key: 'r' }]));
    assert.equal(command.checkCallback(true), true);
    assert.equal(command.checkCallback(false), true);
    assert.match(host.notices.at(-1), /请先选中/);
    assert.equal(host.requests.length, 0);
    assert.equal(host.plugin.readingPopover, null);
    assert.equal(host.plugin.settings.autoExplain, false);
    const doc=host.dom.window.document, word=doc.createElement('div');word.textContent='contribution';doc.body.append(word);
    host.app.workspace.activeFileView={file:{path:'Reading.md'},containerEl:word};
    const range=doc.createRange();range.selectNodeContents(word);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);
    word.dispatchEvent(new host.dom.window.MouseEvent('mouseup',{button:0,bubbles:true}));
    doc.dispatchEvent(new host.dom.window.Event('selectionchange'));
    await new Promise(resolve=>setTimeout(resolve,220));await host.settle();
    assert.equal(host.requests.length,0);assert.equal(host.pronunciationRequests.length,0);assert.equal(host.audioRequests.length,0);assert.equal(host.plugin.readingPopover,null);
    command.checkCallback(false);await host.settle();
    assert.equal(host.requests.length,1);assert.ok(host.plugin.readingPopover);
    assert.equal(JSON.parse(JSON.parse(host.requests[0].body).messages[1].content).studyData.selection,'contribution');
  } finally { await host.close(); }
});
test('a word card shows one definition without duplicate explanations and a sentence folds vocabulary details', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async r => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(JSON.parse(JSON.parse(r.body).messages[1].content).studyData.selection === 'Listing' ? wordAnalysis : { ...DEMO_ANALYSIS, summary: `这句话的意思是：${DEMO_ANALYSIS.summary}` }) } }] }) }));
  try {
    await host.plugin.explainSource({ path: '', line: 0, quote: 'Listing', context: 'Listing order is random.' });
    const card = host.view().contentEl;
    assert.equal(card.querySelector('.ef-card-definition').textContent, '名单；列表');
    assert.equal(card.textContent.split('名单；列表').length - 1, 1);
    assert.equal(card.querySelectorAll('h2, h3, h4').length, 0);
    assert.doesNotMatch(card.textContent, /所查单词|单词讲解|这个单词的意思|用法与例句|本次讲解用时/);
    assert.match(card.querySelector('.ef-card-example').textContent, /You can find her name/);
    assert.equal(card.querySelector('.ef-card-context').open, false);
    const root = host.dom.window.document.querySelector('.ef-popover');
    assert.equal(root.querySelector('.ef-popover-title').textContent, 'Listing');
    assert.equal(root.style.width, '380px');
    assert.equal(root.querySelector('button.ef-popover-close').getAttribute('aria-label'), '关闭讲解');
    await host.plugin.explainSource({ path: '', line: 0, quote: 'I am tired', context: '' });
    const sentence = host.view().contentEl;
    assert.match(sentence.textContent, /中文翻译|重点词汇/);
    assert.equal(sentence.querySelector('.ef-card-translation-text').textContent, DEMO_ANALYSIS.translation);
    assert.equal(sentence.querySelector('.ef-card-translation-text').closest('details'), null);
    assert.equal(sentence.querySelector('.ef-card-summary').textContent, DEMO_ANALYSIS.summary);
    assert.equal(sentence.querySelectorAll('.ef-card-term:not([open])').length, DEMO_ANALYSIS.expressions.length);
    assert.equal(sentence.querySelectorAll('h2, h3, h4').length, 0);
    assert.equal(host.dom.window.document.querySelector('.ef-popover').style.width, '440px');
  } finally { await host.close(); }
});
test('sentence translation is visible before commentary and clause translations explain how to translate',async()=>{
  const result:Analysis={
    summary:'这里强调作者排序没有先后主次之分。',translation:'名单的排列顺序是随机的。',simpleEnglish:'The names are listed in no particular order.',
    translationChunks:[{english:'Listing order',chinese:'名单的排列顺序',note:'名词短语，作主语。'},{english:'is random',chinese:'是随机的',note:'random 是形容词，译为「随机的」。'}],
    expressions:[{...wordAnalysis.expressions[0]!,phrase:'random',meaning:'随机的',pattern:'形容词 · in random order',example:'The names are in random order.'}],grammar:[]
  };
  const host=await createHost(await bundlePromise,{settings:liveSettings},async()=>({status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]})}));
  try{
    const source={path:'Reading.md',line:0,quote:'Listing order is random',context:''};
    await host.plugin.explainSource(source);
    const card=host.view().contentEl, translation=card.querySelector('.ef-card-translation-text');
    assert.equal(translation.textContent,result.translation);assert.equal(translation.closest('details'),null);
    assert.ok(card.textContent.indexOf(result.translation)<card.textContent.indexOf(result.summary));
    assert.equal(card.querySelector('.ef-card-explanation').open,false);
    const chunks=card.querySelector('.ef-translation-chunks');assert.equal(chunks.open,false);chunks.open=true;
    assert.deepEqual([...chunks.querySelectorAll('.ef-translation-english')].map(e=>e.textContent),['Listing order','is random']);
    assert.deepEqual([...chunks.querySelectorAll('.ef-translation-chinese')].map(e=>e.textContent),['名单的排列顺序','是随机的']);
    assert.match(chunks.textContent,/形容词/);
    await host.plugin.explainSource(source);assert.equal(host.requests.length,1);
    assert.equal(host.view().contentEl.querySelector('.ef-card-translation-text').textContent,result.translation);
  }finally{await host.close();}
});
test('a word can be collected once and practiced from the same concise card', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(wordAnalysis) } }] }) }));
  try {
    await host.plugin.explainSource({ path: '', line: 0, quote: 'Listing', context: '' });
    const root = host.dom.window.document.querySelector('.ef-popover');
    await host.click('收藏表达');
    assert.equal((await host.plugin.store().load()).cards.length, 1);
    assert.equal(host.view().contentEl.querySelector('.ef-card-actions button').textContent, '已收藏');
    assert.equal(host.view().contentEl.querySelector('.ef-card-actions button').disabled, true);
    await host.click('收藏并练习');
    assert.equal(host.dom.window.document.querySelector('.ef-popover'), root);
    host.input('I found your name in the listing.'); await host.click('保存练习');
    await host.click('返回讲解');
    assert.equal(host.view().contentEl.querySelector('.ef-card-definition').textContent, '名单；列表');
    assert.equal((await host.plugin.store().load()).records.length, 1);
    assert.equal(host.requests.length, 1);
  } finally { await host.close(); }
});
test('the reading card closes on outside click or Escape and never changes the active note', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) }));
  try {
    const doc = host.dom.window.document;
    host.app.workspace.activeFileView = { file: { path: 'reading.md' }, containerEl: doc.body };
    await host.plugin.explainSource({ path: 'reading.md', line: 0, quote: 'dominant', context: '' });
    assert.equal(doc.querySelectorAll('.ef-popover .ef-nav').length, 0);
    assert.equal(host.app.workspace.getActiveFile().path, 'reading.md');
    doc.body.dispatchEvent(new host.dom.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(host.plugin.readingPopover, null);
    assert.equal(doc.querySelectorAll('.ef-popover').length, 0);
    await host.plugin.explainSource({ path: 'reading.md', line: 0, quote: 'dominant', context: '' });
    doc.dispatchEvent(new host.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(host.plugin.readingPopover, null);
    assert.equal(host.app.workspace.getActiveFile().path, 'reading.md');
    assert.equal(host.app.workspace.getLeavesOfType('english-reading-flow-view').length, 0);
  } finally { await host.close(); }
});
test('the anchored card stays inside a narrow viewport and closes when the reader scrolls', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) }));
  try {
    const win = host.dom.window, doc = win.document;
    Object.defineProperty(win, 'innerWidth', { value: 360, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 240, configurable: true });
    await host.plugin.explainSource({ path: '', line: 0, quote: 'dominant', context: '' }, { document: doc, rect: () => ({ left: 340, right: 355, top: 210, bottom: 225 }) });
    const root = doc.querySelector('.ef-popover');
    assert.equal(root.style.width, '336px');
    assert.equal(root.style.left, '12px');
    assert.equal(root.style.top, '12px');
    assert.equal(root.style.maxHeight, '216px');
    root.dispatchEvent(new win.Event('scroll', { bubbles: true }));
    assert.ok(host.plugin.readingPopover);
    doc.dispatchEvent(new win.Event('scroll'));
    assert.equal(host.plugin.readingPopover, null);
  } finally { await host.close(); }
});
test('collection and transfer practice stay inside the same card without opening a study page', async () => {
  const host = await createHost(await bundlePromise, { settings: liveSettings }, async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DEMO_ANALYSIS) } }] }) }));
  try {
    await host.plugin.explainSource({ path: '', line: 0, quote: 'I am tired', context: '' });
    const root = host.dom.window.document.querySelector('.ef-popover');
    host.view().contentEl.querySelector('details.ef-card-term').open = true;
    await host.click('收藏并练习');
    assert.equal(host.dom.window.document.querySelector('.ef-popover'), root);
    host.input('I ended up ordering takeout.'); await host.click('保存练习');
    await host.click('返回讲解');
    assert.match(host.view().contentEl.textContent, /中文翻译/);
    assert.equal(host.dom.window.document.querySelector('.ef-popover'), root);
    assert.equal(host.dom.window.document.querySelectorAll('.modal').length, 0);
    assert.equal(host.app.workspace.getLeavesOfType('english-reading-flow-view').length, 0);
    assert.equal((await host.plugin.store().load()).records.length, 1);
  } finally { await host.close(); }
});
