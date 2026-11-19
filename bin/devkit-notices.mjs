#!/usr/bin/env node
/**
 * `devkit-notices [--check] [--only <output>]...`: writes, or checks, the third-party notices file
 * for every deliverable in the `notices` block of `devkit.config.mjs`, or only for the deliverables
 * whose `output` each `--only` names (for a CI job that installs just some of them).
 *
 * `--check` builds them in memory, writes nothing, and fails when a file is missing or out of date,
 * for the app's `validate` gate. Both fail on a package with no usable licence. Like the other
 * `devkit-*` commands it needs no bootstrapped machine; it needs the dependencies installed.
 */
import {
  checkNotices,
  selectDeliverables,
  writeNotices,
} from '../src/notices/index.mjs'
import { loadProjectConfig } from '../src/project-config.mjs'

const root = process.cwd()

/** Reads `--check` and repeatable `--only <output>`; anything else is refused. */
function parseArguments(argv) {
  const options = { check: false, only: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') {
      options.check = true
      continue
    }
    if (argument !== '--only') {
      throw new Error(`devkit-notices: unknown argument ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('devkit-notices: --only needs an output path')
    }
    options.only.push(value)
    index += 1
  }
  return options
}

try {
  const options = parseArguments(process.argv.slice(2))
  const config = await loadProjectConfig(root)
  const notices = selectDeliverables(config.notices, options.only)

  if (options.check) {
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
