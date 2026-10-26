/**
 * Host side of Voice Studio.
 *
 * Registers providers into the shared `speechToText` service:
 *  - `whisper-*` local recognizers on the sherpa-onnx runtime shipped with DSH
 *    (offline, Russian supported, models downloaded on demand);
 *  - one OpenAI-compatible cloud recognizer (optional, key stays on the Host).
 *
 * Config (row config in cordis.patch.yml):
 *   enableLocal / enableCloud  toggle provider families
 *   local.models               local rows to expose: tiny|base|small
 *   local.dataRoot             absolute cache directory for model files
 *   cloud.* / flat fields      see createProvider below
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createWhisperProvider } from './whisper-local.js'

export const name = 'voiceStudio'
export const inject = ['speechToText']

const CLOUD_DEFAULTS = {
  providerId: 'cloud-openai',
  title: 'Облако · OpenAI-совместимый',
  baseURL: 'https://api.openai.com/v1',
  model: 'whisper-1',
  apiKey: '',
  apiKeyEnv: 'OPENAI_API_KEY',
  languages: ['auto', 'ru', 'en'],
  prompt: '',
  timeoutMs: 120_000,
}

function optionString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function readKey(options) {
  const literal = optionString(options.apiKey, '').trim()
  if (literal !== '') return literal
  const variable = optionString(options.apiKeyEnv, '').trim()
  if (variable !== '' && typeof process !== 'undefined' && process.env) {
    const value = process.env[variable]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** OpenAI-compatible `/audio/transcriptions` provider. */
export function createProvider(rawConfig = {}) {
  const config = { ...CLOUD_DEFAULTS, ...rawConfig }
  const languages = Array.isArray(config.languages)
    ? config.languages.filter((item) => typeof item === 'string' && item !== '')
    : CLOUD_DEFAULTS.languages
  const baseURL = optionString(config.baseURL, CLOUD_DEFAULTS.baseURL).replace(/\/+$/u, '')
  const model = optionString(config.model, CLOUD_DEFAULTS.model)
  const prompt = optionString(config.prompt, '')
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : CLOUD_DEFAULTS.timeoutMs

  return {
    info: {
      id: optionString(config.providerId, CLOUD_DEFAULTS.providerId),
      name: optionString(config.title, CLOUD_DEFAULTS.title),
      location: 'cloud',
      languages: languages.length > 0 ? languages : CLOUD_DEFAULTS.languages,
    },
    async transcribe(input, signal) {
      const apiKey = readKey(config)
      if (apiKey === '') {
        throw new Error(
          `Voice Studio: не найден ключ API. Задайте переменную ${config.apiKeyEnv} или поле apiKey в конфиге плагина.`,
        )
      }
      if (!input || (!(input.audio instanceof Uint8Array) && !Buffer.isBuffer(input.audio))) {
        throw new Error('Voice Studio: ожидался WAV-буфер')
      }
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
          throw new Error(`Voice Studio: сервер распознавания не ответил за ${Math.round(timeoutMs / 1000)} с`)
        }
        throw new Error(`Voice Studio: запрос к ${baseURL} не удался — ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Voice Studio: сервер вернул ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      const payload = await response.json().catch(() => {
        throw new Error('Voice Studio: ответ сервера не является JSON')
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

function fallbackDataRoot() {
  const base = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(base, 'speech-to-text', 'whisper')
}

/** Activation diagnostics: a file in the model cache, readable without DevTools. */
function logLine(message) {
  try {
    const file = join(fallbackDataRoot(), '_voice-studio.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* logging must never break activation */
  }
}

export function apply(ctx, rowConfig = {}) {
  const config = rowConfig && typeof rowConfig === 'object' ? rowConfig : {}
  const local = config.local && typeof config.local === 'object' ? config.local : {}
  const cloud = config.cloud && typeof config.cloud === 'object' ? config.cloud : {}
  const providers = []

  if (config.enableLocal !== false) {
    const dataRoot = optionString(local.dataRoot, optionString(config.dataRoot, '')) || fallbackDataRoot()
    const models = Array.isArray(local.models) && local.models.length > 0
      ? local.models
      : [local.model ?? config.model ?? 'base']
    for (const model of models) {
      if (!['tiny', 'base', 'small'].includes(model)) continue
      providers.push(
        createWhisperProvider({
          model,
          precision: local.precision ?? 'int8',
          dataRoot: join(dataRoot, model),
          modelOrigins: local.modelOrigins ?? config.modelOrigins,
          threads: local.threads ?? 4,
          languages: local.languages,
          fallbackLanguage: local.fallbackLanguage ?? 'ru',
        }),
      )
    }
  }

  if (config.enableCloud !== false) {
    providers.push(createProvider({ ...config, ...cloud }))
  }

  logLine(`apply local=${config.enableLocal !== false} cloud=${config.enableCloud !== false} providers=${providers.length}`)
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
