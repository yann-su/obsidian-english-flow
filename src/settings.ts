import { safeFolder } from './storage';
import { uniqueId } from './model';

export interface FlowSettings {
  folder: string; endpoint: string; model: string; secretName: string;
  jsonMode: boolean; legacyTokens: boolean; deepseekFast: boolean; autoExplain: boolean; dailyLimit: number; deviceId: string;
}
export const DEFAULT_SETTINGS: Omit<FlowSettings, 'deviceId'> = {
  folder: 'English Flow', endpoint: 'https://api.openai.com/v1', model: '',
  secretName: 'english-reading-flow', jsonMode: true, legacyTokens: false, deepseekFast: true, autoExplain: false, dailyLimit: 20
};
export function endpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('API 地址无效。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('API 地址需使用 HTTPS；本机 localhost 可使用 HTTP。地址中不能包含凭据或查询参数。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.toString();
}
export function validateSettings(value: FlowSettings): FlowSettings {
  endpointUrl(value.endpoint);
  if (!Number.isInteger(value.dailyLimit) || value.dailyLimit < 5 || value.dailyLimit > 100) throw new Error('每日复习额度应为 5～100 次作答。');
  if (value.model.trim().length > 160 || /[\r\n]/.test(value.model)) throw new Error('模型名称无效。');
  if (value.secretName && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.secretName)) throw new Error('凭据名称应为小写字母、数字和短横线。');
  return { ...value, folder: safeFolder(value.folder), endpoint: value.endpoint.trim().replace(/\/+$/, ''), model: value.model.trim(), secretName: value.secretName.trim() };
}
export function loadSettings(value: unknown): FlowSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const defaults = { ...DEFAULT_SETTINGS, deviceId: uniqueId() };
  const candidate = { ...defaults };
  for (const key of ['folder', 'endpoint', 'model', 'secretName'] as const) if (typeof raw[key] === 'string') candidate[key] = raw[key] as string;
  if (typeof raw.jsonMode === 'boolean') candidate.jsonMode = raw.jsonMode;
  if (typeof raw.legacyTokens === 'boolean') candidate.legacyTokens = raw.legacyTokens;
  if (typeof raw.deepseekFast === 'boolean') candidate.deepseekFast = raw.deepseekFast;
  if (typeof raw.autoExplain === 'boolean') candidate.autoExplain = raw.autoExplain;
  if (typeof raw.dailyLimit === 'number') candidate.dailyLimit = raw.dailyLimit;
  if (typeof raw.deviceId === 'string' && /^[a-f0-9-]{36}$/.test(raw.deviceId)) candidate.deviceId = raw.deviceId;
  return validateSettings(candidate);
}
