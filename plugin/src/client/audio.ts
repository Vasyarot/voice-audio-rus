// Microphone capture with an optional RNNoise worklet, live level metering,
// noise gate, AGC and canonical 16 kHz mono PCM16 WAV encoding for the Host.
import wasmBinary from '../../assets/rnnoise.wasm'
import workletSource from '../../assets/rnnoise-worklet.txt'
import type { Settings } from './settings'

export const TARGET_SAMPLE_RATE = 48000
export const WAV_SAMPLE_RATE = 16000

export type RecorderFailure =
  | 'unavailable'
  | 'permission'
  | 'deviceMissing'
  | 'interrupted'
  | 'empty'
  | 'rnnoise'

export class RecorderError extends Error {
  kind: RecorderFailure
  constructor(kind: RecorderFailure, message?: string) {
    super(message ?? kind)
    this.kind = kind
    this.name = 'RecorderError'
  }
}

export type AudioDevice = { id: string; label: string }

export async function listInputDevices(): Promise<AudioDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  let index = 0
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => {
      index += 1
      return { id: device.deviceId, label: device.label || `Микрофон ${index}` }
    })
}

/** Ask for microphone access once so device labels become readable. */
export async function requestMicrophonePermission(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new RecorderError('unavailable')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    for (const track of stream.getTracks()) track.stop()
  } catch (error) {
    throw mapMediaError(error)
  }
}

function mapMediaError(error: unknown): RecorderError {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return new RecorderError('permission')
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return new RecorderError('deviceMissing')
  }
  return new RecorderError('unavailable', error instanceof Error ? error.message : String(error))
}

const workletLoaded = new WeakMap<AudioContext, Promise<void>>()

function ensureWorklet(context: AudioContext): Promise<void> {
  const cached = workletLoaded.get(context)
  if (cached) return cached
  if (!context.audioWorklet) {
    const rejected = Promise.reject(new RecorderError('rnnoise', 'AudioWorklet недоступен'))
    workletLoaded.set(context, rejected)
    return rejected
  }
  const pending = (async () => {
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
  })()
  workletLoaded.set(context, pending)
  return pending
}

function createRnnoiseNode(context: AudioContext): AudioWorkletNode {
  return new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/rnnoise', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { wasmBinary, maxChannels: 1 },
  })
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate
    } catch {
      /* keep probing */
    }
  }
  return ''
}

/** Live capture session: one microphone, one processed graph, one recorder. */
export class VoiceRecorder {
  readonly settings: Settings
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private recorder: MediaRecorder | null = null
  private analyser: AnalyserNode | null = null
  private chunks: BlobPart[] = []
  private levelBuffer = new Float32Array(1024)
  rnnoiseApplied = false
  rnnoiseFailure: string | null = null
  startedAt = 0

  constructor(settings: Settings) {
    this.settings = settings
  }

