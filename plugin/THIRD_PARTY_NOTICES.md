# Third-party notices

Voice Studio bundles the following third-party components:

## RNNoise

- Project: https://github.com/xiph/rnnoise
- License: BSD 3-Clause
- Copyright: Jean-Marc Valin, Xiph.Org Foundation

## rnnoise-wasm

- Project: https://github.com/shiguredo/rnnoise-wasm
- License: Apache-2.0
- Copyright 2021–2025, Takeru Ohta; Copyright 2021–2025, Shiguredo Inc.

## @sapphi-red/web-noise-suppressor (worklet glue and wasm build)

- Project: https://github.com/sapphi-red/web-noise-suppressor
- License: MIT
- Copyright: sapphi-red

The vendored `assets/rnnoise.wasm` and `assets/rnnoise-worklet.txt` are unmodified
build artifacts of `@sapphi-red/web-noise-suppressor@0.4.1` (which itself builds
RNNoise through `@shiguredo/rnnoise-wasm`).

The speech Remote contribution under `src/vendor/` is generated code from
`@deepseek-ai/dsh-experimental-api-speech-to-text` (DeepSeek Harness, MIT),
copied to keep the client bundle self-contained.
