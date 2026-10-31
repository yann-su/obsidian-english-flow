export type Accent = 'us' | 'uk';
export interface AudioClip { data: ArrayBuffer; mime: string; provider: 'youdao' | 'google' }
export interface AudioResponse { status: number; mime: string; data: ArrayBuffer }
export type AudioGet = (url: string) => Promise<AudioResponse>;
const MAX_BYTES = 2_000_000;

export function speechChunks(text: string): string[] {
  let rest = text.replace(/\s+/g, ' ').trim();
  if (!rest || rest.length > 8000) throw new Error('请选择不超过 8000 字符的英语朗读。');
  const chunks: string[] = [];
  while (rest.length > 180) {
    const head = rest.slice(0, 180);
    const punctuation = [...head.matchAll(/[.!?;:]\s/g)].at(-1)?.index;
    const boundary = punctuation !== undefined && punctuation > 60 ? punctuation + 1 : head.lastIndexOf(' ');
    const cut = boundary > 0 ? boundary : 180;
    chunks.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
export function publicSpeechSources(text: string, accent: Accent): { url: string; provider: AudioClip['provider'] }[] {
  const youdao = new URL('https://dict.youdao.com/dictvoice');
  youdao.searchParams.set('audio', text); youdao.searchParams.set('type', accent === 'uk' ? '1' : '2');
  const google = new URL('https://translate.google.com/translate_tts');
  google.searchParams.set('ie', 'UTF-8'); google.searchParams.set('client', 'tw-ob');
  google.searchParams.set('tl', accent === 'uk' ? 'en-GB' : 'en'); google.searchParams.set('q', text);
  return [{ url: youdao.href, provider: 'youdao' }, { url: google.href, provider: 'google' }];
}
export function audioMime(response: AudioResponse): string {
  if (response.status !== 200 || Object.prototype.toString.call(response.data) !== '[object ArrayBuffer]' || response.data.byteLength < 64 || response.data.byteLength > MAX_BYTES) throw new Error('发音来源没有返回有效音频。');
  const mime = response.mime.toLowerCase().split(';')[0]!.trim(), b = new Uint8Array(response.data);
  if (mime && !mime.startsWith('audio/') && mime !== 'application/octet-stream') throw new Error('发音来源返回了非音频内容。');
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav';
  throw new Error('发音来源返回了无法识别的音频。');
}
export class PublicAudioClient {
  private cache = new Map<string, AudioClip>();
  private inFlight = new Map<string, Promise<AudioClip>>();
  private cacheBytes = 0;
  constructor(private get: AudioGet, private timeoutMs = 6000) {}
  async load(text: string, accent: Accent = 'us'): Promise<AudioClip> {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 180) throw new Error('请将朗读内容分成较短的句子。');
    const key = JSON.stringify([accent, normalized]);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const active = this.inFlight.get(key);
    if (active) return active;
    const pending = this.fetch(normalized, accent);
    this.inFlight.set(key, pending);
    try {
      const result = await pending;
      this.cache.set(key, result); this.cacheBytes += result.data.byteLength;
      while (this.cache.size > 24 || this.cacheBytes > 6_000_000) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.data.byteLength; this.cache.delete(oldest);
      }
      return result;
    } finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
  }
  private async fetch(text: string, accent: Accent): Promise<AudioClip> {
    for (const source of publicSpeechSources(text, accent)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          this.get(source.url),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('音频下载超时。')), this.timeoutMs); })
        ]);
        return { data: response.data, mime: audioMime(response), provider: source.provider };
      } catch { /* Try the next public source, without forwarding credentials. */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    throw new Error('公开发音来源暂时不可用，请检查网络后重试。');
  }
}
