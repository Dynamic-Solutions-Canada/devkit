/**
 * The Vite `server` settings every devkit app repeats, for `@dynamic-solutions-canada/devkit/vite`.
 *
 * Imported from an app's `vite.config`, which Vite also loads for production builds, so this file
 * stays pure: no imports, no side effects, and nothing here applies outside `vite dev`. The app
 * keeps everything that is its own, such as its `/api` proxy and headers.
 */

/**
 * Returns `server` options from the environment devkit gives the dev container.
 *
 * @param {Record<string, string | undefined>} env The app's merged environment: Vite's `loadEnv`
 *   result with `process.env` on top, since devkit passes its values through the process.
 * @returns {{port: number, host: string | true, allowedHosts: string[] | undefined,
 *   watch: {ignored: string[]}}}
 *   - `port`: the fixed in-container port (`VITE_DEV_PORT`, default 5173); devkit maps the
 *     checkout's own host port to it.
 *   - `host`: `VITE_DEV_HOST` (devkit sets an IPv4 bind its proxy can reach), else Vite's default.
 *   - `allowedHosts`: every hostname devkit routes to this checkout (`VITE_DEV_ALLOWED_HOSTS`).
 *   - `watch.ignored`: worktrees inside the checkout (`.worktrees/`, D-032), which the primary
 *     checkout's container mounts but must not watch. Vite keeps its own defaults alongside.
 */
export function devkitViteServer(env = process.env) {
  const allowedHosts = env.VITE_DEV_ALLOWED_HOSTS
    ? env.VITE_DEV_ALLOWED_HOSTS.split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    : undefined

  return {
    port: Number(env.VITE_DEV_PORT ?? 5173),
    host: env.VITE_DEV_HOST || true,
    allowedHosts,
    watch: { ignored: ['**/.worktrees/**'] },
  }
}
