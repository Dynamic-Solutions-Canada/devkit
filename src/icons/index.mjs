/**
 * The shared icon generator (ASSET-3, D-069): sizes and packs a repo's SVG masters into every
 * platform's icon set, and checks that the committed outputs still match.
 *
 * It draws nothing and knows no app. The masters live in `assets/brand/` (`icon.svg`, and
 * `icon-maskable.svg` and `icon-mono.svg` when a target needs them), and
 * `assets/brand/icons.json` says which targets the repo has and where their files go. Rendering
 * uses `@resvg/resvg-js`, resolved from the repo, never from devkit, so only repos that make
 * icons install it; its version must be pinned exactly, because `--check` compares bytes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadRenderer as loadSharedRenderer } from '../resvg.mjs'
import { targetEntries } from './entries.mjs'
import { packIco } from './ico.mjs'
import { supersededFiles } from './superseded.mjs'
import { parseMaster } from './svg.mjs'
import {
  androidOutputs,
  generatedOutputs,
  webOutputs,
  windowsOutputs,
} from './targets.mjs'

export const CONFIG_PATH = 'assets/brand/icons.json'
const MASTER_NAMES = ['icon.svg', 'icon-maskable.svg', 'icon-mono.svg']
const TARGETS = {
  web: webOutputs,
  windows: windowsOutputs,
  android: androidOutputs,
}

/** Reads and checks `assets/brand/icons.json`. */
export function loadIconConfig(root) {
  const file = path.join(root, CONFIG_PATH)
  if (!existsSync(file)) {
    throw new Error(
      `devkit-icons: ${CONFIG_PATH} is missing; see "Icons" in devkit's README`,
    )
  }
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const targets = config.targets ?? {}
  const unknown = Object.keys(targets).find((name) => !TARGETS[name])
  if (unknown)
    throw new Error(
      `devkit-icons: unknown target "${unknown}" in ${CONFIG_PATH}`,
    )

  const needsBackground = targets.web || targets.android
  if (needsBackground && !/^#[0-9A-Fa-f]{6}$/.test(config.background ?? '')) {
    throw new Error(
      `devkit-icons: set "background" in ${CONFIG_PATH} to a #RRGGBB colour for the opaque icons`,
    )
  }
  for (const { name, entry, label } of targetEntries(targets)) {
    validateEntry(name, entry, label)
  }
  return { targets, background: config.background }
}

/** The keys each target must set to a path. */
const REQUIRED_PATHS = {
  web: ['dir'],
  windows: ['images', 'ico'],
  android: ['res'],
}

/** The keys that choose between the `"icon"` and `"maskable"` masters. */
const MASTER_CHOICES = { web: ['appleTouchMaster'], android: ['playMaster'] }

/** The masters an entry's `masters` block may replace, by key, and the shared file each replaces. */
const MASTER_OVERRIDES = {
  icon: 'icon.svg',
  maskable: 'icon-maskable.svg',
  mono: 'icon-mono.svg',
}

/** Checks one target entry; `label` names it in errors, as `targets.android[1]` for a list. */
function validateEntry(name, entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`devkit-icons: ${label} must be an object`)
  }

  const missing = REQUIRED_PATHS[name].find(
    (key) => typeof entry[key] !== 'string',
  )
  if (missing)
    throw new Error(`devkit-icons: ${label}.${missing} must be a path`)

  for (const key of MASTER_CHOICES[name] ?? []) {
    const choice = entry[key]
    if (choice !== undefined && !['icon', 'maskable'].includes(choice)) {
      throw new Error(
        `devkit-icons: ${label}.${key} must be "icon" or "maskable"`,
      )
    }
  }

  if (name === 'windows' && entry.gameBarIcons !== undefined) {
    if (typeof entry.gameBarIcons !== 'string') {
      throw new Error(`devkit-icons: ${label}.gameBarIcons must be a path`)
    }
  }

  if (name === 'android' && entry.playPath !== undefined) {
    if (typeof entry.playPath !== 'string') {
      throw new Error(`devkit-icons: ${label}.playPath must be a path`)
    }
  }

  validateMasterOverrides(entry.masters, label)
}

