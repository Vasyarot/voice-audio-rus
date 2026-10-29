// Проверка хоста: какие провайдеры реально регистрируются и в каком порядке.
import { apply } from '../plugin/index.js'

const registered = []
const ctx = {
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => {
    const dispose = fn()
    return () => {}
  },
  speechToText: {
    register(provider) {
      registered.push(provider)
      return async () => {}
    },
  },
}

apply(ctx, {})

console.log(
  registered.map((provider) => `${provider.info.id} | ${provider.info.name} | ${provider.info.location}`).join('\n'),
)
const ids = registered.map((provider) => provider.info.id)
const expected = ['whisper-tiny', 'whisper-base', 'whisper-small', 'cloud-openai']
for (const id of expected) {
  if (!ids.includes(id)) throw new Error('нет провайдера: ' + id)
}
if (ids.length !== expected.length) throw new Error('лишние провайдеры: ' + ids.filter((id) => !expected.includes(id)).join(', '))
console.log('total:', registered.length)
