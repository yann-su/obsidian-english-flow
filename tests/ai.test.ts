import test from 'node:test';
import assert from 'node:assert/strict';
import { TutorClient, type HttpRequest, type HttpResponse } from '../src/ai';
import { DEMO_ANALYSIS } from '../src/model';
import { DEFAULT_SETTINGS, endpointUrl, loadSettings } from '../src/settings';
import { savedCard, SOURCE } from './helpers';
const settings = () => loadSettings({ ...DEFAULT_SETTINGS, model: 'test-model' });
const response = (content: unknown): HttpResponse => ({ status: 200, text: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) });
test('analysis sends only the selected passage and nearby context in the expected JSON request', async () => {
  let request: HttpRequest | undefined;
  const client = new TutorClient(async value => { request = value; return response(DEMO_ANALYSIS); }, settings, () => 'test-secret');
  assert.deepEqual(await client.explain(SOURCE), DEMO_ANALYSIS);
  assert.equal(request?.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request?.headers.Authorization, 'Bearer test-secret');
  const body = JSON.parse(request!.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_completion_tokens, 2600);
  assert.doesNotMatch(request!.body, /test-secret|Reading\/Coffee/);
  assert.deepEqual(JSON.parse(body.messages[1].content).studyData, { selection: SOURCE.quote, surroundingContext: SOURCE.context });
});
test('feedback accepts different valid wording and separates corrections from optional style', async () => {
  const result = { verdict: 'correct', meaning: '意思正确', corrections: [], naturalAlternative: '', explanation: '你的表达已经合适。' };
  const client = new TutorClient(async () => response(result), settings, () => 'key');
  assert.deepEqual(await client.assess(await savedCard(), 'I ended up getting takeout.'), result);
});
test('unsupported JSON mode and legacy token parameters are configurable', async () => {
  let body: Record<string, unknown> = {};
  const client = new TutorClient(async r => { body = JSON.parse(r.body); return response(DEMO_ANALYSIS); }, () => ({ ...settings(), jsonMode: false, legacyTokens: true }), () => 'key');
  await client.explain(SOURCE);
  assert.equal(body.response_format, undefined);
  assert.equal(body.max_tokens, 2600);
  assert.equal(body.max_completion_tokens, undefined);
});
test('malformed, truncated, refused and structurally invalid outputs never become learning data', async () => {
  const invalid = [
    { status: 200, text: 'not JSON' },
    { status: 200, text: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) },
    { status: 200, text: JSON.stringify({ choices: [{ message: { refusal: 'no', content: null } }] }) },
    response({ ...DEMO_ANALYSIS, expressions: [] })
  ];
  for (const value of invalid) {
    const client = new TutorClient(async () => value, settings, () => 'key');
    await assert.rejects(client.explain(SOURCE));
  }
});
test('errors never echo raw provider bodies, URLs with credentials, or transport messages', async () => {
  const client = new TutorClient(async () => ({ status: 401, text: 'secret-credential-123' }), settings, () => 'secret-credential-123');
  await assert.rejects(client.explain(SOURCE), error => error instanceof Error && !error.message.includes('secret-credential-123'));
  const transportError = new TutorClient(async () => { throw new Error('secret-credential-123'); }, settings, () => 'key');
  await assert.rejects(transportError.explain(SOURCE), /无法连接 AI 服务/);
  for (const url of ['http://example.com/v1', 'https://user:pass@host/v1', 'https://host/v1?key=abc']) assert.throws(() => endpointUrl(url));
});
test('localhost can run without a key and a stalled provider times out without automatic retries', async () => {
  const local = new TutorClient(async () => response(DEMO_ANALYSIS), () => ({ ...settings(), endpoint: 'http://127.0.0.1:11434/v1' }), () => null);
  assert.deepEqual(await local.explain(SOURCE), DEMO_ANALYSIS);
  let count = 0;
  const hanging = new TutorClient(() => { count++; return new Promise(() => {}); }, settings, () => 'key', 10);
  await assert.rejects(hanging.explain(SOURCE), /请求超过/);
  assert.equal(count, 1);
});
test('selection and answer length are validated before sending any request', async () => {
  const client = new TutorClient(async () => { throw new Error('should not request'); }, settings, () => 'key');
  await assert.rejects(client.explain({ ...SOURCE, quote: 'x'.repeat(8001) }), /8000/);
  await assert.rejects(client.assess(await savedCard(), ''), /先填写/);
});
test('DeepSeek uses non-thinking requests and its supported token parameter by default', async () => {
  let body: Record<string, unknown> = {};
  const client = new TutorClient(async r => { body = JSON.parse(r.body); return response(DEMO_ANALYSIS); }, () => ({ ...settings(), endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', legacyTokens: false }), () => 'key');
  await client.explain({ ...SOURCE, quote: 'who' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 1800);
  assert.equal(body.max_completion_tokens, undefined);
  const user = JSON.parse((body.messages as { content: string }[])[1]!.content);
  assert.match(user.task, /ONE expression/);
  assert.match(user.task, /grammar: \[\]/);
});
test('DeepSeek deep thinking can be enabled and its vendor-specific fields do not reach other providers', async () => {
  let body: Record<string, unknown> = {};
  const client = new TutorClient(async r => { body = JSON.parse(r.body); return response(DEMO_ANALYSIS); }, () => ({ ...settings(), endpoint: 'https://api.deepseek.com', deepseekFast: false }), () => 'key');
  await client.explain(SOURCE);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  const generic = new TutorClient(async r => { body = JSON.parse(r.body); return response(DEMO_ANALYSIS); }, settings, () => 'key');
  await generic.explain(SOURCE);
  assert.equal(body.thinking, undefined);
});
test('repeated and simultaneous lookups share a request; cached output is isolated from caller mutation', async () => {
  let count = 0;
  const client = new TutorClient(async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return response(DEMO_ANALYSIS); }, settings, () => 'key');
  const [one, two] = await Promise.all([client.explain(SOURCE), client.explain(SOURCE)]);
  assert.deepEqual(one, two); assert.equal(count, 1); assert.equal(client.isCached(SOURCE), true);
  one.expressions[0]!.meaning = 'Changed locally';
  assert.deepEqual(await client.explain(SOURCE), DEMO_ANALYSIS);
  await client.explain({ ...SOURCE, context: 'Different surrounding sentence' });
  assert.equal(count, 2);
  await client.explain(SOURCE, true); assert.equal(count, 3);
  client.clearCache(); assert.equal(client.isCached(SOURCE), false);
});
test('failed requests are not cached, and the session cache is bounded', async () => {
  let count = 0;
  const client = new TutorClient(async () => { count++; return count === 1 ? { status: 500, text: '' } : response(DEMO_ANALYSIS); }, settings, () => 'key');
  await assert.rejects(client.explain(SOURCE));
  assert.equal(client.isCached(SOURCE), false);
  await client.explain(SOURCE);
  for (let i = 0; i < 20; i++) await client.explain({ ...SOURCE, quote: `word-${i}` });
  assert.equal(client.isCached(SOURCE), false);
});
test('a word lookup targets the selected word itself and a short unpunctuated sentence includes key vocabulary', async () => {
  const requests: Record<string, unknown>[] = [];
  const client = new TutorClient(async r => { requests.push(JSON.parse(r.body)); return response(DEMO_ANALYSIS); }, settings, () => 'key');
  await client.explain({ ...SOURCE, quote: 'dominant' });
  let user = JSON.parse((requests[0]!.messages as { content: string }[])[1]!.content);
  assert.match(user.task, /SINGLE WORD lookup/);
  assert.equal(user.outputShape.expressions[0].phrase, 'dominant');
  assert.match(user.task, /part of speech/);
  await client.explain({ ...SOURCE, quote: 'I am tired' });
  user = JSON.parse((requests[1]!.messages as { content: string }[])[1]!.content);
  assert.match(user.task, /SENTENCE lookup/);
  assert.match(user.task, /meaning of the WHOLE selected sentence/);
  assert.match(user.task, /ONE to THREE important words/);
  assert.equal(requests[1]!.max_completion_tokens, 2600);
});
test('a sentence requests a complete translation separately and keeps only aligned exact-quote translation chunks',async()=>{
  let user:any;
  const result={...DEMO_ANALYSIS,translation:'虽然我很累，但我仍继续阅读。',translationChunks:[
    {english:'Although I was tired',chinese:'虽然我很累',note:'让步背景。'},
    {english:'an invented clause',chinese:'这部分不在原文中',note:''},
    {english:'I kept reading',chinese:'我仍继续阅读',note:'keep doing 表示继续做。'}
  ]};
  const client=new TutorClient(async r=>{user=JSON.parse(JSON.parse(r.body).messages[1].content);return response(result);},settings,()=> 'key');
  const actual=await client.explain({...SOURCE,quote:'Although I was tired, I kept reading.'});
  assert.equal(actual.translation,result.translation);
  assert.deepEqual(actual.translationChunks?.map(c=>c.english),['Although I was tired','I kept reading']);
  assert.ok(Array.isArray(user.outputShape.translationChunks));
  assert.match(user.task,/actual translation, not a paraphrase/);
  assert.match(user.task,/EXACT substring/);
});
test('old analysis without clause translations remains valid and malformed clause translations are rejected',async()=>{
  const old=new TutorClient(async()=>response(DEMO_ANALYSIS),settings,()=> 'key');
  assert.deepEqual(await old.explain(SOURCE),DEMO_ANALYSIS);
  for(const chunks of [null, [{english:'quoted text',chinese:''}], Array.from({length:5},()=>({english:'x',chinese:'译文',note:''}))]){
    const invalid=new TutorClient(async()=>response({...DEMO_ANALYSIS,translationChunks:chunks}),settings,()=> 'key');
    await assert.rejects(invalid.explain(SOURCE),/字段不完整/);
  }
});
