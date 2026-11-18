import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const extensionDir = path.join(repoRoot, 'vscode-extension')
const manifest = JSON.parse(
  readFileSync(path.join(extensionDir, 'package.json'), 'utf8'),
)

/** The file name `src/browser.mjs` loads from the installed package. */
export const trackedVsixName = `devkit-browser-${manifest.version}.vsix`
export const trackedVsixPath = path.join(extensionDir, trackedVsixName)

/**
 * Packages the VS Code browser bridge into `output` (absolute, or relative to the extension
 * folder). Returns the packager's exit status; it prints its own progress and errors.
 */
export function buildBrowserExtension(output = trackedVsixName) {
  // Pin the packager so local and CI artifacts are produced by the same toolchain.
  const result = spawnSync(
    'npx',
    ['--yes', '@vscode/vsce@3.9.2', 'package', '--out', output],
    {
      cwd: extensionDir,
      stdio: 'inherit',
      windowsHide: true,
    },
  )

  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = buildBrowserExtension()
}
