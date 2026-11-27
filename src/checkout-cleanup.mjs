/** Archive cleanup deliberately needs neither Compose interpolation nor installed app dependencies. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { checkoutIdentity } from './checkout-identity.mjs'
import {
  acquireCheckoutRunner,
  stopCheckoutRunner,
} from './checkout-runner.mjs'
import { loadProjectConfig } from './project-config.mjs'
import { releaseProxy } from './proxy.mjs'
import {
  dependencyTargetsPath,
  removeDependencyTargets,
} from './dependency-targets.mjs'

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.status}`,
    )
  }
  return result.stdout.trim()
}

/** Only declared private volumes are eligible, even when shared caches carry this project label. */
export function cleanupVolumeNames(identity, project) {
  const names = [
    `${identity.composeProject}-database`,
    ...project.cleanup.volumes.map((name) =>
      name.replace('{project}', identity.composeProject),
    ),
  ]
  return [...new Set(names)]
}

function resources(identity, names, run) {
  const filter = `label=com.docker.compose.project=${identity.composeProject}`
  const lines = (value) => value.split('\n').filter(Boolean)
  const containers = lines(run('docker', ['ps', '-aq', '--filter', filter]))
  const networks = lines(
    run('docker', ['network', 'ls', '-q', '--filter', filter]),
  )
  // Listing first makes an absent volume idempotent without treating daemon failure as absence.
  const existing = new Set(
    lines(run('docker', ['volume', 'ls', '--format', '{{.Name}}'])),
  )
  const volumes = names.filter((name) => existing.has(name))
  for (const name of volumes) {
    const [volume] = JSON.parse(run('docker', ['volume', 'inspect', name]))
    if (
      volume?.Labels?.['com.docker.compose.project'] !== identity.composeProject
    ) {
      throw new Error(
        `devkit: refusing to remove volume ${name}: checkout ownership does not match`,
      )
    }
  }
  return { containers, networks, volumes }
}

export async function cleanupCheckout({
  repoRoot = process.cwd(),
  config,
  yes = false,
  log = console.log,
  identity = checkoutIdentity(repoRoot),
  load = loadProjectConfig,
  run = execute,
  stopRunner = stopCheckoutRunner,
  acquireRunner = acquireCheckoutRunner,
  releaseRoute = releaseProxy,
  removeTargets = removeDependencyTargets,
  targetsFile = () =>
    config?.configDir ? dependencyTargetsPath(config, identity) : null,
} = {}) {
  if (!identity) throw new Error('devkit: cleanup requires a Git checkout')
  if (identity.isPrimary)
    throw new Error(
      'devkit: cleanup refuses primary checkouts; use the project dev:down command to stop them',
    )
  const project = await load(repoRoot)
  const names = cleanupVolumeNames(identity, project)
  const preview = resources(identity, names, run)
  const targets = targetsFile()
  const targetsNote =
    targets && existsSync(targets) ? `, dependency targets: ${targets}` : ''
  log(
    `[devkit] ${yes ? 'cleaning' : 'would clean'} ${identity.composeProject}: ${preview.containers.length} containers, ${preview.networks.length} networks, volumes: ${preview.volumes.join(', ') || '(none)'}${targetsNote}`,
  )
  if (!yes) {
    log(
      '[devkit] preview only; pass --yes to permanently remove this worktree’s private development data',
    )
    return preview
  }
  await stopRunner(config, identity)
  const lease = acquireRunner(config, identity)
  try {
    // Re-list after waiting for a runner. The lease blocks devkit from starting this checkout
    // during cleanup.
    const current = resources(identity, names, run)
    if (current.containers.length) {
      run('docker', ['stop', ...current.containers])
      run('docker', ['rm', ...current.containers])
    }
    if (current.networks.length)
      run('docker', ['network', 'rm', ...current.networks])
    if (!releaseRoute(config, identity))
      throw new Error('devkit: could not release the checkout proxy route')
    // No force: Docker refuses any volume still mounted by another container.
    for (const volume of current.volumes)
      run('docker', ['volume', 'rm', volume])
    removeTargets(config, identity)
    log(
      '[devkit] removed private checkout resources; shared caches and baselines retained',
    )
    return current
  } finally {
    lease.release()
  }
}
