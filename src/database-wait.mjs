/**
 * Waits for the database in a connection URL to accept TCP connections, so migrations and
 * generators do not race a database container that is still starting.
 *
 * This only proves the port is open, which is what the callers need: Compose already waits for
 * the database health check, and this covers the moments around it (a restart, a host-side tool).
 * No side effects on import; the `devkit-wait-for-db` command is its entry point.
 */
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** Port each URL scheme uses when the URL names none. */
const DEFAULT_PORTS = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'mysql:': 3306,
  'mariadb:': 3306,
}

/** Returns `url` with any password replaced, for messages that may end up in logs. */
export function redactDatabaseUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '(unparseable database URL)'
  }
}

/** Reads the host and port to probe from a database URL; throws on a URL it cannot use. */
export function databaseAddress(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('devkit-wait-for-db: DATABASE_URL is not a valid URL')
  }
  const port = parsed.port
    ? Number(parsed.port)
    : DEFAULT_PORTS[parsed.protocol]
  if (!parsed.hostname || !port) {
    throw new Error(
      `devkit-wait-for-db: cannot tell the host and port from ${redactDatabaseUrl(url)}`,
    )
  }
  return { host: parsed.hostname, port }
}

/** Resolves true when one connection attempt succeeds within `timeoutMs`, false otherwise. */
function canConnect({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)

    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })

    const fail = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once('timeout', fail)
    socket.once('error', fail)
  })
}

/**
 * Retries until the database accepts a connection or `timeoutMs` passes.
 *
 * @param {object} options
 * @param {string} options.url Database connection URL, usually `DATABASE_URL`.
 * @param {number} [options.timeoutMs] Total time to keep trying, in milliseconds.
 * @param {number} [options.retryMs] Pause between attempts, in milliseconds.
 * @returns {Promise<{ok: boolean, host: string, port: number}>} `ok` is false on timeout.
 */
export async function waitForDatabase({
  url,
  timeoutMs = 60_000,
  retryMs = 1_000,
}) {
  const address = databaseAddress(url)
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const attemptMs = Math.max(1, Math.min(2_000, deadline - Date.now()))
    if (await canConnect(address, attemptMs)) return { ok: true, ...address }
    await delay(retryMs)
  }
  return { ok: false, ...address }
}
