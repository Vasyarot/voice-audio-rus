// Offline Whisper provider built on the sherpa-onnx runtime that ships with DSH.
// Resolution is caller-relative, so the native package is loaded from the DSH
// installation directory, not from this plugin's node_modules.
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'

const SIZES = {
  tiny: { repo: 'csukuangfj/sherpa-onnx-whisper-tiny', disk: 110 * 1024 * 1024 },
  base: { repo: 'csukuangfj/sherpa-onnx-whisper-base', disk: 165 * 1024 * 1024 },
  small: { repo: 'csukuangfj/sherpa-onnx-whisper-small', disk: 380 * 1024 * 1024 },
}

const DEFAULT_LANGUAGES = ['auto', 'ru', 'en']

const DEFAULTS = {
  model: 'base',
  precision: 'int8',
  dataRoot: '',
  modelOrigins: ['https://huggingface.co', 'https://hf-mirror.com'],
  threads: 4,
  fallbackLanguage: 'ru',
}

/** Resolve sherpa-onnx-node from the DSH installation instead of the profile. */
export function defaultLoadSherpa() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh'))
    candidates.push(join(process.resourcesPath, 'app', 'dsh'))
  }
  if (typeof process.argv[2] === 'string' && process.argv[2]) candidates.push(process.argv[2])
  for (const directory of candidates) {
    try {
      if (!existsSync(join(directory, 'package.json'))) continue
      return createRequire(join(directory, 'package.json'))('sherpa-onnx-node')
    } catch {
      /* try the next candidate */
    }
  }
  return createRequire(import.meta.url)('sherpa-onnx-node')
}

function canonicalWaveSamples(audio) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio)
  if (
    buffer.length < 46 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE' ||
    buffer.toString('ascii', 12, 16) !== 'fmt ' ||
    buffer.readUInt32LE(16) !== 16 ||
    buffer.readUInt16LE(20) !== 1 ||
    buffer.readUInt16LE(22) !== 1 ||
    buffer.readUInt32LE(24) !== 16000 ||
    buffer.readUInt32LE(28) !== 32000 ||
    buffer.readUInt16LE(32) !== 2 ||
    buffer.readUInt16LE(34) !== 16 ||
    buffer.toString('ascii', 36, 40) !== 'data' ||
    buffer.readUInt32LE(40) !== buffer.length - 44
  ) {
    throw new Error('Ожидался WAV 16 кГц, mono, PCM16')
  }
  const count = (buffer.length - 44) / 2
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(44 + i * 2) / 32768
  return samples
}

function filesOf(size, precision) {
  return [`${size}-encoder.${precision}.onnx`, `${size}-decoder.${precision}.onnx`, `${size}-tokens.txt`]
}

/**
 * One local recognizer per model size. Preparation is provider-owned (download +
 * load), transcription runs on the sherpa-onnx CPU runtime in-process.
 */
