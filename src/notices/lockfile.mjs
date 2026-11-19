/**
 * Finds what a package folder ships by walking the dependency graph in `package-lock.json`
 * (lockfileVersion 2 or 3) from that folder's entry.
 *
 * It follows `dependencies`, `optionalDependencies` and the `peerDependencies` not marked optional
 * in `peerDependenciesMeta`. It never follows `devDependencies` or optional peers, so a package
 * that only an optional peer and a dev dependency reach (TypeScript, as an optional peer of
 * i18next, installed for the repo's own build) is not counted as shipped. `npm ls --omit=dev`
 * keeps those, because npm flags them `devOptional` without saying which edge put them there.
 *
 * Names resolve the way Node and npm resolve them: the nearest `node_modules/<name>` walking up
 * from the dependent's folder, following `link` entries (workspaces) to their folder. Overrides
 * and `npm:` aliases need no handling: the lockfile already records the installed result under
 * the name the dependent uses. Only installed folders count, so an optional dependency built for
 * another platform is skipped.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Returns the real directories of every package `folder` ships, including the folder itself and
 * any of the repo's own packages it reaches; the caller decides what is third party.
 * @param {string} root The repo checkout.
 * @param {string} folder A repo-relative package folder: a workspace, or a package with its own
 *   `package-lock.json`.
 */
export function closureDirectories(root, folder) {
  const { lockRoot, packages, start } = readLockfile(root, folder)

  const visited = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const location = queue.shift()
    for (const edge of shippedEdges(packages[location])) {
      const target = resolve(packages, location, edge.name)
      if (target === null || !existsSync(path.join(lockRoot, target))) {
        if (edge.optional) continue
        throw new Error(
          `devkit-notices: ${edge.name}, needed by ${location || folder}, is not installed; run npm ci`,
        )
      }
      if (visited.has(target)) continue
      visited.add(target)
      queue.push(target)
    }
  }

  return [...visited].map((location) => realpath(path.join(lockRoot, location)))
}

/**
 * Reads the lockfile that governs `folder`: its own when it has one, otherwise the repo root's,
 * where `folder` must be a workspace. Returns the lockfile's folder, its `packages` map and the
 * location the walk starts from.
 */
function readLockfile(root, folder) {
  const own = path.join(root, folder, 'package-lock.json')
  const standalone = existsSync(own)
  const lockRoot = standalone ? path.join(root, folder) : root
  const file = standalone ? own : path.join(root, 'package-lock.json')
  if (!existsSync(file)) {
    throw new Error(
      `devkit-notices: ${path.relative(root, file)} is missing; run npm install`,
    )
  }

  const lockfile = JSON.parse(readFileSync(file, 'utf8'))
  if (!(lockfile.lockfileVersion >= 2) || !lockfile.packages) {
    throw new Error(
      `devkit-notices: ${path.relative(root, file)} is lockfileVersion ${lockfile.lockfileVersion ?? 'unknown'}; regenerate it with npm 7 or later`,
    )
  }

  const start = standalone ? '' : folder.split(path.sep).join('/')
  if (!lockfile.packages[start]) {
    throw new Error(
      `devkit-notices: ${folder} is not a workspace in package-lock.json`,
    )
  }
  return { lockRoot, packages: lockfile.packages, start }
}

/**
 * The edges of one lockfile entry that ship with it, as `{ name, optional }`. An optional
 * dependency may be missing (another platform); an optional peer is not followed at all.
 */
function shippedEdges(entry) {
  const edges = new Map()
  for (const name of Object.keys(entry.dependencies ?? {})) {
    edges.set(name, { name, optional: false })
  }
  for (const name of Object.keys(entry.optionalDependencies ?? {})) {
    edges.set(name, { name, optional: true })
  }
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    const optionalPeer = entry.peerDependenciesMeta?.[name]?.optional === true
    if (!optionalPeer && !edges.has(name)) {
      edges.set(name, { name, optional: false })
    }
  }
  return edges.values()
}

/**
 * The lockfile location `name` resolves to from `location`, following links, or null. Checks
 * `<dir>/node_modules/<name>` for the dependent's folder and each folder above it.
 */
function resolve(packages, location, name) {
  let directory = location
  while (true) {
    if (!isNodeModulesFolder(directory)) {
      const candidate = directory
        ? `${directory}/node_modules/${name}`
        : `node_modules/${name}`
      if (packages[candidate]) return followLink(packages, candidate)
    }
    if (directory === '') return null
    const parent = path.posix.dirname(directory)
    directory = parent === '.' ? '' : parent
  }
}

/** True for a `node_modules` folder or a scope folder in one, which hold no packages of their own. */
function isNodeModulesFolder(directory) {
  const base = path.posix.basename(directory)
  const parent = path.posix.basename(path.posix.dirname(directory))
  return (
    base === 'node_modules' ||
    (base.startsWith('@') && parent === 'node_modules')
  )
}

/** A link entry's target location (a workspace folder); any other location as is. */
function followLink(packages, location) {
  const entry = packages[location]
  if (!entry.link) return location
  return packages[entry.resolved] ? entry.resolved : location
}

/** The real path of `directory`, or the path itself when it cannot be resolved. */
function realpath(directory) {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}
