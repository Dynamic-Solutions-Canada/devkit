#!/usr/bin/env node
/**
 * `devkit-icons [--check]`: writes, or checks, every icon size the repo's targets need, from the
 * SVG masters in `assets/brand/` and the targets in `assets/brand/icons.json`.
 *
 * `--check` writes nothing and fails when a committed output is missing or differs from what the
 * masters produce, or when a superseded file (a same-named Android icon in another resource folder,
 * or the Play icon at its old path) is still committed, for the repo's `validate` gate (ASSET-3).
 * A plain run names superseded files too but never deletes them. Like the other `devkit-*`
 * commands it needs no bootstrapped machine; it needs `@resvg/resvg-js` installed in the repo.
 */
import { checkIcons, supersededIcons, writeIcons } from '../src/icons/index.mjs'

const root = process.cwd()

/** Lists superseded files on stderr; returns true when there were any. */
function reportSuperseded() {
  const superseded = supersededIcons(root)
  if (superseded.length === 0) return false

  console.error(
    'devkit-icons: remove these files; they would show instead of, or linger beside, the generated icons:',
  )
  for (const file of superseded) console.error(`  ${file}`)
  return true
}

try {
  if (process.argv.includes('--check')) {
    const stale = checkIcons(root)
    if (stale.length > 0) {
      console.error('devkit-icons: these icons do not match their masters:')
      for (const file of stale) console.error(`  ${file}`)
      console.error('Run `devkit-icons` and commit the result.')
    }
    const hasSuperseded = reportSuperseded()

    if (stale.length > 0 || hasSuperseded) process.exitCode = 1
    else console.log('devkit-icons: every icon matches its master')
  } else {
    const written = writeIcons(root)
    console.log(`devkit-icons: wrote ${written.length} files`)
    reportSuperseded()
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
