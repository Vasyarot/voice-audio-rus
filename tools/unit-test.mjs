// Unit checks for the pure parts of the client: text post-processing and WAV/DSP helpers.
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

await mkdir(resolve(root, '.tmp'), { recursive: true })
await writeFile(
  resolve(root, '.tmp/unit-entry.ts'),
  `
export { postProcess, joinLiveText } from '../plugin/src/client/text'
export { encodeWav, downsample, processSamples, wavFromSamples } from '../plugin/src/client/audio'
export { DEFAULT_SETTINGS, getSettings, resetSettings, setSettings } from '../plugin/src/client/settings'
export { isSpeechModel, recommendModel, scoreModel, normalizeBaseURL } from '../plugin/src/client/cloud'
export { createLiveWriter } from '../plugin/src/client/live'
`,
)

// settings.ts touches localStorage while its module body runs, so the stub has to
// be in place before the bundle is imported.
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
}

await build({
  entryPoints: [resolve(root, '.tmp/unit-entry.ts')],
  outfile: resolve(root, '.tmp/unit.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  loader: { '.wasm': 'binary', '.txt': 'text' },
  logLevel: 'warning',
})

const { postProcess, encodeWav, downsample, processSamples, DEFAULT_SETTINGS, resetSettings, setSettings, getSettings, joinLiveText, wavFromSamples, isSpeechModel, recommendModel, scoreModel, normalizeBaseURL, createLiveWriter } = await import(
  new URL('../.tmp/unit.mjs', import.meta.url).href
)

// Reset returns audio/text settings to defaults but keeps the host-owned model choice.
setSettings({
  ...DEFAULT_SETTINGS,
  providerId: 'cloud-openai',
  language: 'en',
  gainDb: 9,
  gate: { enabled: false, thresholdDb: -60, holdMs: 900 },
  text: { autoPunctuation: false, removeFillers: true, dictionary: [{ from: 'а', to: 'б' }] },
})
resetSettings({ providerId: getSettings().providerId, language: getSettings().language })
const afterReset = getSettings()
assert.equal(afterReset.providerId, 'cloud-openai', 'reset must keep the provider')
assert.equal(afterReset.language, 'en', 'reset must keep the language')
assert.equal(afterReset.gainDb, DEFAULT_SETTINGS.gainDb)
assert.deepEqual(afterReset.gate, DEFAULT_SETTINGS.gate)
assert.deepEqual(afterReset.text, DEFAULT_SETTINGS.text)
assert.equal(afterReset.ptt.enabled, DEFAULT_SETTINGS.ptt.enabled)

const base = structuredClone(DEFAULT_SETTINGS)
base.text = { ...base.text, autoPunctuation: true, removeFillers: true, dictionary: [] }

assert.equal(postProcess('привет   мир', base), 'Привет мир.')
assert.equal(postProcess('как дела', base), 'Как дела.')
assert.equal(postProcess('уже с точкой.', base), 'Уже с точкой.')

base.text.dictionary = [{ from: 'ханес', to: 'Harness' }]
assert.equal(postProcess('ханес рулит', base), 'Harness рулит.')

base.text.dictionary = []
assert.equal(postProcess('ну вот это как бы тест', base), 'Это тест.')

const wav = encodeWav(new Float32Array(16000).fill(0.5))
const view = new DataView(wav.buffer)
assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')
assert.equal(view.getUint32(24, true), 16000)
assert.equal(view.getUint32(40, true), 32000)
assert.equal(wav.length, 44 + 32000)

const source = new Float32Array(48000)
for (let i = 0; i < source.length; i += 1) source[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.3
const down = downsample(source, 48000, 16000)
assert.equal(down.length, 16000)
for (const value of down) assert.ok(Number.isFinite(value) && Math.abs(value) <= 1)

const gated = new Float32Array(48000)
for (let i = 0; i < gated.length; i += 1) {
  gated[i] = i > 24000 ? Math.sin((2 * Math.PI * 300 * (i - 24000)) / 48000) * 0.05 : 0.00001
}
const processed = processSamples(gated, structuredClone(DEFAULT_SETTINGS), 48000)
for (const value of processed) assert.ok(Number.isFinite(value))
assert.ok(Math.abs(processed[100]) < Math.abs(processed[40000]), 'gate should suppress leading silence')

console.log('unit tests passed')

// ---- dictation mode, live fragments and cloud model ranking

assert.equal(DEFAULT_SETTINGS.mode, 'utterance')
assert.deepEqual(DEFAULT_SETTINGS.live, { chunkSeconds: 1.5, pauseMs: 400, autoStop: true })

setSettings({ ...DEFAULT_SETTINGS, mode: 'live', live: { chunkSeconds: 99, pauseMs: 10 } })
const liveSettings = getSettings()
assert.equal(liveSettings.mode, 'live', 'live mode must persist')
assert.equal(liveSettings.live.chunkSeconds, 15, 'chunk seconds are clamped')
assert.equal(liveSettings.live.pauseMs, 200, 'pause is clamped')
assert.equal(liveSettings.live.autoStop, true, 'live auto-stop defaults to on')
setSettings({ ...DEFAULT_SETTINGS, live: { chunkSeconds: 0.2, pauseMs: 9000, autoStop: false } })
assert.equal(getSettings().live.chunkSeconds, 1, 'chunk seconds have a one-second floor')
assert.equal(getSettings().live.pauseMs, 3000, 'pause has a ceiling')
assert.equal(getSettings().live.autoStop, false, 'a manual-only live session must persist')
setSettings({ ...DEFAULT_SETTINGS, mode: 'weird' })
assert.equal(getSettings().mode, 'utterance', 'unknown mode falls back to the button mode')
setSettings({ ...DEFAULT_SETTINGS, mode: 'live' })
resetSettings({ providerId: 'cloud-openai', language: 'ru' })
assert.equal(getSettings().mode, 'utterance', 'reset restores the button mode')
assert.equal(getSettings().providerId, 'cloud-openai')

assert.equal(joinLiveText('', ' Привет '), 'Привет')
assert.equal(joinLiveText('Привет', ' мир'), 'Привет мир')
assert.equal(joinLiveText('Привет', '.'), 'Привет.')
assert.equal(joinLiveText('Привет', ', мир'), 'Привет, мир')
assert.equal(joinLiveText('Привет.', 'как дела'), 'Привет. Как дела')
assert.equal(joinLiveText('Привет', '   '), 'Привет')

const liveWav = wavFromSamples(new Float32Array(48000).fill(0.2), 48000, structuredClone(DEFAULT_SETTINGS))
const liveView = new DataView(liveWav.buffer)
assert.equal(liveView.getUint32(24, true), 16000)
assert.equal(liveView.getUint32(40, true), 32000)
assert.equal(liveWav.length, 44 + 32000)
assert.equal(wavFromSamples(new Float32Array(0), 48000, structuredClone(DEFAULT_SETTINGS)).length, 44)

assert.equal(normalizeBaseURL(' https://api.example/v1/ '), 'https://api.example/v1')
assert.ok(isSpeechModel('whisper-1'))
assert.ok(isSpeechModel('gpt-4o-transcribe'))
assert.ok(isSpeechModel('whisper-large-v3-turbo'))
assert.ok(!isSpeechModel('tts-1'))
assert.ok(!isSpeechModel('text-embedding-3-small'))
assert.ok(scoreModel('whisper-1') > scoreModel('tts-1'))
const catalogList = ['gpt-4o-mini-tts', 'text-embedding-3-small', 'whisper-1', 'gpt-4o-transcribe']
assert.equal(recommendModel(catalogList), 'gpt-4o-transcribe')
assert.equal(recommendModel(['whisper-large-v3', 'whisper-large-v3-turbo']), 'whisper-large-v3-turbo')
assert.equal(recommendModel(['tts-1', 'dall-e-3']), null)
assert.equal(recommendModel([]), null)

console.log('live mode and model ranking tests passed')

// ---- live writer against DSH composer semantics
// Every edit bumps the draft revision and the caret lands after the insertion,
// which is exactly why a span captured once rejects the next fragment.

function fakeComposer() {
  const editor = { rev: 0, text: '', caret: 0 }
  const port = {
    capture: () => ({ draftRev: editor.rev, at: editor.caret }),
    insert: (text, span) => {
      if (span.draftRev !== editor.rev) return false
      editor.text = editor.text.slice(0, span.at) + text + editor.text.slice(span.at)
      editor.caret = span.at + text.length
      editor.rev += 1
      return true
    },
  }
  return { editor, port }
}

const first = fakeComposer()
const firstWriter = createLiveWriter(first.port, { schedule: (run) => run() })
firstWriter.push('Привет')
firstWriter.push('Привет мир')
firstWriter.push('Привет мир.')
assert.equal(first.editor.text, 'Привет мир.', 'every fragment must land in order')
assert.equal(first.editor.caret, 'Привет мир.'.length, 'the caret follows the inserted text')
assert.equal(firstWriter.committed(), 'Привет мир.'.length)
assert.equal(firstWriter.pending(), '')
// An unchanged session text must not be inserted twice.
firstWriter.push('Привет мир.')
assert.equal(first.editor.text, 'Привет мир.')

const retrying = fakeComposer()
let refusals = 3
const retryPort = {
  capture: retrying.port.capture,
  insert: (text, span) => (refusals-- > 0 ? false : retrying.port.insert(text, span)),
}
const retryWriter = createLiveWriter(retryPort, { schedule: (run) => run() })
retryWriter.push('Раз')
assert.equal(retrying.editor.text, 'Раз', 'refused insertions are retried')
assert.equal(retryWriter.pending(), '')

const cancelledComposer = fakeComposer()
const cancelledWriter = createLiveWriter(cancelledComposer.port, { schedule: (run) => run() })
cancelledWriter.cancel()
cancelledWriter.push('Не должно появиться')
assert.equal(cancelledComposer.editor.text, '', 'a cancelled writer never touches the draft')

console.log('live writer tests passed')
