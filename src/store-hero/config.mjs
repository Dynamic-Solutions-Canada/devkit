/**
 * Reads and checks a repo's hero configuration: the hero entry in `store-assets/manifest.json`
 * and the per-locale headlines in each store's `listings.json`, resolved into one job per hero.
 *
 * The manifest is the one LIST-8 already defines, so a hero is just another entry, first in its
 * store's list, with a `hero` block. Every problem is reported before anything renders, so a
 * missing translation fails in seconds rather than after six locales have drawn.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { pngHeader } from './png.mjs'

export const DEFAULT_ASSETS_DIR = 'store-assets'
export const LAYOUTS = ['split', 'brand-card']
const DEFAULT_SIZE = '1366x768'
const LOCALE_TOKEN = '{locale}'
const COLOUR = /^#[0-9A-Fa-f]{6}$/

// Microsoft takes desktop screenshots from 1366 x 768 to 3840 x 2160. The layouts are drawn for
// 16:9, so the aspect ratio stays close to it.
const MIN_SIZE = [1366, 768]
const MAX_SIZE = [3840, 2160]
const ASPECT_RANGE = [1.7, 1.8]

/** Throws a devkit-store-hero error. */
function fail(message) {
  throw new Error(`devkit-store-hero: ${message}`)
}

/** Reads a JSON file, tolerating the byte-order mark Windows tools often write. */
export function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return fail(`${label} is not readable JSON (${error.message})`)
  }
}

/** Parses the manifest's `"WIDTHxHEIGHT"` and checks it against the Store's limits. */
export function parseSize(value = DEFAULT_SIZE) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value))
  if (!match) fail(`manifest size ${JSON.stringify(value)} is not WIDTHxHEIGHT`)

  const width = Number(match[1])
  const height = Number(match[2])
  const inRange =
    width >= MIN_SIZE[0] &&
    height >= MIN_SIZE[1] &&
    width <= MAX_SIZE[0] &&
    height <= MAX_SIZE[1]
  const aspect = width / height
  if (!inRange || aspect < ASPECT_RANGE[0] || aspect > ASPECT_RANGE[1]) {
    fail(
      `manifest size ${value} must be landscape, about 16:9, from 1366x768 to 3840x2160`,
    )
  }
  return { width, height }
}

/**
 * Reads a capture's sidecar (`<capture>.json`, written by the capture helper) and the region the
 * hero shows: the whole window the sidecar records, or `crop` when given. A crop must contain the
 * whole window, because a hero that cuts the UI would misrepresent it (Store policy 10.1). The one
 * exception is `fade: "bottom"`: the crop may then cut the window's bottom edge, and the layout
 * fades the UI out there so it reads as continuing, not as ending.
 *
 * @param {string} assets the store-assets folder
 * @param {string} source the capture, relative to `assets`
 * @param {number[] | undefined} crop `[x, y, width, height]` in capture pixels
 * @param {string} label names the entry in errors
 * @param {'bottom' | undefined} fade where a crop may cut the window
 */
export function resolveCapture(assets, source, crop, label, fade) {
  const file = path.join(assets, source)
  if (!existsSync(file)) fail(`${label}.source (${source}) is missing`)
  const { width, height } = pngHeader(readFileSync(file), source)

  const sidecarFile = file.replace(/\.png$/i, '.json')
  if (!existsSync(sidecarFile)) {
    fail(
      `${label}.source has no ${path.basename(sidecarFile)} beside it saying where the window is`,
    )
  }
  const sidecar = readJson(sidecarFile, path.basename(sidecarFile))
  const window = sidecar.window
  const isRect = (rect) =>
    rect &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isInteger(rect[key]))
  if (!isRect(window))
    fail(`${path.basename(sidecarFile)} has no window rectangle`)
  const windowRect = [window.x, window.y, window.width, window.height]

  const region =
    crop === undefined ? windowRect : checkCrop(crop, windowRect, label, fade)
  const [x, y, w, h] = region
  if (x < 0 || y < 0 || x + w > width || y + h > height) {
    fail(
      `${label}: the region ${region.join(', ')} is not inside the ${width} x ${height} capture`,
    )
  }

  const scale = sidecar.scale ?? 100
  if (!Number.isFinite(scale) || scale <= 0)
    fail(`${path.basename(sidecarFile)} has an unreadable scale`)
  return {
    file,
    width,
    height,
    region,
    scale,
    cropped: crop !== undefined,
    fade: fade ?? null,
  }
}