  async start(): Promise<void> {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new RecorderError('unavailable')
    }
    const settings = this.settings
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: settings.browser.echoCancellation,
      noiseSuppression: settings.browser.noiseSuppression,
      autoGainControl: settings.browser.autoGainControl,
    }
    if (settings.deviceId !== '') audio.deviceId = { exact: settings.deviceId }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
    } catch (error) {
      throw mapMediaError(error)
    }
    this.stream = stream

    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
    this.context = context
    try {
      await context.resume()
    } catch {
      /* resume may need a gesture; capture still works once the graph runs */
    }

    const source = context.createMediaStreamSource(stream)
    let tail: AudioNode = source
    if (settings.highpass.enabled) {
      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = settings.highpass.hz
      highpass.Q.value = 0.707
      tail.connect(highpass)
      tail = highpass
    }
    if (settings.gainDb !== 0) {
      const gain = context.createGain()
      gain.gain.value = Math.pow(10, settings.gainDb / 20)
      tail.connect(gain)
      tail = gain
    }

    const post = context.createGain()
    if (settings.rnnoise.enabled) {
      try {
        await ensureWorklet(context)
        const node = createRnnoiseNode(context)
        const wet = context.createGain()
        wet.gain.value = Math.max(0, Math.min(1, settings.rnnoise.mix))
        const dry = context.createGain()
        dry.gain.value = 1 - wet.gain.value
        tail.connect(dry)
        dry.connect(post)
        tail.connect(node)
        node.connect(wet)
        wet.connect(post)
        this.rnnoiseApplied = true
      } catch (error) {
        this.rnnoiseFailure = error instanceof Error ? error.message : String(error)
        tail.connect(post)
      }
    } else {
      tail.connect(post)
    }

    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.5
    post.connect(analyser)
    this.analyser = analyser

    const destination = context.createMediaStreamDestination()
    analyser.connect(destination)

    const mimeType = pickMimeType()
    const recorder = mimeType === '' ? new MediaRecorder(destination.stream) : new MediaRecorder(destination.stream, { mimeType })
    this.recorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        this.analyser = null
      })
    }
    recorder.start(250)
    this.startedAt = performance.now()
  }

  /** Current RMS level in dBFS, or -100 outside capture. */
  levelDb(): number {
    const analyser = this.analyser
    if (!analyser) return -100
    analyser.getFloatTimeDomainData(this.levelBuffer)
    let sum = 0
    for (const sample of this.levelBuffer) sum += sample * sample
    const rms = Math.sqrt(sum / this.levelBuffer.length)
    return 20 * Math.log10(Math.max(rms, 1e-6))
  }

  elapsedSeconds(): number {
    return this.startedAt === 0 ? 0 : (performance.now() - this.startedAt) / 1000
  }

  /**
   * Finish capture and return canonical PCM16 WAV bytes (16 kHz mono).
   * The processed graph output is decoded, gated, normalized and resampled.
   */
  async stop(maxDurationSeconds: number): Promise<Uint8Array> {
    const recorder = this.recorder
    const context = this.context
    if (!recorder || !context || recorder.state !== 'recording') {
      await this.dispose()
      throw new RecorderError('empty')
    }
    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => resolve()
    })
    try {
      recorder.stop()
    } catch {
      /* already stopped */
    }
    await finished
    for (const track of this.stream?.getTracks() ?? []) track.stop()

    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
    this.chunks = []
    if (blob.size === 0) {
      await this.dispose()
      throw new RecorderError('empty')
    }
    let decoded: AudioBuffer
    try {
      decoded = await context.decodeAudioData(await blob.arrayBuffer())
    } catch (error) {
      await this.dispose()
      throw new RecorderError('empty', error instanceof Error ? error.message : String(error))
    }
    const limit = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * decoded.sampleRate))
    let samples = decoded.getChannelData(0).slice(0, limit)
    samples = processSamples(samples, this.settings, decoded.sampleRate)
    const resampled = downsample(samples, decoded.sampleRate, WAV_SAMPLE_RATE)
    applyFades(resampled, WAV_SAMPLE_RATE)
    const wav = encodeWav(resampled)
    await this.dispose()
    return wav
  }

  async dispose(): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* ignore */
      }
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.analyser = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') {
      try {
        await context.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Gate → AGC → peak protection, all in the time domain on the decoded buffer. */
export function processSamples(input: Float32Array, settings: Settings, sampleRate: number): Float32Array {
  const out = Float32Array.from(input)
  if (settings.gate.enabled) applyGate(out, settings, sampleRate)
  if (settings.agc.enabled) applyAgc(out, settings, sampleRate)
  if (settings.limiter) protectPeak(out)
  return out
}

function applyGate(samples: Float32Array, settings: Settings, sampleRate: number): void {
  const openDb = settings.gate.thresholdDb
  const closeDb = openDb - 6
  const holdSamples = Math.round((settings.gate.holdMs / 1000) * sampleRate)
  const attack = 1 - Math.exp(-1 / (sampleRate * 0.004))
  const release = 1 - Math.exp(-1 / (sampleRate * 0.06))
  let envelope = 0
  let gain = 0
  let hold = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    envelope += (magnitude - envelope) * (magnitude > envelope ? 0.35 : 0.0015)
    const db = 20 * Math.log10(envelope + 1e-9)
    let target = gain > 0.5 ? 1 : 0
    if (db >= openDb) {
      target = 1
      hold = holdSamples
    } else if (db <= closeDb) {
      if (hold > 0) {
        hold -= 1
        target = 1
      } else {
        target = 0
      }
    }
    gain += (target - gain) * (target > gain ? attack : release)
    samples[i] *= gain
  }
}

