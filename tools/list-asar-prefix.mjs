// Print ASAR subtree entries under a prefix path, depth-limited.
import fs from 'node:fs'

const [archivePath, prefixPath, maxDepthArg] = process.argv.slice(2)
const maxDepth = Number(maxDepthArg ?? 2)
const buf = fs.readFileSync(archivePath)
const jsonLength = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLength))

let node = header
for (const part of prefixPath.split('/').filter(Boolean)) {
  const next = node.files?.[part]
  if (!next) {
    console.error(`not found: ${part}`)
    process.exit(2)
  }
  node = next
}

function walk(n, depth, prefix) {
  if (depth > maxDepth) return
  for (const [name, entry] of Object.entries(n.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      console.log(`${'  '.repeat(depth)}${p}/`)
      walk(entry, depth + 1, p)
    } else {
      console.log(`${'  '.repeat(depth)}${p}  ${entry.size}`)
    }
  }
}
walk(node, 0, '')
