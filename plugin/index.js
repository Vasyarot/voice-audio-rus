/**
 * Host side of Voice Audio Rus.
 *
 * Cloud (OpenAI-compatible) settings are declared as volatile Config fields, so
 * they are editable at runtime through the profile settings service and take
 * effect without a restart. The API key is never stored in the plugin config:
 * only the *reference name* (`apiKeyEnv`) lives there; the secret itself is
 * written through the credentials service (redacted reads) or an env var.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createWhisperProvider } from './whisper-local.js'

export const name = 'voiceStudio'
export const inject = ['speechToText']

let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  /* Settings editing is optional: without schemastery the plugin still runs on row config. */
}

const DEFAULTS = {
  enableLocal: true,
  enableCloud: true,
  localModels: ['tiny', 'base', 'small'],
  localDataRoot: '',
  localThreads: 4,
  localOrigins: ['https://huggingface.co', 'https://hf-mirror.com'],
  fallbackLanguage: 'ru',
  providerId: 'cloud-openai',
  title: 'Облако · OpenAI-совместимый',
  baseURL: 'https://api.openai.com/v1',
  model: 'whisper-1',
  apiKeyEnv: 'OPENAI_API_KEY',
  languages: ['auto', 'ru', 'en'],
  prompt: '',
  timeoutMs: 120000,
}

export const Config = z
  ? z.object({
      enableLocal: z.boolean().default(true).volatile(),
      enableCloud: z.boolean().default(true).volatile(),
      localModels: z.array(z.string()).default(['tiny', 'base', 'small']).volatile(),
      localDataRoot: z.string().default('').volatile(),
      localThreads: z.natural().default(4).volatile(),
      localOrigins: z.array(z.string()).default(['https://huggingface.co', 'https://hf-mirror.com']).volatile(),
      fallbackLanguage: z.string().default('ru').volatile(),
      providerId: z.string().default('cloud-openai').volatile(),
      title: z.string().default('Облако · OpenAI-совместимый').volatile(),
      baseURL: z.string().default('https://api.openai.com/v1').volatile(),
      model: z.string().default('whisper-1').volatile(),
      apiKeyEnv: z.string().default('OPENAI_API_KEY').volatile(),
      languages: z.array(z.string()).default(['auto', 'ru', 'en']).volatile(),
      prompt: z.string().default('').volatile(),
      timeoutMs: z.natural().default(120000).volatile(),
    })
  : undefined

/** Read a volatile field (settings form) or a plain row-config value. */
function live(value, fallback) {
  if (value && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined || current === null ? fallback : current
  }
  return value === undefined || value === null ? fallback : value
}

function setting(config, key) {
  const flat = live(config?.[key], undefined)
  if (flat !== undefined) return flat
  const cloud = config?.cloud && typeof config.cloud === 'object' ? config.cloud : {}
  const local = config?.local && typeof config.local === 'object' ? config.local : {}
  const nested = live(cloud[key], undefined) ?? live(local[key], undefined)
  return nested !== undefined ? nested : DEFAULTS[key]
}

function fallbackDataRoot() {
  const base = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(base, 'speech-to-text', 'whisper')
}

function logLine(message) {
  try {
    const file = join(fallbackDataRoot(), '_voice-studio.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* logging must never break activation */
  }
}

/**
 * Resolve the secret for a reference name: DSH credentials first, then the
 * process environment. The value never appears in configs, logs or UI.
 */
async function resolveApiKey(ctx, ref) {
  const name = typeof ref === 'string' ? ref.trim() : ''
  if (name === '') return ''
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(name)
      const value = typeof hit === 'string' ? hit : hit?.value
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      /* fall back to the environment */
    }
  }
  const fromEnv = process.env[name]
  return typeof fromEnv === 'string' ? fromEnv.trim() : ''
}

