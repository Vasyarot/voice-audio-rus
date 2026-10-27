// Smoke test: emulate the browser module loader, mount the plugin factories and
// exercise the apply() wiring with a fake Cordis context. No DOM/audio needed.
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const code = await readFile(resolve(here, '../plugin/client.js'), 'utf8')

const storage = new Map()
// Live mode is persisted before the bundle loads, so the settings page renders its
// extra sliders during the server-side smoke render.
storage.set('dsh.voice-studio.settings.v1', JSON.stringify({ mode: 'live', live: { chunkSeconds: 4, pauseMs: 500 } }))
const elements = []
const documentStub = {
  hidden: false,
  querySelector: () => null,
  createElement: () => {
    const element = { dataset: {}, style: {}, textContent: '', appendChild() {}, remove() {}, click() {} }
    elements.push(element)
    return element
  },
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      globalThis.__entry = entry
    },
  },
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  clearTimeout() {},
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
}
globalThis.document = documentStub
globalThis.localStorage = window.localStorage
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => ({ getTracks: () => [] }) },
    clipboard: { writeText: async () => {} },
  },
})
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => Date.now() } })
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.AudioContext = class AudioContext {}
globalThis.MediaRecorder = class MediaRecorder {}
globalThis.Blob = Blob
globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')

eval(code)

const entry = globalThis.__entry
if (!entry || typeof entry.factory !== 'function') throw new Error('module loader entry missing')
console.log('bundle id:', entry.id)

const module = entry.factory((specifier) => {
  if (specifier === 'react') return require('react')
  if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
  if (specifier === 'react-dom') return require('react-dom')
  if (specifier === 'react-dom/client') return require('react-dom/client')
  if (specifier === 'zod') {
    const zod = require('zod')
    return zod.z ? zod : { z: zod }
  }
  throw new Error(`unexpected require: ${specifier}`)
})

if (typeof module.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(module.inject)) throw new Error('inject missing')
console.log('inject services:', module.inject.join(', '))

const registered = []
const disposers = []
const slots = {
  inject(name, callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  register(options, component) {
    registered.push({ options, component })
    return () => {}
  },
}

const speech = {
  catalog: async () => ({
    ok: true,
    value: {
      providers: [{ id: 'whisper-base', name: 'Whisper base', location: 'host-local', languages: ['auto', 'ru'], preparation: { phase: 'ready' } }],
      selection: { providerId: 'whisper-base', language: 'ru' },
      maxAudioBytes: 1,
      maxDurationSeconds: 1,
    },
  }),
  configure: async () => ({ ok: true }),
  prepare: async () => ({ ok: true }),
  transcribe: async () => ({ ok: true, value: { text: 'ok', audioSeconds: 1 } }),
}
const ctx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  inject(_services, callback) {
    const result = callback({ remote: { speech }, slots, locale: {}, pluginNavigation: {} })
    return Promise.resolve({ dispose: async () => {} })
  },
  remote: { $mount: async () => async () => {}, speech },
  slots,
  locale: { register: () => () => {} },
  pluginNavigation: { openBundle() {} },
}

await module.apply(ctx)
await new Promise((r) => setTimeout(r, 10))

const names = registered.map((item) => item.options?.name ?? '?')
console.log('registered slots:', names.join(', '))
if (!names.includes('conversation.input.activity')) throw new Error('composer slot not registered')
if (!names.includes('plugins.bundle.config')) throw new Error('settings slot not registered')
for (const item of registered) {
  if (typeof item.component !== 'function') throw new Error(`component for ${item.options?.name} is not a function`)
}

// Server-render both contributions to catch reference errors in JSX outside effects.
const React = require('react')
const { renderToString } = require('react-dom/server')
const inputActions = {
  insertText: () => true,
  captureInsertion: () => ({ draftRev: 0 }),
  setDraft() {},
}
const mic = registered.find((item) => item.options?.name === 'conversation.input.activity')
const micHtml = renderToString(
  React.createElement(mic.component, {
    sessionId: 's1',
    inputActions,
    locked: false,
    voiceStudio: { ctx, openSettings() {} },
    t: (key) => key,
  }),
)
if (!micHtml.includes('aria-label="Голосовой ввод"')) throw new Error('microphone trigger did not render')
if (!micHtml.includes('aria-haspopup="menu"')) throw new Error('microphone must expose the popup menu trigger')
if (!micHtml.includes('aria-label="Режим: в реальном времени"')) throw new Error('the mode badge must show the live mode')
if (!micHtml.includes('aria-expanded="false"')) throw new Error('quick menu must start closed')
if (micHtml.includes('aria-expanded="true"')) throw new Error('quick menu opened by default')
if (!micHtml.includes('удержание — выбор режима')) throw new Error('the trigger must document the hold gesture')
if (!micHtml.includes('правый клик — быстрые настройки')) throw new Error('the trigger must document the right-click settings')

