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
import { createRequire } from 'node:module'
import path from 'node:path'

import { packIco } from './ico.mjs'
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
  for (const [name, required] of [
    ['web', ['dir']],
    ['windows', ['images', 'ico']],
    ['android', ['res']],
  ]) {
    if (!targets[name]) continue
    const missing = required.find(
      (key) => typeof targets[name][key] !== 'string',
    )
    if (missing)
      throw new Error(`devkit-icons: targets.${name}.${missing} must be a path`)
  }
  return { targets, background: config.background }
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
 * Loads resvg, so devkit itself never carries the native module.
 *
 * By default it comes from the repo being generated. `DEVKIT_ICONS_RENDERER_DIR` names another
 * place instead, for repos with no `node_modules` of their own (the Windows repos run this from
 * winui-app-kit's tools folder): either a folder containing `node_modules/@resvg/resvg-js`, or
 * the package folder itself.
 */
export function loadRenderer(root, env = process.env) {
  const rendererDir = env.DEVKIT_ICONS_RENDERER_DIR?.trim()
  const from = rendererDir ? path.resolve(rendererDir) : root
  const require = createRequire(path.join(from, 'package.json'))

  try {
    if (rendererDir && isRendererPackage(from)) return require(from).Resvg
    return require('@resvg/resvg-js').Resvg
  } catch {
    const where = rendererDir
      ? `DEVKIT_ICONS_RENDERER_DIR (${from}) holds neither node_modules/@resvg/resvg-js nor the package itself`
      : 'install @resvg/resvg-js in this repo (pinned exactly), or set DEVKIT_ICONS_RENDERER_DIR'
    throw new Error(`devkit-icons: ${where}`)
  }
}

/** True when `dir` is the `@resvg/resvg-js` package folder itself. */
function isRendererPackage(dir) {
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  return JSON.parse(readFileSync(manifest, 'utf8')).name === '@resvg/resvg-js'
}

/** Every output the repo's config asks for, generated exports first. */
export function planIcons(root) {
  const config = loadIconConfig(root)
  const masters = loadMasters(root)
  const outputs = [...generatedOutputs(masters)]
  for (const [name, options] of Object.entries(config.targets)) {
    outputs.push(...TARGETS[name](masters, options, config))
  }
  return outputs
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