/** OpenAI-compatible `/audio/transcriptions` provider, reading live settings. */
export function createProvider(config, ctx) {
  let lastKeyError = ''
  const listeners = new Set()
  let health = { phase: 'unprepared' }
  const setHealth = (next) => {
    health = next
    for (const listener of listeners) listener()
  }
  const baseUrlOf = () => String(setting(config, 'baseURL') || '').replace(/\/+$/u, '')
  const modelOf = () => String(setting(config, 'model') || '')

  return {
    info: {
      id: setting(config, 'providerId'),
      name: setting(config, 'title'),
      location: 'cloud',
      languages: setting(config, 'languages'),
    },
    preparation: {
      snapshot: () => health,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      async prepare() {
        const baseURL = baseUrlOf()
        const model = modelOf()
        if (baseURL === '' || model === '') {
          setHealth({ phase: 'failed', message: 'Не настроен: укажите Base URL и модель' })
          return
        }
        const apiKey = await resolveApiKey(ctx, setting(config, 'apiKeyEnv'))
        if (apiKey === '') {
          setHealth({ phase: 'failed', message: `Нет ключа: сохраните секрет для ${setting(config, 'apiKeyEnv')}` })
          return
        }
        setHealth({ phase: 'checking', startedAt: Date.now() })
        try {
          const response = await fetch(`${baseURL}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8000),
          })
          if (response.status === 401 || response.status === 403) {
            setHealth({ phase: 'failed', message: `Ключ отклонён (${response.status})` })
          } else if (response.ok || response.status === 404 || response.status === 405) {
            // 404/405: сервер не предоставляет /models, но соединение и ключ приняты.
            setHealth({ phase: 'ready' })
          } else {
            setHealth({ phase: 'failed', message: `Сервер ответил ${response.status}` })
          }
        } catch (error) {
          setHealth({ phase: 'failed', message: `Ошибка соединения: ${error instanceof Error ? error.message : String(error)}` })
        }
      },
      async cancel() {},
    },
    async transcribe(input, signal) {
      if (!input || (!(input.audio instanceof Uint8Array) && !Buffer.isBuffer(input.audio))) {
        throw new Error('Voice Audio Rus: ожидался WAV-буфер')
      }
      const languages = setting(config, 'languages')
      if (Array.isArray(languages) && typeof input.language === 'string' && input.language !== 'auto' && !languages.includes(input.language)) {
        throw new Error(`Voice Audio Rus: язык «${input.language}» не поддерживается облачным провайдером`)
      }
      const apiKey = await resolveApiKey(ctx, setting(config, 'apiKeyEnv'))
      if (apiKey === '') {
        lastKeyError = setting(config, 'apiKeyEnv')
        throw new Error(
          `Voice Audio Rus: ключ не найден. Сохраните его в настройках плагина (поле «Ключ API») для ссылки ${lastKeyError} или задайте переменную окружения.`,
        )
      }
      const baseURL = String(setting(config, 'baseURL')).replace(/\/+$/u, '')
      const model = setting(config, 'model')
      const prompt = setting(config, 'prompt')
      const timeoutMs = Math.max(1000, Number(setting(config, 'timeoutMs')) || DEFAULTS.timeoutMs)
      const audio = input.audio
      const audioSeconds = Math.max(0, (audio.length - 44) / 32000)
      const form = new FormData()
      form.set('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav')
      form.set('model', model)
      form.set('response_format', 'json')
      if (typeof input.language === 'string' && input.language !== '' && input.language !== 'auto') {
        form.set('language', input.language)
      }
      if (prompt !== '') form.set('prompt', prompt)

      const startedAt = Date.now()
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline
      let response
      try {
        response = await fetch(`${baseURL}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: combined,
        })
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw new Error(`Voice Audio Rus: сервер не ответил за ${Math.round(timeoutMs / 1000)} с`)
        }
        throw new Error(`Voice Audio Rus: запрос к ${baseURL} не удался — ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Voice Audio Rus: сервер вернул ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      const payload = await response.json().catch(() => {
        throw new Error('Voice Audio Rus: ответ сервера не является JSON')
      })
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      return {
        text,
        audioSeconds,
        inferenceSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
      }
    },
  }
}

/** Resolve `sherpa-onnx-node` from the DSH installation; used for diagnostics. */
export function locateSherpa() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh'))
    candidates.push(join(process.resourcesPath, 'app', 'dsh'))
  }
  if (typeof process.argv[2] === 'string' && process.argv[2]) candidates.push(process.argv[2])
  for (const directory of candidates) {
    try {
      if (!existsSync(join(directory, 'package.json'))) continue
      return { directory, resolved: createRequire(join(directory, 'package.json')).resolve('sherpa-onnx-node') }
    } catch {
      /* next candidate */
    }
  }
  return null
}

export function apply(ctx, rowConfig = {}) {
  const config = rowConfig && typeof rowConfig === 'object' ? rowConfig : {}
  const providers = []

  if (live(config.enableLocal, true) !== false) {
    const dataRoot = String(live(config.localDataRoot, '') || fallbackDataRoot())
    const models = live(config.localModels, DEFAULTS.localModels)
    for (const model of Array.isArray(models) ? models : DEFAULTS.localModels) {
      if (!['tiny', 'base', 'small'].includes(model)) continue
      providers.push(
        createWhisperProvider({
          model,
          precision: 'int8',
          dataRoot: join(dataRoot, model),
          modelOrigins: live(config.localOrigins, DEFAULTS.localOrigins),
          threads: live(config.localThreads, 4),
          languages: live(config.languages, DEFAULTS.languages),
          fallbackLanguage: live(config.fallbackLanguage, 'ru'),
        }),
      )
    }
  }

  if (live(config.enableCloud, true) !== false) {
    providers.push(createProvider(config, ctx))
  }

  logLine(`apply local=${live(config.enableLocal, true)} cloud=${live(config.enableCloud, true)} providers=${providers.length}`)
  if (providers.length === 0) return
  for (const provider of providers) {
    const operation = provider.preparation
    if (!operation) continue
    const originalPrepare = operation.prepare.bind(operation)
    operation.prepare = async (options) => {
      logLine(`prepare ${provider.info.id} start`)
      try {
        return await originalPrepare(options)
      } finally {
        logLine(`prepare ${provider.info.id} -> ${JSON.stringify(operation.snapshot())}`)
      }
    }
    const originalSnapshot = operation.snapshot.bind(operation)
    let lastSnapshotLog = 0
    operation.snapshot = () => {
      const snapshot = originalSnapshot()
      const now = Date.now()
      if (now - lastSnapshotLog > 15_000) {
        lastSnapshotLog = now
        logLine(`catalog ${provider.info.id} ${JSON.stringify(snapshot)}`)
      }
      return snapshot
    }
  }
  ctx.effect(() => {
    const unregisters = []
    for (const provider of providers) {
      try {
        unregisters.push(ctx.speechToText.register(provider))
        logLine(`registered ${provider.info.id}`)
      } catch (error) {
        logLine(`register failed ${provider.info.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return async () => {
      for (const unregister of unregisters) await unregister()
    }
  })
}
