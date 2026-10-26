// Persisted dictionary settings shared by the microphone activity and the bundle settings page.
import { useEffect, useState } from 'react'

export type DictEntry = { from: string; to: string }

export type Settings = {
  deviceId: string
  deviceLabel: string
  browser: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
  rnnoise: { enabled: boolean; mix: number }
  highpass: { enabled: boolean; hz: number }
  gate: { enabled: boolean; thresholdDb: number; holdMs: number }
  agc: { enabled: boolean; targetDb: number; maxGainDb: number }
  gainDb: number
  limiter: boolean
  vad: { autoStop: boolean; silenceMs: number; thresholdDb: number }
  ptt: { enabled: boolean; combo: string; mode: 'hold' | 'toggle' }
  text: { autoPunctuation: boolean; removeFillers: boolean; dictionary: DictEntry[] }
  historyLimit: number
  providerId: string
  language: string
}

export const DEFAULT_SETTINGS: Settings = {
  deviceId: '',
  deviceLabel: '',
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
  historyLimit: 50,
  providerId: '',
  language: 'ru',
}

const STORAGE_KEY = 'dsh.voice-studio.settings.v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

/** Merge persisted JSON over defaults without trusting its shape. */
export function normalizeSettings(raw: unknown): Settings {
  const base = clone(DEFAULT_SETTINGS)
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Record<string, any>
  const text = (input: unknown, fallback: string) => (typeof input === 'string' ? input : fallback)
  const bool = (input: unknown, fallback: boolean) => (typeof input === 'boolean' ? input : fallback)
  const dictionary = Array.isArray(value.text?.dictionary)
    ? value.text.dictionary
        .filter((item: any) => item && typeof item.from === 'string' && typeof item.to === 'string')
        .slice(0, 200)
        .map((item: any) => ({ from: item.from.slice(0, 200), to: item.to.slice(0, 400) }))
    : base.text.dictionary
  return {
    deviceId: text(value.deviceId, base.deviceId),
    deviceLabel: text(value.deviceLabel, base.deviceLabel),
    browser: {
      echoCancellation: bool(value.browser?.echoCancellation, base.browser.echoCancellation),
      noiseSuppression: bool(value.browser?.noiseSuppression, base.browser.noiseSuppression),
      autoGainControl: bool(value.browser?.autoGainControl, base.browser.autoGainControl),
    },
    rnnoise: {
      enabled: bool(value.rnnoise?.enabled, base.rnnoise.enabled),
      mix: clamp(value.rnnoise?.mix, 0, 1, base.rnnoise.mix),
    },
    highpass: {
      enabled: bool(value.highpass?.enabled, base.highpass.enabled),
      hz: clamp(value.highpass?.hz, 20, 400, base.highpass.hz),
    },
    gate: {
      enabled: bool(value.gate?.enabled, base.gate.enabled),
      thresholdDb: clamp(value.gate?.thresholdDb, -80, -6, base.gate.thresholdDb),
      holdMs: clamp(value.gate?.holdMs, 0, 2000, base.gate.holdMs),
    },
    agc: {
      enabled: bool(value.agc?.enabled, base.agc.enabled),
      targetDb: clamp(value.agc?.targetDb, -40, -6, base.agc.targetDb),
      maxGainDb: clamp(value.agc?.maxGainDb, 0, 36, base.agc.maxGainDb),
    },
    gainDb: clamp(value.gainDb, -12, 24, base.gainDb),
    limiter: bool(value.limiter, base.limiter),
    vad: {
      autoStop: bool(value.vad?.autoStop, base.vad.autoStop),
      silenceMs: clamp(value.vad?.silenceMs, 300, 8000, base.vad.silenceMs),
      thresholdDb: clamp(value.vad?.thresholdDb, -80, -10, base.vad.thresholdDb),
    },
    ptt: {
      enabled: bool(value.ptt?.enabled, base.ptt.enabled),
      combo: text(value.ptt?.combo, base.ptt.combo).slice(0, 80),
      mode: value.ptt?.mode === 'toggle' ? 'toggle' : 'hold',
    },
    text: {
      autoPunctuation: bool(value.text?.autoPunctuation, base.text.autoPunctuation),
      removeFillers: bool(value.text?.removeFillers, base.text.removeFillers),
      dictionary,
    },
    historyLimit: clamp(value.historyLimit, 0, 200, base.historyLimit),
    providerId: text(value.providerId, base.providerId),
    language: text(value.language, base.language),
  }
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeSettings(JSON.parse(raw)) : clone(DEFAULT_SETTINGS)
  } catch {
    return clone(DEFAULT_SETTINGS)
  }
}

let current: Settings = loadSettings()
const listeners = new Set<() => void>()

export function getSettings(): Settings {
  return current
}

export function setSettings(next: Settings): void {
  current = normalizeSettings(next)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    /* A full or disabled storage keeps the in-memory settings for this page. */
  }
  for (const listener of listeners) listener()
}

export function updateSettings(recipe: (settings: Settings) => Settings): void {
  setSettings(recipe(getSettings()))
}

export function resetSettings(): void {
  setSettings(clone(DEFAULT_SETTINGS))
}

export function useSettings(): Settings {
  const [value, setValue] = useState(getSettings())
  useEffect(() => {
    const listener = () => setValue(getSettings())
    listeners.add(listener)
    setValue(getSettings())
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return value
}
