// Browser-local dictation history with text/markdown/JSON export.
import { useEffect, useState } from 'react'

export type HistoryEntry = {
  id: string
  text: string
  createdAt: number
  seconds: number
  providerId: string
  language: string
  deviceLabel: string
}

const STORAGE_KEY = 'dsh.voice-studio.history.v1'

function read(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry: any) => entry && typeof entry.text === 'string' && typeof entry.createdAt === 'number')
      .slice(0, 200)
      .map((entry: any) => ({
        id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
        text: entry.text,
        createdAt: entry.createdAt,
        seconds: Number(entry.seconds) || 0,
        providerId: typeof entry.providerId === 'string' ? entry.providerId : '',
        language: typeof entry.language === 'string' ? entry.language : '',
        deviceLabel: typeof entry.deviceLabel === 'string' ? entry.deviceLabel : '',
      }))
  } catch {
    return []
  }
}

let entries: HistoryEntry[] = read()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* Keep the in-memory list when storage is unavailable. */
  }
  for (const listener of listeners) listener()
}

export function listHistory(): HistoryEntry[] {
  return entries
}

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt'>, limit: number): void {
  const next: HistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  }
  entries = [next, ...entries].slice(0, Math.max(0, limit || 0))
  persist()
}

export function removeHistory(id: string): void {
  entries = entries.filter((entry) => entry.id !== id)
  persist()
}

export function clearHistory(): void {
  entries = []
  persist()
}

export function useHistory(): HistoryEntry[] {
  const [value, setValue] = useState(listHistory())
  useEffect(() => {
    const listener = () => setValue(listHistory())
    listeners.add(listener)
    setValue(listHistory())
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return value
}

function stamp(entry: HistoryEntry): string {
  return new Date(entry.createdAt).toLocaleString()
}

/** Build an export payload and trigger a download through a temporary anchor. */
export function exportHistory(format: 'md' | 'txt' | 'json'): void {
  const list = listHistory()
  let content = ''
  let mime = 'text/plain;charset=utf-8'
  let extension = 'txt'
  if (format === 'json') {
    content = JSON.stringify(list, null, 2)
    mime = 'application/json;charset=utf-8'
    extension = 'json'
  } else if (format === 'md') {
    content = list
      .map((entry) => `## ${stamp(entry)}\n\n${entry.text}\n\n---\n`)
      .join('\n')
    mime = 'text/markdown;charset=utf-8'
    extension = 'md'
  } else {
    content = list.map((entry) => `[${stamp(entry)}] ${entry.text}`).join('\n')
  }
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `voice-studio-${new Date().toISOString().slice(0, 10)}.${extension}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
