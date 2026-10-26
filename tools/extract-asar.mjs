// Minimal ASAR extractor (no deps). Usage: node extract-asar.mjs <archive> <outDir> [filter]
import fs from 'node:fs'
import path from 'node:path'

const [archivePath, outDir, filter] = process.argv.slice(2)
if (!archivePath || !outDir) {
  console.error('usage: node extract-asar.mjs <archive> <outDir> [substring filter]')
  process.exit(2)
}

const buf = fs.readFileSync(archivePath)

// ASAR layout:
// [uint32=4][uint32 headerPickleLength][uint32 payloadSize][uint32 jsonLength][json][pad] data...
const headerPickleLength = buf.readUInt32LE(4)
const payloadSize = buf.readUInt32LE(8)
const jsonLength = buf.readUInt32LE(12)
const json = buf.toString('utf8', 16, 16 + jsonLength)
let header
try {
  header = JSON.parse(json)
} catch (e) {
  console.error('header parse failed', e.message, json.slice(0, 80))
  process.exit(3)
}
const pad = (4 - (jsonLength % 4)) % 4
const baseOffset = 16 + jsonLength + pad
if (12 + payloadSize !== baseOffset) {
  console.error(`header sanity mismatch: base=${baseOffset} expected=${12 + payloadSize}`)
  process.exit(4)
}

let files = 0
let bytes = 0
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      walk(entry, p)
      continue
    }
    if (filter && !p.includes(filter)) continue
    const target = path.join(outDir, p)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (entry.link) {
      fs.writeFileSync(target + '.link', entry.link)
      continue
    }
    const start = baseOffset + Number(entry.offset)
    const end = start + Number(entry.size)
    fs.writeFileSync(target, buf.subarray(start, end))
    files++
    bytes += Number(entry.size)
  }
}
walk(header, '')
console.log(JSON.stringify({ files, bytes, baseOffset }))
