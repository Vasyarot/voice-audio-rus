// Print ASAR tree (depth-limited) to understand archive structure.
import fs from 'node:fs'

const archivePath = process.argv[2]
const maxDepth = Number(process.argv[3] ?? 3)
const buf = fs.readFileSync(archivePath)
const headerPickleLength = buf.readUInt32LE(4)
const payloadSize = buf.readUInt32LE(8)
const jsonLength = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLength))
const pad = (4 - (jsonLength % 4)) % 4
const baseOffset = 16 + jsonLength + pad
console.log(JSON.stringify({ headerPickleLength, payloadSize, jsonLength, baseOffset, archiveSize: buf.length }))

function walk(node, prefix, depth) {
  if (depth > maxDepth) return
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      const count = Object.keys(entry.files).length
      console.log(`${'  '.repeat(depth)}${name}/  (${count})`)
      walk(entry, p, depth + 1)
    } else {
      console.log(`${'  '.repeat(depth)}${name}  ${entry.size}`)
    }
  }
}
walk(header, '', 0)
