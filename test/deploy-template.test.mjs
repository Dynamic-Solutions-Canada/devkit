import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEPLOY_DEFAULTS,
  buildRemoteScript,
  deploySettings,
  parseOptions,
} from '../templates/deploy-over-ssh.mjs'

const SHA = 'a'.repeat(40)

// Fake `git` and `docker` record every call and behave as FAKE_* variables say, so the server
// script runs end to end with real bash and gzip and nothing leaves the machine.
const FAKE_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$FAKE_LOG"
case "$1" in
  status) printf '%s' "\${FAKE_GIT_DIRTY:-}" ;;
  rev-parse) if [[ "$2" == --short ]]; then echo "\${FAKE_HEAD:0:7}"; else echo "$FAKE_HEAD"; fi ;;
esac
`
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
args="$*"
case "$args" in
  *" ps -q "*) printf '%s' "\${FAKE_DB_CONTAINER:-}" ;;
  *" exec -T "*) printf '%b' "\${FAKE_DUMP:-}" ;;
  *" up "*) echo "labels $DEPLOY_REVISION $DEPLOY_VERSION" >> "$FAKE_LOG"; exit "\${FAKE_UP_STATUS:-0}" ;;
  "exec "*" nginx -t") exit "\${FAKE_NGINX_TEST_STATUS:-0}" ;;
esac
`

/** Creates a fake server: a checkout, a sites folder, and the fake binaries on PATH. */
function server(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-deploy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const repo = path.join(root, 'repo')
  const sites = path.join(root, 'nginx', 'conf.d')
  for (const dir of [bin, repo, sites]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(bin, 'git'), FAKE_GIT)
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER)
  chmodSync(path.join(bin, 'git'), 0o755)
  chmodSync(path.join(bin, 'docker'), 0o755)
  writeFileSync(path.join(repo, 'nginx.server.conf'), 'server { listen 80; }\n')
  return { root, bin, repo, sites, log: path.join(root, 'calls.log') }
}

const settings = (overrides = {}) => ({
  ...DEPLOY_DEFAULTS,
  version: '1.2.3',
  site: { source: 'nginx.server.conf', name: 'app.conf' },
  dump: {
    command: 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"',
    trailer: 'PostgreSQL database dump complete',
  },
  ...overrides,
})

