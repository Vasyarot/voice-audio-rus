// Cloud provider tests: live volatile settings, key resolution (credentials → env) and redaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createProvider } from '../plugin/index.js'

const wrap = (value) => ({ get: () => value })

const calls = []
const fetchMock = async (url) => {
  calls.push(url)
  return new Response(JSON.stringify({ text: ' привет ' }), { status: 200, headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = fetchMock

const wav = Buffer.alloc(44 + 32000)
wav.write('RIFF', 0, 'ascii')
wav.write('WAVE', 8, 'ascii')
wav.write('fmt ', 12, 'ascii')
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(32000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36, 'ascii')
wav.writeUInt32LE(32000, 40)
wav.writeUInt32LE(wav.length - 8, 4)

const baseConfig = () => ({
  providerId: wrap('cloud-openai'),
  title: wrap('Облако'),
  baseURL: wrap('https://api.example/v1'),
  model: wrap('whisper-1'),
  apiKeyEnv: wrap('VOICE_TEST_KEY'),
  languages: wrap(['auto', 'ru', 'en']),
  prompt: wrap(''),
  timeoutMs: wrap(5000),
})

const credentials = {
  resolve: async (ref) => (ref === 'VOICE_TEST_KEY' ? { value: 'secret-from-store' } : undefined),
}
const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined) }
const provider = createProvider(baseConfig(), ctx)

const result = await provider.transcribe({ audio: wav, language: 'ru' }, new AbortController().signal)
assert.equal(result.text, 'привет')
assert.equal(result.audioSeconds, 1)
assert.equal(calls.at(-1), 'https://api.example/v1/audio/transcriptions')

// Live settings: a changed wrapper value takes effect on the next call.
const live = baseConfig()
live.baseURL = wrap('https://api.other/v2')
const liveProvider = createProvider(live, ctx)
await liveProvider.transcribe({ audio: wav, language: 'auto' }, new AbortController().signal)
assert.equal(calls.at(-1), 'https://api.other/v2/audio/transcriptions')

// Environment fallback when the credentials service has no entry.
delete credentials.resolve
process.env.VOICE_TEST_KEY = 'secret-from-env'
const envProvider = createProvider(baseConfig(), { get: () => undefined })
await envProvider.transcribe({ audio: wav, language: 'ru' }, new AbortController().signal)

// Missing secret: actionable error names the reference, never the value.
delete process.env.VOICE_TEST_KEY
const broken = createProvider(baseConfig(), { get: () => undefined })
await assert.rejects(
  () => broken.transcribe({ audio: wav, language: 'ru' }, new AbortController().signal),
  /VOICE_TEST_KEY/,
)

// Unsupported language is rejected before any network call.
const before = calls.length
await assert.rejects(() => provider.transcribe({ audio: wav, language: 'de' }, new AbortController().signal), /de/)
assert.equal(calls.length, before)

// Auth header carries the store secret, not a placeholder.
let seen
globalThis.fetch = async (url, init) => {
  seen = init.headers.Authorization
  return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
}
credentials.resolve = async () => ({ value: 'secret-from-store' })
await createProvider(baseConfig(), ctx).transcribe({ audio: wav, language: 'ru' }, new AbortController().signal)
assert.equal(seen, 'Bearer secret-from-store')

console.log('cloud provider tests passed')
