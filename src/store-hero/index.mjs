/**
 * The shared Store hero renderer (D-123, LIST-8): draws each listing's first screenshot, in every
 * listing locale, from a raw capture, the app's icon and colours, and the headline in
 * `listings.json`, and checks that committed heroes still match.
 *
 * It knows no app. `store-assets/manifest.json` names the layout, capture, icon and colours in a
 * `hero` block on the store's first entry (see `config.mjs`), and each locale's `heroHeadline`
 * and `heroSubline` come from that store's `listings.json`. Drawing uses `@resvg/resvg-js`,
 * resolved from the repo like `devkit-icons` does, and fonts pinned by hash (see `fonts.mjs`), so
 * the same inputs should give the same pixels on every machine.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { loadRenderer } from '../resvg.mjs'
import { DEFAULT_ASSETS_DIR, loadHeroJobs } from './config.mjs'
import { ensureFonts } from './fonts.mjs'
import { encodeRgbPng, readRgbPng } from './png.mjs'
import { createRenderer } from './render.mjs'

/** Above this many output pixels per captured pixel, the enlarged UI looks soft. */
const SOFT_UPSCALE = 1.5

/**
 * Loads the jobs, the renderer and the fonts that every run needs.
 *
 * @param {string} root the repo root
 * @param {{ assetsDir?: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch,
 *   log?: (message: string) => void }} options
 */
async function prepare(
  root,
  { assetsDir = DEFAULT_ASSETS_DIR, env = process.env, fetchImpl, log } = {},
) {
  // Configuration first: a missing headline should fail before any download.
  const jobs = loadHeroJobs(root, assetsDir)
  const Resvg = loadRenderer(root, env, 'devkit-store-hero')
  const fonts = await ensureFonts({ env, fetchImpl, log })
  return { jobs, renderer: createRenderer(Resvg, fonts) }
}

/**
 * Writes every hero, in every locale, and returns what it wrote with any advice about the
 * capture (a 100% capture enlarged far looks soft; a 200% capture is sharper).
 *
 * @returns {Promise<{ written: string[], advice: string[] }>}
 */
export async function writeHeroes(root, options = {}) {
  const { jobs, renderer } = await prepare(root, options)
  const written = []
  const advice = new Set()

  for (const job of jobs) {
    for (const output of job.outputs) {
      const { rows, notes } = renderer.render(job, output)
      const file = path.join(root, output.path)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, encodeRgbPng(rows, job.size.width, job.size.height))
      written.push(output.path)

      for (const { upscale } of notes) {
        if (upscale > SOFT_UPSCALE) {
          advice.add(
            `${job.store}: the capture is enlarged ${upscale.toFixed(1)}x and will look soft; a capture at 200% display scale would be sharper`,
          )
        }
      }
    }
  }
  return { written, advice: [...advice] }
}

/**
 * Renders every hero in memory and returns the committed files that are missing, differ in their
 * pixels, or were not written by devkit, each with the reason. Nothing is written.
 *
 * @returns {Promise<Array<{ path: string, reason: string }>>}
 */
export async function checkHeroes(root, options = {}) {
  const { jobs, renderer } = await prepare(root, options)
  const stale = []

  for (const job of jobs) {
    const { width, height } = job.size
    for (const output of job.outputs) {
      const file = path.join(root, output.path)
      if (!existsSync(file)) {
        stale.push({ path: output.path, reason: 'missing' })
        continue
      }

      const committed = readRgbPng(
        readFileSync(file),
        width,
        height,
        output.path,
      )
      if (typeof committed === 'string') {
        stale.push({ path: output.path, reason: committed })
        continue
      }
      if (!committed.equals(renderer.render(job, output).rows)) {
        stale.push({ path: output.path, reason: 'differs from its inputs' })
      }
    }
  }
  return stale
}

/**
 * Locales whose own capture is missing and whose hero draws the en-US capture instead (a
 * `source` with `{locale}`), as `{ store, locale, source }`. A plain run draws them that way as
 * a preview while captures are being localised; `--check` fails on them, so an English
 * screenshot never reaches a translated listing.
 */
export function captureFallbacks(
  root,
  { assetsDir = DEFAULT_ASSETS_DIR } = {},
) {
  return loadHeroJobs(root, assetsDir).flatMap((job) =>
    job.fallbacks.map((fallback) => ({ store: job.store, ...fallback })),
  )
}

/**
 * Hero files left from a locale the listing no longer has: for a `file` whose `{locale}` is a
 * whole folder name (`screenshots/{locale}/00-hero-dark.png`), any sibling folder holding the
 * same file name for a locale that is not configured. They are only named, never deleted.
 */
export function orphanedHeroes(root, { assetsDir = DEFAULT_ASSETS_DIR } = {}) {
  const orphans = []
  for (const job of loadHeroJobs(root, assetsDir)) {
    const segments = job.pattern.split(/[\\/]/)
    const index = segments.indexOf('{locale}')
    if (index === -1 || segments.slice(index + 1).includes('{locale}')) continue

    const parent = path.join(root, ...segments.slice(0, index))
    if (!existsSync(parent)) continue
    const rest = segments.slice(index + 1)
    const expected = new Set(job.outputs.map((output) => output.path))
    for (const folder of readdirSync(parent, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      const candidate = path.join(
        ...segments.slice(0, index),
        folder.name,
        ...rest,
      )
      if (!expected.has(candidate) && existsSync(path.join(root, candidate)))
        orphans.push(candidate)
    }
  }
  return orphans.sort()
}