/** Runs the server script on the fake server and returns its result and the recorded calls. */
function deploy(fake, { env = {}, options = {}, settingsOverrides = {} } = {}) {
  const parsed = {
    ...parseOptions([], {}),
    repoPath: fake.repo,
    sitesDir: fake.sites,
    ...options,
  }
  const script = buildRemoteScript(settings(settingsOverrides), parsed, SHA)
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${fake.bin}:${process.env.PATH}`,
      FAKE_LOG: fake.log,
      FAKE_HEAD: SHA,
      FAKE_DB_CONTAINER: 'db123',
      FAKE_DUMP: '-- dump\\n-- PostgreSQL database dump complete\\n',
      ...env,
    },
  })
  const calls = existsSync(fake.log)
    ? readFileSync(fake.log, 'utf8').trim().split('\n')
    : []
  return { ...result, calls }
}

/** Index of the first recorded call containing `text`, or -1. */
const callIndex = (calls, text) =>
  calls.findIndex((call) => call.includes(text))

test('a deploy runs the CTR-11 steps in order and installs a new site file', (t) => {
  const fake = server(t)
  const result = deploy(fake)
  assert.equal(result.status, 0, result.stderr)

  const order = [
    'git status',
    'exec -T db',
    'git pull --ff-only origin main',
    'up --build -d --wait',
    'nginx -t',
    'nginx -s reload',
    'image prune -f',
  ].map((text) => callIndex(result.calls, text))
  assert.ok(
    order.every((index) => index >= 0),
    result.calls.join('\n'),
  )
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  )

  const backups = readdirSync(path.join(fake.repo, '.backups'))
  assert.equal(backups.length, 1)
  assert.match(backups[0], /^pre-deploy-.*-aaaaaaaaaaaa\.sql\.gz$/)
  assert.equal(
    readFileSync(path.join(fake.sites, 'app.conf'), 'utf8'),
    'server { listen 80; }\n',
  )
})

test('a dirty server checkout is refused before anything changes', (t) => {
  const fake = server(t)
  const result = deploy(fake, {
    env: { FAKE_GIT_DIRTY: ' M compose.server.yml' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /tracked changes/)
  assert.equal(callIndex(result.calls, 'exec -T'), -1)
  assert.equal(callIndex(result.calls, 'git pull'), -1)
})

test('an incomplete dump is deleted and stops the deploy before the checkout moves', (t) => {
  const fake = server(t)
  const result = deploy(fake, { env: { FAKE_DUMP: '-- dump cut short\\n' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dump is incomplete/)
  assert.equal(callIndex(result.calls, 'git pull'), -1)
  assert.deepEqual(readdirSync(path.join(fake.repo, '.backups')), [])
})

test('only the newest backups are kept', (t) => {
  const fake = server(t)
  const backups = path.join(fake.repo, '.backups')
  mkdirSync(backups)
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(path.join(backups, `pre-deploy-old${index}.sql.gz`), '')
  }
  const result = deploy(fake, { settingsOverrides: { backupsKept: 2 } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readdirSync(backups).length, 2)
})

test('a first deploy with no database container skips the dump', (t) => {
  const fake = server(t)
  const result = deploy(fake, { env: { FAKE_DB_CONTAINER: '' } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nothing to back up/)
})

test('a checkout that lands on another commit stops before the stack restarts', (t) => {
  const fake = server(t)
  const result = deploy(fake, { env: { FAKE_HEAD: 'b'.repeat(40) } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /validated locally/)
  assert.equal(callIndex(result.calls, ' up '), -1)
})

test('an unhealthy stack stops the deploy with its status and logs', (t) => {
  const fake = server(t)
  const result = deploy(fake, { env: { FAKE_UP_STATUS: '1' } })
  assert.equal(result.status, 1)
  assert.ok(callIndex(result.calls, 'logs --tail=100') >= 0)
  assert.equal(callIndex(result.calls, 'nginx -t'), -1)
})

test('a site file that fails nginx -t is rolled back to the previous one', (t) => {
  const fake = server(t)
  writeFileSync(path.join(fake.sites, 'app.conf'), 'previous\n')
  const result = deploy(fake, { env: { FAKE_NGINX_TEST_STATUS: '1' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /failed nginx -t/)
  assert.equal(
    readFileSync(path.join(fake.sites, 'app.conf'), 'utf8'),
    'previous\n',
  )
  assert.equal(callIndex(result.calls, 'nginx -s reload'), -1)
  // The previous file was kept outside conf.d.
  assert.equal(
    readdirSync(path.join(fake.root, 'nginx', 'site-backups')).length,
    1,
  )
})

test('a failed first install removes the new site file', (t) => {
  const fake = server(t)
  const result = deploy(fake, { env: { FAKE_NGINX_TEST_STATUS: '1' } })
  assert.equal(result.status, 1)
  assert.ok(!existsSync(path.join(fake.sites, 'app.conf')))
})

test('an unchanged site file is left alone and nginx is not reloaded', (t) => {
  const fake = server(t)
  writeFileSync(path.join(fake.sites, 'app.conf'), 'server { listen 80; }\n')
  const result = deploy(fake)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(callIndex(result.calls, 'nginx'), -1)
})

test('skip flags leave out the dump and the prune, and the override file is added when present', (t) => {
  const fake = server(t)
  writeFileSync(path.join(fake.repo, 'compose.override.yml'), '')
  const result = deploy(fake, {
    options: { skipBackup: true, skipPrune: true },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(callIndex(result.calls, 'exec -T'), -1)
  assert.equal(callIndex(result.calls, 'image prune'), -1)
  assert.ok(
    callIndex(
      result.calls,
      '-f compose.server.yml -f compose.override.yml up',
    ) >= 0,
  )
})

test('settings come from the deploy block, the engine and package.json', (t) => {
  const fake = server(t)
  writeFileSync(
    path.join(fake.repo, 'package.json'),
    '{"name":"@acme/shop","version":"2.0.1"}',
  )
  const postgres = deploySettings(fake.repo, {})
  assert.equal(postgres.site.name, 'shop.conf')
  assert.equal(postgres.version, '2.0.1')
  assert.equal(postgres.databaseService, 'db')
  assert.equal(postgres.backupsKept, 10)
  assert.match(postgres.dump.command, /pg_dump/)

  const mariadb = deploySettings(fake.repo, {
    database: { engine: 'mariadb' },
    deploy: { site: null, databaseService: 'database' },
  })
  assert.equal(mariadb.site, null)
  assert.equal(mariadb.databaseService, 'database')
  assert.match(mariadb.dump.command, /mariadb-dump/)
  assert.doesNotMatch(mariadb.dump.command, /-p"/)

  rmSync(path.join(fake.repo, 'nginx.server.conf'))
  assert.throws(() => deploySettings(fake.repo, {}), /does not exist/)
})

test('the target comes from the environment and unknown options are refused', () => {
  const options = parseOptions(['--skip-validate'], {
    DEPLOY_SSH_HOST: 'deploy@server',
    DEPLOY_REPO_PATH: '/home/apps/shop',
    DEPLOY_BACKUP: '0',
  })
  assert.equal(options.host, 'deploy@server')
  assert.equal(options.port, '22')
  assert.equal(options.sitesDir, '/home/apps/nginx/conf.d')
  assert.equal(options.nginxContainer, 'nginx')
  assert.equal(options.skipBackup, true)
  assert.equal(options.skipValidate, true)
  assert.throws(() => parseOptions(['--branch'], {}), /Unknown argument/)
})

test('dumps are private to the deploy user while the rest of the deploy keeps normal modes', (t) => {
  const fake = server(t)
  const result = deploy(fake)
  assert.equal(result.status, 0, result.stderr)

  const backups = path.join(fake.repo, '.backups')
  assert.equal(statSync(backups).mode & 0o777, 0o700)
  const [dump] = readdirSync(backups)
  assert.equal(statSync(path.join(backups, dump)).mode & 0o777, 0o600)
  // The site file is written after the dump step, outside its umask.
  assert.equal(
    statSync(path.join(fake.sites, 'app.conf')).mode & 0o077,
    0o044 & ~process.umask(),
  )
})

test('an existing backup folder is tightened to 700', (t) => {
  const fake = server(t)
  mkdirSync(path.join(fake.repo, '.backups'), { mode: 0o755 })
  const result = deploy(fake)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(statSync(path.join(fake.repo, '.backups')).mode & 0o777, 0o700)
})

test('the image labels get the validated commit and the package version', (t) => {
  const fake = server(t)
  const result = deploy(fake)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(
    result.calls.includes(`labels ${SHA} 1.2.3`),
    result.calls.join('\n'),
  )
})

test('a package.json without a version stops the deploy before it starts', (t) => {
  const fake = server(t)
  writeFileSync(path.join(fake.repo, 'package.json'), '{"name":"shop"}')
  assert.throws(() => deploySettings(fake.repo, {}), /Set "version"/)
})
