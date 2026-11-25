#!/usr/bin/env node
/**
 * `devkit-store-hero [--check] [--assets <dir>]`: writes, or checks, the generated first Store
 * screenshot (D-123) in every listing locale, from `store-assets/manifest.json` and each store's
 * `listings.json`.
 *
 * `--check` writes nothing and fails when a hero is missing, differs from what its inputs draw,
 * or was saved by another tool, for the repo's `validate` gate. Both modes name hero files left
 * from a locale the listing no longer has; `--check` fails on them. Both also name each locale
 * whose own capture is missing: a plain run draws it from the en-US capture as a preview, and
 * `--check` fails, as winui-app-kit's screenshot check does. `--assets` names the
 * store-assets folder when it is not `store-assets/` at the repo root. `--fetch-fonts` only
 * downloads the pinned fonts, for a CI cache step.
 *
 * Like the other `devkit-*` commands it needs no bootstrapped machine. It needs `@resvg/resvg-js`
 * (as `devkit-icons` does) and downloads its fonts once (see "Store heroes" in the README).
 */
import {
  captureFallbacks,
  checkHeroes,
  orphanedHeroes,
  writeHeroes,
} from '../src/store-hero/index.mjs'
import { ensureFonts, fontsDir } from '../src/store-hero/fonts.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const log = (message) => console.error(message)

/** The value after `--assets`, if given. */
function assetsDir() {
  const index = args.indexOf('--assets')
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--'))
    throw new Error('devkit-store-hero: --assets needs a folder')
  return value
}

/** Lists hero files for removed locales on stderr; returns true when there were any. */
function reportOrphans(options) {
  const orphans = orphanedHeroes(root, options)
  if (orphans.length === 0) return false

  console.error(
    'devkit-store-hero: remove these heroes; their locale is no longer in the listing:',
  )
  for (const file of orphans) console.error(`  ${file}`)
  return true
}

/**
 * Names on stderr each locale whose own capture is missing; returns true when there were any.
 * `check` says whether this fails the run (`--check`) or only previews it with the en-US capture.
 */
function reportFallbacks(options, check) {
  const fallbacks = captureFallbacks(root, options)
  if (fallbacks.length === 0) return false

  console.error(
    check
      ? 'devkit-store-hero: these locales have no capture of their own; capture them:'
      : 'devkit-store-hero: warning: these locales have no capture of their own, so their heroes are previews drawn from the en-US one, and --check fails until they are captured:',
  )
  for (const { store, locale, source } of fallbacks)
    console.error(`  ${store} ${locale}: ${source} is missing`)
  return true
}

try {
  const known = new Set(['--check', '--assets', '--fetch-fonts'])
  const unknown = args.find(
    (arg, index) =>
      arg.startsWith('--') && !known.has(arg) && args[index - 1] !== '--assets',
  )
  if (unknown) throw new Error(`devkit-store-hero: unknown option ${unknown}`)

  const options = { assetsDir: assetsDir(), log }
  if (args.includes('--fetch-fonts')) {
    await ensureFonts({ log })
    console.log(`devkit-store-hero: fonts are in ${fontsDir()}`)
  } else if (args.includes('--check')) {
    const stale = await checkHeroes(root, options)
    if (stale.length > 0) {
      console.error(
        'devkit-store-hero: these heroes do not match their inputs:',
      )
      for (const { path, reason } of stale)
        console.error(`  ${path}: ${reason}`)
      console.error('Run `devkit-store-hero` and commit the result.')
    }
    const hasOrphans = reportOrphans(options)
    const hasFallbacks = reportFallbacks(options, true)

    if (stale.length > 0 || hasOrphans || hasFallbacks) process.exitCode = 1
    else console.log('devkit-store-hero: every hero matches its inputs')
  } else {
    const { written, advice } = await writeHeroes(root, options)
    console.log(`devkit-store-hero: wrote ${written.length} files`)
    for (const line of advice) console.error(`devkit-store-hero: note: ${line}`)
    reportOrphans(options)
    reportFallbacks(options, false)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
