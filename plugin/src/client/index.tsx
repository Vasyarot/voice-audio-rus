// Voice Studio client contribution: microphone activity beside the composer,
// a capture row with metering and VAD, and a settings page inside bundle details.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import TYPERT_REMOTE from '../vendor/speech-remote.js'
import { attachSuppressorAsync, audioBase64, listInputDevices, requestMicrophonePermission, RecorderError, VoiceRecorder, wavFromSamples } from './audio'
import type { AudioDevice } from './audio'
import { addHistory, clearHistory, exportHistory, removeHistory, useHistory } from './history'
import { normalizeSettings, resetSettings, updateSettings, useSettings } from './settings'
import type { Settings } from './settings'
import { CSS } from './styles'
import { joinLiveText, postProcess } from './text'
import { createLiveWriter } from './live'
import {
  CLOUD_DEFAULT,
  fetchModels,
  isSpeechModel,
  loadCachedModels,
  loadCloudDraft,
  normalizeBaseURL,
  recommendModel,
  saveCachedModels,
  saveCloudConfig,
  saveCloudDraft,
  saveCloudKey,
} from './cloud'
import type { CloudDraft } from './cloud'

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

function cloudStatusText(provider: ProviderInfo): string {
  const phase = provider.preparation?.phase ?? 'unprepared'
  if (phase === 'ready') return 'готов'
  if (phase === 'checking' || phase === 'loading' || phase === 'waking') return 'проверка…'
  if (phase === 'failed') {
    const message = provider.preparation?.message ?? ''
    if (/401|403|отклон/iu.test(message)) return 'ключ отклонён'
    if (/нет ключа|ключ не найден/iu.test(message)) return 'нет ключа'
    if (/настроен|base\s?url|модел/iu.test(message)) return 'не настроен'
    if (/соедин|сет|dns|timeout|таймаут/iu.test(message)) return 'нет соединения'
    return `ошибка: ${message.slice(0, 60)}`
  }
  return 'не проверен'
}

function statusFor(provider?: ProviderInfo): string {
  if (!provider) return 'нет провайдера'
  return provider.location === 'cloud' ? cloudStatusText(provider) : phaseText(provider)
}

