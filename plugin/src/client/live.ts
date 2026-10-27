// Append-only writer for live dictation.
//
// DSH bumps the draft revision on *every* edit, and `insertText(text, span)`
// rejects a span whose revision is stale. A span captured once at session start
// therefore accepts only the first fragment; the rest must be pasted by hand.
// This writer captures a fresh span for every attempt, retries transient
// refusals (submitting/adjudicating phases) and keeps the order intact: the
// caret lands after each insertion, so the next fragment appends after it.

export type InsertionPort = {
  /** Snapshot of the composer caret, carrying the current draft revision. */
  capture: () => unknown
  /** Insert text at the captured span; returns whether the draft accepted it. */
  insert: (text: string, span: any) => boolean
}

export type LiveWriterOptions = {
  /** Retries per fragment before giving up (250 ms apart). */
  attempts?: number
  /** Scheduler seam for tests; defaults to `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => void
}

export type LiveWriter = {
  /** Queue the whole session text; only the characters added since the last call are inserted. */
  push: (next: string) => void
  /** Characters already written into the draft. */
  committed: () => number
  /** Recognised characters still waiting for the draft. */
  pending: () => string
  /** Stop every pending retry: the draft must not change after a cancel. */
  cancel: () => void
}

export function createLiveWriter(port: InsertionPort, options: LiveWriterOptions = {}): LiveWriter {
  const attempts = options.attempts ?? 80
  const schedule = options.schedule ?? ((run, delayMs) => {
    window.setTimeout(run, delayMs)
  })
  let committed = 0
  let buffer = ''
  let flushing = false
  let cancelled = false

  const flush = (): void => {
    if (cancelled || flushing || buffer === '') return
    flushing = true
    const attempt = (tries: number) => {
      if (cancelled || buffer === '') {
        flushing = false
        return
      }
      const text = buffer
      let applied = false
      try {
        applied = port.insert(text, port.capture())
      } catch {
        applied = false
      }
      if (applied) {
        committed += text.length
        buffer = buffer.slice(text.length)
        flushing = false
        // Text may have arrived while the edit was being applied.
        if (buffer !== '') flush()
        return
      }
      if (tries >= attempts) {
        flushing = false
        return
      }
      schedule(() => attempt(tries + 1), 250)
    }
    attempt(0)
  }

  return {
    push(next: string) {
      const delta = next.slice(committed + buffer.length)
      if (delta === '') return
      buffer += delta
      flush()
    },
    committed: () => committed,
    pending: () => buffer,
    cancel() {
      cancelled = true
      buffer = ''
      flushing = false
    },
  }
}
