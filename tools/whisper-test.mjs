// Whisper-local provider test with an injected sherpa runtime and fake HTTP.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { register } = require('node:module')
// The provider is ESM; import it directly.
const { createWhisperProvider } = await import(new URL('../plugin/whisper-local.js', import.meta.url).href)

const root = await mkdtemp(join(tmpdir(), 'voice-studio-whisper-'))
const captured = []
const payload = new TextEncoder().encode('fake-model-bytes')

const fakeFetch = async (url) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(payload.length) : null) },
  body: (async function* () {
    yield payload.subarray(0, 4)
    yield payload.subarray(4)
  })(),
})

class FakeRecognizer {
  constructor(config) {
    captured.push(config)
  }
  createStream() {
    return { acceptWaveform() {} }
  }
  decode() {}
  getResult() {
    return { text: ' привет мир ' }
  }
}

const provider = createWhisperProvider(
  {
    model: 'tiny',
    dataRoot: root,
    modelOrigins: ['https://example.test'],
    threads: 2,
    languages: ['auto', 'ru', 'en'],
  },
  { fetch: fakeFetch, loadSherpa: () => ({ OfflineRecognizer: FakeRecognizer }) },
)

assert.equal(provider.info.id, 'whisper-tiny')
assert.equal(provider.info.location, 'host-local')
assert.ok(provider.info.languages.includes('ru'))
assert.equal(provider.preparation.snapshot().phase, 'unprepared')

await provider.preparation.prepare()
assert.equal(provider.preparation.snapshot().phase, 'ready')
const encoder = await readFile(join(root, 'tiny-encoder.int8.onnx'))
assert.equal(encoder.toString(), 'fake-model-bytes')

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

const result = await provider.transcribe({ audio: wav, language: 'ru' }, new AbortController().signal)
assert.equal(result.text, 'привет мир')
assert.equal(result.audioSeconds, 1)
assert.equal(captured.at(-1).modelConfig.whisper.language, 'ru')
assert.equal(captured.at(-1).modelConfig.whisper.task, 'transcribe')

await provider.transcribe({ audio: wav, language: 'auto' }, new AbortController().signal)
assert.equal(captured.at(-1).modelConfig.whisper.language, '')

await rm(root, { recursive: true, force: true })
console.log('whisper provider test passed')
