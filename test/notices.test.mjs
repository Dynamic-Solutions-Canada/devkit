import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkNotices,
  planNotices,
  writeNotices,
} from '../src/notices/index.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'

const devkitRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = path.join(devkitRoot, 'bin/devkit-notices.mjs')

/** A temporary repo folder, removed after the test. */
function tempRoot(t) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'devkit-notices-')),
  )
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Writes `contents` at `file` under `root`, creating its folder. */
function write(root, file, contents) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

/**
 * Installs the given packages and writes the lockfile that records them, as npm would. `packages`
 * maps each lockfile location to `{ lock, manifest, files }`: `lock` is the lockfile entry,
 * `manifest` the installed `package.json` (none for a package left uninstalled), and `files` any
 * licence files. `at` is the folder holding the lockfile.
 */
function install(root, packages, { at = '', lockfileVersion = 3 } = {}) {
  const entries = {}
  for (const [location, { lock = {}, manifest, files = {} }] of Object.entries(
    packages,
  )) {
    entries[location] = lock
    if (!manifest) continue
    const folder = path.join(root, at, location)
    write(folder, 'package.json', JSON.stringify(manifest))
    for (const [name, text] of Object.entries(files)) write(folder, name, text)
  }
  write(
    root,
    path.join(at, 'package-lock.json'),
    JSON.stringify({ lockfileVersion, packages: entries }),
  )
}

/** A third-party package: its lockfile entry and installed manifest, MIT unless overridden. */
function dependency(name, version, { lock = {}, manifest = {}, files } = {}) {
  return {
    lock: { version, ...lock },
    manifest: { name, version, license: 'MIT', ...manifest },
    files,
  }
}

/** A monorepo with an `apps/web` workspace depending on `dependencies`, plus `packages`. */
function webRepo(t, webLock, packages = {}) {
  const root = tempRoot(t)
  install(root, {
    '': {
      lock: { name: 'example', workspaces: ['apps/*'] },
      manifest: { name: 'example' },
    },
    'apps/web': { lock: webLock, manifest: { name: '@example/web' } },
    'node_modules/@example/web': {
      lock: { resolved: 'apps/web', link: true },
    },
    ...packages,
  })
  return root
}

/** The `name@version` entries a deliverable lists, in order. */
function listed(root, deliverable = webDeliverable) {
  const [planned] = planNotices(root, [deliverable])
  return [...planned.text.matchAll(/^-{78}\n(\S+)$/gm)].map((match) => match[1])
}

const webDeliverable = {
  title: 'Example web app',
  packages: ['apps/web'],
  output: 'apps/web/public/THIRD-PARTY-NOTICES.txt',
}

