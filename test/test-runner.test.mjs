import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadProjectConfig } from '../src/project-config.mjs'
import { findTestFiles, runTests, testArguments } from '../src/test-runner.mjs'

const bin = fileURLToPath(new URL('../bin/devkit-test.mjs', import.meta.url))

/** Creates a temporary repo containing `files` (path to contents) and returns its root. */
function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-test-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

test('discovery walks every folder and skips dependencies, build output, submodules and dot-folders', (t) => {
  const root = fixture(t, {
    'apps/api/src/deep/nested/a.test.ts': '',
    'apps/web/src/b.test.tsx': '',
    'scripts/c.test.mjs': '',
    'test/d.test.mjs': '',
    'apps/api/src/helper.ts': '',
    'node_modules/pkg/e.test.mjs': '',
    'apps/web/dist/f.test.mjs': '',
    'external/kit/g.test.mjs': '',
    '.worktrees/fix/test/h.test.mjs': '',
    '.vite/i.test.mjs': '',
  })

  assert.deepEqual(findTestFiles({ root }), [
    'apps/api/src/deep/nested/a.test.ts',
    'apps/web/src/b.test.tsx',
    'scripts/c.test.mjs',
    'test/d.test.mjs',
  ])
})

test('ignore takes folder names at any depth and repo-relative folder paths', (t) => {
  const root = fixture(t, {
    'apps/mobile/android/a.test.mjs': '',
    'apps/api/test/b.test.ts': '',
    'apps/api/src/c.test.ts': '',
    'apps/api/testing/d.test.ts': '',
  })

  assert.deepEqual(
    findTestFiles({ root, ignore: ['android', 'apps/api/test/'] }),
    ['apps/api/src/c.test.ts', 'apps/api/testing/d.test.ts'],
  )
})

test('integration tests are split out by default, and the integration run takes only them', (t) => {
  const root = fixture(t, {
    'apps/api/src/a.test.ts': '',
    'apps/api/src/a.integration.test.ts': '',
    'apps/web/src/b.integration.test.tsx': '',
    'scripts/c.integration.test.mjs': '',
    'scripts/c.slow.test.mjs': '',
  })

  assert.deepEqual(findTestFiles({ root }), [
    'apps/api/src/a.test.ts',
    'scripts/c.slow.test.mjs',
  ])
  assert.deepEqual(findTestFiles({ root, skipSuffixes: ['.slow.test.mjs'] }), [
    'apps/api/src/a.test.ts',
  ])
  assert.deepEqual(
    findTestFiles({
      root,
      integration: true,
      skipSuffixes: ['.slow.test.mjs'],
    }),
    [
      'apps/api/src/a.integration.test.ts',
      'apps/web/src/b.integration.test.tsx',
      'scripts/c.integration.test.mjs',
    ],
  )
})

test('the integration run is serial, and finding none is a failure', (t) => {
  const root = fixture(t, {
    'db.integration.test.mjs': '',
    'unit.test.mjs': '',
  })
  const calls = []
  const status = runTests({
    root,
    integration: true,
    nodeArgs: ['--test-reporter=tap'],
    run: (command, args) => {
      calls.push(args)
      return { status: 0 }
    },
  })
  assert.equal(status, 0)
  assert.deepEqual(calls[0], [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    'db.integration.test.mjs',
  ])

  const unitOnly = fixture(t, { 'unit.test.mjs': '' })
  const messages = []
  assert.equal(
    runTests({
      root: unitOnly,
      integration: true,
      run: () => assert.fail('nothing should run'),
      log: (message) => messages.push(message),
    }),
    1,
  )
  assert.match(messages[0], /no integration test files found/)
})

test('symlinked folders are not followed, so linked checkouts are never walked', (t) => {
  const root = fixture(t, { 'packages/real/a.test.mjs': '' })
  symlinkSync(path.join(root, 'packages/real'), path.join(root, 'linked'))

  assert.deepEqual(findTestFiles({ root }), ['packages/real/a.test.mjs'])
})

test('paths narrow the search, and a path outside the repo or missing is an error', (t) => {
  const root = fixture(t, {
    'apps/api/a.test.ts': '',
    'apps/web/b.test.ts': '',
    'scripts/c.test.mjs': '',
  })

  assert.deepEqual(
    findTestFiles({ root, paths: ['apps/web', 'scripts/c.test.mjs'] }),
    ['apps/web/b.test.ts', 'scripts/c.test.mjs'],
  )
  assert.throws(
    () => findTestFiles({ root, paths: ['..'] }),
    /outside the repository/,
  )
  assert.throws(
    () => findTestFiles({ root, paths: ['apps/none'] }),
    /does not exist/,
  )
})

test('TypeScript tests add the tsx loader only when the app has it installed', (t) => {
  const plain = fixture(t, { 'package.json': '{}' })
  assert.deepEqual(testArguments({ root: plain, files: ['a.test.mjs'] }), [
    '--test',
    'a.test.mjs',
  ])
  assert.throws(
    () => testArguments({ root: plain, files: ['a.test.ts'] }),
    /need tsx/,
  )

  const withTsx = fixture(t, {
    'package.json': '{}',
    'node_modules/tsx/package.json': '{"name":"tsx","main":"index.js"}',
    'node_modules/tsx/index.js': '',
  })
  assert.deepEqual(
    testArguments({
      root: withTsx,
      files: ['a.test.ts'],
      nodeArgs: ['--test-concurrency=1'],
    }),
    ['--import', 'tsx', '--test', '--test-concurrency=1', 'a.test.ts'],
  )
})

test('a run with no test files fails instead of passing silently', (t) => {
  const root = fixture(t, { 'src/index.mjs': '' })
  const messages = []
  const status = runTests({
    root,
    run: () => assert.fail('nothing should run'),
    log: (message) => messages.push(message),
  })

  assert.equal(status, 1)
  assert.match(messages[0], /no test files found/)
})

test('tests run on the current Node with NODE_ENV defaulting to test', (t) => {
  const root = fixture(t, { 'a.test.mjs': '' })
  const calls = []
  const status = runTests({
    root,
    env: { PATH: '/bin' },
    execPath: '/opt/node/bin/node',
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    },
  })

  assert.equal(status, 0)
  assert.equal(calls[0].command, '/opt/node/bin/node')
  assert.deepEqual(calls[0].args, ['--test', 'a.test.mjs'])
  assert.equal(calls[0].options.cwd, root)
  assert.equal(calls[0].options.env.NODE_ENV, 'test')
})

test('test options in devkit.config.mjs are merged with the defaults and validated', async (t) => {
  const root = fixture(t, {
    'devkit.config.mjs':
      "export default { test: { skipSuffixes: ['.slow.test.ts'] } }\n",
  })
  const project = await loadProjectConfig(root)
  assert.deepEqual(project.test, {
    ignore: [],
    skipSuffixes: ['.slow.test.ts'],
  })

  const bad = fixture(t, {
    'devkit.config.mjs': "export default { test: { skipSuffixes: ['.ts'] } }\n",
  })
  await assert.rejects(loadProjectConfig(bad), /`test.skipSuffixes`/)
})

test('devkit-test runs without nvm or a bootstrapped machine, whatever .nvmrc says', (t) => {
  const empty = fixture(t, {})
  const root = fixture(t, {
    '.nvmrc': '20.0.0\n',
    'package.json': '{"type":"module"}',
    'a.test.mjs': "import test from 'node:test'\ntest('passes', () => {})\n",
  })

  const result = spawnSync(process.execPath, [bin], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NVM_DIR: empty,
      DEVKIT_CONFIG_DIR: empty,
    },
  })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /pass 1/)
})
