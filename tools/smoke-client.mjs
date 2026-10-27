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
  catalog: async () => ({ ok: true, value: { providers: [], selection: { providerId: '', language: 'auto' }, maxAudioBytes: 1, maxDurationSeconds: 1 } }),
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

const settings = registered.find((item) => item.options?.name === 'plugins.bundle.config')
const settingsHtml = renderToString(
  React.createElement(settings.component, { voiceStudio: { ctx }, t: (key) => key }),
)
const sections = [
  'Модели распознавания речи',
  'Микрофон',
  'Сравнение и история',
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
for (const nested of ['Сравнение моделей', 'История диктовок']) {
  if (!settingsHtml.includes(nested)) throw new Error(`merged section missing part: ${nested}`)
}
if (settingsHtml.includes('Облачный провайдер')) throw new Error('duplicated cloud section is still rendered')

console.log('render smoke passed, settings page bytes:', settingsHtml.length)
console.log('smoke test passed')
process.exit(0)
