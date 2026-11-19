#!/usr/bin/env node
/**
 * `devkit-icons [--check]`: writes, or checks, every icon size the repo's targets need, from the
 * SVG masters in `assets/brand/` and the targets in `assets/brand/icons.json`.
 *
 * `--check` writes nothing and fails when a committed output is missing or differs from what the
 * masters produce, for the repo's `validate` gate (ASSET-3). Like the other `devkit-*` commands it
 * needs no bootstrapped machine; it needs `@resvg/resvg-js` installed in the repo.
 */
import { checkIcons, writeIcons } from '../src/icons/index.mjs'

const root = process.cwd()

try {
  if (process.argv.includes('--check')) {
    const stale = checkIcons(root)
    if (stale.length > 0) {
      console.error('devkit-icons: these icons do not match their masters:')
      for (const file of stale) console.error(`  ${file}`)
      console.error('Run `devkit-icons` and commit the result.')
      process.exitCode = 1
    } else {
      console.log('devkit-icons: every icon matches its master')
    }
  } else {
    const written = writeIcons(root)
    console.log(`devkit-icons: wrote ${written.length} files`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
