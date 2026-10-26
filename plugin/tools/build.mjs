// Build the client bundle in the DSH module-loader format:
//   window.__ModuleLoader__.load({ id, factory(require){ ... } })
// Runtime modules provided by the web shell stay external; everything else is inlined.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const banner = `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){`
const footer = `return module.exports;}});`

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome126'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  loader: {
    '.wasm': 'binary',
    '.txt': 'text',
  },
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'zod',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-store',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})

const code = result.outputFiles[0].text
const out = `${banner}"use strict";var module={exports:{}};var exports=module.exports;${code}${footer}`
await mkdir(root, { recursive: true })
await writeFile(resolve(root, 'client.js'), out)
console.log(`client.js: ${(out.length / 1024).toFixed(1)} KiB`)
