/**
 * Types for `@dynamic-solutions-canada/devkit/vite`, so a typed `vite.config.ts` can import it.
 * Kept in step with `vite.mjs` by hand; the shape is small and changes rarely.
 */

/** The Vite `server` options devkit's environment decides. */
export interface DevkitViteServer {
  /** The fixed in-container port: `VITE_DEV_PORT`, default 5173. */
  port: number
  /** `VITE_DEV_HOST`, or `true` (Vite's all-interfaces default) when unset. */
  host: string | true
  /** Every hostname devkit routes to this checkout, from `VITE_DEV_ALLOWED_HOSTS`. */
  allowedHosts: string[] | undefined
  /** Ignores `.worktrees/`; Vite keeps its own defaults alongside. */
  watch: { ignored: string[] }
}

/**
 * Returns the `server` options devkit decides, from the app's merged environment (Vite's
 * `loadEnv` result with `process.env` on top).
 */
export function devkitViteServer(
  env?: Record<string, string | undefined>,
): DevkitViteServer