function applyAgc(samples: Float32Array, settings: Settings, sampleRate: number): void {
  let sum = 0
  let counted = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    if (Math.abs(value) > 1e-4) {
      sum += value * value
      counted += 1
    }
  }
  if (counted === 0) return
  const rms = Math.sqrt(sum / counted)
  if (rms <= 1e-5) return
  const target = Math.pow(10, settings.agc.targetDb / 20)
  const maxGain = Math.pow(10, settings.agc.maxGainDb / 20)
  const desired = Math.min(maxGain, Math.max(0.1, target / rms))
  const smoothing = 1 - Math.exp(-1 / (sampleRate * 0.12))
  let gain = desired
  for (let i = 0; i < samples.length; i += 1) {
    gain += (desired - gain) * smoothing
    samples[i] *= gain
  }
}

function protectPeak(samples: Float32Array): void {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  if (peak <= 0.98) return
  const scale = 0.98 / peak
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale
}

function applyFades(samples: Float32Array, sampleRate: number): void {
  const fade = Math.min(Math.floor(samples.length / 2), Math.round(sampleRate * 0.01))
  for (let i = 0; i < fade; i += 1) {
    const factor = i / fade
    samples[i] *= factor
    samples[samples.length - 1 - i] *= factor
  }
}

/** Box-filter downsampling (48 kHz → 16 kHz is an exact factor of three). */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  if (from % to === 0) {
    const factor = from / to
    const length = Math.floor(input.length / factor)
    const out = new Float32Array(length)
    for (let i = 0; i < length; i += 1) {
      let sum = 0
      for (let j = 0; j < factor; j += 1) sum += input[i * factor + j]
      out[i] = sum / factor
    }
    return out
  }
  const ratio = from / to
  const length = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/** Canonical little-endian 16 kHz mono PCM16 WAV accepted by the speech Remote. */
export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, WAV_SAMPLE_RATE, true)
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

export function audioBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}

/**
 * Preview chain for the settings meter: high-pass → gain → RNNoise → analyser.
 * Returns an analyser measuring the post-suppression signal, so the page can show
 * both the raw microphone level and the level after the configured processing.
 */
export async function attachSuppressorAsync(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  settings: Settings,
): Promise<AnalyserNode> {
  let tail: AudioNode = source
  if (settings.highpass.enabled) {
    const highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = settings.highpass.hz
    highpass.Q.value = 0.707
    tail.connect(highpass)
    tail = highpass
  }
  if (settings.gainDb !== 0) {
    const gain = context.createGain()
    gain.gain.value = Math.pow(10, settings.gainDb / 20)
    tail.connect(gain)
    tail = gain
  }
  const post = context.createGain()
  if (settings.rnnoise.enabled) {
    try {
      await ensureWorklet(context)
      const node = createRnnoiseNode(context)
      const wet = context.createGain()
      wet.gain.value = Math.max(0, Math.min(1, settings.rnnoise.mix))
      const dry = context.createGain()
      dry.gain.value = 1 - wet.gain.value
      tail.connect(dry)
      dry.connect(post)
      tail.connect(node)
      node.connect(wet)
      wet.connect(post)
    } catch {
      tail.connect(post)
    }
  } else {
    tail.connect(post)
  }
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  post.connect(analyser)
  return analyser
}

