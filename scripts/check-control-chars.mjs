/**
 * Refuse to ship source containing stray control characters.
 *
 * This exists because of a real bug that cost an hour: a `\b` word boundary in
 * a regular expression was written to disk as a literal backspace byte, so the
 * pattern read `/<BS>json<BS>/` and matched nothing. Every tool displayed it as
 * `/json/` — grep, the editor, the terminal — because a backspace is invisible.
 * The code looked correct and silently did the wrong thing.
 *
 * Tab, newline and carriage return are the only control characters a source
 * file has any business containing.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const ROOTS = ['src', 'test', 'scripts']
const CHECKED = new Set(['.ts', '.mts', '.js', '.mjs', '.sql', '.json', '.yml', '.yaml', '.md'])
const ALLOWED = new Set([9, 10, 13])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (CHECKED.has(extname(entry.name))) yield path
  }
}

let failures = 0

for (const root of ROOTS) {
  let entries
  try {
    entries = walk(root)
  } catch {
    continue
  }
  for await (const path of entries) {
    const text = await readFile(path, 'utf8')
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code < 32 && !ALLOWED.has(code)) {
        const line = text.slice(0, i).split('\n').length
        console.error(
          `${path}:${line}: control character U+${code.toString(16).padStart(4, '0')} ` +
            `— probably a backslash escape that was written literally`,
        )
        failures++
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} control character(s) found.`)
  process.exit(1)
}
console.log('no stray control characters')