/**
 * Checks an explicit `[x, y, width, height]` crop: it keeps the whole window, or, with
 * `fade: "bottom"`, the whole window except part of its bottom, which it must then really cut.
 */
function checkCrop(crop, windowRect, label, fade) {
  const valid =
    Array.isArray(crop) && crop.length === 4 && crop.every(Number.isInteger)
  if (!valid || crop[2] <= 0 || crop[3] <= 0)
    fail(`${label}.hero.crop must be [x, y, width, height] in capture pixels`)

  const [x, y, w, h] = crop
  const [wx, wy, ww, wh] = windowRect
  const keepsTopAndSides = x <= wx && y <= wy && x + w >= wx + ww
  const keepsBottom = y + h >= wy + wh

  if (fade === 'bottom') {
    if (!keepsTopAndSides) {
      fail(
        `${label}.hero.crop may cut only the window's bottom edge (${windowRect.join(', ')}); its top and sides must stay whole`,
      )
    }
    if (keepsBottom) {
      fail(
        `${label}.hero.fade is "bottom", but the crop keeps the whole window; remove fade to show it whole`,
      )
    }
    if (y + h <= wy) fail(`${label}.hero.crop ends above the window`)
    return crop
  }

  if (!keepsTopAndSides || !keepsBottom) {
    fail(
      `${label}.hero.crop must contain the whole window (${windowRect.join(', ')}); a hero shows a complete window or flyout, never part of one`,
    )
  }
  return crop
}

/** Checks a hero block's own fields; `label` names the entry in errors. */
function checkHeroBlock(root, entry, label) {
  const hero = entry.hero
  if (!hero || typeof hero !== 'object' || Array.isArray(hero))
    fail(`${label}.hero must be an object`)
  if (!LAYOUTS.includes(hero.layout))
    fail(
      `${label}.hero.layout must be ${LAYOUTS.map((name) => `"${name}"`).join(' or ')}`,
    )

  for (const key of ['primary', 'accent']) {
    if (!COLOUR.test(hero[key] ?? ''))
      fail(`${label}.hero.${key} must be a #RRGGBB colour`)
  }

  if (typeof hero.icon !== 'string' || !/\.(png|svg)$/i.test(hero.icon)) {
    fail(
      `${label}.hero.icon must be the repo-relative path of a .png or .svg icon`,
    )
  }
  if (!existsSync(path.join(root, hero.icon)))
    fail(`${label}.hero.icon (${hero.icon}) is missing`)

  if (
    typeof entry.file !== 'string' ||
    !entry.file.includes(LOCALE_TOKEN) ||
    !entry.file.endsWith('.png')
  ) {
    fail(
      `${label}.file must be a .png path containing ${LOCALE_TOKEN}, since every listing locale gets its own hero`,
    )
  }
  if (hero.layout === 'split' && typeof entry.source !== 'string') {
    fail(
      `${label}.source must name the raw capture whose window the split layout enlarges`,
    )
  }
  if (hero.crop !== undefined && typeof entry.source !== 'string')
    fail(`${label}.hero.crop needs a source`)

  // A faded cut is for a split hero's enlarged UI only, and only with a crop saying where to cut.
  if (hero.fade !== undefined) {
    if (hero.fade !== 'bottom') fail(`${label}.hero.fade can only be "bottom"`)
    if (hero.layout !== 'split')
      fail(`${label}.hero.fade applies only to the split layout`)
    if (hero.crop === undefined)
      fail(`${label}.hero.fade needs a crop saying where the window is cut`)
  }

  // The text-free variant is one image for every locale, so its path has no {locale}.
  if (hero.textFreeFile !== undefined) {
    const file = hero.textFreeFile
    if (
      typeof file !== 'string' ||
      !file.endsWith('.png') ||
      file.includes(LOCALE_TOKEN)
    ) {
      fail(
        `${label}.hero.textFreeFile must be a .png path without ${LOCALE_TOKEN}, since one image serves every locale`,
      )
    }
    if (hero.layout !== 'split')
      fail(`${label}.hero.textFreeFile applies only to the split layout`)
  }
}

/**
 * The locales that get their own hero and the text each one draws. A `copyFrom` locale reuses its
 * target's image and needs no text. Every missing headline is named at once.
 */
