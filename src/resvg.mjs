/**
 * Loads `@resvg/resvg-js`, the SVG renderer devkit's image commands share (`devkit-icons`,
 * `devkit-store-hero`), so devkit itself never carries the native module.
 *
 * By default it comes from the repo being generated. `DEVKIT_ICONS_RENDERER_DIR` names another
 * place instead, for repos with no `node_modules` of their own (the Windows repos run devkit from
 * winui-app-kit's tools folder): either a folder containing `node_modules/@resvg/resvg-js`, or
 * the package folder itself. The variable keeps its first command's name because the kit's
 * wrapper already sets it; it applies to every command that renders.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Returns the `Resvg` class.
 *
 * @param {string} root the repo being generated; the renderer resolves from here by default
 * @param {NodeJS.ProcessEnv} env read for `DEVKIT_ICONS_RENDERER_DIR`
 * @param {string} command prefixes the error, so it names the command that needed the renderer
 * @throws when neither place holds the package
 */
export function loadRenderer(root, env = process.env, command = 'devkit') {
  const rendererDir = env.DEVKIT_ICONS_RENDERER_DIR?.trim()
  const from = rendererDir ? path.resolve(rendererDir) : root
  const require = createRequire(path.join(from, 'package.json'))

  try {
    if (rendererDir && isRendererPackage(from)) return require(from).Resvg
    return require('@resvg/resvg-js').Resvg
  } catch {
    const where = rendererDir
      ? `DEVKIT_ICONS_RENDERER_DIR (${from}) holds neither node_modules/@resvg/resvg-js nor the package itself`
      : 'install @resvg/resvg-js in this repo (pinned exactly), or set DEVKIT_ICONS_RENDERER_DIR'
    throw new Error(`${command}: ${where}`)
  }
}

/** True when `dir` is the `@resvg/resvg-js` package folder itself. */
function isRendererPackage(dir) {
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  return JSON.parse(readFileSync(manifest, 'utf8')).name === '@resvg/resvg-js'
}
