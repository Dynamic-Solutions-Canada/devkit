/**
 * The dev glue devkit generates into an app (D-045, SCRIPT-7): the runner, the lifecycle npm
 * scripts, `paseo.json`, and a first `compose.dev.yml`.
 *
 * Each output has an owner. devkit owns the whole runner file, exactly the npm script names below,
 * and exactly the `paseo.json` keys it writes; everything else in those files stays the app's and
 * is never touched. `compose.dev.yml` is written once, when it does not exist, because its
 * environment list is the app's policy; after that devkit neither checks nor rewrites it.
 *
 * `planTemplates` decides what each owned output should contain, `writeTemplates` applies the plan,
 * and `checkTemplates` reports drift without writing, for the app's `validate` gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url))

/** Where apps reach devkit's CLI from a worktree hook or a Paseo script. */
const DEVKIT_CLI =
  'node_modules/@dynamic-solutions-canada/devkit/bin/devkit.mjs'

export const RUNNER_PATH = 'scripts/dev/run-dev.mjs'
export const COMPOSE_PATH = 'compose.dev.yml'
export const DEPLOY_PATH = 'scripts/deploy/deploy-over-ssh.mjs'

/** The lifecycle npm scripts devkit owns (SCRIPT-7). `dev` is owned only with the runner. */
const LIFECYCLE_SCRIPTS = {
  'dev:background': 'npm run dev -- --background',
  'dev:down': 'npm run dev -- --down',
  'dev:cleanup': 'devkit cleanup --yes',
  'dev:doctor': 'devkit doctor',
  'dev:bootstrap': 'devkit bootstrap',
  'dev:host': 'devkit',
  // The app's own preparation (generated code, a shared build) goes in `dev:postprepare`.
  'dev:prepare-worktree':
    'devkit prepare && npm run --if-present dev:postprepare',
}
const RUNNER_SCRIPT = { dev: `devkit run node ${RUNNER_PATH}` }
const DEPLOY_SCRIPT = {
  'deploy:prod': `node --env-file-if-exists=.env ${DEPLOY_PATH}`,
}

/** npm scripts that `paseo.json` mirrors, in order, when the app defines them (AI-12). */
const PASEO_SCRIPTS = [
  'dev',
  'dev:background',
  'dev:down',
  'dev:prepare-worktree',
  'dev:doctor',
  'validate',
  'test',
  'build',
]

/** Reads a JSON file, or returns `fallback` when it does not exist. */
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Serialises JSON the way npm and Prettier both write it: two spaces and a final newline. */
function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The npm scripts devkit owns for this app, given its `generated` options. */
function ownedScripts(generated) {
  return {
    ...(generated.scripts && generated.runner ? RUNNER_SCRIPT : {}),
    ...(generated.scripts ? LIFECYCLE_SCRIPTS : {}),
    ...(generated.deploy ? DEPLOY_SCRIPT : {}),
  }
}

/**
 * Builds the `paseo.json` keys devkit owns. Script entries call the npm script through devkit's
 * launcher, so Paseo and a terminal run the same command; only scripts the app has are mirrored.
 */
function ownedPaseo(scripts) {
  const entries = {}
  for (const name of PASEO_SCRIPTS) {
    if (!scripts[name]) continue
    const npmCommand = name === 'test' ? 'npm test' : `npm run ${name}`
    entries[name.replaceAll(':', '-')] = {
      command: `node ${DEVKIT_CLI} run ${npmCommand}`,
    }
  }
  return {
    worktree: {
      setup: `node "$PASEO_SOURCE_CHECKOUT_PATH/${DEVKIT_CLI}" run npm run dev:prepare-worktree`,
      teardown: `node "$PASEO_SOURCE_CHECKOUT_PATH/${DEVKIT_CLI}" cleanup --paseo --yes`,
    },
    scripts: entries,
  }
}

/**
 * Works out every owned output for the app at `root`.
 *
 * Returns a list of `{ path, contents, current }`, where `contents` is what devkit would write and
 * `current` is what is there now (null when missing). Outputs devkit does not own for this app,
 * through an opt-out or an existing `compose.dev.yml`, are left out of the list.
 */
export function planTemplates({ root, generated }) {
  const plan = []

  /** Adds one output, reading what the file holds today. */
  function add(relative, contents) {
    const file = path.join(root, relative)
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    plan.push({ path: relative, contents, current })
  }

  // package.json: set exactly the owned script names, keep everything else in place.
  const packagePath = path.join(root, 'package.json')
  const pkg = readJson(packagePath, null)
  if (!pkg)
    throw new Error('devkit-init: run it from an app root with a package.json')
  const scripts = { ...pkg.scripts, ...ownedScripts(generated) }
  if (generated.scripts || generated.deploy) {
    add('package.json', formatJson({ ...pkg, scripts }))
  }

  if (generated.runner) {
    add(
      RUNNER_PATH,
      readFileSync(path.join(templatesDir, 'run-dev.mjs'), 'utf8'),
    )
  }

  if (generated.deploy) {
    add(
      DEPLOY_PATH,
      readFileSync(path.join(templatesDir, 'deploy-over-ssh.mjs'), 'utf8'),
    )
  }

  // paseo.json: devkit's keys replace their old values; app-added worktree and script keys stay.
  if (generated.paseo) {
    const existing = readJson(path.join(root, 'paseo.json'), {})
    const owned = ownedPaseo(scripts)
    add(
      'paseo.json',
      formatJson({
        ...existing,
        worktree: { ...existing.worktree, ...owned.worktree },
        scripts: { ...existing.scripts, ...owned.scripts },
      }),
    )
  }

  // compose.dev.yml is the app's once it exists, so it is only ever created.
  if (generated.runner && !existsSync(path.join(root, COMPOSE_PATH))) {
    add(
      COMPOSE_PATH,
      readFileSync(path.join(templatesDir, 'compose.dev.yml'), 'utf8'),
    )
  }

  return plan
}

/**
 * True when `current` already holds `contents`. JSON files compare by value, so an app's
 * formatter may lay them out differently without counting as drift.
 */
function matches({ path: relative, contents, current }) {
  if (current === null) return false
  if (!relative.endsWith('.json')) return current === contents
  return (
    JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(contents))
  )
}

/** Writes every owned output that differs, and returns the paths it wrote. */
export function writeTemplates({ root, generated }) {
  const written = []
  for (const output of planTemplates({ root, generated })) {
    if (matches(output)) continue
    const file = path.join(root, output.path)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, output.contents)
    written.push(output.path)
  }
  return written
}

/**
 * Returns the paths whose owned contents differ from what this devkit version generates. A new
 * `compose.dev.yml` is not drift: once written it is the app's, so the check never asks for it.
 */
export function checkTemplates({ root, generated }) {
  return planTemplates({ root, generated })
    .filter((output) => output.path !== COMPOSE_PATH)
    .filter((output) => !matches(output))
    .map((output) => output.path)
}

/**
 * Lists what the app still has to provide for the generated files to work. The runner hands the
 * container over to `dev:container`, which only the app can write.
 */
export function templateWarnings({ root, generated }) {
  const pkg = readJson(path.join(root, 'package.json'), {})
  const warnings = []
  if (generated.runner && !pkg.scripts?.['dev:container']) {
    warnings.push(
      'add a `dev:container` npm script: the generated runner runs it inside the container to prepare the database and start the dev servers',
    )
  }
  return warnings
}
