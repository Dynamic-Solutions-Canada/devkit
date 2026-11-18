import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  databaseAddress,
  redactDatabaseUrl,
  waitForDatabase,
} from '../src/database-wait.mjs'

const bin = fileURLToPath(
  new URL('../bin/devkit-wait-for-db.mjs', import.meta.url),
)

/** Starts a TCP server on a free loopback port and returns it with its port. */
async function listener(t) {
  const server = net.createServer((socket) => socket.end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server.address().port
}

/** Returns a loopback port that nothing is listening on. */
async function closedPort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('the address comes from the URL, with the default port for each engine', () => {
  assert.deepEqual(databaseAddress('postgresql://u:p@database/app'), {
    host: 'database',
    port: 5432,
  })
  assert.deepEqual(databaseAddress('mysql://u:p@database/app'), {
    host: 'database',
    port: 3306,
  })
  assert.deepEqual(databaseAddress('postgres://localhost:6543/app'), {
    host: 'localhost',
    port: 6543,
  })
  assert.throws(() => databaseAddress('not a url'), /not a valid URL/)
  assert.throws(
    () => databaseAddress('redis://u:secret@cache/0'),
    /cannot tell/,
  )
})

test('passwords never appear in messages', () => {
  assert.equal(
    redactDatabaseUrl('postgresql://app:s3cret@database:5432/app'),
    'postgresql://app:***@database:5432/app',
  )
  assert.doesNotMatch(
    (() => {
      try {
        databaseAddress('redis://u:s3cret@cache/0')
      } catch (error) {
        return error.message
      }
    })(),
    /s3cret/,
  )
})

test('waiting succeeds once the port accepts connections', async (t) => {
  const port = await listener(t)
  const result = await waitForDatabase({
    url: `postgresql://u:p@127.0.0.1:${port}/app`,
    timeoutMs: 2_000,
    retryMs: 10,
  })
  assert.deepEqual(result, { ok: true, host: '127.0.0.1', port })
})

test('waiting gives up after the timeout', async () => {
  const port = await closedPort()
  const started = Date.now()
  const result = await waitForDatabase({
    url: `postgresql://u:p@127.0.0.1:${port}/app`,
    timeoutMs: 200,
    retryMs: 20,
  })
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started < 2_000)
})

test('devkit-wait-for-db exits 1 on timeout and never prints the password', async () => {
  const port = await closedPort()
  const result = spawnSync(process.execPath, [bin], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: `postgresql://u:s3cret@127.0.0.1:${port}/app`,
      DB_WAIT_TIMEOUT_MS: '200',
      DB_WAIT_RETRY_MS: '20',
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Timed out/)
  assert.doesNotMatch(result.stdout + result.stderr, /s3cret/)

  const missing = spawnSync(process.execPath, [bin], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /DATABASE_URL is required/)
})
