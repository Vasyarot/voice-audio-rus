// Real-network download check for the Whisper provider (sherpa is stubbed, only files matter).
import { createWhisperProvider } from '../plugin/whisper-local.js'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../.models-test/tiny', import.meta.url))
await rm(fileURLToPath(new URL('../.models-test', import.meta.url)), { recursive: true, force: true })

class Stub {
  constructor() {}
  createStream() { return { acceptWaveform() {} } }
  decode() {}
  getResult() { return { text: '' } }
}

const provider = createWhisperProvider(
  { model: 'tiny', dataRoot: root, modelOrigins: ['https://huggingface.co'], threads: 2 },
  { loadSherpa: () => ({ OfflineRecognizer: Stub }) },
)

let lastPhase = ''
const started = Date.now()
const timer = setInterval(() => {
  const snapshot = provider.preparation.snapshot()
  const pct = snapshot.totalBytes ? Math.round((snapshot.completedBytes / snapshot.totalBytes) * 100) : 0
  const line = `${snapshot.phase} ${snapshot.resource ?? ''} ${pct}%`
  if (line !== lastPhase) {
    lastPhase = line
    console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, line)
  }
}, 1000)

await provider.preparation.prepare()
clearInterval(timer)
console.log('final:', JSON.stringify(provider.preparation.snapshot()))
for (const file of ['tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tiny-tokens.txt']) {
  const info = await stat(join(root, file))
  console.log(file, (info.size / 1024 / 1024).toFixed(1), 'MB')
}
console.log('elapsed:', ((Date.now() - started) / 1000).toFixed(1), 's')
