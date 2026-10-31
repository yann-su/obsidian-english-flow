import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PronunciationClient, SpeechPlayer, recordingUrl } from '../src/pronunciation';
import { PublicAudioClient, speechChunks, type AudioClip } from '../src/public-audio';
const recording='https://api.dictionaryapi.dev/media/pronunciations/en/contribution-us.mp3';
const data=[{word:'contribution',phonetics:[{text:'/ˌkɒntɹɪˈbjuːʃən/',audio:''},{text:'/ˌkɑntɹɪˈbjuʃən/',audio:recording}],sourceUrls:['https://en.wiktionary.org/wiki/contribution']}];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const mp3=()=>{const bytes=new Uint8Array(128);bytes.set([0x49,0x44,0x33]);return bytes.buffer;};
const clip=():AudioClip=>({data:mp3(),mime:'audio/mpeg',provider:'youdao'});
const offline={load:async():Promise<AudioClip>=>{throw new Error('offline');}};
function speechHost(voices=[{name:'Chinese',lang:'zh-CN',localService:true},{name:'English',lang:'en-US',localService:true}]) {
  const dom=new JSDOM('');
  const spoken:any[]=[];
  const synth={getVoices:()=>voices,cancel(){},addEventListener(){},removeEventListener(){},speak(utterance:any){spoken.push(utterance);queueMicrotask(()=>utterance.onstart?.());}};
  Object.defineProperty(dom.window,'speechSynthesis',{value:synth});
  Object.defineProperty(dom.window,'SpeechSynthesisUtterance',{value:class {constructor(public text:string) {}}});
  const urls=new Set<string>();let sequence=0;
  dom.window.URL.createObjectURL=()=>{const url=`blob:test-${++sequence}`;urls.add(url);return url;};
  dom.window.URL.revokeObjectURL=url=>urls.delete(url);
  return {dom,spoken,synth,urls};
}
test('dictionary pronunciation is cached and deduplicated, with audio prioritized over bare IPA',async()=>{
  const urls:string[]=[];
  const client=new PronunciationClient(async url=>{urls.push(url);return{status:200,text:JSON.stringify(data)};});
  const [one,two]=await Promise.all([client.lookup('Contribution'),client.lookup('contribution')]);
  assert.equal(urls.length,1);assert.equal(urls[0],'https://api.dictionaryapi.dev/api/v2/entries/en/contribution');
  assert.deepEqual(one,two);assert.equal(one.entries[0].accent,'美音');assert.equal(one.entries[0].audio,recording);
  assert.equal(one.entries[0].phonetic,'/ˌkɑntɹɪˈbjuʃən/');
  assert.equal(one.sourceUrl,'https://en.wiktionary.org/wiki/contribution');
  await client.lookup('contribution');assert.equal(urls.length,1);
  await client.lookup('a private sentence');await client.lookup('中文');assert.equal(urls.length,1);
});
test('unavailable dictionary data does not block AI, invent IPA, or cache a transient outage',async()=>{
  let calls=0;
  const client=new PronunciationClient(async()=>{calls++;return calls===1?{status:503,text:''}:{status:200,text:JSON.stringify(data)};});
  assert.deepEqual((await client.lookup('contribution')).entries,[]);
  assert.equal((await client.lookup('contribution')).entries.length,2);assert.equal(calls,2);
  const stalled=new PronunciationClient(()=>new Promise(()=>{}),5);
  assert.deepEqual((await stalled.lookup('hello')).entries,[]);
});
test('dictionary audio accepts only HTTPS recordings on the expected hosts',()=>{
  assert.equal(recordingUrl(recording),recording);
  for(const url of ['javascript:alert(1)','http://api.dictionaryapi.dev/a.mp3','https://evil.example/a.mp3','https://user:secret@api.dictionaryapi.dev/a.mp3','https://api.dictionaryapi.dev/a.mp3?token=private','https://api.dictionaryapi.dev/a.html']) assert.equal(recordingUrl(url),'');
});
test('downloaded audio plays from a Blob without English voices and revokes URLs on completion and stop',async()=>{
  const {dom,spoken,urls}=speechHost([]);const played:any[]=[];const states:string[]=[];
  class FakeAudio {onplaying:Function|null=null;onended:Function|null=null;onerror:Function|null=null;paused=false;playbackRate=1;constructor(public src:string){played.push(this);}async play(){this.onplaying?.();}pause(){this.paused=true;}removeAttribute(){}}
  Object.defineProperty(dom.window,'Audio',{value:FakeAudio});
  const player=new SpeechPlayer({load:async()=>clip()});
  try{
    const first=player.play('contribution',dom.window.document,{changed:s=>states.push(s),rate:.75});
    await tick();assert.match(played[0].src,/^blob:/);assert.equal(states.at(-1),'playing');assert.equal(played[0].playbackRate,.75);assert.equal(played[0].preservesPitch,true);
    played[0].onended();await first;assert.equal(states.at(-1),'ended');assert.equal(urls.size,0);assert.equal(spoken.length,0);
    const second=player.play('contribution',dom.window.document);await tick();player.stop();await second;assert.equal(played[1].paused,true);assert.equal(urls.size,0);
  }finally{player.stop();dom.window.close();}
});
test('unavailable public sources fall back to an English voice with the requested slow rate',async()=>{
  const {dom,spoken}=speechHost();
  Object.defineProperty(dom.window,'Audio',{value:class{pause(){}removeAttribute(){}async play(){throw new Error('audio unavailable');}}});
  const player=new SpeechPlayer(offline);
  try{
    const running=player.play('A useful example.',dom.window.document,{rate:.75});
    await tick();assert.equal(spoken[0].text,'A useful example.');assert.equal(spoken[0].voice.lang,'en-US');assert.equal(spoken[0].rate,.75);
    spoken[0].onend();await running;
  }finally{player.stop();dom.window.close();}
});
test('a missing English voice or a silent speech engine is reported instead of claiming playback',async()=>{
  const noEnglish=speechHost([{name:'Chinese',lang:'zh-CN',localService:true}]);
  try{await assert.rejects(new SpeechPlayer(offline).play('hello',noEnglish.dom.window.document),/没有可用的英语语音/);}finally{noEnglish.dom.window.close();}
  const silent=speechHost();silent.synth.speak=()=>{};
  try{await assert.rejects(new SpeechPlayer(offline,5).play('hello',silent.dom.window.document),/没有启动/);}finally{silent.dom.window.close();}
});
test('dismissing a card during pronunciation lookup prevents late audio from starting',async()=>{
  const {dom,spoken,urls}=speechHost();let finish:(clip:AudioClip)=>void=()=>{};
  const player=new SpeechPlayer({load:()=>new Promise(resolve=>{finish=resolve;})});
  try{
    const running=player.play('hello',dom.window.document);
    player.stop();finish(clip());await running;assert.equal(spoken.length,0);assert.equal(urls.size,0);
  }finally{player.stop();dom.window.close();}
});
test('public speech defaults to Youdao, separates UK and US, caches audio and rejects HTTP error pages',async()=>{
  const urls:string[]=[];
  const client=new PublicAudioClient(async url=>{urls.push(url);return {status:200,mime:'audio/mpeg',data:mp3()};});
  const [one,two]=await Promise.all([client.load('contribution','us'),client.load('contribution','us')]);
  assert.equal(one.provider,'youdao');assert.equal(one,two);assert.equal(urls.length,1);
  assert.equal(new URL(urls[0]).hostname,'dict.youdao.com');assert.equal(new URL(urls[0]).searchParams.get('type'),'2');
  await client.load('contribution','us');assert.equal(urls.length,1);
  await client.load('contribution','uk');assert.equal(new URL(urls[1]).searchParams.get('type'),'1');
  const fallback=new PublicAudioClient(async url=>url.includes('youdao')?{status:500,mime:'text/html',data:mp3()}:{status:200,mime:'audio/mpeg',data:mp3()});
  assert.equal((await fallback.load('She made a contribution.')).provider,'google');
  const html=new PublicAudioClient(async()=>({status:200,mime:'text/html',data:new TextEncoder().encode('<html>'+'.'.repeat(100)+'</html>').buffer}));
  await assert.rejects(html.load('hello'),/公开发音来源/);
});
test('timeouts and failed public downloads can be retried, and long text is split at readable boundaries',async()=>{
  const client=new PublicAudioClient(()=>new Promise(()=>{}),5);
  await assert.rejects(client.load('hello'),/公开发音来源/);
  let attempts=0;
  const retry=new PublicAudioClient(async()=>{attempts++;if(attempts<=2)throw new Error('network');return{status:200,mime:'audio/mpeg',data:mp3()};});
  await assert.rejects(retry.load('hello'));await retry.load('hello');assert.equal(attempts,3);
  const text='A short English sentence. '.repeat(30).trim();const chunks=speechChunks(text);
  assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=180));assert.equal(chunks.join(' '),text);
});
