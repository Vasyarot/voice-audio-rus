// Transcript post-processing: dictionary replacements, filler stripping and light punctuation.
import type { Settings } from './settings'

const FILLERS_RU = ['э-э', 'ээ', 'эм', 'мм', 'ну вот', 'как бы', 'типа', 'значит', 'в общем', 'короче']
const FILLERS_EN = ['uh', 'um', 'erm', 'like', 'you know']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace whole occurrences case-insensitively, keeping the entry order stable. */
export function applyDictionary(text: string, entries: Array<{ from: string; to: string }>): string {
  let result = text
  for (const entry of entries) {
    const from = entry.from.trim()
    if (from === '') continue
    try {
      const pattern = new RegExp(escapeRegExp(from), 'giu')
      result = result.replace(pattern, entry.to)
    } catch {
      result = result.split(from).join(entry.to)
    }
  }
  return result
}

function stripFillers(text: string): string {
  let result = text
  for (const filler of [...FILLERS_RU, ...FILLERS_EN]) {
    const pattern = new RegExp(`(^|[\\s,.;:!?—–-])${escapeRegExp(filler)}(?=$|[\\s,.;:!?—–-])`, 'giu')
    result = result.replace(pattern, '$1')
  }
  return result
}

function tidySpaces(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:!?…])/gu, '$1')
    .replace(/([,.;:!?…])(?=[А-Яа-яЁёA-Za-z0-9])/gu, '$1 ')
    .replace(/([—–])\s*([^\s])/gu, '$1 $2')
    .trim()
}

function capitalizeSentences(text: string): string {
  let result = text
  result = result.replace(/(^|[.!?…]\s+)([а-яё])/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase())
  result = result.replace(/^([а-яё])/u, (_match, letter: string) => letter.toUpperCase())
  return result
}

/**
 * Produce the text inserted into the draft.
 * `maxLength` trims runaway transcripts; the Host already bounds the audio.
 */
export function postProcess(raw: string, settings: Settings): string {
  let text = raw.replace(/\r\n?/gu, '\n').trim()
  if (settings.text.removeFillers) text = stripFillers(text)
  text = applyDictionary(text, settings.text.dictionary)
  text = tidySpaces(text)
  if (settings.text.autoPunctuation) {
    text = capitalizeSentences(text)
    if (text !== '' && !/[.!?…]$/u.test(text)) text += '.'
  }
  return text.trim()
}

/** Split a transcript into sentences, useful for history previews. */
export function sentenceCount(text: string): number {
  return (text.match(/[.!?…]+/gu) ?? []).length
}
