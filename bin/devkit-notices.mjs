#!/usr/bin/env node
/**
 * `devkit-notices [--check]`: writes, or checks, the third-party notices file for every
 * deliverable in the `notices` block of `devkit.config.mjs`.
 *
 * `--check` builds them in memory, writes nothing, and fails when a file is missing or out of date,
 * for the app's `validate` gate. Both fail on a package with no usable licence. Like the other
 * `devkit-*` commands it needs no bootstrapped machine; it needs the dependencies installed.
 */
import { checkNotices, writeNotices } from '../src/notices/index.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'

const root = process.cwd()

try {
  const { notices } = await loadProjectConfig(root)

  if (process.argv.includes('--check')) {
    const stale = checkNotices(root, notices)
    if (stale.length > 0) {
      console.error(
        'devkit-notices: these notices do not match the installed production dependencies:',
      )
      for (const file of stale) console.error(`  ${file}`)
      console.error('Run `devkit-notices` and commit the result.')
      process.exitCode = 1
    } else {
      console.log('devkit-notices: every notices file is current')
    }
  } else {
    for (const { output, count } of writeNotices(root, notices)) {
      console.log(`  + ${output} (${count} packages)`)
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