function statusKind(provider?: ProviderInfo): 'ok' | 'error' | 'pending' {
  if (!provider) return 'pending'
  if (provider.location === 'cloud') {
    const phase = provider.preparation?.phase ?? 'unprepared'
    if (phase === 'ready') return 'ok'
    if (phase === 'checking' || phase === 'loading' || phase === 'waking') return 'pending'
    return 'error'
  }
  return provider.preparation?.phase === 'ready' ? 'ok' : 'pending'
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

// ---------------------------------------------------------------- quick settings
//
// The popover next to the microphone changes the two things people touch most —
// the dictation mode and the recognizer — without leaving the composer. With a
// cloud provider it also discovers the models the server offers and picks the
// one that suits dictation best.

function failureText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Well-known dictation models, offered when the server does not expose `/models` to the browser. */
const SUGGESTED_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-large-v3']

type QuickProps = {
  ctx: any
  settings: Settings
  catalog: Catalog | null
  refresh: () => Promise<void> | void
  openSettings: () => void
  onClose: () => void
  /** Viewport anchor: the composer panel is fixed, so the row cannot clip it. */
  style?: React.CSSProperties
}

export function QuickSettings(props: QuickProps) {
  const { ctx, settings, catalog, refresh } = props
  const providers = catalog?.providers ?? []
  const selectedId = settings.providerId || catalog?.selection.providerId || ''
  const provider = providers.find((item) => item.id === selectedId)
  const isCloud = provider?.location === 'cloud'
  const languages = provider?.languages ?? []

  const boxRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  const [draft, setDraft] = useState<CloudDraft>(loadCloudDraft)
  const [keyValue, setKeyValue] = useState('')
  const [models, setModels] = useState<string[]>(loadCachedModels)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error' | 'pending'>('pending')
  const [busy, setBusy] = useState(false)
  const pullingRef = useRef(false)
  const best = useMemo(() => recommendModel(models), [models])

  useEffect(() => {
    saveCloudDraft(draft)
  }, [draft])

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const box = boxRef.current
      if (box && event.target instanceof Node && !box.contains(event.target)) closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const setMode = (mode: Settings['mode']) => updateSettings((current) => ({ ...current, mode }))

  const applySelection = async (providerId: string) => {
    const next = providers.find((item) => item.id === providerId)
    const language =
      next && !next.languages.includes(settings.language)
        ? next.languages.includes('ru')
          ? 'ru'
          : next.languages[0] ?? 'auto'
        : settings.language
    updateSettings((current) => ({ ...current, providerId, language }))
    try {
      const result = await ctx.remote.speech.configure({ providerId, language })
      if (result?.ok === false) throw new Error(catalogError(result))
      await refresh()
      setNoticeKind('ok')
      setNotice(`Выбрано: ${providerLabel(next ?? provider)}`)
    } catch (failure) {
      setNoticeKind('error')
      setNotice(`Не переключилось: ${failureText(failure)}`)
    }
  }

  const applyLanguage = async (language: string) => {
    updateSettings((current) => ({ ...current, language }))
    try {
      const result = await ctx.remote.speech.configure({ language })
      if (result?.ok === false) throw new Error(catalogError(result))
      await refresh()
    } catch (failure) {
      setNoticeKind('error')
      setNotice(`Язык не применён: ${failureText(failure)}`)
    }
  }

  const persistCloud = async (patch: Record<string, string>, message: string) => {
    try {
      await saveCloudConfig(ctx, patch)
      if (provider) await ctx.remote.speech.prepare(provider.id, undefined).catch(() => {})
      await refresh()
      setNoticeKind('ok')
      setNotice(message)
    } catch (failure) {
      setNoticeKind('error')
      setNotice(`Не сохранилось: ${failureText(failure)}`)
    }
  }

  /**
   * Ask the configured server for its model list, store the key, save the
   * settings and preselect the best dictation model. Everything after "Base URL
   * and key are filled in" happens automatically — see the debounced effect.
   */
  const pullModels = async () => {
    if (pullingRef.current) return
    const base = normalizeBaseURL(draft.baseURL)
    const key = keyValue.trim()
    if (!/^https?:\/\//iu.test(base)) {
      setNoticeKind('error')
      setNotice('Base URL должен начинаться с http:// или https://')
      return
    }
    if (key === '') {
      setNoticeKind('pending')
      setNotice('Введите ключ API — по нему сервер отдаст список моделей.')
      return
    }
    pullingRef.current = true
    setBusy(true)
    setNoticeKind('pending')
    setNotice('Запрашиваю список моделей…')
    try {
      const list = await fetchModels(base, key)
      setModels(list)
      saveCachedModels(list)
      const apiKeyEnv = await saveCloudKey(ctx, draft.apiKeyEnv, key)
      setKeyValue('')
      const speech = list.filter(isSpeechModel)
      const chosen = recommendModel(list) ?? (list.includes(draft.model) ? draft.model : list[0] ?? '')
      const nextDraft: CloudDraft = { baseURL: base, model: chosen || draft.model, apiKeyEnv }
      setDraft(nextDraft)
      const patch: Record<string, string> = { baseURL: base, apiKeyEnv }
      if (nextDraft.model !== '') patch.model = nextDraft.model
      await saveCloudConfig(ctx, patch)
      if (provider) await ctx.remote.speech.prepare(provider.id, undefined).catch(() => {})
      await refresh()
      setNoticeKind('ok')
      if (chosen === '') {
        setNotice(`Моделей: ${list.length}, но явных моделей распознавания нет — выберите вручную.`)
      } else if (speech.length > 1) {
        setNotice(`Моделей: ${list.length}. Автоматически выбрана «${chosen}» — лучшая для речи из ${speech.length} подходящих.`)
      } else {
        setNotice(`Моделей: ${list.length}. Автоматически выбрана «${chosen}».`)
      }
    } catch (failure) {
      // Servers such as api.openai.com send no CORS headers, so the browser cannot
      // read `/models`. Keep what the user typed: the Host stores the key and probes
      // the endpoint itself, and the panel falls back to known dictation models.
      try {
        const apiKeyEnv = await saveCloudKey(ctx, draft.apiKeyEnv, key)
        const base = normalizeBaseURL(draft.baseURL)
        setDraft({ ...draft, baseURL: base, apiKeyEnv })
        await saveCloudConfig(ctx, { baseURL: base, apiKeyEnv })
        setKeyValue('')
        if (provider) await ctx.remote.speech.prepare(provider.id, undefined).catch(() => {})
        await refresh()
        setNoticeKind('error')
        setNotice(
          `Список моделей сервер не отдал браузеру (обычно CORS). Адрес и ключ сохранены, хост проверил доступ сам — выберите модель из подсказок ниже.`,
        )
      } catch (second) {
        setNoticeKind('error')
        setNotice(`Модели не получены: ${failureText(failure)}. Ключ не сохранён: ${failureText(second)}`)
      }
    } finally {
      pullingRef.current = false
      setBusy(false)
    }
  }
  const pullRef = useRef(pullModels)
  pullRef.current = pullModels

  // Automatic discovery: as soon as a plausible Base URL and a key are present,
  // the panel asks for the model list on its own (debounced, once per key entry).
  useEffect(() => {
    if (!isCloud) return
    const base = normalizeBaseURL(draft.baseURL)
    const key = keyValue.trim()
    if (!/^https?:\/\//iu.test(base) || key.length < 8) return
    const timer = window.setTimeout(() => void pullRef.current(), 900)
    return () => window.clearTimeout(timer)
  }, [isCloud, draft.baseURL, keyValue])

  const chooseModel = async (model: string) => {
    setDraft((current) => ({ ...current, model }))
    await persistCloud({ model }, `Модель «${model}» сохранена.`)
  }

  return (
    <div className="vs-quick" ref={boxRef} style={props.style} role="dialog" aria-label="Быстрые настройки голосового ввода">
      <div className="vs-quick-head">
        <strong>Голосовой ввод</strong>
        <button type="button" className="vs-round" aria-label="Закрыть" onClick={props.onClose}>
          <IconClose />
        </button>
      </div>
      <div className="vs-quick-block">
        <span className="vs-quick-label">Режим</span>
        <div className="vs-seg">
          <button type="button" data-active={settings.mode !== 'live'} onClick={() => setMode('utterance')}>
            По кнопке
          </button>
          <button type="button" data-active={settings.mode === 'live'} onClick={() => setMode('live')}>
            В реальном времени
          </button>
        </div>
        <p className="vs-hint">
          {settings.mode === 'live'
            ? 'Текст дописывается в конец черновика сразу после каждых ~1.5 с речи — без кнопок «Вставить».'
            : 'Запись целиком: текст вставляется сам после остановки.'}
        </p>
      </div>
      <div className="vs-quick-block">
        <span className="vs-quick-label">Модель распознавания</span>
        <select className="vs-select" value={selectedId} onChange={(event) => void applySelection(event.target.value)}>
          {providers.length === 0 ? <option value="">Каталог не загружен</option> : null}
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {providerLabel(item)} · {statusFor(item)}
            </option>
          ))}
        </select>
        {languages.length > 1 ? (
          <select className="vs-select" value={settings.language} onChange={(event) => void applyLanguage(event.target.value)}>
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        ) : null}
        <p className="vs-hint" data-status={statusKind(provider)}>
          <span className="vs-dot" data-status={statusKind(provider)} />
          {statusFor(provider)}
        </p>
      </div>
      {isCloud ? (
        <div className="vs-quick-block">
          <span className="vs-quick-label">Облачная модель</span>
          <input
            className="vs-input"
            value={draft.baseURL}
            placeholder={CLOUD_DEFAULT.baseURL}
            onChange={(event) => setDraft((current) => ({ ...current, baseURL: event.target.value }))}
            onBlur={() => {
              const base = normalizeBaseURL(draft.baseURL)
              if (base !== '' && base !== draft.baseURL) setDraft((current) => ({ ...current, baseURL: base }))
            }}
          />
          <input
            className="vs-input"
            type="password"
            autoComplete="off"
            value={keyValue}
            placeholder="ключ API (sk-…)"
            onChange={(event) => setKeyValue(event.target.value)}
          />
          <div className="vs-controls">
            <button type="button" className="vs-btn" data-kind="primary" disabled={busy} onClick={() => void pullModels()}>
              {busy ? 'Запрашиваю…' : 'Подтянуть модели'}
            </button>
            {models.length > 0 ? <span className="vs-hint">в списке {models.length}</span> : null}
          </div>
          {models.length > 0 ? (
            <select className="vs-select" value={draft.model} onChange={(event) => void chooseModel(event.target.value)}>
              {models.includes(draft.model) ? null : <option value={draft.model}>{draft.model} (сохранена)</option>}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === best ? ' ★ лучшая для речи' : ''}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                className="vs-input"
                value={draft.model}
                placeholder="модель, например whisper-1"
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                onBlur={() => {
                  const model = draft.model.trim()
                  if (model !== '') void persistCloud({ model }, 'Модель сохранена.')
                }}
              />
              <div className="vs-controls">
                {SUGGESTED_MODELS.map((name) => (
                  <button type="button" className="vs-btn" key={name} onClick={() => void chooseModel(name)}>
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
      {notice ? (
        <p className="vs-hint" data-status={noticeKind}>
          {notice}
        </p>
      ) : null}
      <div className="vs-quick-foot">
        <button type="button" className="vs-link" onClick={props.openSettings}>
          Все настройки →
        </button>
        <span className="vs-hint">{settings.mode === 'live' ? 'живой текст' : 'по кнопке'}</span>
      </div>
    </div>
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

/** One live (incremental) dictation session: fragments are cut while recording. */
type LiveSession = {
  timer: number
  stopped: boolean
  cancelled: boolean
  text: string
  lastTick: number
  chunkStartedAt: number
  silentMs: number
  speechMs: number
  busy: boolean
  queue: Promise<void>
}

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
  const [seconds, setSeconds] = useState(0)
  const [live, setLive] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickAnchor, setQuickAnchor] = useState<React.CSSProperties | undefined>(undefined)
  const liveRef = useRef<LiveSession | null>(null)
  const writerRef = useRef<ReturnType<typeof createLiveWriter> | null>(null)
  /** Bumped by cancel/unmount so pending insert retries stop touching the draft. */
  const insertTokenRef = useRef(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
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
    insertTokenRef.current += 1
    writerRef.current?.cancel()
    writerRef.current = null
    const live = liveRef.current
    liveRef.current = null
    if (live) {
      live.cancelled = true
      if (live.timer) window.clearInterval(live.timer)
    }
    setLive(false)
    setLiveText('')
    abortRef.current?.abort()
    abortRef.current = null
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) void recorder.dispose()
    setPhase('idle')
    setMessage('')
    setSeconds(0)
  }, [])

  // ---- live mode: cut fragments while the microphone is open -----------------

  /**
   * Write recognised text into the draft. The insertion span is captured right
   * before every attempt: DSH bumps the draft revision on each edit, so a span
   * captured once rejects the second fragment and the text would have to be
   * pasted by hand. Failed attempts are retried, the user never presses "insert".
   */
  const insertTextWithRetry = useCallback(
    async (text: string): Promise<boolean> => {
      const token = insertTokenRef.current
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (insertTokenRef.current !== token) return false
        let applied = false
        try {
          applied = Boolean(inputActions.insertText(text, inputActions.captureInsertion()))
        } catch {
          applied = false
        }
        if (applied) return true
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      }
      return false
    },
    [inputActions],
  )

  /** Append one recognised fragment to the draft, inserting only the new characters. */
  const appendLive = useCallback(
    (piece: string) => {
      const state = liveRef.current
      const writer = writerRef.current
      if (!state || !writer) return
      const next = joinLiveText(state.text, piece)
      state.text = next
      setLiveText(next)
      writer.push(next)
    },
    [],
  )

  /** Transcribe everything captured since the previous cut. */
  const cutLive = useCallback(async () => {
    const state = liveRef.current
    const recorder = recorderRef.current
    if (!state || !recorder) return
    const samples = recorder.drainPcm()
    if (samples.length < recorder.sampleRate * 0.35) return
    const wav = wavFromSamples(samples, recorder.sampleRate, settingsRef.current)
    const selectionValue = selectionRef.current ?? catalogRef.current?.selection
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const result = await ctx.remote.speech.transcribe(
        {
          audioBase64: audioBase64(wav),
          ...(selectionValue ? { providerId: selectionValue.providerId, language: selectionValue.language } : {}),
        },
        abort.signal,
      )
      if (!result?.ok) throw new Error(catalogError(result))
      const value = result.value as { text?: string }
      let piece = postProcess(typeof value?.text === 'string' ? value.text : '', {
        ...settingsRef.current,
        text: { ...settingsRef.current.text, autoPunctuation: false },
      })
      if (piece !== '' && state.text === '' && settingsRef.current.text.autoPunctuation) {
        piece = piece.charAt(0).toUpperCase() + piece.slice(1)
      }
      if (piece !== '') appendLive(piece)
    } catch (failure) {
      if (!abort.signal.aborted && liveRef.current) {
        setPhase('feedback')
        setMessage(describeFailure(failure))
      }
    } finally {
      abortRef.current = null
    }
  }, [appendLive, ctx])

  /** Serialize cuts: one transcription at a time, fragments are never duplicated. */
  const requestCut = useCallback(() => {
    const state = liveRef.current
    if (!state || state.stopped || state.busy) return
    state.busy = true
    state.queue = state.queue
      .then(() => cutLive())
      .catch(() => {})
      .then(() => {
        state.busy = false
      })
  }, [cutLive])

  const tickLive = useCallback(() => {
    const state = liveRef.current
    const recorder = recorderRef.current
    if (!state || !recorder || state.stopped) return
    const now = performance.now()
    const delta = Math.max(0, now - state.lastTick)
    state.lastTick = now
    const threshold = settingsRef.current.vad.thresholdDb
    if (recorder.levelDb() > threshold) {
      state.silentMs = 0
      state.speechMs += delta
    } else {
      state.silentMs += delta
    }
    const since = now - state.chunkStartedAt
    const pauseHit = state.silentMs >= settingsRef.current.live.pauseMs && since >= 900
    const lengthHit = since >= settingsRef.current.live.chunkSeconds * 1000
    if (!pauseHit && !lengthHit) return
    const hasSpeech = state.speechMs >= 250
    state.chunkStartedAt = now
    state.silentMs = 0
    state.speechMs = 0
    if (hasSpeech) requestCut()
    else recorder.drainPcm()
  }, [requestCut])
  const tickLiveRef = useRef(tickLive)
  tickLiveRef.current = tickLive

  const startLive = useCallback(async () => {
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
    selectionRef.current = { providerId: currentProvider.id, language: currentCatalog.selection.language }
    const recorder = new VoiceRecorder(settingsRef.current)
    setMessage('')
    setLiveText('')
    setSeconds(0)
    setPhase('requesting')
    try {
      await recorder.start(true)
    } catch (failure) {
      setPhase('feedback')
      setMessage(describeFailure(failure))
      return
    }
    recorderRef.current = recorder
    writerRef.current = createLiveWriter({
      capture: () => inputActions.captureInsertion(),
      insert: (text: string, span: any) => inputActions.insertText(text, span),
    })
    const now = performance.now()
    liveRef.current = {
      timer: window.setInterval(() => tickLiveRef.current(), 250),
      stopped: false,
      text: '',
      cancelled: false,
      lastTick: now,
      chunkStartedAt: now,
      silentMs: 0,
      speechMs: 0,
      busy: false,
      queue: Promise.resolve(),
    }
    phaseRef.current = 'recording'
    setLive(true)
    setPhase('recording')
  }, [inputActions])

  const finishLive = useCallback(async () => {
    const state = liveRef.current
    const recorder = recorderRef.current
    if (!state || !recorder || state.stopped) return
    state.stopped = true
    if (state.timer) window.clearInterval(state.timer)
    phaseRef.current = 'transcribing'
    setPhase('transcribing')
    const elapsed = recorder.elapsedSeconds()
    state.busy = true
    state.queue = state.queue.then(async () => {
      await cutLive()
      if (settingsRef.current.text.autoPunctuation && state.text !== '' && !/[.!?…]$/u.test(state.text)) {
        appendLive('.')
      }
      await recorder.dispose()
    })
    try {
      await state.queue
      liveRef.current = null
      recorderRef.current = null
      setLive(false)
      setLiveText('')
      const text = state.text.trim()
      if (text === '') {
        setPhase('feedback')
        setMessage('Речь не распознана — попробуйте ближе к микрофону.')
        return
      }
      addHistory(
        {
          text,
          seconds: Math.round(elapsed),
          providerId: selectionRef.current?.providerId ?? '',
          language: selectionRef.current?.language ?? '',
          deviceLabel: settingsRef.current.deviceLabel,
        },
        settingsRef.current.historyLimit,
      )
      setPhase('idle')
      setMessage('')
    } catch (failure) {
      liveRef.current = null
      recorderRef.current = null
      setLive(false)
      setLiveText('')
      setPhase('feedback')
      setMessage(describeFailure(failure))
    } finally {
      void refresh()
    }
  }, [appendLive, cutLive, refresh])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || locked) return
    // A previous session's writer must not append its leftovers into the new one.
    writerRef.current?.cancel()
    writerRef.current = null
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
    if (settingsRef.current.mode === 'live') {
      await startLive()
      return
    }
    if (locked) return
    selectionRef.current = { providerId: currentProvider.id, language: currentCatalog.selection.language }
    const recorder = new VoiceRecorder(settingsRef.current)
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
  }, [inputActions, locked, startLive])

  const finish = useCallback(async () => {
    if (liveRef.current) {
      await finishLive()
      return
    }
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
      const applied = await insertTextWithRetry(text)
      setPhase(applied ? 'idle' : 'feedback')
      setMessage(applied ? '' : 'Не удалось вставить текст в черновик — он сохранён в истории.')
    } catch (failure) {
      if (!runRef.cancelled) {
        setPhase('feedback')
        setMessage(describeFailure(failure))
      }
    } finally {
      recorderRef.current = null
      abortRef.current = null
      void refresh()
    }
  }, [ctx, finishLive, insertTextWithRetry, refresh])

  finishRef.current = () => {
    void finish()
  }
  startRef.current = () => {
    void start()
  }

  // Meter, silence auto-stop and the hard duration limit.
  useEffect(() => {
    if (phase !== 'recording') return
    // Live mode inserts text continuously, so the silence auto-stop would cut the
    // session mid-thought: it stays manual there (with a long hard limit).
    const liveMode = settingsRef.current.mode === 'live'
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
        if (vad.autoStop && !liveMode) {
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
    const maxSeconds = liveMode ? 900 : (catalogRef.current?.maxDurationSeconds ?? 120) - 0.6
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
    if (expanded) setQuickOpen(false)
  }, [expanded])
  useEffect(() => {
    onActiveChange?.(expanded)
    return () => onActiveChange?.(false)
  }, [expanded, onActiveChange])

  useEffect(() => {
    // A new session owns a fresh draft: drop a transcript that belonged to the old one.
    setMessage('')
    if (phaseRef.current !== 'recording') setPhase('idle')
  }, [sessionId])

  const toggleQuick = (event?: { clientX: number; clientY: number }) => {
    if (quickOpen) {
      setQuickOpen(false)
      return
    }
    if (event) {
      // Menu semantics: the panel grows up-left from the click, never off screen.
      setQuickAnchor({
        right: Math.max(8, window.innerWidth - event.clientX),
        bottom: Math.max(8, window.innerHeight - event.clientY),
      })
    }
    setQuickOpen(true)
  }

  if (!expanded) {
    return (
      <span className="vs-root vs-trigger-wrap">
        <button
          type="button"
          className="vs-trigger"
          title={usable ? 'Голосовой ввод · правый клик — настройки' : 'Голосовой ввод: настройте распознавание'}
          aria-label="Голосовой ввод"
          aria-haspopup="menu"
          aria-expanded={quickOpen}
          disabled={Boolean(locked)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (usable) void start()
            else {
              setPhase('feedback')
              setMessage(speechError ?? 'Провайдер не готов. Подготовьте модель в настройках.')
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            toggleQuick({ clientX: event.clientX, clientY: event.clientY })
          }}
        >
          <IconMic />
        </button>
        {quickOpen ? (
          <QuickSettings
            ctx={ctx}
            settings={settings}
            catalog={catalog}
            refresh={refresh}
            openSettings={voiceStudio.openSettings}
            onClose={() => setQuickOpen(false)}
            style={quickAnchor}
          />
        ) : null}
      </span>
    )
  }

  return (
    <div className="vs-root vs-row" data-voice-studio={phase}>
      <button
        type="button"
        className="vs-round"
        aria-label="Отмена"
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
          {live ? (
            <span className="vs-live-tag" title={liveText}>
              <span className="vs-dot" data-status="ok" />
              {liveText === '' ? 'Слушаю…' : tailText(liveText, 56)}
            </span>
          ) : null}
          <button
            type="button"
            className="vs-round"
            aria-label={live ? 'Остановить и оставить текст' : 'Остановить и распознать'}
            title={live ? 'Остановить: текст уже в черновике' : 'Остановить и распознать'}
            onClick={() => finishRef.current()}
          >
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
                : message || 'Голосовой ввод'}
          </span>
          {phase === 'feedback' ? (
            <button
              type="button"
              className="vs-round"
              aria-label="Повторить запись"
              onClick={() => {
                setMessage('')
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

/** Tail of a growing text: the capture row shows the freshest words, not the start. */
function tailText(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > max ? `…${text.slice(-(max - 1))}` : text
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
  const fractional = props.step !== undefined && props.step < 1
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
        {fractional ? props.value.toFixed(1) : Math.round(props.value)}
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

  const prepareAll = async () => {
    const locals = (catalog?.providers ?? []).filter((item) => item.location === 'host-local')
    for (const provider of locals) {
      if (provider.preparation?.phase === 'ready') continue
      await ctx.remote.speech.prepare(provider.id, undefined)
    }
    await refresh()
  }

  const [cloudForm, setCloudForm] = useState<CloudDraft>(loadCloudDraft)
  const [cloudRevision, setCloudRevision] = useState<number | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [cloudNotice, setCloudNotice] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsNotice, setModelsNotice] = useState<string | null>(null)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  // The composer popover writes the same draft key, so both surfaces agree.
  useEffect(() => {
    saveCloudDraft(cloudForm)
  }, [cloudForm])

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
      await loadModels()
      setKeyValue('')
      setCloudNotice(`Ключ сохранён в защищённом хранилище DSH (${ref}); в интерфейс он больше не возвращается.`)
    } catch (failure) {
      setCloudNotice(`Ключ не сохранён: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }

  const loadModels = async () => {
    const base = cloudForm.baseURL.trim().replace(/\/+$/u, '')
    const key = keyValue.trim()
    setModelsNotice(null)
    if (base === '') {
      setModelsNotice('Укажите Base URL')
      return
    }
    if (key === '') {
      setModelsNotice('Введите ключ API, чтобы получить список моделей')
      return
    }
    try {
      const list = await fetchModels(base, key)
      saveCachedModels(list)
      setModelOptions(list)
      if (cloudForm.model.trim() === '') setCloudForm((current) => ({ ...current, model: list[0] }))
      setModelsNotice(`Найдено моделей: ${list.length}`)
    } catch (failure) {
      setModelsNotice(`Не удалось получить модели: ${failureText(failure)}. Введите модель вручную — если сервер не отдаёт список браузеру (CORS), это нормально.`)
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

  // Cloud health: probe automatically when the settings page opens with the cloud
  // provider selected (or right after it is selected).
  const probingRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedProvider || selectedProvider.location !== 'cloud') return
    if ((selectedProvider.preparation?.phase ?? 'unprepared') !== 'unprepared') return
    if (probingRef.current === selectedProvider.id) return
    probingRef.current = selectedProvider.id
    void ctx.remote.speech
      .prepare(selectedProvider.id, undefined)
      .catch(() => {})
      .finally(() => {
        probingRef.current = null
        void refresh()
      })
  }, [selectedProvider?.id, selectedProvider?.preparation?.phase, refresh, ctx])

  const update = (recipe: (current: Settings) => Settings) => updateSettings(recipe)
  const confirmReset = () => {
    // The provider choice lives on the host, so the reset keeps it: audio and text
    // settings return to defaults, the selected model does not change under the user.
    resetSettings({ providerId: settings.providerId, language: settings.language })
    setResetOpen(false)
  }
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
        <summary><h4>Модели распознавания речи</h4></summary>
        {error ? <p className="vs-error">{error}</p> : null}
        {selectedProvider ? (
          <>
            <div className="vs-line">
              <label>{providerLabel(selectedProvider)}</label>
              <span className="vs-controls">
                <button type="button" className="vs-btn" onClick={() => void prepareAll()}>
                  Скачать все модели
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
      
        {error ? <p className="vs-error">{error}</p> : null}
        <Row label="Провайдер">
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
                {providerLabel(item)}
              </option>
            ))}
          </select>
        </Row>
        <div className="vs-line">
          <span className="vs-hint" data-status={statusKind(selectedProvider)}>
            Статус: {statusFor(selectedProvider)}
          </span>
          {selectedProvider?.location === 'cloud' ? (
            <button type="button" className="vs-btn" onClick={() => setCloudOpen(true)}>
              Редактировать модель
            </button>
          ) : null}
        </div>
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
        <p className="vs-hint">
          Локальные движки — Whisper (ONNX на CPU через sherpa-onnx, входит в DSH). Русский поддерживается.
          Модель скачивается один раз кнопкой «Скачать все модели»: tiny ≈ 100 МБ (быстро), base ≈ 155 МБ,
          small ≈ 360 МБ (точнее). Для максимального качества можно выбрать облачный провайдер.
        </p>
      </details>
      <details className="vs-section" open>
        <summary><h4>Режим диктовки</h4></summary>
        <Row
          label="Как распознавать"
          hint="«В реальном времени» вставляет текст в черновик сразу после каждых ~1.5 с речи (и раньше, если вы замолчали)."
        >
          <div className="vs-seg">
            <button
              type="button"
              data-active={settings.mode !== 'live'}
              onClick={() => update((current) => ({ ...current, mode: 'utterance' }))}
            >
              По кнопке
            </button>
            <button
              type="button"
              data-active={settings.mode === 'live'}
              onClick={() => update((current) => ({ ...current, mode: 'live' }))}
            >
              В реальном времени
            </button>
          </div>
        </Row>
        {settings.mode === 'live' ? (
          <>
            <Row label="Максимум фразы" hint="Кусок речи не длиннее этого значения; 1.5 с — самый быстрый отклик, 4–6 с — точнее.">
              <Slider
                value={settings.live.chunkSeconds}
                min={1}
                max={15}
                step={0.5}
                unit=" с"
                onChange={(value) => update((current) => ({ ...current, live: { ...current.live, chunkSeconds: value } }))}
              />
            </Row>
            <Row label="Пауза для вставки" hint="Такая пауза тоже завершает кусок — текст появится, не дожидаясь лимита.">
              <Slider
                value={settings.live.pauseMs}
                min={200}
                max={3000}
                step={50}
                unit=" мс"
                onChange={(value) => update((current) => ({ ...current, live: { ...current.live, pauseMs: value } }))}
              />
            </Row>
            <p className="vs-hint">
              Режим работает с любым провайдером: локальный Whisper и облако распознают короткие куски. Авто-стоп по
              тишине здесь выключен — запись останавливается кнопкой, Esc или сочетанием Push-to-talk. Текст вставляется
              сам, кнопки «Вставить» больше нет.
            </p>
          </>
        ) : null}
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
      </details>
<details className="vs-section">
        <summary><h4>Сравнение и история</h4></summary>
        <h5 className="vs-subhead">Сравнение моделей</h5>
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
        <h5 className="vs-subhead">История диктовок</h5>
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
        <summary><h4>Шумоподавление</h4></summary>
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
        <summary><h4>Обработка звука</h4></summary>
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
        <summary><h4>Тишина и клавиши</h4></summary>
        <Row label="Авто-стоп по тишине" hint="Завершает запись, когда вы замолчали.">
          <Check checked={settings.vad.autoStop} onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, autoStop: value } }))} />
        </Row>
        <Row label="Пауза до остановки">
          <Slider value={settings.vad.silenceMs} min={400} max={5000} step={100} unit=" мс" onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, silenceMs: value } }))} />
        </Row>
        <Row label="Порог тишины">
          <Slider value={settings.vad.thresholdDb} min={-70} max={-20} unit=" дБ" onChange={(value) => update((current) => ({ ...current, vad: { ...current.vad, thresholdDb: value } }))} />
        </Row>
        <Row label="Push-to-talk" hint="Запись по удержанию сочетания клавиш.">
          <Check checked={settings.ptt.enabled} onChange={(value) => update((current) => ({ ...current, ptt: { ...current.ptt, enabled: value } }))} />
        </Row>
        <Row label="Сочетание">
          <ComboField value={settings.ptt.combo} onChange={(value) => update((current) => ({ ...current, ptt: { ...current.ptt, combo: value } }))} />
        </Row>
        <Row label="Режим">
          <select className="vs-select" value={settings.ptt.mode} onChange={(event) => update((current) => ({ ...current, ptt: { ...current.ptt, mode: event.target.value === 'toggle' ? 'toggle' : 'hold' } }))}>
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
      <div className="vs-footer-action">
        <button type="button" className="vs-btn" data-kind="danger" onClick={() => setResetOpen(true)}>
          Вернуть настройки по умолчанию
        </button>
      </div>
      {cloudOpen ? (
        <div className="vs-overlay" role="dialog" aria-modal="true" aria-label="Параметры облачного провайдера">
          <div className="vs-modal">
            <div className="vs-modal-head">
              <h4>Параметры облачного провайдера</h4>
              <button type="button" className="vs-round" aria-label="Закрыть" onClick={() => setCloudOpen(false)}>
                <IconClose />
              </button>
            </div>
            <p className="vs-hint">Всё введённое сохраняется как черновик и не теряется при закрытии окна.</p>
            <Row label="Base URL" hint="https://api.openai.com/v1 или адрес своего сервера">
              <input
                className="vs-input"
                value={cloudForm.baseURL}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => setCloudForm((current) => ({ ...current, baseURL: event.target.value }))}
              />
            </Row>
            <Row label="Модель" hint="whisper-1, gpt-4o-transcribe или своя">
              <input
                className="vs-input"
                value={cloudForm.model}
                placeholder="whisper-1"
                onChange={(event) => setCloudForm((current) => ({ ...current, model: event.target.value }))}
              />
            </Row>
            {modelOptions.length > 0 ? (
              <Row label="Модели из API" hint="Список получен по вашему ключу">
                <select
                  className="vs-select"
                  value={cloudForm.model}
                  onChange={(event) => setCloudForm((current) => ({ ...current, model: event.target.value }))}
                >
                  {modelOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Row>
            ) : null}
            {modelsNotice ? (
              <p className="vs-hint" data-status={modelOptions.length > 0 ? 'ok' : 'error'}>
                {modelsNotice}
              </p>
            ) : null}
            <Row label="Ссылка на ключ" hint="Имя записи в credentials или env">
              <input
                className="vs-input"
                value={cloudForm.apiKeyEnv}
                placeholder="OPENAI_API_KEY"
                onChange={(event) => setCloudForm((current) => ({ ...current, apiKeyEnv: event.target.value }))}
              />
            </Row>
            <Row label="Ключ API" hint="Хранится в credentials, в интерфейс не возвращается">
              <input
                className="vs-input"
                type="password"
                autoComplete="off"
                value={keyValue}
                placeholder="sk-…"
                onChange={(event) => setKeyValue(event.target.value)}
              />
            </Row>
            <div className="vs-controls">
              <button type="button" className="vs-btn" data-kind="primary" onClick={() => void saveCloud()}>
                Сохранить параметры
              </button>
              <button type="button" className="vs-btn" onClick={() => void saveKey()}>
                Сохранить ключ
              </button>
              <button
                type="button"
                className="vs-btn"
                onClick={() => {
                  const id = selectedProvider?.id ?? 'cloud-openai'
                  void ctx.remote.speech.prepare(id, undefined).finally(() => void refresh())
                  void loadModels()
                }}
              >
                Проверить и загрузить модели
              </button>
              <button type="button" className="vs-btn" onClick={() => setCloudOpen(false)}>
                Закрыть
              </button>
            </div>
            {cloudNotice ? <p className="vs-hint">{cloudNotice}</p> : null}
          </div>
        </div>
      ) : null}
      {resetOpen ? (
        <div className="vs-overlay" role="dialog" aria-modal="true" aria-label="Сброс настроек">
          <div className="vs-modal">
            <div className="vs-modal-head">
              <h4>Вернуть настройки по умолчанию?</h4>
              <button type="button" className="vs-round" aria-label="Закрыть" onClick={() => setResetOpen(false)}>
                <IconClose />
              </button>
            </div>
            <p className="vs-hint">Текущие значения звука и текста будут заменены стандартными. Отменить это нельзя.</p>
            <div className="vs-reset-list">
              <h5 className="vs-subhead">Что сбросится</h5>
              <ul>
                <li>Микрофон: выбранное устройство → «Автоматически».</li>
                <li>Шумоподавление: RNNoise и его сила, обрезной фильтр, шумовой гейт, фильтры браузера.</li>
                <li>Обработка звука: входное усиление, АРУ и её пределы, защита от перегрузки, пороги гейта.</li>
                <li>Режим диктовки: «по кнопке», максимум фразы и пауза для вставки в живом режиме.</li>
                <li>Тишина и клавиши: авто-стоп по тишине, пауза, порог, Push-to-talk и сочетание клавиш.</li>
                <li>Текст: авто-пунктуация, удаление слов-заиканий и весь словарь замен.</li>
              </ul>
              <h5 className="vs-subhead">Что останется</h5>
              <ul>
                <li>Выбранная модель распознавания и язык.</li>
                <li>История диктовок и скачанные локальные модели.</li>
                <li>Параметры облачного провайдера и сохранённый API-ключ.</li>
              </ul>
            </div>
            <div className="vs-controls">
              <button type="button" className="vs-btn" data-kind="danger" onClick={confirmReset}>
                Да, сбросить
              </button>
              <button type="button" className="vs-btn" data-kind="primary" onClick={() => setResetOpen(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