const settings = registered.find((item) => item.options?.name === 'plugins.bundle.config')
const settingsHtml = renderToString(
  React.createElement(settings.component, { voiceStudio: { ctx }, t: (key) => key }),
)
const sections = [
  'Модели распознавания речи',
  'Режим диктовки',
  'Микрофон',
  'Сравнение моделей',
  'Шумоподавление',
  'Обработка звука',
  'Тишина и клавиши',
  'Текст',
]
let cursor = -1
for (const marker of sections) {
  const at = settingsHtml.indexOf(`<h4>${marker}</h4>`)
  if (at < 0) throw new Error(`settings page missing section: ${marker}`)
  if (at < cursor) throw new Error(`settings section out of order: ${marker}`)
  cursor = at
}
for (const gone of ['История диктовок', 'Экспорт .md', 'Пока пусто']) {
  if (settingsHtml.includes(gone)) throw new Error(`history must be gone from the settings page: ${gone}`)
}
if (settingsHtml.includes('Облачный провайдер')) throw new Error('duplicated cloud section is still rendered')
if (!settingsHtml.includes('Вернуть настройки по умолчанию')) throw new Error('reset button is missing')
if (settingsHtml.includes('Да, сбросить')) throw new Error('reset confirmation must stay closed until asked')
if (settingsHtml.includes('margin:6px 0 12px')) throw new Error('settings rows must not override the shared gap')
for (const marker of ['В реальном времени', 'По кнопке', 'Максимум фразы', 'Пауза для вставки']) {
  if (!settingsHtml.includes(marker)) throw new Error(`dictation mode section missing: ${marker}`)
}

console.log('render smoke passed, settings page bytes:', settingsHtml.length)

// The composer popover renders its own tree: provider list, microphone and the
// cloud block with cached models; the mode itself lives in the hold menu.
storage.set('dsh.voice-studio.cloudModels', JSON.stringify(['whisper-1', 'gpt-4o-transcribe', 'tts-1']))
const panelSettings = {
  deviceId: '',
  deviceLabel: '',
  mode: 'live',
  live: { chunkSeconds: 6, pauseMs: 700 },
  browser: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  rnnoise: { enabled: true, mix: 1 },
  highpass: { enabled: true, hz: 80 },
  gate: { enabled: true, thresholdDb: -45, holdMs: 250 },
  agc: { enabled: true, targetDb: -20, maxGainDb: 18 },
  gainDb: 0,
  limiter: true,
  vad: { autoStop: true, silenceMs: 1800, thresholdDb: -42 },
  ptt: { enabled: false, combo: 'Ctrl+Shift+Space', mode: 'hold' },
  text: { autoPunctuation: true, removeFillers: false, dictionary: [] },
  providerId: 'cloud-openai',
  language: 'ru',
}
const catalog = {
  providers: [
    { id: 'whisper-base', name: 'Whisper base', location: 'host-local', languages: ['auto', 'ru'], preparation: { phase: 'ready' } },
    { id: 'cloud-openai', name: 'Облако · OpenAI', location: 'cloud', languages: ['auto', 'ru', 'en'], preparation: { phase: 'ready' } },
  ],
  selection: { providerId: 'cloud-openai', language: 'ru' },
  maxAudioBytes: 1,
  maxDurationSeconds: 1,
}
const panelHtml = renderToString(
  React.createElement(module.QuickSettings, {
    ctx,
    settings: panelSettings,
    catalog,
    refresh: () => {},
    openSettings() {},
    onClose() {},
  }),
)
for (const marker of ['Модель распознавания', 'Микрофон', 'Облачная модель', 'Подтянуть модели', 'Все настройки']) {
  if (!panelHtml.includes(marker)) throw new Error(`quick panel missing: ${marker}`)
}
for (const duplicated of ['По кнопке', 'В реальном времени', 'Записать', 'Режим']) {
  if (panelHtml.includes(duplicated)) throw new Error(`quick panel duplicates the mode control: ${duplicated}`)
}
if (!panelHtml.includes('★ лучшая для речи')) throw new Error('quick panel must mark the recommended model')

// The hold menu owns the mode choice only.
const modeHtml = renderToString(
  React.createElement(module.ModeMenu, {
    settings: panelSettings,
    onChoose() {},
    onClose() {},
  }),
)
for (const marker of ['Режим диктовки', 'По кнопке', 'В реальном времени', 'role="menuitemradio"', 'остановка вручную']) {
  if (!modeHtml.includes(marker)) throw new Error(`mode menu missing: ${marker}`)
}
if (!modeHtml.includes('aria-checked="true"')) throw new Error('mode menu must mark the current mode')
if (modeHtml.includes('Записать')) throw new Error('mode menu must not start a capture')
if (/aria-expanded="true"/.test(micHtml)) throw new Error('microphone must not open the menu by itself')
if (micHtml.includes('>Вставить<')) throw new Error('the composer must not ask for a manual insert')

console.log('quick panel smoke passed, bytes:', panelHtml.length, 'mode menu bytes:', modeHtml.length)
console.log('smoke test passed')
process.exit(0)