/** Checks an entry's optional `masters` block: known keys, each a repo-relative path. */
function validateMasterOverrides(overrides, label) {
  if (overrides === undefined) return
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`devkit-icons: ${label}.masters must be an object`)
  }
  for (const [key, file] of Object.entries(overrides)) {
    if (!MASTER_OVERRIDES[key]) {
      throw new Error(
        `devkit-icons: ${label}.masters.${key} is not a master; use ${Object.keys(MASTER_OVERRIDES).join(', ')}`,
      )
    }
    if (typeof file !== 'string') {
      throw new Error(`devkit-icons: ${label}.masters.${key} must be a path`)
    }
  }
}

/** Reads the masters that exist, parsed, keeping the original text for outputs that copy it. */
function loadMasters(root) {
  const masters = { source: {} }
  for (const name of MASTER_NAMES) {
    const file = path.join(root, 'assets/brand', name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    masters.source[name] = text
    masters[name] = parseMaster(text, name)
  }
  if (!masters['icon.svg'])
    throw new Error('devkit-icons: assets/brand/icon.svg is missing')
  return masters
}

/**
 * The masters one entry draws from: the shared ones, with any its `masters` block replaces read
 * from their repo-relative paths. Generated exports always use the shared masters.
 */
function entryMasters(root, shared, overrides, label) {
  if (!overrides) return shared

  const masters = { ...shared, source: { ...shared.source } }
  for (const [key, file] of Object.entries(overrides)) {
    const absolute = path.join(root, file)
    if (!existsSync(absolute)) {
      throw new Error(
        `devkit-icons: ${label}.masters.${key} (${file}) is missing`,
      )
    }
    const name = MASTER_OVERRIDES[key]
    const text = readFileSync(absolute, 'utf8')
    masters.source[name] = text
    masters[name] = parseMaster(text, file)
  }
  return masters
}

/**
 * Loads resvg from the repo, or from `DEVKIT_ICONS_RENDERER_DIR` (see `../resvg.mjs`), so
 * devkit itself never carries the native module.
 */
export function loadRenderer(root, env = process.env) {
  return loadSharedRenderer(root, env, 'devkit-icons')
}

/** Every output the repo's config asks for, generated exports first. */
export function planIcons(root) {
  const config = loadIconConfig(root)
  const masters = loadMasters(root)
  const outputs = [...generatedOutputs(masters)]
  for (const { name, entry, label } of targetEntries(config.targets)) {
    const drawFrom = entryMasters(root, masters, entry.masters, label)
    outputs.push(...TARGETS[name](drawFrom, entry, config))
  }
  assertDistinctPaths(outputs)
  return outputs
}

/**
 * Fails when two outputs would write the same file, so one target cannot silently overwrite
 * another's (for example two targets left on the default Play icon path).
 */
function assertDistinctPaths(outputs) {
  const seen = new Set()
  const repeated = new Set()
  for (const { path: file } of outputs) {
    if (seen.has(file)) repeated.add(file)
    seen.add(file)
  }
  if (repeated.size > 0) {
    throw new Error(
      `devkit-icons: more than one output writes ${[...repeated].sort().join(', ')}; give each target its own paths in ${CONFIG_PATH}`,
    )
  }
}

/** Renders one output to the bytes that belong on disk. */
function render(output, Resvg) {
  const png = (svg) => Buffer.from(new Resvg(svg).render().asPng())
  if (output.text !== undefined) return Buffer.from(output.text)
  if (output.ico)
    return packIco(output.ico.map(({ size, svg }) => ({ size, png: png(svg) })))
  return png(output.svg)
}

/** Writes every output and returns their paths. */
export function writeIcons(root) {
  const Resvg = loadRenderer(root)
  const written = []
  for (const output of planIcons(root)) {
    const file = path.join(root, output.path)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, render(output, Resvg))
    written.push(output.path)
  }
  return written
}

/**
 * Renders every output in memory and returns the paths whose committed file is missing or
 * differs, without writing anything.
 */
export function checkIcons(root) {
  const Resvg = loadRenderer(root)
  return planIcons(root)
    .filter((output) => {
      const file = path.join(root, output.path)
      return (
        !existsSync(file) || !readFileSync(file).equals(render(output, Resvg))
      )
    })
    .map((output) => output.path)
}

/**
 * Returns the committed files that would show instead of, or linger beside, the generated icons
 * (see `superseded.mjs`). They are only named, never deleted.
 */
export function supersededIcons(root) {
  return supersededFiles(root, loadIconConfig(root), planIcons(root))
}
