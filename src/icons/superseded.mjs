/**
 * Finds files that would show instead of, or linger beside, what devkit-icons writes. devkit
 * never deletes files from a repo, so these are only named; the repo removes them in a visible
 * commit.
 *
 * Android resolves a resource by name and picks the most specific folder. A same-named icon in
 * another `drawable-*` or `mipmap-*` folder (Capacitor's `drawable-v24/ic_launcher_foreground.xml`,
 * its `mipmap-*` foreground PNGs, or launcher PNGs when `legacy` is off) can therefore win over
 * the generated one while `--check` still passes.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { targetEntries } from './entries.mjs'
import {
  ANDROID_RESOURCE_NAMES,
  DEFAULT_PLAY_PATH,
  OLD_PLAY_PATH,
} from './targets.mjs'

/** Only these resource folders hold icons; `values*`, `xml` and the rest are left alone. */
const ICON_FOLDER = /^(drawable|mipmap)(-|$)/

/**
 * Returns the repo-relative paths that devkit-icons would supersede, sorted, across every
 * Android entry (one per app when `targets.android` is a list).
 *
 * `config` is the loaded `icons.json`; `planned` is the list of outputs this run writes, so a
 * file devkit itself produces is never named.
 */
export function supersededFiles(root, config, planned) {
  const written = new Set(planned.map((output) => output.path))
  const found = new Set()
  for (const { name, entry } of targetEntries(config.targets)) {
    if (name !== 'android') continue
    for (const file of shadowingResources(root, entry.res, written)) {
      found.add(file)
    }
    for (const file of oldPlayIcon(root, entry, written)) found.add(file)
  }
  return [...found].sort()
}

/** Same-named icon resources in `res/` that devkit did not write. */
function shadowingResources(root, res, written) {
  const resDir = path.join(root, res)
  if (!existsSync(resDir)) return []

  const found = []
  for (const folder of readdirSync(resDir)) {
    if (!ICON_FOLDER.test(folder)) continue
    const folderDir = path.join(resDir, folder)
    if (!statSync(folderDir).isDirectory()) continue

    for (const file of readdirSync(folderDir)) {
      const name = file.replace(/\..*$/, '')
      if (!ANDROID_RESOURCE_NAMES.includes(name)) continue
      const relative = path.posix.join(res, folder, file)
      if (!written.has(relative)) found.push(relative)
    }
  }
  return found
}

/** The Play icon left at its pre-0.21.0 path once the icon is written somewhere else. */
function oldPlayIcon(root, android, written) {
  const play = android.play ?? true
  const playPath = android.playPath ?? DEFAULT_PLAY_PATH
  if (!play || playPath === OLD_PLAY_PATH) return []
  if (written.has(OLD_PLAY_PATH)) return []
  return existsSync(path.join(root, OLD_PLAY_PATH)) ? [OLD_PLAY_PATH] : []
}
