import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

/**
 * A temporary repo with a fake `npm`. `npm ls` prints the folders listed in `npm-ls.json` in its
 * working folder, under the `--workspace` value it was given (or `.` for a standalone package),
 * and appends its working folder and arguments to `npm-calls`.
 */
function repo(t) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'devkit-notices-')),
  )
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const npm = path.join(root, '.bin/npm')
  write(
    root,
    '.bin/npm',
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(path.join(root, 'npm-calls'))}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n')
const at = args.indexOf('--workspace')
const tree = JSON.parse(readFileSync('npm-ls.json', 'utf8'))
const dirs = tree[at === -1 ? '.' : args[at + 1]]
if (!dirs) { console.error('npm error missing: tree'); process.exit(1) }
console.log(dirs.map((dir) => require('node:path').resolve(dir)).join('\\n'))
`,
    0o755,
  )
  return { root, npm }
}

/** Writes `contents` at `file` under `root`, creating its folder. */
function write(root, file, contents, mode) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents, mode ? { mode } : undefined)
}

/** Installs a package under `node_modules` with a manifest and optional files. */
function installed(root, at, manifest, files = {}) {
  write(root, path.join(at, 'package.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    write(root, path.join(at, name), text)
  }
  return at
}

const webDeliverable = {
  title: 'Example web app',
  packages: ['apps/web'],
  output: 'apps/web/public/THIRD-PARTY-NOTICES.txt',
}

test('a deliverable lists its third-party closure once each, sorted, without its own packages', (t) => {
  const { root, npm } = repo(t)
  write(root, 'apps/web/package.json', '{"name":"@example/web"}')
  write(root, 'packages/shared/package.json', '{"name":"@example/shared"}')
  const zed = installed(
    root,
    'node_modules/zed',
    {
      name: 'zed',
      version: '1.0.0',
      license: 'MIT',
      author: { name: 'Zed', email: 'z@example.com' },
      repository: { url: 'git+https://example.com/zed.git' },
    },
    { LICENSE: 'MIT text\r\nline two\r\n' },
  )
  const alpha = installed(
    root,
    'node_modules/Alpha',
    {
      name: 'Alpha',
      version: '2.0.0',
      licenses: [{ type: 'BSD-3-Clause' }],
    },
    { 'LICENSE.md': 'long', LICENSE: 'short', NOTICE: 'notice' },
  )
  const nestedZed = installed(root, 'node_modules/Alpha/node_modules/zed', {
    name: 'zed',
    version: '1.0.0',
    license: 'MIT',
  })
  write(
    root,
    'npm-ls.json',
    JSON.stringify({
      'apps/web': ['.', 'apps/web', 'packages/shared', zed, alpha, nestedZed],
    }),
  )

  const [planned] = planNotices(root, [webDeliverable], { npm })
  assert.equal(planned.count, 2)
  const text = planned.text
  assert.ok(
    text.indexOf('Alpha@2.0.0') < text.indexOf('zed@1.0.0'),
    'code-point order puts capitals first',
  )
  assert.doesNotMatch(text, /@example\//)
  assert.doesNotMatch(text, new RegExp(root.replaceAll('/', '\\/')))
  assert.match(text, /License: BSD-3-Clause OR|License: BSD-3-Clause\n/)
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

test('a folder with its own lockfile runs npm ls there, without --workspace', (t) => {
  const { root, npm } = repo(t)
  write(root, 'tools/agent/package-lock.json', '{}')
  const dep = installed(root, 'tools/agent/node_modules/dep', {
    name: 'dep',
    version: '1.0.0',
    license: 'ISC',
  })
  write(
    root,
    'tools/agent/npm-ls.json',
    JSON.stringify({ '.': ['.', path.join(root, dep)] }),
  )

  const [planned] = planNotices(
    root,
    [
      {
        title: 'Agent',
        packages: ['tools/agent'],
        output: 'tools/agent/NOTICES.txt',
      },
    ],
    { npm },
  )
  assert.equal(planned.count, 1)
  const [call] = readFileSync(path.join(root, 'npm-calls'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(call.cwd, path.join(root, 'tools/agent'))
  assert.ok(!call.args.includes('--workspace'))
})

test('SEE LICENSE IN reads the named file', (t) => {
  const { root, npm } = repo(t)
  const dep = installed(
    root,
    'node_modules/vendor',
    {
      name: 'vendor',
      version: '1.0.0',
      license: 'SEE LICENSE IN EULA.txt',
    },
    { 'EULA.txt': 'vendor terms' },
  )
  write(root, 'npm-ls.json', JSON.stringify({ 'apps/web': [dep] }))

  const [planned] = planNotices(root, [webDeliverable], { npm })
  assert.match(planned.text, /----- EULA\.txt -----\nvendor terms/)
})

test('packages with no usable licence fail, and allow excuses only names in the closure', (t) => {
  const { root, npm } = repo(t)
  const bare = installed(root, 'node_modules/bare', {
    name: 'bare',
    version: '1.0.0',
  })
  const privateDep = installed(root, 'node_modules/private', {
    name: 'private',
    version: '1.0.0',
    license: 'UNLICENSED',
  })
  const withFile = installed(
    root,
    'node_modules/with-file',
    {
      name: 'with-file',
      version: '1.0.0',
    },
    { COPYING: 'terms' },
  )
  write(
    root,
    'npm-ls.json',
    JSON.stringify({ 'apps/web': [bare, privateDep, withFile] }),
  )

  assert.throws(
    () => planNotices(root, [webDeliverable], { npm }),
    (error) =>
      /bare@1\.0\.0 declares no licence and ships no licence file/.test(
        error.message,
      ) &&
      /private@1\.0\.0 is UNLICENSED/.test(error.message) &&
      !/with-file/.test(error.message),
  )
  assert.doesNotThrow(() =>
    planNotices(root, [{ ...webDeliverable, allow: ['bare', 'private'] }], {
      npm,
    }),
  )
  assert.throws(
    () =>
      planNotices(
        root,
        [{ ...webDeliverable, allow: ['bare', 'private', 'gone'] }],
        { npm },
      ),
    /`allow` lists gone, which is not in this deliverable's dependencies/,
  )
})

test('a failing npm ls stops the run with its message', (t) => {
  const { root, npm } = repo(t)
  write(root, 'npm-ls.json', '{}')
  assert.throws(
    () => planNotices(root, [webDeliverable], { npm }),
    /npm ls failed for apps\/web; install its dependencies first\.\nnpm error missing: tree/,
  )
})

test('check names a missing or stale file and passes after a write', (t) => {
  const { root, npm } = repo(t)
  const dep = installed(root, 'node_modules/dep', {
    name: 'dep',
    version: '1.0.0',
    license: 'MIT',
  })
  write(root, 'npm-ls.json', JSON.stringify({ 'apps/web': [dep] }))

  assert.deepEqual(checkNotices(root, [webDeliverable], { npm }), [
    webDeliverable.output,
  ])
  writeNotices(root, [webDeliverable], { npm })
  assert.deepEqual(checkNotices(root, [webDeliverable], { npm }), [])

  installed(root, 'node_modules/dep', {
    name: 'dep',
    version: '1.0.1',
    license: 'MIT',
  })
  assert.deepEqual(checkNotices(root, [webDeliverable], { npm }), [
    webDeliverable.output,
  ])
})

test('the notices block is validated', async (t) => {
  const { root } = repo(t)
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

test('devkit-notices writes from devkit.config.mjs and --check fails on drift', (t) => {
  const { root } = repo(t)
  const dep = installed(root, 'node_modules/dep', {
    name: 'dep',
    version: '1.0.0',
    license: 'MIT',
  })
  write(root, 'npm-ls.json', JSON.stringify({ 'apps/web': [dep] }))
  write(
    root,
    'devkit.config.mjs',
    `export default { notices: ${JSON.stringify([webDeliverable])} }`,
  )
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, '.bin')}:${process.env.PATH}`,
      },
    })

  assert.equal(run('--check').status, 1)
  const written = run()
  assert.equal(written.status, 0, written.stderr)
  assert.match(
    written.stdout,
    /apps\/web\/public\/THIRD-PARTY-NOTICES\.txt \(1 packages\)/,
  )
  assert.equal(run('--check').status, 0)
})

test('--only processes just the named deliverables and refuses an unknown output', (t) => {
  const { root } = repo(t)
  const dep = installed(root, 'node_modules/dep', {
    name: 'dep',
    version: '1.0.0',
    license: 'MIT',
  })
  // The Linux deliverable's closure is not installed, as in a CI job that installs only the root.
  write(root, 'npm-ls.json', JSON.stringify({ 'apps/web': [dep] }))
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
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, '.bin')}:${process.env.PATH}`,
      },
    })

  assert.equal(run().status, 1, 'all deliverables need the Linux closure')
  const only = ['--only', webDeliverable.output]
  assert.equal(run(...only).status, 0)
  assert.equal(run('--check', ...only).status, 0)

  const unknown = run('--check', '--only', 'apps/nope.txt')
  assert.equal(unknown.status, 1)
  assert.match(
    unknown.stderr,
    /--only apps\/nope\.txt matches no deliverable's output/,
  )
  assert.match(run('--only').stderr, /--only needs an output path/)
  assert.match(run('--chek').stderr, /unknown argument --chek/)
})
