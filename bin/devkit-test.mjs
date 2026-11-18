#!/usr/bin/env node
/**
 * `devkit-test [--integration] [paths...] [-- node-test-options...]`: runs the app's `node --test`
 * files. By default that is every test file except `*.integration.test.*`; `--integration` runs only
 * those database-backed files, one at a time, for `test:integration` (TEST-7).
 *
 * A separate command from `devkit` on purpose: the `devkit` commands select the checkout's Node
 * through nvm and expect a bootstrapped machine, while tests also run in CI and in containers that
 * have neither. This one uses the Node it was started with and reads only `devkit.config.mjs`.
 *
 * Paths narrow the search for `test:<target>` scripts. Options after `--`, or any argument
 * starting with `--`, pass through to `node --test` (for example `--test-concurrency=1`).
 */
import { loadProjectConfig } from '../src/project-config.mjs'
import { runTests } from '../src/test-runner.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const leading = separator === -1 ? args : args.slice(0, separator)
const integration = leading.includes('--integration')
const before = leading.filter((arg) => arg !== '--integration')
const after = separator === -1 ? [] : args.slice(separator + 1)

const paths = before.filter((arg) => !arg.startsWith('--'))
const nodeArgs = [...before.filter((arg) => arg.startsWith('--')), ...after]

try {
  const project = await loadProjectConfig(root)
  process.exitCode = runTests({
    root,
    paths: paths.length > 0 ? paths : undefined,
    ignore: project.test.ignore,
    skipSuffixes: project.test.skipSuffixes,
    integration,
    nodeArgs,
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
