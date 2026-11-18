#!/usr/bin/env node
/**
 * `devkit-wait-for-db`: waits until the database in `DATABASE_URL` accepts connections.
 *
 * For an app's `db:wait` script, usually run inside the dev container before migrations. Like the
 * other `devkit-*` commands it needs no bootstrapped machine. `DB_WAIT_TIMEOUT_MS` (default 60000)
 * and `DB_WAIT_RETRY_MS` (default 1000) tune it; it exits 1 on timeout. The password is never printed.
 */
import { redactDatabaseUrl, waitForDatabase } from '../src/database-wait.mjs'

/** Reads a positive whole number of milliseconds from the environment, or the default. */
function milliseconds(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `devkit-wait-for-db: ${name} must be a positive number of milliseconds`,
    )
  }
  return parsed
}

try {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('devkit-wait-for-db: DATABASE_URL is required')

  const result = await waitForDatabase({
    url,
    timeoutMs: milliseconds('DB_WAIT_TIMEOUT_MS', 60_000),
    retryMs: milliseconds('DB_WAIT_RETRY_MS', 1_000),
  })
  if (result.ok) {
    console.log(`Database is reachable at ${redactDatabaseUrl(url)}`)
  } else {
    console.error(
      `Timed out waiting for the database at ${redactDatabaseUrl(url)}`,
    )
    process.exitCode = 1
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