export function createWhisperProvider(rawConfig = {}, deps = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const size = SIZES[config.model] ? config.model : 'base'
  const spec = SIZES[size]
  const languages = Array.isArray(config.languages) && config.languages.length > 0 ? config.languages : DEFAULT_LANGUAGES
  const precision = config.precision === 'fp32' ? 'fp32' : 'int8'
  const root = config.dataRoot ? config.dataRoot : ''
  const files = filesOf(size, precision)
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const loadSherpa = deps.loadSherpa ?? defaultLoadSherpa
  const providerId = typeof config.providerId === 'string' && config.providerId !== '' ? config.providerId : `whisper-${size}`

  let state = { phase: 'unprepared' }
  const listeners = new Set()
  let task = null
  let recognizer = null
  let recognizerLanguage = null
  let sherpa = null

  const notify = (next) => {
    state = next
    for (const listener of listeners) listener()
  }

  const paths = () => files.map((file) => join(root, file))

  const filesReady = async () => {
    if (root === '') return false
    for (const file of paths()) {
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size === 0) return false
      } catch {
        return false
      }
    }
    return true
  }

  const ensureRecognizer = async (language) => {
    if (recognizer !== null && recognizerLanguage === language) return recognizer
    if (recognizer !== null) {
      try {
        recognizer.free?.()
      } catch {
        /* sherpa frees its own handle on GC */
      }
      recognizer = null
    }
    sherpa ??= loadSherpa()
    if (typeof sherpa.OfflineRecognizer !== 'function') throw new Error('sherpa-onnx-node не содержит OfflineRecognizer')
    const [encoder, decoder, tokens] = paths()
    const whisperLanguage = language === 'auto' ? '' : language
    const build = (lang) =>
      new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder, decoder, language: lang, task: 'transcribe' },
          tokens,
          numThreads: Math.max(1, Number(config.threads) || 4),
          provider: 'cpu',
          debug: 0,
        },
      })
    try {
      recognizer = build(whisperLanguage)
    } catch (error) {
      if (whisperLanguage === '') {
        recognizer = build(config.fallbackLanguage || 'ru')
      } else {
        throw error
      }
    }
    recognizerLanguage = language
    return recognizer
  }

  const download = async (origin, file, controller, onProgress) => {
    const url = `${origin.replace(/\/+$/u, '')}/${spec.repo}/resolve/main/${file}`
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Не удалось скачать ${file}: HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    const target = join(root, file)
    const temporary = `${target}.part`
    await rm(temporary, { force: true })
    const stream = createWriteStream(temporary)
    let written = 0
    let last = 0
    try {
      for await (const chunk of response.body) {
        stream.write(chunk)
        written += chunk.length
        const now = Date.now()
        if (now - last > 150) {
          last = now
          onProgress(written, total)
        }
      }
    } finally {
      await new Promise((resolve, reject) => {
        stream.once('error', reject)
        stream.end(() => resolve())
      })
    }
    if (written === 0) throw new Error(`Пустой ответ для ${file}`)
    await rename(temporary, target)
    return written
  }

  const run = async (options, controller) => {
    if (root === '') throw new Error('Не задан dataRoot для локальной модели')
    await mkdir(root, { recursive: true })
    if (await filesReady()) {
      notify({ phase: 'loading', startedAt: Date.now(), step: 'load' })
    } else {
      const origin = typeof options?.downloadSource === 'string' && options.downloadSource !== ''
        ? options.downloadSource
        : config.modelOrigins[0]
      for (const file of files) {
        notify({
          phase: 'downloading',
          resource: file,
          completedBytes: 0,
          totalBytes: 0,
          step: 'model',
          steps: [{ kind: 'model', status: 'running' }],
        })
        await download(origin, file, controller, (completedBytes, totalBytes) => {
          notify({
            phase: 'downloading',
            resource: file,
            completedBytes,
            totalBytes,
            step: 'model',
            steps: [{ kind: 'model', status: 'running' }],
          })
        })
      }
      notify({ phase: 'loading', startedAt: Date.now(), step: 'load' })
    }
    await ensureRecognizer(config.language ?? 'auto')
    notify({ phase: 'ready' })
  }

  const preparation = {
    snapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async prepare(options) {
      if (task !== null) return task.promise
      const controller = new AbortController()
      const promise = (async () => {
        try {
          await run(options, controller)
        } catch (error) {
          if (controller.signal.aborted) {
            notify({ phase: 'cancelled' })
          } else {
            notify({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
          }
        } finally {
          task = null
        }
      })()
      task = { controller, promise }
      return promise
    },
    async cancel() {
      if (task === null) return
      task.controller.abort()
      await task.promise.catch(() => {})
    },
  }

  return {
    info: {
      id: providerId,
      name: `Whisper ${size.toUpperCase()} · локально`,
      location: 'host-local',
      languages,
      downloadSources: config.modelOrigins,
      setupEstimate: {
        recommendedDiskBytes: spec.disk,
        expectedMemoryBytes: Math.round(spec.disk * 1.6),
        minimumMinutes: 1,
        maximumMinutes: 15,
      },
    },
    preparation,
    async transcribe(input, signal) {
      signal.throwIfAborted()
      if (!(await filesReady())) {
        throw new Error('Локальная модель не подготовлена: скачайте её в настройках плагина')
      }
      if (state.phase !== 'ready') {
        notify({ phase: 'loading', startedAt: Date.now(), step: 'load' })
        try {
          await ensureRecognizer(typeof input.language === 'string' ? input.language : 'auto')
          notify({ phase: 'ready' })
        } catch (error) {
          notify({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
          throw error
        }
      }
      const samples = canonicalWaveSamples(input.audio)
      const language = typeof input.language === 'string' ? input.language : 'auto'
      const startedAt = Date.now()
      const active = await ensureRecognizer(language)
      signal.throwIfAborted()
      const stream = active.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      active.decode(stream)
      signal.throwIfAborted()
      const result = active.getResult(stream)
      return {
        text: typeof result?.text === 'string' ? result.text.trim() : '',
        audioSeconds: samples.length / 16000,
        inferenceSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
      }
    },
  }
}
