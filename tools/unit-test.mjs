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
export { postProcess } from '../plugin/src/client/text'
export { encodeWav, downsample, processSamples } from '../plugin/src/client/audio'
export { DEFAULT_SETTINGS } from '../plugin/src/client/settings'
`,
)

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

const { postProcess, encodeWav, downsample, processSamples, DEFAULT_SETTINGS } = await import(
  new URL('../.tmp/unit.mjs', import.meta.url).href
)

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
