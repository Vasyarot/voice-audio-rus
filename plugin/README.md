# Voice Audio Rus для DeepSeek Harness

Русский язык — приоритет: локальный Whisper, `ru` по умолчанию, шумоподавление и тест микрофона.

Голосовой ввод в духе встроенного `voice-input`, но с панелью звука, шумоподавлением,
локальным Whisper и расширенными улучшениями.

## Возможности

- Кнопка микрофона в композере → запись → распознавание → вставка в черновик
  (с проверкой ревизии: при конфликте текст можно вставить вручную).
- Живая панель записи: таймер, индикатор уровня, отмена, повтор, «Стоп».
- Звук: выбор микрофона, RNNoise (WASM, регулируемая сила), high-pass, шумовой гейт,
  AGC, входное усиление, лимитер, фейды.
- Тишина и клавиши: авто-стоп по тишине (VAD), push-to-talk (удержание/переключение).
- Текст: авто-пунктуация, удаление заиканий, словарь замен.
- История: вставка/копирование/удаление, экспорт `.md/.txt/.json`.
- Провайдеры:
  - **Whisper локально** (Whisper tiny/base/small, ONNX на CPU через `sherpa-onnx`,
    который уже входит в DSH) — офлайн, русский поддерживается;
  - **облако** — OpenAI-совместимый `/audio/transcriptions` (ключ на хосте).

## Установка

```powershell
dsh plugin --profile desktop add "file:D:\Project\DeepSeek Harness\Voice\plugin"
```

CLI сам добавляет пакет и бандл в профиль. После установки **перезапустите DSH**.
Откат: `dsh plugin --profile desktop remove dsh-plugin-voice-studio`.

> Не включайте одновременно официальный `@deepseek-ai/dsh-experimental-voice-input-bundle`.

## Локальные модели

В плагине три локальных провайдера — выберите модель в настройках:

| Провайдер | Размер загрузки | Когда выбирать |
|---|---|---|
| `Whisper TINY` | ≈ 100 МБ | быстрый старт, короткие команды |
| `Whisper BASE` | ≈ 155 МБ | баланс по умолчанию |
| `Whisper SMALL` | ≈ 360 МБ | максимум качества офлайн |

Модель скачивается один раз кнопкой «Подготовить модель» (Hugging Face или зеркало
hf-mirror), кэш лежит в `%USERPROFILE%\.dsh\speech-to-text\whisper\<model>`.
Подробное сравнение движков (Vosk, GigaAM, Silero, Whisper, облако) —
в [docs/local-stt-options.md](../docs/local-stt-options.md).

## Облачный провайдер

```powershell
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', 'sk-...', 'User')
```

Либо переопределите строку `voice-studio` в
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`: `cloud.baseURL`, `cloud.model`,
`cloud.apiKeyEnv` / `cloud.apiKey`.

## Приватность

- Аудио живёт в памяти вкладки и в запросе к выбранному провайдеру.
- Локальные модели обрабатывают звук на машине хоста, без сети после загрузки.
- История диктовок хранится в `localStorage`, очищается в настройках.

## Разработка

```powershell
cd plugin
node tools\build.mjs        # client.js из src/client
node ..\tools\whisper-test.mjs
node ..\tools\unit-test.mjs
node ..\tools\smoke-client.mjs
```