test('a deliverable lists its third-party closure once each, sorted, without its own packages', (t) => {
  const root = webRepo(
    t,
    { dependencies: { zed: '^1', Alpha: '^2', '@example/shared': '*' } },
    {
      'packages/shared': {
        lock: { dependencies: { zed: '^1' } },
        manifest: { name: '@example/shared' },
      },
      'node_modules/@example/shared': {
        lock: { resolved: 'packages/shared', link: true },
      },
      'node_modules/zed': dependency('zed', '1.0.0', {
        manifest: {
          author: { name: 'Zed', email: 'z@example.com' },
          repository: { url: 'git+https://example.com/zed.git' },
        },
        files: { LICENSE: 'MIT text\r\nline two\r\n' },
      }),
      'node_modules/Alpha': dependency('Alpha', '2.0.0', {
        lock: { dependencies: { zed: '^1' } },
        manifest: { license: undefined, licenses: [{ type: 'BSD-3-Clause' }] },
        files: { 'LICENSE.md': 'long', LICENSE: 'short', NOTICE: 'notice' },
      }),
      'node_modules/Alpha/node_modules/zed': dependency('zed', '1.0.0'),
    },
  )

  const [planned] = planNotices(root, [webDeliverable])
  assert.equal(planned.count, 2)
  const text = planned.text
  assert.deepEqual(listed(root), ['Alpha@2.0.0', 'zed@1.0.0'])
  assert.doesNotMatch(text, /@example\//)
  assert.doesNotMatch(text, new RegExp(root.replaceAll('/', '\\/')))
  assert.match(text, /License: BSD-3-Clause\n/)
  assert.match(
    text,
    /Publisher: Zed <z@example\.com>\nRepository: https:\/\/example\.com\/zed\n/,
  )
  assert.match(text, /----- LICENSE -----\nMIT text\nline two/)
  assert.doesNotMatch(text, /\r/)
  assert.ok(
    text.indexOf('----- LICENSE -----\nshort') <
      text.indexOf('----- LICENSE.md -----'),
    'shortest licence file name first',
  )
  assert.match(text, /Licenses:\n {5}1 {2}BSD-3-Clause\n {5}1 {2}MIT\n/)
})

test('an optional peer counts only when a shipped dependency also needs it', (t) => {
  // i18next declares typescript as an optional peer; the repo installs typescript for its build.
  const i18next = dependency('i18next', '26.0.0', {
    lock: {
      peerDependencies: { typescript: '*' },
      peerDependenciesMeta: { typescript: { optional: true } },
    },
  })
  const typescript = dependency('typescript', '6.0.3', {
    lock: { devOptional: true },
    manifest: { license: 'Apache-2.0' },
  })
  const devOnly = webRepo(
    t,
    { dependencies: { i18next: '^26' }, devDependencies: { typescript: '^6' } },
    { 'node_modules/i18next': i18next, 'node_modules/typescript': typescript },
  )
  assert.deepEqual(listed(devOnly), ['i18next@26.0.0'])

  // A shipped package that needs typescript itself brings it in.
  const shipped = webRepo(
    t,
    { dependencies: { i18next: '^26', compiler: '^1' } },
    {
      'node_modules/i18next': i18next,
      'node_modules/typescript': typescript,
      'node_modules/compiler': dependency('compiler', '1.0.0', {
        lock: { dependencies: { typescript: '^6' } },
      }),
    },
  )
  assert.deepEqual(listed(shipped), [
    'compiler@1.0.0',
    'i18next@26.0.0',
    'typescript@6.0.3',
  ])
})

test('required peers ship, dev dependencies never do, and missing optional dependencies are skipped', (t) => {
  const root = webRepo(
    t,
    {
      dependencies: { 'react-dom': '^18', bundler: '^1' },
      devDependencies: { linter: '^9' },
    },
    {
      'node_modules/react-dom': dependency('react-dom', '18.3.1', {
        lock: { peerDependencies: { react: '^18' } },
      }),
      'node_modules/react': dependency('react', '18.3.1'),
      'node_modules/linter': dependency('linter', '9.0.0', {
        lock: { dev: true },
      }),
      'node_modules/bundler': dependency('bundler', '1.0.0', {
        lock: {
          optionalDependencies: {
            '@bundler/linux-x64': '1.0.0',
            '@bundler/darwin-arm64': '1.0.0',
          },
        },
      }),
      'node_modules/@bundler/linux-x64': dependency(
        '@bundler/linux-x64',
        '1.0.0',
        {
          lock: { optional: true },
        },
      ),
      // Recorded in the lockfile but not installed: built for another platform.
      'node_modules/@bundler/darwin-arm64': {
        lock: { version: '1.0.0', optional: true },
      },
    },
  )
  assert.deepEqual(listed(root), [
    '@bundler/linux-x64@1.0.0',
    'bundler@1.0.0',
    'react@18.3.1',
    'react-dom@18.3.1',
  ])
})

test('the nearest installed copy wins, and overrides and npm: aliases list what is installed', (t) => {
  const root = webRepo(
    t,
    // `legacy` is an npm: alias; `ms` is pinned by an override to 2.1.3 at the top level.
    { dependencies: { app: '^1', legacy: 'npm:typescript@5.9.3', ms: '^2' } },
    {
      'node_modules/app': dependency('app', '1.0.0', {
        lock: { dependencies: { ms: '^2' } },
      }),
      'node_modules/app/node_modules/ms': dependency('ms', '2.0.0'),
      'node_modules/ms': dependency('ms', '2.1.3'),
      'node_modules/legacy': dependency('typescript', '5.9.3', {
        lock: { name: 'typescript' },
        manifest: { license: 'Apache-2.0' },
      }),
    },
  )
  assert.deepEqual(listed(root), [
    'app@1.0.0',
    'ms@2.0.0',
    'ms@2.1.3',
    'typescript@5.9.3',
  ])
})

test('a folder with its own lockfile walks that lockfile from its root', (t) => {
  const root = tempRoot(t)
  install(
    root,
    {
      '': { lock: { name: 'agent', dependencies: { dep: '^1' } } },
      'node_modules/dep': dependency('dep', '1.0.0', {
        manifest: { license: 'ISC' },
      }),
    },
    { at: 'tools/agent' },
  )
  const agent = {
    title: 'Agent',
    packages: ['tools/agent'],
    output: 'tools/agent/NOTICES.txt',
  }
  assert.deepEqual(listed(root, agent), ['dep@1.0.0'])
})

test('SEE LICENSE IN reads the named file', (t) => {
  const root = webRepo(
    t,
    { dependencies: { vendor: '^1' } },
    {
      'node_modules/vendor': dependency('vendor', '1.0.0', {
        manifest: { license: 'SEE LICENSE IN EULA.txt' },
        files: { 'EULA.txt': 'vendor terms' },
      }),
    },
  )
  const [planned] = planNotices(root, [webDeliverable])
  assert.match(planned.text, /----- EULA\.txt -----\nvendor terms/)
})

test('packages with no usable licence fail, and allow excuses only names in the closure', (t) => {
  const root = webRepo(
    t,
    { dependencies: { bare: '1', private: '1', 'with-file': '1' } },
    {
      'node_modules/bare': dependency('bare', '1.0.0', {
        manifest: { license: undefined },
      }),
      'node_modules/private': dependency('private', '1.0.0', {
        manifest: { license: 'UNLICENSED' },
      }),
      'node_modules/with-file': dependency('with-file', '1.0.0', {
        manifest: { license: undefined },
        files: { COPYING: 'terms' },
      }),
    },
  )

  assert.throws(
    () => planNotices(root, [webDeliverable]),
    (error) =>
      /bare@1\.0\.0 declares no licence and ships no licence file/.test(
        error.message,
      ) &&
      /private@1\.0\.0 is UNLICENSED/.test(error.message) &&
      !/with-file/.test(error.message),
  )
  assert.doesNotThrow(() =>
    planNotices(root, [{ ...webDeliverable, allow: ['bare', 'private'] }]),
  )
  assert.throws(
    () =>
      planNotices(root, [
        { ...webDeliverable, allow: ['bare', 'private', 'gone'] },
      ]),
    /`allow` lists gone, which is not in this deliverable's dependencies/,
  )
})

test('a missing lockfile, an old one, an unknown workspace or a missing dependency stops the run', (t) => {
  const empty = tempRoot(t)
  assert.throws(
    () => planNotices(empty, [webDeliverable]),
    /package-lock\.json is missing; run npm install/,
  )

  const old = tempRoot(t)
  write(old, 'package-lock.json', JSON.stringify({ lockfileVersion: 1 }))
  assert.throws(
    () => planNotices(old, [webDeliverable]),
    /lockfileVersion 1; regenerate it with npm 7 or later/,
  )

  const elsewhere = webRepo(t, {})
  assert.throws(
    () =>
      planNotices(elsewhere, [{ ...webDeliverable, packages: ['apps/api'] }]),
    /apps\/api is not a workspace in package-lock\.json/,
  )

  const missing = webRepo(t, { dependencies: { gone: '^1' } })
  assert.throws(
    () => planNotices(missing, [webDeliverable]),
    /gone, needed by apps\/web, is not installed; run npm ci/,
  )
})

test('check names a missing or stale file and passes after a write', (t) => {
  const packages = (version) => ({
    'node_modules/dep': dependency('dep', version),
  })
  const root = webRepo(t, { dependencies: { dep: '^1' } }, packages('1.0.0'))

  assert.deepEqual(checkNotices(root, [webDeliverable]), [
    webDeliverable.output,
  ])
  writeNotices(root, [webDeliverable])
  assert.deepEqual(checkNotices(root, [webDeliverable]), [])

  write(
    root,
    'node_modules/dep/package.json',
    JSON.stringify(packages('1.0.1')['node_modules/dep'].manifest),
  )
  assert.deepEqual(checkNotices(root, [webDeliverable]), [
    webDeliverable.output,
  ])
})

test('the notices block is validated', async (t) => {
  const root = tempRoot(t)
  let count = 0
  const load = (notices) => {
    // A new folder per load, because ESM caches a module by its path.
    const folder = path.join(root, `config-${(count += 1)}`)
    write(
      folder,
      'devkit.config.mjs',
      `export default { notices: ${JSON.stringify(notices)} }`,
    )
    return loadProjectConfig(folder)
  }
  await assert.rejects(load({}), /`notices` must be an array/)
  await assert.rejects(
    load([{ ...webDeliverable, extra: 1 }]),
    /notices\[0\]`\.extra is not a notices setting/,
  )
  await assert.rejects(
    load([{ ...webDeliverable, packages: [] }]),
    /packages must be a non-empty array/,
  )
  await assert.rejects(
    load([{ ...webDeliverable, output: '../out.txt' }]),
    /output must be a repo-relative path/,
  )
  await assert.rejects(
    load([webDeliverable, webDeliverable]),
    /is written by another deliverable/,
  )
  await assert.rejects(
    load([{ ...webDeliverable, allow: [''] }]),
    /allow must be an array of package names/,
  )
})

/** Runs the devkit-notices command in `root`. */
function run(root, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('devkit-notices writes from devkit.config.mjs and --check fails on drift', (t) => {
  const root = webRepo(
    t,
    { dependencies: { dep: '^1' } },
    { 'node_modules/dep': dependency('dep', '1.0.0') },
  )
  write(
    root,
    'devkit.config.mjs',
    `export default { notices: ${JSON.stringify([webDeliverable])} }`,
  )

  assert.equal(run(root, '--check').status, 1)
  const written = run(root)
  assert.equal(written.status, 0, written.stderr)
  assert.match(
    written.stdout,
    /apps\/web\/public\/THIRD-PARTY-NOTICES\.txt \(1 packages\)/,
  )
  assert.equal(run(root, '--check').status, 0)
})

test('--only processes just the named deliverables and refuses an unknown output', (t) => {
  // The Linux deliverable's dependency is not installed, as in a CI job that installs only the root.
  const root = webRepo(
    t,
    { dependencies: { dep: '^1' } },
    {
      'node_modules/dep': dependency('dep', '1.0.0'),
      'apps/linux': {
        lock: { dependencies: { electron: '^30' } },
        manifest: { name: '@example/linux' },
      },
    },
  )
  const linux = {
    title: 'Linux app',
    packages: ['apps/linux'],
    output: 'apps/linux/NOTICES.txt',
  }
  write(
    root,
    'devkit.config.mjs',
    `export default { notices: ${JSON.stringify([webDeliverable, linux])} }`,
  )

  assert.equal(run(root).status, 1, 'all deliverables need the Linux closure')
  const only = ['--only', webDeliverable.output]
  assert.equal(run(root, ...only).status, 0)
  assert.equal(run(root, '--check', ...only).status, 0)

  const unknown = run(root, '--check', '--only', 'apps/nope.txt')
  assert.equal(unknown.status, 1)
  assert.match(
    unknown.stderr,
    /--only apps\/nope\.txt matches no deliverable's output/,
  )
  assert.match(run(root, '--only').stderr, /--only needs an output path/)
  assert.match(run(root, '--chek').stderr, /unknown argument --chek/)
})
