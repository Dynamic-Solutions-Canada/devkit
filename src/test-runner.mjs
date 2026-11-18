/**
 * Finds a project's `node --test` files by walking the tree, and runs them (TEST-5, D-050).
 *
 * Walking instead of listing folders or relying on shell globs is the point: a test added in a new
 * folder runs without anyone editing a script, and an unquoted `**` cannot silently match only
 * one level. The walk skips what never holds a project's own tests (dependencies, build output,
 * submodules under `external/`, worktrees under `.worktrees/`, and every other dot-folder), so a
 * kit's tests run in the kit's repo and not by accident in a consumer.
 *
 * This module has no side effects on import and needs no devkit machine setup: apps run it in CI
 * and in containers, where devkit itself is off. The `devkit-test` command is its entry point.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** File-name endings that mark a test file (TEST-1). */
export const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.test.mjs']

/**
 * File endings that mark a database-backed test (TEST-7). The unit run always leaves them out and
 * the integration run takes only them, so every test file belongs to exactly one suite.
 */
export const INTEGRATION_SUFFIXES = TEST_FILE_SUFFIXES.map(
  (suffix) => `.integration${suffix}`,
)

/** Folder names skipped at any depth. Folders starting with a dot are skipped as well. */
export const DEFAULT_IGNORED_DIRECTORIES = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  'external',
  'tmp',
]

const TYPESCRIPT_SUFFIXES = ['.ts', '.tsx']

/**
 * Splits `ignore` entries into folder names (matched at any depth) and repo-relative paths
 * (an entry containing a slash, matched as a prefix), so one list can say both `android` and
 * `apps/api/test`.
 */
function ignoreMatcher(ignore) {
  const names = new Set(DEFAULT_IGNORED_DIRECTORIES)
  const prefixes = []
  for (const entry of ignore) {
    const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized.includes('/')) prefixes.push(normalized)
    else names.add(normalized)
  }

  return (relativeDir, name) => {
    if (name.startsWith('.') || names.has(name)) return true
    const relative = relativeDir ? `${relativeDir}/${name}` : name
    return prefixes.some(
      (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
    )
  }
}

/**
 * Decides whether `name` belongs to the requested suite. The integration suite is exactly the
 * `*.integration.test.*` files; the unit suite is every other test file except `skipSuffixes`.
 */
function belongsToSuite(name, { integration, skipSuffixes }) {
  const isIntegration = INTEGRATION_SUFFIXES.some((suffix) =>
    name.endsWith(suffix),
  )
  if (integration) return isIntegration
  if (isIntegration) return false
  if (skipSuffixes.some((suffix) => name.endsWith(suffix))) return false
  return TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * Returns every test file under `root`, as sorted repo-relative paths with forward slashes.
 *
 * @param {object} options
 * @param {string} options.root Repo root the paths are relative to.
 * @param {string[]} [options.paths] Folders or files to search instead of the whole repo, for
 *   `test:<target>` scripts. A named file is included even if its folder would be ignored.
 * @param {string[]} [options.ignore] Extra folder names, or repo-relative folder paths, to skip.
 * @param {boolean} [options.integration] Find only `*.integration.test.*` files instead of the
 *   unit tests.
 * @param {string[]} [options.skipSuffixes] Extra file endings the unit run leaves out, such as
 *   `.integration.test.ts` for tests that need a database.
 * Symlinked folders are not followed, so a linked checkout or package is never walked twice.
 */
export function findTestFiles({
  root,
  paths = ['.'],
  ignore = [],
  skipSuffixes = [],
  integration = false,
}) {
  const isIgnored = ignoreMatcher(ignore)
  const found = new Set()

  /** Walks one folder, given as a path relative to `root` ('' for the root itself). */
  function walk(relativeDir) {
    const entries = readdirSync(path.join(root, relativeDir), {
      withFileTypes: true,
    })
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!isIgnored(relativeDir, entry.name)) walk(relative)
      } else if (
        entry.isFile() &&
        belongsToSuite(entry.name, { integration, skipSuffixes })
      ) {
        found.add(relative)
      }
    }
  }

  for (const requested of paths) {
    const relative = path
      .relative(root, path.resolve(root, requested))
      .replace(/\\/g, '/')
    if (relative.startsWith('..')) {
      throw new Error(`devkit-test: ${requested} is outside the repository`)
    }
    const stats = statSync(path.join(root, relative), {
      throwIfNoEntry: false,
    })
    if (!stats) throw new Error(`devkit-test: ${requested} does not exist`)
    if (stats.isDirectory()) walk(relative)
    else found.add(relative)
  }

  return [...found].sort()
}

/**
 * Builds the `node --test` arguments for `files`. TypeScript files need the `tsx` loader, which
 * must be installed in the app: devkit never depends on it, so a missing loader is reported
 * instead of being papered over.
 */
export function testArguments({ root, files, nodeArgs = [] }) {
  const needsTsx = files.some((file) =>
    TYPESCRIPT_SUFFIXES.some((suffix) => file.endsWith(suffix)),
  )
  if (needsTsx) {
    try {
      createRequire(path.join(root, 'package.json')).resolve('tsx')
    } catch {
      throw new Error(
        'devkit-test: TypeScript tests need tsx; add it as a dev dependency of the app',
      )
    }
  }

  return [
    ...(needsTsx ? ['--import', 'tsx'] : []),
    '--test',
    ...nodeArgs,
    ...files,
  ]
}

/**
 * Discovers and runs one suite, returning the exit status. `integration` selects the
 * `*.integration.test.*` files and runs them one file at a time. Finding no test at all is a failure,
 * because a suite that silently passes with nothing in it is the defect TEST-5 exists to stop.
 */
export function runTests({
  root,
  paths,
  ignore,
  skipSuffixes,
  integration = false,
  nodeArgs = [],
  env = process.env,
  execPath = process.execPath,
  run = spawnSync,
  log = console.error,
}) {
  const files = findTestFiles({
    root,
    paths,
    ignore,
    skipSuffixes,
    integration,
  })
  if (files.length === 0) {
    log(`devkit-test: no ${integration ? 'integration ' : ''}test files found`)
    return 1
  }

  // Database tests share one database, so they run one file at a time.
  const suiteArgs = integration ? ['--test-concurrency=1'] : []
  const result = run(
    execPath,
    testArguments({ root, files, nodeArgs: [...suiteArgs, ...nodeArgs] }),
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...env, NODE_ENV: env.NODE_ENV ?? 'test' },
    },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}
