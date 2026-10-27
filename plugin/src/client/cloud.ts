// Cloud (OpenAI-compatible) helpers shared by the composer quick panel and the
// bundle settings page: draft persistence, model discovery through `/models`,
// speech-model detection and the "best model" recommendation.
//
// Everything here talks to the Host only through already-mounted Remotes:
// `credentials.set` stores the secret, `settings.update` writes the volatile
// plugin config. The model list itself is fetched from the user's server, so no
// API key ever appears in the plugin config.

export type CloudDraft = { baseURL: string; model: string; apiKeyEnv: string }

export const CLOUD_DEFAULT: CloudDraft = {
  baseURL: 'https://api.openai.com/v1',
  model: 'whisper-1',
  apiKeyEnv: 'OPENAI_API_KEY',
}

const DRAFT_KEY = 'dsh.voice-studio.cloudDraft'
const MODELS_KEY = 'dsh.voice-studio.cloudModels'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

function pickText(input: unknown, fallback: string): string {
  return typeof input === 'string' && input.trim() !== '' ? input : fallback
}

export function loadCloudDraft(): CloudDraft {
  const raw = storage()?.getItem(DRAFT_KEY)
  if (!raw) return { ...CLOUD_DEFAULT }
  try {
    const value = JSON.parse(raw)
    return {
      baseURL: pickText(value?.baseURL, CLOUD_DEFAULT.baseURL),
      model: pickText(value?.model, CLOUD_DEFAULT.model),
      apiKeyEnv: pickText(value?.apiKeyEnv, CLOUD_DEFAULT.apiKeyEnv),
    }
  } catch {
    return { ...CLOUD_DEFAULT }
  }
}

export function saveCloudDraft(draft: CloudDraft): void {
  try {
    storage()?.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* storage is optional */
  }
}

/** Last successfully discovered model list, so the panel can render before a key is typed. */
export function loadCachedModels(): string[] {
  const raw = storage()?.getItem(MODELS_KEY)
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 300) : []
  } catch {
    return []
  }
}

export function saveCachedModels(models: string[]): void {
  try {
    storage()?.setItem(MODELS_KEY, JSON.stringify(models.slice(0, 300)))
  } catch {
    /* storage is optional */
  }
}

// ---------------------------------------------------------------- model ranking

const SPEECH_HINTS = [/whisper/u, /transcribe/u, /speech[-_ ]?to[-_ ]?text/u, /\bstt\b/u, /\basr\b/u, /recognition/u, /dictation/u]
const NOT_SPEECH = [/tts/u, /text[-_ ]?to[-_ ]?speech/u, /embedd/u, /moderation/u, /image/u, /vision/u, /dall[-_ ]?e/u, /audio[-_ ]?preview/u, /realtime/u, /chat/u, /completion/u]

/** True when the model name looks like a speech-to-text endpoint. */
export function isSpeechModel(name: string): boolean {
  const value = String(name).toLowerCase()
  if (NOT_SPEECH.some((pattern) => pattern.test(value))) return false
  return SPEECH_HINTS.some((pattern) => pattern.test(value))
}

/**
 * Heuristic "how good is this model for dictation" score. Higher is better:
 * explicit speech models first, then newer/larger Whisper variants, and a heavy
 * penalty for models that clearly do something else.
 */
export function scoreModel(name: string): number {
  const value = String(name).toLowerCase()
  let score = 0
  if (/transcribe/u.test(value)) score += 65
  if (/whisper/u.test(value)) score += 60
  if (/gpt-4o-transcribe/u.test(value)) score += 18
  if (/gpt-4o-mini-transcribe/u.test(value)) score += 12
  if (/whisper-1/u.test(value)) score += 15
  if (/large-v3/u.test(value)) score += 20
  else if (/large/u.test(value)) score += 14
  else if (/medium/u.test(value)) score += 8
  if (/turbo/u.test(value)) score += 8
  if (/multilingual/u.test(value)) score += 3
  if (/small/u.test(value)) score += 4
  else if (/base/u.test(value)) score += 2
  else if (/tiny/u.test(value)) score += 1
  score += isSpeechModel(value) ? 30 : -40
  return score
}

/** The single best dictation model from a `/models` answer, or null when none fits. */
export function recommendModel(models: string[]): string | null {
  let best: string | null = null
  let bestScore = 0
  for (const model of models) {
    const score = scoreModel(model)
    if (score > bestScore) {
      best = model
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------- network / host

export function normalizeBaseURL(value: string): string {
  return String(value).trim().replace(/\/+$/u, '')
}

/** Ask the user's server which models it provides. Throws a readable error. */
export async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  const base = normalizeBaseURL(baseURL)
  if (!/^https?:\/\//iu.test(base)) throw new Error('Base URL должен начинаться с http:// или https://')
  if (apiKey.trim() === '') throw new Error('нужен ключ API')
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey.trim()}` } })
  if (!response.ok) throw new Error(`сервер ответил ${response.status}`)
  const payload = await response.json().catch(() => null)
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const list: string[] = []
  for (const item of raw) {
    const name = typeof item === 'string' ? item : item?.id ?? item?.name
    if (typeof name === 'string' && name.trim() !== '' && !list.includes(name)) list.push(name)
  }
  if (list.length === 0) throw new Error('сервер вернул пустой список')
  return list
}

/** Save volatile plugin config for the cloud provider; keeps other fields untouched. */
export async function saveCloudConfig(ctx: any, patch: Record<string, string>): Promise<void> {
  const described = await ctx.remote.settings.describe()
  const payload = described?.ok === false ? null : described?.ok ? described.value : described
  const list = Array.isArray(payload) ? payload : payload?.namespaces ?? payload?.entries ?? []
  const row = list.find((item: any) => (item?.ns ?? item?.id ?? item?.namespace) === 'voice-studio')
  const result = await ctx.remote.settings.update('voice-studio', patch, row?.revision ?? undefined)
  if (result?.ok === false) {
    const message = result?.error?.message ?? result?.error?.reason
    throw new Error(typeof message === 'string' ? message : 'настройки не сохранены')
  }
}

/** Store the secret in the DSH credentials service; returns the reference name used. */
export async function saveCloudKey(ctx: any, ref: string, value: string): Promise<string> {
  const name = ref.trim() === '' ? CLOUD_DEFAULT.apiKeyEnv : ref.trim()
  if (value.trim() === '') throw new Error('пустой ключ')
  const result = await ctx.remote.credentials.set(name, value.trim())
  if (result?.ok === false) {
    const message = result?.error?.message ?? result?.error?.reason
    throw new Error(typeof message === 'string' ? message : 'ключ не сохранён')
  }
  return name
}
