// Voice Studio client contribution: microphone activity beside the composer,
// a capture row with metering and VAD, and a settings page inside bundle details.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import TYPERT_REMOTE from '../vendor/speech-remote.js'
import { attachSuppressorAsync, audioBase64, listInputDevices, requestMicrophonePermission, RecorderError, VoiceRecorder } from './audio'
import type { AudioDevice } from './audio'
import { addHistory, clearHistory, exportHistory, removeHistory, useHistory } from './history'
import { DEFAULT_SETTINGS, normalizeSettings, resetSettings, setSettings, updateSettings, useSettings } from './settings'
import type { Settings } from './settings'
import { CSS } from './styles'
import { postProcess } from './text'

const NS = 'voice-studio'
const PACKAGE = 'dsh-plugin-voice-studio'

// ---------------------------------------------------------------- icons

function IconMic(props: { size?: number }) {
  const size = props.size ?? 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconStop(props: { size?: number }) {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  )
}

function IconClose(props: { size?: number }) {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function IconGear(props: { size?: number }) {
  const size = props.size ?? 15
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------- speech catalog

type ProviderInfo = {
  id: string
  name?: string
  location: string
  languages: string[]
  preparation?: {
    phase: string
    step?: string
    message?: string
    steps?: Array<{ kind: string; status: string; startedAt?: number }>
    resource?: string
    completedBytes?: number
    totalBytes?: number
  }
}

type Catalog = {
  providers: ProviderInfo[]
  selection: { providerId: string; language: string }
  maxAudioBytes: number
  maxDurationSeconds: number
}

function catalogError(result: any): string {
  const error = result?.error
  if (typeof error?.message === 'string') return error.message
  if (typeof error?.reason === 'string') return error.reason
  return 'Служба распознавания недоступна'
}

function useSpeechCatalog(ctx: any) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const result = await ctx.remote.speech.catalog()
      if (result?.ok) {
        setCatalog(result.value as Catalog)
        setError(null)
      } else {
        setError(catalogError(result))
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [ctx])
  useEffect(() => {
    let alive = true
    const run = () => {
      if (alive) void refresh()
    }
    run()
    const timer = window.setInterval(run, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [refresh])
  return { catalog, error, refresh }
}

function providerLabel(provider: ProviderInfo): string {
  if (provider.name && provider.name.trim() !== '') return provider.name
  if (provider.location === 'host-local') return 'Локально · встроенный движок'
  return provider.id
}

const LANGUAGE_LABELS: Record<string, string> = {
  auto: 'Автоопределение',
  ru: 'Русский',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  yue: '粵語',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  uk: 'Українська',
}

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code
}

function phaseText(provider: ProviderInfo | undefined): string {
  const phase = provider?.preparation?.phase ?? 'ready'
  if (phase === 'ready') return 'готов'
  if (phase === 'standby') return 'ожидает'
  if (phase === 'waking') return 'запуск…'
  if (phase === 'unprepared') return 'модель не скачана'
  if (phase === 'downloading') {
    const done = provider?.preparation?.completedBytes ?? 0
    const total = provider?.preparation?.totalBytes ?? 0
    return total > 0 ? `загрузка ${Math.round((done / total) * 100)}%` : 'загрузка…'
  }
  if (phase === 'checking' || phase === 'loading' || phase === 'cancelling') return 'подготовка…'
  if (phase === 'cancelled') return 'отменено'
  if (phase === 'failed') return provider?.preparation?.message ? `ошибка: ${provider.preparation.message}` : 'ошибка подготовки'
  return phase
}

// ---------------------------------------------------------------- shared helpers

function describeFailure(failure: unknown): string {
  if (failure instanceof RecorderError) {
    switch (failure.kind) {
      case 'permission':
        return 'Нет доступа к микрофону: разрешите его в системе и браузере.'
      case 'deviceMissing':
        return 'Выбранный микрофон не найден. Выберите другое устройство в настройках.'
      case 'unavailable':
        return 'Захват звука недоступен в этом окне.'
      case 'rnnoise':
        return 'Шумоподавление RNNoise не запустилось.'
      case 'empty':
        return 'Пустая запись — попробуйте ещё раз.'
      case 'interrupted':
        return 'Запись прервана: устройство отключилось.'
      default:
        return failure.message
    }
  }
  return failure instanceof Error ? failure.message : String(failure)
}

function comboMatches(event: KeyboardEvent, combo: string): boolean {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return false
  const key = parts[parts.length - 1]
  const wantsCtrl = parts.includes('ctrl') || parts.includes('control')
  const wantsAlt = parts.includes('alt')
  const wantsShift = parts.includes('shift')
  const wantsMeta = parts.includes('meta') || parts.includes('win')
  if (event.ctrlKey !== wantsCtrl) return false
  if (event.altKey !== wantsAlt) return false
  if (event.shiftKey !== wantsShift) return false
  if (event.metaKey !== wantsMeta) return false
  const code = event.code.toLowerCase()
  const name = event.key.toLowerCase()
  if (key === 'space') return code === 'space'
  if (key.length === 1) return name === key || code === `key${key}`
  return code === key || name === key
}

function ComboField(props: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const parts: string[] = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      const key = event.code.startsWith('Key')
        ? event.code.slice(3)
        : event.code.startsWith('Digit')
          ? event.code.slice(5)
          : event.code === 'Space'
            ? 'Space'
            : event.key.length === 1
              ? event.key.toUpperCase()
              : event.code
      parts.push(key)
      props.onChange(parts.join('+'))
      setListening(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [listening, props])
  return (
    <button type="button" className="vs-btn" disabled={props.disabled} onClick={() => setListening((value) => !value)}>
      {listening ? 'Нажмите сочетание…' : props.value || 'Не задано'}
    </button>
  )
}

// ---------------------------------------------------------------- microphone activity

type ActivityProps = {
  sessionId: string
  inputActions: any
  locked?: boolean
  onActiveChange?: (active: boolean) => void
  t?: (key: string, values?: Record<string, unknown>) => string
  voiceStudio: { ctx: any; openSettings: () => void }
}

/** Loopback used by the history page to insert into the active draft. */
let activeDraft: { insertText: (text: string) => boolean } | null = null

function MicActivity(props: ActivityProps) {
  const { sessionId, inputActions, locked, onActiveChange, voiceStudio } = props
  const ctx = voiceStudio.ctx
  const settings = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const { catalog, error: speechError, refresh } = useSpeechCatalog(ctx)
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog

  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'>('idle')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState('')
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const spanRef = useRef<any>(null)
  const selectionRef = useRef<{ providerId: string; language: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const meterRef = useRef<Array<HTMLSpanElement | null>>([])
  const finishRef = useRef<() => void>(() => {})
  const startRef = useRef<() => void>(() => {})

  const selection = catalog?.selection
  const provider = catalog?.providers.find((item) => item.id === selection?.providerId)
  const usable = provider != null && ['ready', 'standby', 'waking'].includes(provider.preparation?.phase ?? 'ready')

  useEffect(() => {
    activeDraft = {
      insertText: (text: string) => {
        try {
          return Boolean(inputActions.insertText(text, inputActions.captureInsertion()))
        } catch {
          return false
        }
      },
    }
    return () => {
      activeDraft = null
    }
  }, [inputActions])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) void recorder.dispose()
    spanRef.current = null
    setPhase('idle')
    setMessage('')
    setPending('')
    setSeconds(0)
  }, [])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || locked) return
    const currentCatalog = catalogRef.current
    const currentProvider = currentCatalog?.providers.find((item) => item.id === currentCatalog.selection.providerId)
    if (!currentCatalog || !currentProvider) {
      setPhase('feedback')
      setMessage('Распознавание ещё не готово. Откройте настройки плагина.')
      return
    }
    if (!['ready', 'standby', 'waking'].includes(currentProvider.preparation?.phase ?? 'ready')) {
      setPhase('feedback')
      setMessage(`Провайдер не готов: ${phaseText(currentProvider)}. Подготовьте модель в настройках.`)
      return
    }
    if (locked) return
    spanRef.current = inputActions.captureInsertion()
    selectionRef.current = { providerId: currentProvider.id, language: currentCatalog.selection.language }
    const recorder = new VoiceRecorder(settingsRef.current)
    setPending('')
    setMessage('')
    setPhase('requesting')
    try {
      await recorder.start()
    } catch (failure) {
      setPhase('feedback')
      setMessage(describeFailure(failure))
      return
    }
    recorderRef.current = recorder
    setSeconds(0)
    setPhase('recording')
  }, [inputActions, locked])

  const finish = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder || phaseRef.current !== 'recording') return
    phaseRef.current = 'transcribing'
    setPhase('transcribing')
    const runRef = { cancelled: false }
    try {
      const maxSeconds = catalogRef.current?.maxDurationSeconds ?? 120
      const wav = await recorder.stop(maxSeconds)
      if (wav.length > (catalogRef.current?.maxAudioBytes ?? 4 * 1024 * 1024)) {
        setPhase('feedback')
        setMessage('Запись слишком большая для выбранного провайдера.')
        return
      }
      const abort = new AbortController()
      abortRef.current = abort
      const selectionValue = selectionRef.current ?? catalogRef.current?.selection
      const result = await ctx.remote.speech.transcribe(
        {
          audioBase64: audioBase64(wav),
          ...(selectionValue ? { providerId: selectionValue.providerId, language: selectionValue.language } : {}),
        },
        abort.signal,
      )
      if (runRef.cancelled) return
      if (!result?.ok) {
        setPhase('feedback')
        setMessage(catalogError(result))
        return
      }
      const transcript = result.value as { text: string; audioSeconds: number }
      if (!transcript.text || transcript.text.trim() === '') {
        setPhase('feedback')
        setMessage('Речь не распознана — попробуйте ближе к микрофону.')
        return
      }
      const text = postProcess(transcript.text, settingsRef.current)
      addHistory(
        {
          text,
          seconds: Math.round(transcript.audioSeconds ?? 0),
          providerId: selectionValue?.providerId ?? '',
          language: selectionValue?.language ?? '',
          deviceLabel: settingsRef.current.deviceLabel,
        },
        settingsRef.current.historyLimit,
      )
      let inserted = false
      try {
        inserted = Boolean(inputActions.insertText(text, spanRef.current))
      } catch {
        inserted = false
      }
      if (inserted) {
        setPhase('idle')
        setMessage('')
        setPending('')
      } else {
        setPending(text)
        setPhase('feedback')
        setMessage('Черновик изменился — вставьте текст вручную.')
      }
    } catch (failure) {
      if (!runRef.cancelled) {
        setPhase('feedback')
        setMessage(describeFailure(failure))
      }
    } finally {
      recorderRef.current = null
      abortRef.current = null
      spanRef.current = null
      void refresh()
    }
  }, [ctx, inputActions, refresh])

  finishRef.current = () => {
    void finish()
  }
  startRef.current = () => {
    void start()
  }

  // Meter, silence auto-stop and the hard duration limit.
  useEffect(() => {
    if (phase !== 'recording') return
    let raf = 0
    let silentMs = 0
    let last = performance.now()
    const tick = () => {
      const recorder = recorderRef.current
      if (recorder) {
        const db = recorder.levelDb()
        const normalized = Math.max(0, Math.min(1, (db + 60) / 60))
        const count = Math.ceil(normalized * 28)
        meterRef.current.forEach((bar, index) => {
          if (!bar) return
          bar.dataset.on = String(index < count)
          bar.dataset.hot = String(index < count && db > -12)
        })
        const now = performance.now()
        const delta = now - last
        last = now
        const vad = settingsRef.current.vad
        if (vad.autoStop) {
          if (db > vad.thresholdDb) silentMs = 0
          else silentMs += delta
          if (silentMs >= vad.silenceMs) {
            silentMs = 0
            finishRef.current()
            return
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const timer = window.setInterval(() => {
      const recorder = recorderRef.current
      setSeconds(recorder ? Math.floor(recorder.elapsedSeconds()) : 0)
    }, 200)
    const maxSeconds = (catalogRef.current?.maxDurationSeconds ?? 120) - 0.6
    const limit = window.setTimeout(() => finishRef.current(), Math.max(1000, maxSeconds * 1000))
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(timer)
      window.clearTimeout(limit)
    }
  }, [phase])

  // Push-to-talk while the composer is mounted.
  useEffect(() => {
    const ptt = settings.ptt
    if (!ptt.enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!comboMatches(event, ptt.combo) || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      event.preventDefault()
      if (ptt.mode === 'toggle') {
        if (phaseRef.current === 'recording') finishRef.current()
        else startRef.current()
      } else if (phaseRef.current === 'idle') {
        startRef.current()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (ptt.mode !== 'hold') return
      if (phaseRef.current !== 'recording') return
      if (!comboMatches(event, ptt.combo)) return
      event.preventDefault()
      finishRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [settings.ptt.enabled, settings.ptt.combo, settings.ptt.mode])

  // Escape cancels; hiding the page abandons the capture.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phaseRef.current !== 'idle') {
        event.preventDefault()
        cancel()
      }
    }
    const onVisibility = () => {
      if (document.hidden && phaseRef.current === 'recording') cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [cancel])

  useEffect(() => () => cancel(), [cancel])

  const expanded = phase !== 'idle'
  useEffect(() => {
    onActiveChange?.(expanded)
    return () => onActiveChange?.(false)
  }, [expanded, onActiveChange])

  useEffect(() => {
    // A new session owns a fresh draft: drop a transcript that belonged to the old one.
    setPending('')
    setMessage('')
    if (phaseRef.current !== 'recording') setPhase('idle')
  }, [sessionId])

  const insertPending = () => {
    if (pending === '') return
    try {
      if (inputActions.insertText(pending, inputActions.captureInsertion())) {
        setPending('')
        setPhase('idle')
        setMessage('')
      }
    } catch {
      /* keep the pending text visible */
    }
  }

  const copyPending = () => {
    if (pending !== '') void navigator.clipboard?.writeText(pending).catch(() => {})
  }

  if (!expanded) {
    return (
      <span className="vs-root" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <button
          type="button"
          className="vs-trigger"
          title={usable ? 'Голосовой ввод' : 'Голосовой ввод: настройте распознавание'}
          aria-label="Голосовой ввод"
          disabled={Boolean(locked)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (usable) void start()
            else {
              setPhase('feedback')
              setMessage(speechError ?? 'Провайдер не готов. Подготовьте модель в настройках.')
            }
          }}
        >
          <IconMic />
        </button>
      </span>
    )
  }

  return (
    <div className="vs-root vs-row" data-voice-studio={phase}>
      <button
        type="button"
        className="vs-round"
        aria-label={pending ? 'Отменить' : 'Отмена'}
        onClick={cancel}
      >
        <IconClose />
      </button>
      {phase === 'recording' ? (
        <>
          <span className="vs-timer">{formatSeconds(seconds)}</span>
          <span className="vs-meter" role="img" aria-label="Уровень микрофона">
            {Array.from({ length: 28 }, (_, index) => (
              <span
                key={index}
                ref={(element) => {
                  meterRef.current[index] = element
                }}
              />
            ))}
          </span>
          <button type="button" className="vs-round" aria-label="Остановить и распознать" onClick={() => finishRef.current()}>
            <IconStop />
          </button>
        </>
      ) : (
        <>
          <span className="vs-status" role="status">
            {phase === 'requesting'
              ? 'Доступ к микрофону…'
              : phase === 'transcribing'
                ? 'Распознавание…'
                : pending !== ''
                  ? 'Текст готов — вставьте вручную'
                  : message || 'Голосовой ввод'}
          </span>
          {phase === 'feedback' && pending !== '' ? (
            <span className="vs-pending">
              <button type="button" className="vs-link" onClick={insertPending}>
                Вставить
              </button>
              <button type="button" className="vs-link" onClick={copyPending}>
                Копировать
              </button>
            </span>
          ) : null}
          {phase === 'feedback' ? (
            <button
              type="button"
              className="vs-round"
              aria-label="Повторить запись"
              onClick={() => {
                setMessage('')
                setPending('')
                setPhase('idle')
                void start()
              }}
            >
              <IconMic size={16} />
            </button>
          ) : null}
        </>
      )}
      <button
        type="button"
        className="vs-round"
        aria-label="Настройки голосового ввода"
        title="Настройки голосового ввода"
        onClick={voiceStudio.openSettings}
      >
        <IconGear />
      </button>
    </div>
  )
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = Math.max(0, value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// ---------------------------------------------------------------- settings page

function Row(props: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="vs-line">
      <label>
        {props.label}
        {props.hint ? <div className="vs-hint">{props.hint}</div> : null}
      </label>
      <span className="vs-controls">{props.children}</span>
    </div>
  )
}

function Slider(props: {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (value: number) => void
}) {
  return (
    <>
      <input
        className="vs-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <span className="vs-value">
        {Math.round(props.value)}
        {props.unit ?? ''}
      </span>
    </>
  )
}

function Check(props: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <label className="vs-check">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      {props.label ?? null}
    </label>
  )
}

function PreparationProgress(props: { provider?: ProviderInfo }) {
  const preparation = props.provider?.preparation
  if (!preparation) return null
  const phase = preparation.phase ?? 'ready'
  if (phase === 'failed') return <p className="vs-error">{preparation.message ?? 'Не удалось подготовить модель'}</p>
  if (phase === 'downloading') {
    const total = preparation.totalBytes ?? 0
    const done = preparation.completedBytes ?? 0
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    return (
      <div className="vs-progress">
        <div className="vs-progress-bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="vs-progress-meta">
          {preparation.resource ?? 'модель'} · {(done / 1048576).toFixed(1)} МБ
          {total > 0 ? ` / ${(total / 1048576).toFixed(1)} МБ` : ''} · {percent}%
        </div>
      </div>
    )
  }
  if (phase === 'checking' || phase === 'loading' || phase === 'waking' || phase === 'cancelling') {
    return <p className="vs-hint">Подготовка модели…</p>
  }
  return null
}

function MicTester(props: {
  settings: Settings
  onThresholdChange: (value: number) => void
  onCalibrate: (value: number) => void
}) {
  const [running, setRunning] = useState(false)
  const [db, setDb] = useState(-100)
  const [processedDb, setProcessedDb] = useState(-100)
  const [error, setError] = useState<string | null>(null)
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const processedFillRef = useRef<HTMLSpanElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const collectRef = useRef<number[]>([])
  const collectingRef = useRef(false)
  const [calibrating, setCalibrating] = useState(false)
  const [calibration, setCalibration] = useState<string | null>(null)

  const stop = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
    setRunning(false)
  }, [])
  useEffect(() => stop, [stop])

  const start = async () => {
    setError(null)
    try {
      const audio: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: props.settings.browser.echoCancellation,
        noiseSuppression: props.settings.browser.noiseSuppression,
        autoGainControl: props.settings.browser.autoGainControl,
      }
      if (props.settings.deviceId !== '') audio.deviceId = { exact: props.settings.deviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      const context = new AudioContext({ sampleRate: 48000 })
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      const source = context.createMediaStreamSource(stream)
      source.connect(analyser)
      const processedAnalyser = await attachSuppressorAsync(context, source, props.settings)
      const buffer = new Float32Array(analyser.fftSize)
      const processedBuffer = new Float32Array(processedAnalyser.fftSize)
      let raf = 0
      let last = 0
      const tick = () => {
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (const value of buffer) sum += value * value
        const level = 20 * Math.log10(Math.max(Math.sqrt(sum / buffer.length), 1e-6))
        processedAnalyser.getFloatTimeDomainData(processedBuffer)
        let processedSum = 0
        for (const value of processedBuffer) processedSum += value * value
        const processedLevel = 20 * Math.log10(Math.max(Math.sqrt(processedSum / processedBuffer.length), 1e-6))
        const now = performance.now()
        if (now - last > 80) {
          last = now
          setDb(level)
          setProcessedDb(processedLevel)
          if (collectingRef.current) {
            collectRef.current.push(level)
            if (collectRef.current.length > 400) collectRef.current.shift()
          }
          if (fillRef.current) fillRef.current.style.width = `${Math.max(0, Math.min(1, (level + 60) / 60)) * 100}%`
          if (processedFillRef.current) {
            processedFillRef.current.style.width = `${Math.max(0, Math.min(1, (processedLevel + 60) / 60)) * 100}%`
          }
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      setRunning(true)
      stopRef.current = () => {
        cancelAnimationFrame(raf)
        for (const track of stream.getTracks()) track.stop()
        void context.close().catch(() => {})
      }
    } catch (failure) {
      setError(describeFailure(failure))
    }
  }

  const calibrate = () => {
    if (!running) return
    collectRef.current = []
    collectingRef.current = true
    setCalibrating(true)
    setCalibration(null)
    window.setTimeout(() => {
      collectingRef.current = false
      setCalibrating(false)
      const levels = [...collectRef.current].sort((a, b) => a - b)
      if (levels.length === 0) return
      const noise = levels[Math.floor(levels.length * 0.8)]
      const threshold = Math.round(Math.max(-70, Math.min(-15, noise + 6)))
      props.onCalibrate(threshold)
      setCalibration(`Порог: ${threshold} дБ (измеренный шум ${noise.toFixed(1)} дБ)`)
    }, 1200)
  }

  return (
    <div className="vs-live">
      <div className="vs-line">
        <label>
          Тест микрофона
          <div className="vs-hint">Говорите — уровень обновляется в реальном времени; капля = децибелы.</div>
        </label>
        <span className="vs-controls">
          {running ? (
            <button type="button" className="vs-btn" onClick={stop}>
              Остановить
            </button>
          ) : (
            <button type="button" className="vs-btn" onClick={() => void start()}>
              Включить тест
            </button>
          )}
        </span>
      </div>
      <div className="vs-live-db">
        До подавления: {running ? `${db.toFixed(1)} дБ · ${db >= props.settings.gate.thresholdDb ? 'речь/сигнал' : 'шум'}` : '— дБ'}
      </div>
      <div className="vs-live-meter">
        <span ref={fillRef} style={{ width: '0%' }} />
      </div>
      <div className="vs-live-db">После подавления: {running ? `${processedDb.toFixed(1)} дБ` : '— дБ'}</div>
      <div className="vs-live-meter" data-kind="processed">
        <span ref={processedFillRef} style={{ width: '0%' }} />
      </div>
      <div className="vs-line">
        <label>
          Порог шума
          <div className="vs-hint">Ниже порога сигнал считается шумом и обрезается гейтом.</div>
        </label>
        <span className="vs-controls">
          <input
            className="vs-range"
            type="range"
            min={-70}
            max={-15}
            value={props.settings.gate.thresholdDb}
            onChange={(event) => props.onThresholdChange(Number(event.target.value))}
          />
          <span className="vs-value">{Math.round(props.settings.gate.thresholdDb)} дБ</span>
          <button type="button" className="vs-btn" disabled={!running || calibrating} onClick={calibrate}>
            {calibrating ? 'Замер…' : 'Обрезать шум'}
          </button>
        </span>
      </div>
      {calibration ? <p className="vs-hint">{calibration}</p> : null}
      {error ? <p className="vs-error">{error}</p> : null}
    </div>
  )
}

function SettingsPage(props: { t?: any; voiceStudio: { ctx: any } }) {
  const ctx = props.voiceStudio.ctx
  const settings = useSettings()
  const { catalog, error, refresh } = useSpeechCatalog(ctx)
  useEffect(() => {
    const providers = catalog?.providers ?? []
    if (providers.length === 0) return
    if (settings.providerId !== '' && !providers.some((item) => item.id === settings.providerId)) {
      updateSettings((current) => ({ ...current, providerId: '' }))
    }
  }, [catalog, settings.providerId])
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const history = useHistory()
  const [newFrom, setNewFrom] = useState('')
  const [newTo, setNewTo] = useState('')

  const refreshDevices = useCallback(async () => {
    try {
      const list = await listInputDevices()
      setDevices(list)
      setDeviceError(null)
    } catch (failure) {
      setDeviceError(describeFailure(failure))
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    const onChange = () => void refreshDevices()
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [refreshDevices])

  const askPermission = async () => {
    setBusy(true)
    try {
      await requestMicrophonePermission()
      await refreshDevices()
      setDeviceError(null)
    } catch (failure) {
      setDeviceError(describeFailure(failure))
    } finally {
      setBusy(false)
    }
  }

  const configure = async (patch: { providerId?: string; language?: string }) => {
    try {
      const result = await ctx.remote.speech.configure(patch)
      if (!result?.ok) setDeviceError(catalogError(result))
      await refresh()
    } catch (failure) {
      setDeviceError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const prepare = async (providerId: string) => {
    setBusy(true)
    setActionError(null)
    try {
      // The generated Remote validates arity: prepare(providerId, options),
      // so the optional options slot is passed explicitly as undefined.
      const result = await ctx.remote.speech.prepare(providerId, undefined)
      if (!result?.ok) setActionError(catalogError(result))
      await refresh()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const prepareSelected = async () => {
    const id = selectedProvider?.id ?? catalog?.selection.providerId ?? 'whisper-base'
    await prepare(id)
  }

  const [cloudForm, setCloudForm] = useState({ baseURL: '', model: '', apiKeyEnv: '' })
  const [cloudRevision, setCloudRevision] = useState<number | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [cloudNotice, setCloudNotice] = useState<string | null>(null)

  const saveCloud = async () => {
    setCloudNotice(null)
    try {
      const described = await ctx.remote.settings.describe()
      const payload = described?.ok === false ? null : described?.ok ? described.value : described
      const list = Array.isArray(payload) ? payload : payload?.namespaces ?? payload?.entries ?? []
      const row = list.find((item: any) => (item?.ns ?? item?.id ?? item?.namespace) === 'voice-studio')
      const revision = row?.revision ?? cloudRevision ?? undefined
      const patch: Record<string, string> = {}
      if (cloudForm.baseURL.trim() !== '') patch.baseURL = cloudForm.baseURL.trim()
      if (cloudForm.model.trim() !== '') patch.model = cloudForm.model.trim()
      if (cloudForm.apiKeyEnv.trim() !== '') patch.apiKeyEnv = cloudForm.apiKeyEnv.trim()
      if (Object.keys(patch).length === 0) {
        setCloudNotice('Заполните хотя бы одно поле.')
        return
      }
      const result = await ctx.remote.settings.update('voice-studio', patch, revision)
      if (result?.ok === false) throw new Error(catalogError(result))
      setCloudRevision(row?.revision ?? null)
      setCloudNotice('Сохранено. Облачный провайдер применит значения сразу.')
    } catch (failure) {
      setCloudNotice(`Не удалось сохранить: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }

  const saveKey = async () => {
    const ref = (cloudForm.apiKeyEnv || 'OPENAI_API_KEY').trim()
    if (keyValue.trim() === '') {
      setCloudNotice('Введите ключ API.')
      return
    }
    try {
      const result = await ctx.remote.credentials.set(ref, keyValue.trim())
      if (result?.ok === false) throw new Error(catalogError(result))
      setKeyValue('')
      setCloudNotice(`Ключ сохранён в защищённом хранилище DSH (${ref}); в интерфейс он больше не возвращается.`)
    } catch (failure) {
      setCloudNotice(`Ключ не сохранён: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }

  const [compareState, setCompareState] = useState<'idle' | 'recording' | 'running'>('idle')
  const [compareResults, setCompareResults] = useState<
    Array<{ id: string; name: string; text?: string; ms?: number; error?: string }>
  >([])
  const compareRecorder = useRef<VoiceRecorder | null>(null)

  const startCompare = async () => {
    setActionError(null)
    setCompareResults([])
    setCompareState('recording')
    const recorder = new VoiceRecorder(settings)
    try {
      await recorder.start()
      compareRecorder.current = recorder
    } catch (failure) {
      setCompareState('idle')
      setActionError(describeFailure(failure))
    }
  }

  const stopCompare = async () => {
    const recorder = compareRecorder.current
    if (!recorder) return
    compareRecorder.current = null
    setCompareState('running')
    try {
      const wav = await recorder.stop(30)
      const base64 = audioBase64(wav)
      const readyProviders = (catalog?.providers ?? []).filter((item) =>
        ['ready', 'standby', 'waking'].includes(item.preparation?.phase ?? 'ready'),
      )
      if (readyProviders.length === 0) {
        setActionError('Нет готовых провайдеров: подготовьте модель или настройте облако.')
      }
      const results: Array<{ id: string; name: string; text?: string; ms?: number; error?: string }> = []
      for (const provider of readyProviders) {
        const startedAt = performance.now()
        try {
          const result = await ctx.remote.speech.transcribe(
            { audioBase64: base64, providerId: provider.id, language: catalog?.selection.language },
            new AbortController().signal,
          )
          const elapsed = Math.round(performance.now() - startedAt)
          if (result?.ok) {
            results.push({ id: provider.id, name: providerLabel(provider), text: result.value.text, ms: elapsed })
          } else {
            results.push({ id: provider.id, name: providerLabel(provider), error: catalogError(result), ms: elapsed })
          }
        } catch (failure) {
          results.push({
            id: provider.id,
            name: providerLabel(provider),
            error: failure instanceof Error ? failure.message : String(failure),
          })
        }
        setCompareResults([...results])
      }
    } catch (failure) {
      setActionError(describeFailure(failure))
    } finally {
      setCompareState('idle')
    }
  }

  const providers = catalog?.providers ?? []
  const selectedProvider = providers.find((item) => item.id === (settings.providerId || catalog?.selection.providerId))

  const activePhase = selectedProvider?.preparation?.phase
  const preparingNow = busy || ['downloading', 'checking', 'loading', 'waking', 'cancelling'].includes(activePhase ?? '')
  useEffect(() => {
    if (!preparingNow) return
    const timer = window.setInterval(() => void refresh(), 800)
    return () => window.clearInterval(timer)
  }, [preparingNow, refresh])

  // Opening the settings page with an unprepared local model starts its download once.
  // This bypasses any stale selection state: the user asked for a working local model.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current) return
    if (!selectedProvider || selectedProvider.location !== 'host-local') return
    if (selectedProvider.preparation?.phase !== 'unprepared') return
    autoStarted.current = true
    void prepare(selectedProvider.id)
  }, [selectedProvider, prepare])

  const update = (recipe: (current: Settings) => Settings) => updateSettings(recipe)
  const noiseReductionOn = settings.rnnoise.enabled && settings.gate.enabled && settings.highpass.enabled
  const toggleNoiseReduction = (enabled: boolean) =>
    update((current) => ({
      ...current,
      rnnoise: { ...current.rnnoise, enabled },
      gate: { ...current.gate, enabled },
      highpass: { ...current.highpass, enabled },
      // RNNoise already suppresses noise; the browser filter would process the signal twice.
      browser: { ...current.browser, noiseSuppression: enabled ? false : current.browser.noiseSuppression },
    }))

  return (
    <div className="vs-root vs-card">
      <details className="vs-section" open>
        <summary><h4>Модель распознавания</h4></summary>
        {error ? <p className="vs-error">{error}</p> : null}
        {selectedProvider ? (
          <>
            <div className="vs-line">
              <label>
                {providerLabel(selectedProvider)}
                <div className="vs-hint">Статус: {phaseText(selectedProvider)}</div>
              </label>
              <span className="vs-controls">
                <button type="button" className="vs-btn" data-kind="primary" disabled={busy} onClick={() => void prepareSelected()}>
                  Скачать / подготовить
                </button>
                <button type="button" className="vs-btn" onClick={() => void refresh()}>
                  Обновить
                </button>
              </span>
            </div>
            <PreparationProgress provider={selectedProvider} />
            {actionError ? <p className="vs-error">{actionError}</p> : null}
            <p className="vs-hint">tiny ≈ 100 МБ · base ≈ 155 МБ · small ≈ 360 МБ. Сменить модель — в разделе «Распознавание» ниже.</p>
          </>
        ) : (
          <p className="vs-hint">Каталог провайдеров ещё не загружен…</p>
        )}
      </details>
      <details className="vs-section" open>
        <summary><h4>Микрофон</h4></summary>
        <Row
          label="Устройство ввода"
          hint="Системный по умолчанию — «Автоматически». Список имён появляется после разрешения доступа."
        >
          <select
            className="vs-select"
            value={settings.deviceId}
            onChange={(event) => {
              const id = event.target.value
              const found = devices.find((device) => device.id === id)
              update((current) => ({ ...current, deviceId: id, deviceLabel: found?.label ?? '' }))
            }}
          >
            <option value="">Автоматически</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
          <button type="button" className="vs-btn" disabled={busy} onClick={() => void askPermission()}>
            Разрешить доступ
          </button>
        </Row>
        {deviceError ? <p className="vs-error">{deviceError}</p> : null}
        <MicTester
          settings={settings}
          onThresholdChange={(value) =>
            update((current) => ({
              ...current,
              gate: { ...current.gate, thresholdDb: value },
              vad: { ...current.vad, thresholdDb: value },
            }))
          }
          onCalibrate={(value) =>
            update((current) => ({
              ...current,
              gate: { ...current.gate, thresholdDb: value, enabled: true },
              highpass: { ...current.highpass, enabled: true },
              vad: { ...current.vad, thresholdDb: value },
            }))
          }
        />
        <Row
          label="Шумоподавление"
          hint="Один переключатель: RNNoise + обрезной фильтр + шумовой гейт. Браузерный фильтр при этом отключается."
        >
          <button
            type="button"
            className="vs-btn"
            data-kind={noiseReductionOn ? 'primary' : undefined}
            aria-pressed={noiseReductionOn}
            onClick={() => toggleNoiseReduction(!noiseReductionOn)}
          >
            {noiseReductionOn ? 'Включено' : 'Выключено'}
          </button>
        </Row>
        <Row label="Шумоподавление браузера" hint="Встроенный фильтр Chromium. Держите выключенным, если работает RNNoise.">
          <Check
            checked={settings.browser.noiseSuppression}
            onChange={(value) => update((current) => ({ ...current, browser: { ...current.browser, noiseSuppression: value } }))}
          />
        </Row>
        <Row label="Эхоподавление" hint="Полезно без наушников; на чистом микрофоне лучше выключить.">
          <Check
            checked={settings.browser.echoCancellation}
            onChange={(value) => update((current) => ({ ...current, browser: { ...current.browser, echoCancellation: value } }))}
          />
        </Row>
        <Row label="АРУ браузера" hint="Дублирует наш AGC — обычно не нужно.">
          <Check
            checked={settings.browser.autoGainControl}
            onChange={(value) => update((current) => ({ ...current, browser: { ...current.browser, autoGainControl: value } }))}
          />
        </Row>
      </details>

      <details className="vs-section">
        <summary><h4>Шумоподавление и обработка</h4></summary>
        <Row label="RNNoise" hint="Нейросетевое шумоподавление Xiph в WebAssembly. Работает локально.">
          <Check checked={settings.rnnoise.enabled} onChange={(value) => update((current) => ({ ...current, rnnoise: { ...current.rnnoise, enabled: value } }))} />
        </Row>
        <Row label="Сила RNNoise" hint="0% — чистый сигнал, 100% — полностью очищенный.">
          <Slider
            value={settings.rnnoise.mix * 100}
            min={0}
            max={100}
            unit="%"
            onChange={(value) => update((current) => ({ ...current, rnnoise: { ...current.rnnoise, mix: value / 100 } }))}
          />
        </Row>
        <Row label="Обрезной фильтр" hint="Убирает гул и низкочастотный шум.">
          <Check checked={settings.highpass.enabled} onChange={(value) => update((current) => ({ ...current, highpass: { ...current.highpass, enabled: value } }))} />
          <Slider
            value={settings.highpass.hz}
            min={40}
            max={300}
            unit=" Гц"
            onChange={(value) => update((current) => ({ ...current, highpass: { ...current.highpass, hz: value } }))}
          />
        </Row>
        <Row label="Входное усиление">
          <Slider
            value={settings.gainDb}
            min={-12}
            max={24}
            unit=" дБ"
            onChange={(value) => update((current) => ({ ...current, gainDb: value }))}
          />
        </Row>
        <Row label="Шумовой гейт" hint="Закрывает микрофон в паузах; порог — уровень, ниже которого тишина.">
          <Check checked={settings.gate.enabled} onChange={(value) => update((current) => ({ ...current, gate: { ...current.gate, enabled: value } }))} />
        </Row>
        <Row label="Порог гейта">
          <Slider
            value={settings.gate.thresholdDb}
            min={-70}
            max={-15}
            unit=" дБ"
            onChange={(value) => update((current) => ({ ...current, gate: { ...current.gate, thresholdDb: value } }))}
          />
        </Row>
        <Row label="Удержание гейта">
          <Slider
            value={settings.gate.holdMs}
            min={0}
            max={1500}
            step={50}
            unit=" мс"
            onChange={(value) => update((current) => ({ ...current, gate: { ...current.gate, holdMs: value } }))}
          />
        </Row>
        <Row label="АРУ (AGC)" hint="Подтягивает тихую речь к целевому уровню после записи.">
          <Check checked={settings.agc.enabled} onChange={(value) => update((current) => ({ ...current, agc: { ...current.agc, enabled: value } }))} />
        </Row>
        <Row label="Целевая громкость">
          <Slider
            value={settings.agc.targetDb}
            min={-34}
            max={-10}
            unit=" дБ"
            onChange={(value) => update((current) => ({ ...current, agc: { ...current.agc, targetDb: value } }))}
          />
        </Row>
        <Row label="Предел усиления">
          <Slider
            value={settings.agc.maxGainDb}
            min={0}
            max={30}
            unit=" дБ"
            onChange={(value) => update((current) => ({ ...current, agc: { ...current.agc, maxGainDb: value } }))}
          />
        </Row>
        <Row label="Защита от перегрузки">
          <Check checked={settings.limiter} onChange={(value) => update((current) => ({ ...current, limiter: value }))} />
        </Row>
      </details>

      <details className="vs-section">
        <summary><h4>Тишина и горячие клавиши</h4></summary>
        <Row label="Авто-стоп по тишине" hint="Завершает запись, когда вы замолчали.">
          <Check checked={settings.vad.autoStop} onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, autoStop: value } }))} />
        </Row>
        <Row label="Пауза до остановки">
          <Slider
            value={settings.vad.silenceMs}
            min={400}
            max={5000}
            step={100}
            unit=" мс"
            onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, silenceMs: value } }))}
          />
        </Row>
        <Row label="Порог тишины">
          <Slider
            value={settings.vad.thresholdDb}
            min={-70}
            max={-20}
            unit=" дБ"
            onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, thresholdDb: value } }))}
          />
        </Row>
        <Row label="Push-to-talk" hint="Запись по удержанию сочетания клавиш.">
          <Check checked={settings.ptt.enabled} onChange={(value) => update((current) => ({ ...current, ptt: { ...current.ptt, enabled: value } }))} />
        </Row>
        <Row label="Сочетание">
          <ComboField
            value={settings.ptt.combo}
            onChange={(value) => update((current) => ({ ...current, ptt: { ...current.ptt, combo: value } }))}
          />
        </Row>
        <Row label="Режим">
          <select
            className="vs-select"
            value={settings.ptt.mode}
            onChange={(event) =>
              update((current) => ({ ...current, ptt: { ...current.ptt, mode: event.target.value === 'toggle' ? 'toggle' : 'hold' } }))
            }
          >
            <option value="hold">Удержание</option>
            <option value="toggle">Переключение</option>
          </select>
        </Row>
      </details>

      <details className="vs-section">
        <summary><h4>Текст</h4></summary>
        <Row label="Авто-пунктуация" hint="Заглавные буквы и точка в конце.">
          <Check
            checked={settings.text.autoPunctuation}
            onChange={(value) => update((current) => ({ ...current, text: { ...current.text, autoPunctuation: value } }))}
          />
        </Row>
        <Row label="Убирать слова-заикания" hint="«ну вот», «как бы», «э-э» и подобные.">
          <Check
            checked={settings.text.removeFillers}
            onChange={(value) => update((current) => ({ ...current, text: { ...current.text, removeFillers: value } }))}
          />
        </Row>
        <div className="vs-dict">
          <span className="vs-hint">Словарь замен: «как слышится» → «как вставить». Регистр не важен.</span>
          {settings.text.dictionary.map((entry, index) => (
            <div className="vs-dict-row" key={`${entry.from}-${index}`}>
              <input
                className="vs-input"
                value={entry.from}
                placeholder="услышано"
                onChange={(event) =>
                  update((current) => {
                    const dictionary = current.text.dictionary.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, from: event.target.value } : item,
                    )
                    return { ...current, text: { ...current.text, dictionary } }
                  })
                }
              />
              <input
                className="vs-input"
                value={entry.to}
                placeholder="вставить"
                onChange={(event) =>
                  update((current) => {
                    const dictionary = current.text.dictionary.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, to: event.target.value } : item,
                    )
                    return { ...current, text: { ...current.text, dictionary } }
                  })
                }
              />
              <button
                type="button"
                className="vs-btn"
                onClick={() =>
                  update((current) => ({
                    ...current,
                    text: { ...current.text, dictionary: current.text.dictionary.filter((_item, itemIndex) => itemIndex !== index) },
                  }))
                }
              >
                Удалить
              </button>
            </div>
          ))}
          <div className="vs-dict-row">
            <input className="vs-input" value={newFrom} placeholder="услышано" onChange={(event) => setNewFrom(event.target.value)} />
            <input className="vs-input" value={newTo} placeholder="вставить" onChange={(event) => setNewTo(event.target.value)} />
            <button
              type="button"
              className="vs-btn"
              onClick={() => {
                if (newFrom.trim() === '') return
                update((current) => ({
                  ...current,
                  text: { ...current.text, dictionary: [...current.text.dictionary, { from: newFrom.trim(), to: newTo }] },
                }))
                setNewFrom('')
                setNewTo('')
              }}
            >
              Добавить
            </button>
          </div>
        </div>
      </details>

      <details className="vs-section">
        <summary><h4>Распознавание</h4></summary>
        {error ? <p className="vs-error">{error}</p> : null}
        <Row label="Провайдер" hint={selectedProvider ? `Статус: ${phaseText(selectedProvider)}` : 'Список недоступен'}>
          <select
            className="vs-select"
            value={settings.providerId || catalog?.selection.providerId || ''}
            onChange={(event) => {
              const providerId = event.target.value
              const provider = providers.find((item) => item.id === providerId)
              const language =
                provider && !provider.languages.includes(settings.language)
                  ? provider.languages.includes('ru')
                    ? 'ru'
                    : provider.languages[0] ?? 'auto'
                  : settings.language
              update((current) => ({ ...current, providerId, language }))
              void configure({ providerId, language })
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {providerLabel(item)} — {phaseText(item)}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Язык"
          hint={
            selectedProvider && !selectedProvider.languages.includes(settings.language)
              ? `Провайдер не поддерживает «${languageLabel(settings.language)}»`
              : undefined
          }
        >
          <select
            className="vs-select"
            value={settings.language}
            onChange={(event) => {
              const language = event.target.value
              update((current) => ({ ...current, language }))
              void configure({ language })
            }}
          >
            {(selectedProvider?.languages ?? catalog?.providers.flatMap((item) => item.languages) ?? ['auto']).map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </Row>
        <div className="vs-controls">
          <button
            type="button"
            className="vs-btn"
            disabled={busy || !selectedProvider}
            onClick={() => selectedProvider && void prepare(selectedProvider.id)}
          >
            Подготовить модель
          </button>
          <button type="button" className="vs-btn" onClick={() => void refresh()}>
            Обновить статус
          </button>
        </div>
        <p className="vs-hint">
          Локальные движки — Whisper (ONNX на CPU через sherpa-onnx, входит в DSH). Русский поддерживается.
          Модель скачивается один раз кнопкой «Подготовить модель»: tiny ≈ 100 МБ (быстро), base ≈ 155 МБ,
          small ≈ 360 МБ (точнее). Для максимального качества можно выбрать облачный провайдер.
        </p>
      </details>

      <details className="vs-section">
        <summary><h4>Облачный провайдер</h4></summary>
        <p className="vs-hint">
          OpenAI-совместимый API: можно указать свой сервер, модель и ссылку на ключ. Ключ хранится в защищённом
          хранилище DSH (credentials) и никогда не возвращается в интерфейс; в конфиге остаётся только имя ссылки.
        </p>
        <Row label="Base URL" hint="Например https://api.openai.com/v1 или адрес локального shim-сервера.">
          <input
            className="vs-input"
            value={cloudForm.baseURL}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => setCloudForm((current) => ({ ...current, baseURL: event.target.value }))}
          />
        </Row>
        <Row label="Модель" hint="whisper-1, gpt-4o-transcribe или имя модели на вашем сервере.">
          <input
            className="vs-input"
            value={cloudForm.model}
            placeholder="whisper-1"
            onChange={(event) => setCloudForm((current) => ({ ...current, model: event.target.value }))}
          />
        </Row>
        <Row label="Ссылка на ключ" hint="Имя записи в credentials или переменной окружения.">
          <input
            className="vs-input"
            value={cloudForm.apiKeyEnv}
            placeholder="OPENAI_API_KEY"
            onChange={(event) => setCloudForm((current) => ({ ...current, apiKeyEnv: event.target.value }))}
          />
        </Row>
        <div className="vs-controls">
          <button type="button" className="vs-btn" data-kind="primary" onClick={() => void saveCloud()}>
            Сохранить параметры
          </button>
        </div>
        <Row label="Ключ API" hint="Передаётся только на сервер; после сохранения поле очищается.">
          <input
            className="vs-input"
            type="password"
            autoComplete="off"
            value={keyValue}
            placeholder="sk-…"
            onChange={(event) => setKeyValue(event.target.value)}
          />
          <button type="button" className="vs-btn" onClick={() => void saveKey()}>
            Сохранить ключ
          </button>
        </Row>
        {cloudNotice ? <p className="vs-hint">{cloudNotice}</p> : null}
      </details>
      <details className="vs-section">
        <summary><h4>Сравнение распознавания</h4></summary>
        <p className="vs-hint">
          Запишите одну фразу — её распознают все готовые провайдеры независимо. Так видно, кто как слышит,
          насколько быстро отвечает и где ошибается.
        </p>
        <div className="vs-controls">
          <button
            type="button"
            className="vs-btn"
            data-kind="primary"
            disabled={compareState === 'running'}
            onClick={() => {
              if (compareState === 'recording') void stopCompare()
              else if (compareState === 'idle') void startCompare()
            }}
          >
            {compareState === 'recording' ? 'Остановить и сравнить' : compareState === 'running' ? 'Распознавание…' : 'Записать тест'}
          </button>
          {compareResults.length > 0 ? (
            <button type="button" className="vs-btn" onClick={() => setCompareResults([])}>
              Очистить
            </button>
          ) : null}
        </div>
        {compareResults.map((item) => (
          <div className="vs-history-item" key={item.id}>
            <div className="vs-history-meta">
              <strong>{item.name}</strong>
              <span className="vs-badge">{item.ms !== undefined ? `${item.ms} мс` : '—'}</span>
            </div>
            {item.text !== undefined ? <p>{item.text || '∅ (пусто)'}</p> : <p className="vs-error">{item.error ?? 'ошибка'}</p>}
          </div>
        ))}
      </details>
      <details className="vs-section">
        <summary><h4>История диктовок</h4></summary>
        {history.length === 0 ? <p className="vs-hint">Пока пусто.</p> : null}
        <div className="vs-history">
          {history.map((entry) => (
            <div className="vs-history-item" key={entry.id}>
              <p>{entry.text}</p>
              <div className="vs-history-meta">
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                <span className="vs-badge">{Math.round(entry.seconds)} с</span>
                {entry.language ? <span className="vs-badge">{languageLabel(entry.language)}</span> : null}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="vs-link"
                  onClick={() => {
                    if (activeDraft) activeDraft.insertText(entry.text)
                    else void navigator.clipboard?.writeText(entry.text).catch(() => {})
                  }}
                >
                  Вставить
                </button>
                <button type="button" className="vs-link" onClick={() => void navigator.clipboard?.writeText(entry.text).catch(() => {})}>
                  Копировать
                </button>
                <button type="button" className="vs-link" onClick={() => removeHistory(entry.id)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="vs-controls">
          <button type="button" className="vs-btn" onClick={() => exportHistory('md')} disabled={history.length === 0}>
            Экспорт .md
          </button>
          <button type="button" className="vs-btn" onClick={() => exportHistory('txt')} disabled={history.length === 0}>
            Экспорт .txt
          </button>
          <button type="button" className="vs-btn" onClick={() => exportHistory('json')} disabled={history.length === 0}>
            Экспорт .json
          </button>
          <button type="button" className="vs-btn" onClick={() => clearHistory()} disabled={history.length === 0}>
            Очистить
          </button>
        </div>
      </details>

      <details className="vs-section">
        <summary><h4>Сброс</h4></summary>
        <div className="vs-controls">
          <button type="button" className="vs-btn" onClick={() => resetSettings()}>
            Вернуть настройки по умолчанию
          </button>
          <button
            type="button"
            className="vs-btn"
            onClick={() =>
              setSettings({
                ...normalizeSettings(DEFAULT_SETTINGS),
                providerId: settings.providerId,
                language: settings.language,
              })
            }
          >
            Сбросить только звук
          </button>
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------- plugin wiring

const DICTIONARY_RU = {
  'mic.dictate': 'Голосовой ввод',
  'settings.title': 'Голосовая студия',
}
const DICTIONARY_EN = {
  'mic.dictate': 'Voice input',
  'settings.title': 'Voice Studio',
}

export const inject = ['remote', 'slots', 'locale', 'pluginNavigation']

export async function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register(NS, { ru: DICTIONARY_RU, en: DICTIONARY_EN }))

  let disposeRemote: (() => Promise<void>) | undefined
  try {
    disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  } catch (failure) {
    // Another contribution may already own the `speech` namespace (for example the
    // shipped voice-input bundle). The Remote then stays mounted by that owner.
    console.warn('[voice-studio] speech remote is already mounted:', failure)
  }

  const ui = ctx.inject(['remote.speech', 'slots', 'locale', 'pluginNavigation'], (scope: any) => {
    const openSettings = () => {
      try {
        scope.pluginNavigation.openBundle(PACKAGE)
      } catch (failure) {
        console.warn('[voice-studio] cannot open bundle settings:', failure)
      }
    }
    const styleId = 'voice-studio-styles'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.pluginCss = styleId
      style.textContent = CSS
      document.head.appendChild(style)
    }
    scope.slots.inject('conversation.input.activity', () =>
      scope.slots.register(
        {
          name: 'conversation.input.activity',
          id: 'voice-studio',
          order: 40,
          locale: NS,
          inject: () => ({ voiceStudio: { ctx: scope, openSettings } }),
        },
        MicActivity,
      ),
    )
    scope.slots.inject('plugins.bundle.config', () =>
      scope.slots.register(
        {
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: NS,
          inject: () => ({ voiceStudio: { ctx: scope } }),
        },
        SettingsPage,
      ),
    )
  })

  try {
    await ui
  } catch (failure) {
    await ui.dispose()
    if (disposeRemote) await disposeRemote()
    throw failure
  }

  return async () => {
    await ui.dispose()
    if (disposeRemote) await disposeRemote()
  }
}
