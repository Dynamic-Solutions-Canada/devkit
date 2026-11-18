import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkTemplates,
  templateWarnings,
  writeTemplates,
} from '../src/app-templates.mjs'

const bin = fileURLToPath(new URL('../bin/devkit-init.mjs', import.meta.url))
const runnerTemplate = fileURLToPath(
  new URL('../templates/run-dev.mjs', import.meta.url),
)
const ALL = { runner: true, paseo: true, scripts: true }

/** Creates a temporary app containing `files` (path to contents) and returns its root. */
function app(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-init-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      typeof contents === 'string'
        ? contents
        : `${JSON.stringify(contents, null, 2)}\n`,
    )
  }
  return root
}

const read = (root, relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (root, relative) => JSON.parse(read(root, relative))

test('a fresh app gets the runner, lifecycle scripts, paseo.json and a first compose file', (t) => {
  const root = app(t, {
    'package.json': {
      name: 'app',
      scripts: {
        build: 'vite build',
        validate: 'npm test',
        test: 'devkit-test',
      },
    },
  })

  assert.deepEqual(writeTemplates({ root, generated: ALL }).sort(), [
    'compose.dev.yml',
    'package.json',
    'paseo.json',
    'scripts/dev/run-dev.mjs',
  ])
  assert.equal(
    read(root, 'scripts/dev/run-dev.mjs'),
    readFileSync(runnerTemplate, 'utf8'),
  )

  const scripts = readJson(root, 'package.json').scripts
  assert.equal(scripts.dev, 'devkit run node scripts/dev/run-dev.mjs')
  assert.equal(scripts['dev:down'], 'npm run dev -- --down')
  assert.equal(
    scripts['dev:prepare-worktree'],
    'devkit prepare && npm run --if-present dev:postprepare',
  )
  assert.equal(scripts.build, 'vite build')

  const paseo = readJson(root, 'paseo.json')
  assert.match(paseo.worktree.teardown, /cleanup --paseo --yes$/)
  assert.deepEqual(Object.keys(paseo.scripts), [
    'dev',
    'dev-background',
    'dev-down',
    'dev-prepare-worktree',
    'dev-doctor',
    'validate',
    'test',
    'build',
  ])
  assert.match(paseo.scripts.test.command, /devkit\.mjs run npm test$/)

  // Running it again changes nothing, and the check agrees.
  assert.deepEqual(writeTemplates({ root, generated: ALL }), [])
  assert.deepEqual(checkTemplates({ root, generated: ALL }), [])
})

test('app-owned scripts and paseo keys survive, and only owned values are replaced', (t) => {
  const root = app(t, {
    'package.json': {
      scripts: {
        'dev:down': 'something old',
        'dev:fresh': 'devkit run node scripts/dev/run-dev.mjs --fresh',
        'dev:container': 'node scripts/dev/container.mjs',
      },
    },
    'paseo.json': {
      worktree: { setup: 'old setup', note: 'kept' },
      scripts: { 'dev-db': { command: 'npm run dev:db' } },
    },
  })
  writeTemplates({ root, generated: ALL })

  const scripts = readJson(root, 'package.json').scripts
  assert.equal(scripts['dev:down'], 'npm run dev -- --down')
  assert.equal(
    scripts['dev:fresh'],
    'devkit run node scripts/dev/run-dev.mjs --fresh',
  )
  assert.equal(scripts['dev:container'], 'node scripts/dev/container.mjs')

  const paseo = readJson(root, 'paseo.json')
  assert.equal(paseo.worktree.note, 'kept')
  assert.match(paseo.worktree.setup, /npm run dev:prepare-worktree$/)
  assert.deepEqual(paseo.scripts['dev-db'], { command: 'npm run dev:db' })
})

test("an existing compose.dev.yml is the app's and is never rewritten or checked", (t) => {
  const root = app(t, {
    'package.json': { scripts: {} },
    'compose.dev.yml': 'services: {}\n',
  })
  assert.ok(
    !writeTemplates({ root, generated: ALL }).includes('compose.dev.yml'),
  )
  assert.equal(read(root, 'compose.dev.yml'), 'services: {}\n')
})

test('the check reports drift in owned outputs and ignores JSON layout', (t) => {
  const root = app(t, { 'package.json': { scripts: {} } })
  writeTemplates({ root, generated: ALL })

  // Reformatting JSON is not drift.
  const pkg = readJson(root, 'package.json')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  assert.deepEqual(checkTemplates({ root, generated: ALL }), [])

  // Hand edits to the runner, an owned script or an owned paseo entry are.
  writeFileSync(path.join(root, 'scripts/dev/run-dev.mjs'), '// edited\n')
  pkg.scripts['dev:doctor'] = 'edited'
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  const paseo = readJson(root, 'paseo.json')
  delete paseo.scripts['dev-down']
  writeFileSync(path.join(root, 'paseo.json'), JSON.stringify(paseo))

  assert.deepEqual(checkTemplates({ root, generated: ALL }).sort(), [
    'package.json',
    'paseo.json',
    'scripts/dev/run-dev.mjs',
  ])
})

test('opt-outs keep a hand-written runner, its dev script and compose file out of the plan', (t) => {
  const root = app(t, {
    'package.json': { scripts: { dev: 'node scripts/dev/custom.mjs' } },
  })
  const generated = { runner: false, paseo: true, scripts: true }
  writeTemplates({ root, generated })

  assert.ok(!existsSync(path.join(root, 'scripts/dev/run-dev.mjs')))
  assert.ok(!existsSync(path.join(root, 'compose.dev.yml')))
  assert.equal(
    readJson(root, 'package.json').scripts.dev,
    'node scripts/dev/custom.mjs',
  )
  assert.deepEqual(checkTemplates({ root, generated }), [])
  assert.deepEqual(templateWarnings({ root, generated }), [])
})

test('the app is told when the runner has no dev:container script to hand over to', (t) => {
  const root = app(t, { 'package.json': { scripts: {} } })
  assert.match(templateWarnings({ root, generated: ALL })[0], /dev:container/)
})

test('devkit-init --check fails on drift and passes once devkit-init has run', (t) => {
  const empty = app(t, {})
  const root = app(t, { 'package.json': { scripts: {} } })
  const env = {
    PATH: process.env.PATH,
    NVM_DIR: empty,
    DEVKIT_CONFIG_DIR: empty,
  }
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
    })

  const before = run('--check')
  assert.equal(before.status, 1)
  assert.match(before.stderr, /scripts\/dev\/run-dev\.mjs/)

  assert.equal(run().status, 0)
  const after = run('--check')
  assert.equal(after.status, 0, after.stderr)
})

test('the runner template is valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', runnerTemplate], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})

test('generated opt-outs in devkit.config.mjs merge with the defaults and are validated', async (t) => {
  const { loadProjectConfig } = await import('../src/project-config.mjs')
  const root = app(t, {
    'devkit.config.mjs': 'export default { generated: { runner: false } }\n',
  })
  assert.deepEqual((await loadProjectConfig(root)).generated, {
    runner: false,
    paseo: true,
    scripts: true,
  })

  const bad = app(t, {
    'devkit.config.mjs': 'export default { generated: { compose: false } }\n',
  })
  await assert.rejects(loadProjectConfig(bad), /`generated` may set only/)
})
