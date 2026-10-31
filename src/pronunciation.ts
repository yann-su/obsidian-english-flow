export interface Pronunciation {
  phonetic: string;
  audio: string;
  accent: '美音' | '英音' | '发音';
}
export interface WordPronunciation { entries: Pronunciation[]; sourceUrl: string }
type DictionaryGet = (url: string) => Promise<{ status: number; text: string }>;

export function dictionaryWord(text: string): string | null {
  const word = text.trim().replace(/^[^a-z]+|[^a-z'’\-]+$/gi, '').toLowerCase();
  return /^[a-z]+(?:['’\-][a-z]+)*$/.test(word) && word.length <= 80 ? word : null;
}
export function recordingUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1500) return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      ['api.dictionaryapi.dev', 'upload.wikimedia.org', 'ssl.gstatic.com'].includes(url.hostname) && /\.(mp3|ogg|wav)$/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}
export class PronunciationClient {
  private cache = new Map<string, WordPronunciation>();
  private inFlight = new Map<string, Promise<WordPronunciation | null>>();
  constructor(private get: DictionaryGet, private timeoutMs = 4500) {}
  async lookup(text: string): Promise<WordPronunciation> {
    const word = dictionaryWord(text), empty = { entries: [], sourceUrl: '' };
    if (!word) return empty;
    const cached = this.cache.get(word);
    if (cached) { this.cache.delete(word); this.cache.set(word, cached); return cached; }
    const existing = this.inFlight.get(word);
    if (existing) return (await existing) ?? empty;
    const pending = this.fetch(word);
    this.inFlight.set(word, pending);
    try {
      const result = await pending;
      if (result) {
        this.cache.set(word, result);
        while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return result ?? empty;
    } finally { if (this.inFlight.get(word) === pending) this.inFlight.delete(word); }
  }
  private async fetch(word: string): Promise<WordPronunciation | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); })
      ]);
      if (response.status === 404) return { entries: [], sourceUrl: '' };
      if (response.status !== 200 || response.text.length > 300_000) return null;
      const data: unknown = JSON.parse(response.text);
      if (!Array.isArray(data)) return null;
      const entries: Pronunciation[] = [];
      let sourceUrl = '';
      for (const raw of data.slice(0, 5)) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.word === 'string' && item.word.toLowerCase() !== word) continue;
        if (Array.isArray(item.sourceUrls)) sourceUrl ||= item.sourceUrls.find((s: unknown) => typeof s === 'string' && /^https:\/\/en\.wiktionary\.org\/wiki\//.test(s)) ?? '';
        const phonetics = Array.isArray(item.phonetics) ? item.phonetics : [];
        for (const rawPhonetic of phonetics) {
          if (!rawPhonetic || typeof rawPhonetic !== 'object') continue;
          const ph = rawPhonetic as Record<string, unknown>, audio = recordingUrl(ph.audio);
          const rawText = typeof ph.text === 'string' ? ph.text : typeof item.phonetic === 'string' ? item.phonetic : '';
          const phonetic = rawText && rawText.length <= 180 ? `/${rawText.replace(/^\/+|\/+$/g, '')}/` : '';
          if (!audio && !phonetic) continue;
          const accent = /(?:[-_]us)[-_.]/i.test(audio) ? '美音' : /(?:[-_](?:uk|gb))[-_.]/i.test(audio) ? '英音' : '发音';
          if (!entries.some(e => e.audio === audio && e.phonetic === phonetic)) entries.push({ audio, phonetic, accent });
        }
        if (!phonetics.length && typeof item.phonetic === 'string' && item.phonetic.length <= 180) entries.push({ phonetic: `/${item.phonetic.replace(/^\/+|\/+$/g, '')}/`, audio: '', accent: '发音' });
      }
      // Show recordings first; the word's variants remain visible without invented IPA.
      entries.sort((a, b) => Number(Boolean(b.audio)) - Number(Boolean(a.audio)));
      return { entries: entries.slice(0, 2), sourceUrl };
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

export type PlaybackState = 'loading' | 'playing' | 'ended' | 'idle';
interface Session { stop: () => void; changed: (state: PlaybackState) => void }
interface PlaybackOptions { accent?: Accent; rate?: number; changed?: (state: PlaybackState) => void }
type SpeechWindow = Window & typeof globalThis;