export function heroLocales(listings, layout, label) {
  const records = listings?.locales
  if (!records || typeof records !== 'object')
    fail(`${label} has no "locales" object`)

  const locales = []
  const missingHeadline = []
  const missingTitle = []
  for (const [locale, record] of Object.entries(records)) {
    if (record && typeof record.copyFrom === 'string') continue

    const headline =
      typeof record?.heroHeadline === 'string' ? record.heroHeadline.trim() : ''
    const subline =
      typeof record?.heroSubline === 'string' ? record.heroSubline.trim() : ''
    if (!headline) missingHeadline.push(locale)
    if (typeof record?.title !== 'string' || !record.title.trim())
      missingTitle.push(locale)
    locales.push({
      locale,
      name: record?.title?.trim() ?? '',
      headline,
      subline,
    })
  }

  if (missingHeadline.length > 0)
    fail(`${label}: no heroHeadline for ${missingHeadline.join(', ')}`)
  if (missingTitle.length > 0)
    fail(`${label}: no title for ${missingTitle.join(', ')}`)
  if (locales.length === 0) fail(`${label} lists no locale with its own text`)

  // A subline in some locales but not others would make the heroes differ by language.
  const withSubline = locales
    .filter(({ subline }) => subline)
    .map(({ locale }) => locale)
  const needsSubline = layout === 'brand-card'
  if (
    (needsSubline || withSubline.length > 0) &&
    withSubline.length !== locales.length
  ) {
    const missing = locales
      .filter(({ subline }) => !subline)
      .map(({ locale }) => locale)
    const why = needsSubline
      ? 'the brand card needs one in every locale'
      : 'set it in every locale or none'
    fail(`${label}: no heroSubline for ${missing.join(', ')}; ${why}`)
  }
  return locales
}

/**
 * Every hero the repo configures, resolved and checked: one job per store list with a hero entry.
 *
 * @param {string} root the repo root; `hero.icon` is relative to it
 * @param {string} assetsDir the store-assets folder, relative to `root`
 * @returns {Array<object>} jobs with their layout, size, colours, icon, capture and outputs: one
 *   per locale, then the text-free variant (`textFree: true`, no locale) when one is configured
 */
export function loadHeroJobs(root, assetsDir = DEFAULT_ASSETS_DIR) {
  const assets = path.join(root, assetsDir)
  const manifestFile = path.join(assets, 'manifest.json')
  if (!existsSync(manifestFile))
    fail(
      `${path.join(assetsDir, 'manifest.json')} is missing; see "Store heroes" in devkit's README`,
    )
  const manifest = readJson(manifestFile, 'manifest.json')
  const size = parseSize(manifest.size)

  const jobs = []
  for (const [store, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) continue

    const heroIndexes = entries.flatMap((entry, index) =>
      entry?.hero === undefined ? [] : [index],
    )
    if (heroIndexes.length === 0) continue
    if (heroIndexes.length > 1 || heroIndexes[0] !== 0) {
      fail(
        `${store}: the hero must be the first entry, and the only one (LIST-8)`,
      )
    }

    const entry = entries[0]
    const label = `${store}[0]`
    checkHeroBlock(root, entry, label)
    const { hero } = entry

    const listingsPath = path.join(assetsDir, store, 'listings.json')
    if (!existsSync(path.join(root, listingsPath)))
      fail(`${listingsPath} is missing; the hero takes its text from it`)
    const locales = heroLocales(
      readJson(path.join(root, listingsPath), listingsPath),
      hero.layout,
      listingsPath,
    )

    const capture =
      typeof entry.source === 'string'
        ? resolveCapture(assets, entry.source, hero.crop, label, hero.fade)
        : null
    const outputs = locales.map((text) => ({
      ...text,
      path: path.join(
        assetsDir,
        store,
        entry.file.replaceAll(LOCALE_TOKEN, text.locale),
      ),
    }))
    if (hero.textFreeFile !== undefined) {
      const textFreePath = path.join(assetsDir, store, hero.textFreeFile)
      if (outputs.some((output) => output.path === textFreePath)) {
        fail(
          `${label}.hero.textFreeFile (${hero.textFreeFile}) is also a locale's hero; give it its own name`,
        )
      }
      outputs.push({ textFree: true, path: textFreePath })
    }

    jobs.push({
      store,
      layout: hero.layout,
      size,
      primary: hero.primary.toUpperCase(),
      accent: hero.accent.toUpperCase(),
      icon: path.join(root, hero.icon),
      capture,
      outputs,
      pattern: path.join(assetsDir, store, entry.file),
    })
  }

  if (jobs.length === 0)
    fail(
      `${path.join(assetsDir, 'manifest.json')} has no entry with a "hero" block`,
    )
  return jobs
}
