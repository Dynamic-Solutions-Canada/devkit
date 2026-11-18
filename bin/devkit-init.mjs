#!/usr/bin/env node
/**
 * `devkit-init [--check]`: writes or checks the dev glue devkit generates into an app.
 *
 * Without options it writes the runner, the lifecycle npm scripts, `paseo.json` and, if missing,
 * a first `compose.dev.yml`, and lists what changed. Run it after adding devkit and after every
 * pin bump, then commit the result. `--check` writes nothing and fails when an owned output is out
 * of date, for the app's `validate` gate.
 *
 * Like `devkit-test`, it needs no bootstrapped machine and no nvm runtime switch, so the check runs
 * the same in CI. It reads only `package.json`, `paseo.json` and `devkit.config.mjs`.
 */
import {
  checkTemplates,
  templateWarnings,
  writeTemplates,
} from '../src/app-templates.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'

const root = process.cwd()
const check = process.argv.includes('--check')

try {
  const { generated } = await loadProjectConfig(root)

  if (check) {
    const stale = checkTemplates({ root, generated })
    if (stale.length > 0) {
      console.error('devkit-init: these generated files are out of date:')
      for (const file of stale) console.error(`  ${file}`)
      console.error('Run `devkit-init` and commit the result.')
      process.exitCode = 1
    } else {
      console.log('devkit-init: generated files are up to date')
    }
  } else {
    const written = writeTemplates({ root, generated })
    if (written.length === 0) console.log('devkit-init: nothing to change')
    for (const file of written) console.log(`  + ${file}`)
    for (const warning of templateWarnings({ root, generated })) {
      console.warn(`devkit-init: ${warning}`)
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