export class SpeechPlayer {
  private current: Session | null = null;
  constructor(private audioClient: Pick<PublicAudioClient, 'load'>, private startTimeoutMs = 5000, private voicesTimeoutMs = 1000) {}
  stop(): void {
    const session = this.current;
    this.current = null;
    if (session) { session.stop(); session.changed('idle'); }
  }
  async play(text: string, doc: Document, options: PlaybackOptions = {}): Promise<void> {
    this.stop();
    if (!text.trim() || text.length > 8000) throw new Error('请选择不超过 8000 字符的英语朗读。');
    const win = doc.defaultView as SpeechWindow | null;
    if (!win) throw new Error('当前窗口无法播放声音。');
    const session: Session = { stop: () => {}, changed: options.changed ?? (() => {}) };
    this.current = session; session.changed('loading');
    try {
      for (const chunk of speechChunks(text)) {
        if (this.current !== session) return;
        session.changed('loading');
        let clip;
        try { clip = await this.audioClient.load(chunk, options.accent ?? 'us'); }
        catch {
          if (this.current !== session) return;
          try { await this.synthesize(win, chunk, options.rate ?? .95, session); }
          catch (error) { throw new Error(`公开发音来源暂不可用；${error instanceof Error ? error.message : '系统朗读也未能启动，请检查网络后重试。'}`); }
          continue;
        }
        if (this.current !== session) return;
        const url = win.URL.createObjectURL(new win.Blob([clip.data], { type: clip.mime }));
        try {
          const played = await this.recording(win, url, options.rate ?? 1, session).catch(() => false);
          if (this.current !== session) return;
          if (!played) throw new Error('音频已获取，但播放器没有成功播放，请检查 Obsidian 的声音输出后重试。');
        } finally { win.URL.revokeObjectURL(url); }
      }
      if (this.current === session) { this.current = null; session.changed('ended'); }
    } catch (error) {
      if (this.current !== session) return;
      this.current = null; session.stop(); session.changed('idle');
      throw error;
    }
  }
  private recording(win: SpeechWindow, url: string, rate: number, session: Session): Promise<boolean> {
    return new Promise(resolve => {
      const audio = new win.Audio(url);
      audio.playbackRate = rate;
      audio.preservesPitch = true;
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        audio.onplaying = null; audio.onended = null; audio.onerror = null;
        audio.pause(); audio.removeAttribute('src'); resolve(ok);
      };
      session.stop = () => finish(false);
      audio.onplaying = () => {
        clearTimeout(timer); session.changed('playing');
        timer = setTimeout(() => finish(false), 45_000);
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      timer = setTimeout(() => finish(false), this.startTimeoutMs);
      try { void audio.play().catch(() => finish(false)); } catch { finish(false); }
    });
  }
  private async synthesize(win: SpeechWindow, text: string, rate: number, session: Session): Promise<void> {
    const synth = win.speechSynthesis;
    if (!synth || !win.SpeechSynthesisUtterance) throw new Error('这台设备暂不支持英语朗读；单词可使用词典录音。');
    if (!synth.getVoices().length) {
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const ready = () => { clearTimeout(timer); synth.removeEventListener('voiceschanged', ready); resolve(); };
        synth.addEventListener('voiceschanged', ready); timer = setTimeout(ready, this.voicesTimeoutMs); session.stop = ready;
      });
    }
    if (this.current !== session) return;
    const voices = synth.getVoices().filter(v => /^en(?:-|_)/i.test(v.lang));
    const voice = voices.find(v => v.localService && /^en-US$/i.test(v.lang)) ?? voices.find(v => v.localService) ?? voices[0];
    if (!voice) throw new Error('没有可用的英语语音，请先在系统中安装英语声音；单词仍可尝试词典录音。');
    await new Promise<void>((resolve, reject) => {
      const utterance = new win.SpeechSynthesisUtterance(text);
      utterance.lang = voice.lang; utterance.voice = voice; utterance.rate = rate;
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
        synth.cancel(); if (error) reject(error); else resolve();
      };
      session.stop = () => finish();
      utterance.onstart = () => { clearTimeout(timer); session.changed('playing'); timer = setTimeout(() => finish(new Error('朗读时间过长，请分段播放。')), 10 * 60_000); };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error('英语语音未能播放，请检查系统英语声音或尝试词典发音。'));
      timer = setTimeout(() => finish(new Error('系统英语语音没有启动，请检查设备的英语声音设置。')), this.startTimeoutMs);
      try { synth.speak(utterance); } catch { finish(new Error('当前设备无法启动英语朗读。')); }
    });
  }
}
import { speechChunks, type Accent, type PublicAudioClient } from './public-audio';
