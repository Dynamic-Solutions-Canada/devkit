/**
 * The shared third-party notices generator (HYG-3, D-085): one de-duplicated, sorted notices file
 * per deliverable, from the production dependencies of the packages that deliverable ships.
 *
 * Deliverables come from the `notices` block of `devkit.config.mjs`. The output depends only on
 * the installed packages, never on where they are installed, so `--check` compares it byte for
 * byte. Linux x64 is the canonical platform: packages that exist for one platform only (native
 * binaries such as `@esbuild/linux-x64`) appear as installed there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  closureDirectories,
  compare,
  isThirdParty,
  readPackage,
} from './packages.mjs'
import { renderNotices } from './render.mjs'

/**
 * Collects one deliverable's third-party packages, de-duplicated by name and version and sorted,
 * and the problems that must stop it: a package with no declared licence and no licence file, an
 * `UNLICENSED` package, and an `allow` entry that names no package in the closure.
 */
export function collectDeliverable(root, deliverable, options = {}) {
  const byKey = new Map()
  for (const folder of deliverable.packages) {
    for (const directory of closureDirectories(root, folder, options)) {
      if (!isThirdParty(directory)) continue
      const record = readPackage(directory)
      if (!record) continue
      const key = `${record.name}@${record.version}`
      if (!byKey.has(key)) byKey.set(key, record)
    }
  }

  const packages = [...byKey.values()].sort(
    (first, second) =>
      compare(first.name, second.name) ||
      compare(first.version, second.version),
  )
  return { packages, problems: licenceProblems(packages, deliverable.allow) }
}

/** The licence problems in one deliverable's packages, as messages. */
function licenceProblems(packages, allow = []) {
  const allowed = new Set(allow)
  const problems = []

  for (const record of packages) {
    if (allowed.has(record.name)) continue
    const id = `${record.name}@${record.version}`
    const declared =
      record.license && record.license.toUpperCase() !== 'UNKNOWN'
    if (!declared && !record.text) {
      problems.push(`${id} declares no licence and ships no licence file`)
    } else if (record.license?.toUpperCase() === 'UNLICENSED') {
      problems.push(
        `${id} is UNLICENSED; add it to \`allow\` only if this app may ship it`,
      )
    }
  }

  const names = new Set(packages.map((record) => record.name))
  for (const name of allowed) {
    if (!names.has(name)) {
      problems.push(
        `\`allow\` lists ${name}, which is not in this deliverable's dependencies`,
      )
    }
  }
  return problems
}

/**
 * Builds every deliverable in memory as `{ output, text, count }`. Throws one error listing every
 * licence problem across them, so a run never writes a partial set.
 */
export function planNotices(root, notices, options = {}) {
  if (notices.length === 0) {
    throw new Error(
      'devkit-notices: add a `notices` block to devkit.config.mjs; see "Third-party notices" in devkit\'s README',
    )
  }

  const planned = []
  const problems = []
  for (const deliverable of notices) {
    const collected = collectDeliverable(root, deliverable, options)
    for (const problem of collected.problems) {
      problems.push(`${deliverable.output}: ${problem}`)
    }
    planned.push({
      output: deliverable.output,
      text: renderNotices(deliverable.title, collected.packages),
      count: collected.packages.length,
    })
  }

  if (problems.length > 0) {
    throw new Error(
      `devkit-notices: these packages cannot be listed:\n${problems.map((problem) => `  ${problem}`).join('\n')}`,
    )
  }
  return planned
}

/** Writes every deliverable's notices file and returns what was written. */
export function writeNotices(root, notices, options) {
  const planned = planNotices(root, notices, options)
  for (const { output, text } of planned) {
    const file = path.join(root, output)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return planned
}

/** Returns the outputs whose file is missing or differs from a fresh build; writes nothing. */
export function checkNotices(root, notices, options) {
  return planNotices(root, notices, options)
    .filter(({ output, text }) => {
      const file = path.join(root, output)
      return !existsSync(file) || readFileSync(file, 'utf8') !== text
    })
    .map(({ output }) => output)
}
