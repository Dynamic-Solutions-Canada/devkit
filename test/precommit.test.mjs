import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkStaged,
  forbiddenName,
  parseOptions,
  parseSize,
} from '../src/precommit.mjs'

const bin = fileURLToPath(
  new URL('../bin/devkit-precommit.mjs', import.meta.url),
)
// Built at run time so this test file is not itself a staged private key to any scanner.
const PEM = (edge) => `-----${edge} OPENSSH PRIVATE ${'KEY'}-----`
const KEY = [PEM('BEGIN'), 'b3BlbnNzaC1rZXktdjE=', PEM('END')].join('\n')

/** A temporary git repo; `stage` writes files and adds them to the index. */
function repo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-precommit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const stage = (files) => {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), contents)
    }
    git('add', '--', ...Object.keys(files))
  }
  return { root, git, stage }
}

const defaults = () => parseOptions([])
const files = (problems) => problems.map(({ file }) => file).sort()

test('signing material, environment files and .secrets/ are refused by name', () => {
  for (const file of [
    'cert.pfx',
    'a/b.P12',
    'release.jks',
    'x.der',
    'x.cer',
    'app/release.keystore',
    '.env',
    'apps/api/.env.local',
    '.secrets/token',
    'a/.secrets/b/c.txt',
  ]) {
    assert.ok(forbiddenName(file), file)
  }
  for (const file of [
    '.env.example',
    '.env.production.example',
    '.envrc',
    'src/env.ts',
    'secrets.md',
    'keystore.md',
  ]) {
    assert.equal(forbiddenName(file), null, file)
  }
})

test('only staged files are checked, and allowed paths pass', (t) => {
  const { root, stage } = repo(t)
  writeFileSync(path.join(root, 'unstaged.pfx'), 'not staged')
  stage({
    'android/app/debug.keystore': 'debug',
    'release.keystore': 'release',
    'src/app.ts': 'ok',
  })

  const options = parseOptions(['--allow', 'android/app/debug.keystore'])
  assert.deepEqual(checkStaged(root, options), [
    { file: 'release.keystore', reason: 'is signing material or a key' },
  ])
})

test('a private key pasted into an ordinary file is refused, and binaries are not scanned', (t) => {
  const { root, stage } = repo(t)
  stage({
    'config/deploy.yml': `host: example\nkey: |\n${KEY}\n`,
    'docs/how-keys-work.md':
      'A PEM file starts with BEGIN and ends with END.\n',
    'assets/logo.bin': Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(KEY),
    ]),
  })
  assert.deepEqual(checkStaged(root, defaults()), [
    { file: 'config/deploy.yml', reason: 'contains a private key' },
  ])
  assert.deepEqual(
    checkStaged(root, parseOptions(['--allow', 'config/deploy.yml'])),
    [],
  )
})

test('the staged size, not the working copy, is held to the limit', (t) => {
  const { root, stage } = repo(t)
  stage({ 'big.bin': Buffer.alloc(2048), 'small.txt': 'x' })
  // The working copy shrinks after staging; the staged blob is what would be committed.
  writeFileSync(path.join(root, 'big.bin'), '')

  const options = parseOptions(['--max-size', '1KB'])
  assert.deepEqual(files(checkStaged(root, options)), ['big.bin'])
  assert.match(checkStaged(root, options)[0].reason, /over the size limit/)
  assert.deepEqual(
    checkStaged(
      root,
      parseOptions(['--max-size', '1KB', '--allow-large', 'big.bin']),
    ),
    [],
  )
})

test('deleted files are ignored and a rename is checked at its new path', (t) => {
  const { root, git, stage } = repo(t)
  stage({ 'old.txt': 'x', 'gone.txt': 'y' })
  git('commit', '-qm', 'base')
  git('mv', 'old.txt', 'renamed.pfx')
  git('rm', '-q', 'gone.txt')
  assert.deepEqual(files(checkStaged(root, defaults())), ['renamed.pfx'])
})

test('a staged submodule pointer is not treated as a file', (t) => {
  const { root, git } = repo(t)
  git(
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${'a'.repeat(40)},external/kit`,
  )
  assert.deepEqual(checkStaged(root, defaults()), [])
})

test('sizes and options are parsed strictly', () => {
  assert.equal(parseSize('5MB'), 5 * 1024 * 1024)
  assert.equal(parseSize('512kb'), 512 * 1024)
  assert.equal(parseSize('100'), 100)
  assert.throws(() => parseSize('five'), /not a size/)
  assert.throws(() => parseOptions(['--allwo', 'x']), /unknown argument/)
  assert.throws(() => parseOptions(['--allow']), /needs a value/)
})

test('devkit-precommit lists every problem and exits 1, or exits 0 when clean', (t) => {
  const { root, stage } = repo(t)
  stage({ 'src/app.ts': 'ok' })
  assert.equal(spawnSync(process.execPath, [bin], { cwd: root }).status, 0)

  stage({ '.env': 'SECRET=1', 'cert.pfx': 'x' })
  const result = spawnSync(process.execPath, [bin], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\.env is an environment file/)
  assert.match(result.stderr, /cert\.pfx is signing material/)
})
