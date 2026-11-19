#!/usr/bin/env node
/**
 * `devkit-precommit [--allow <path>]... [--allow-large <path>]... [--max-size <n>[KB|MB]]`: the
 * shared pre-commit check (HYG-10), run from the repo's lefthook.yml.
 *
 * Refuses staged signing material and keys, `.env` files other than examples, anything under
 * `.secrets/`, staged text holding a private key, and files over the size limit (5 MB unless set).
 * Like the other `devkit-*` commands it needs no bootstrapped machine.
 */
import { execFileSync } from 'node:child_process'

import { checkStaged, parseOptions } from '../src/precommit.mjs'

try {
  const options = parseOptions(process.argv.slice(2))
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  const problems = checkStaged(root, options)
  if (problems.length > 0) {
    console.error('devkit-precommit: these staged files must not be committed:')
    for (const { file, reason } of problems)
      console.error(`  ${file} ${reason}`)
    console.error(
      'Unstage them (git restore --staged <file>). If one is safe, add it with --allow in lefthook.yml.',
    )
    process.exitCode = 1
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
