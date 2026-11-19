import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { DEFAULT_DATABASE_VERSIONS } from '../src/database-runtime.mjs'

const preflightUrl = new URL('../src/index.mjs', import.meta.url).href

/**
 * A git repo with one linked worktree, a devkit host config, and a fake `docker` that records
 * its calls. The fake reports the checkout database as present until it sees a DROP, so a fresh
 * start must drop it and create it again.
 */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-fresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const repo = path.join(root, 'app')
  const configDir = path.join(root, 'config')
  const bin = path.join(root, 'bin')
  for (const directory of [repo, bin, path.join(configDir, 'infra')])
    mkdirSync(directory, { recursive: true })

  const git = (...args) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  writeFileSync(
    path.join(repo, 'devkit.config.mjs'),
    'export default { migrationsTable: null }',
  )
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const worktree = path.join(repo, '.worktrees/try')
  git('worktree', 'add', '-q', worktree)

  // A baseline that a normal start would clone; a fresh start must leave it alone.
  const runtimeKey = `postgres-${DEFAULT_DATABASE_VERSIONS.postgres.replace(/[^a-z0-9]+/g, '-')}`
  mkdirSync(path.join(configDir, 'baselines'))
  writeFileSync(path.join(configDir, 'baselines', `app-${runtimeKey}.sql`), '')
  writeFileSync(
    path.join(configDir, 'host.json'),
    JSON.stringify({ enabled: true }),
  )
  const trace = path.join(root, 'docker-calls')
  const dropped = path.join(root, 'dropped')
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env node
    const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    const line = args.join(' ')
    appendFileSync(process.env.TEST_DOCKER_TRACE, JSON.stringify(args) + '\\n')
    if (args[0] === 'version') console.log('test')
    else if (args[0] === 'ps' && args.includes('-q')) console.log('test-container')
    else if (args[0] === 'exec' && line.includes('DROP DATABASE')) writeFileSync(${JSON.stringify(dropped)}, '')
    else if (args[0] === 'exec' && line.includes('pg_database')) { if (!existsSync(${JSON.stringify(dropped)})) console.log('1') }
    else if (args[0] === 'exec') console.log('1')
  `,
    { mode: 0o755 },
  )

  const script = path.join(root, 'dev.mjs')
  writeFileSync(
    script,
    `
    import { preflight } from ${JSON.stringify(preflightUrl)}
    const state = await preflight({ repoRoot: process.cwd(), log: null, fresh: true })
    state.runner.release()
  `,
  )

  /** Runs a fresh preflight in `cwd`; resolves with its output or rejects with its error. */
  const start = (cwd) =>
    promisify(execFile)(process.execPath, [script], {
      cwd,
      env: {
        ...process.env,
        DEVKIT: '1',
        DEVKIT_OPEN_BROWSER: '0',
        DEVKIT_CONFIG_DIR: configDir,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DOCKER_TRACE: trace,
      },
    })
  const calls = () =>
    existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : []

  return { repo, worktree, start, calls }
}

test('--fresh drops a worktree database and recreates it empty', async (t) => {
  const { worktree, start, calls } = fixture(t)
  await start(worktree)

  const sql = calls().filter((call) => call.includes('DATABASE'))
  assert.equal(sql.length, 2, sql.join('\n'))
  assert.match(sql[0], /DROP DATABASE IF EXISTS .* WITH \(FORCE\)/)
  assert.match(sql[1], /CREATE DATABASE/)
  assert.ok(
    !calls().some((call) => call.includes('devkit-baselines')),
    'the baseline was not imported',
  )
})

test('--fresh refuses the primary checkout before touching its database', async (t) => {
  const { repo, start, calls } = fixture(t)
  await assert.rejects(start(repo), /refusing --fresh in the primary checkout/)
  assert.deepEqual(
    calls().filter((call) => call.includes('DATABASE')),
    [],
  )
})
