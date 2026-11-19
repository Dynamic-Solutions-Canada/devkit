/**
 * The shared pre-commit check (HYG-10): refuses staged signing material, environment files,
 * anything under `.secrets/`, staged text holding a private key, and files over a size limit.
 *
 * It looks at what is staged, not at the working tree: names come from the index, sizes from the
 * staged blobs, and contents from `git show :<path>`. Deleted files are never checked, and a
 * renamed file is checked at its new path. Policy comes from the command line, which a repo sets
 * once on its lefthook run line.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** Extensions that only ever hold signing material or keys. `.keystore` covers Android's too. */
const KEY_EXTENSIONS = ['.pfx', '.p12', '.jks', '.der', '.cer', '.keystore']

/** A PEM private key of any kind: RSA, EC, OpenSSH, PKCS#8, encrypted. */
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/

/** Only this much of a file is read to tell text from binary. */
const BINARY_SNIFF_BYTES = 8000

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * Reads `--allow <path>`, `--allow-large <path>` (both repeatable, exact repo-relative paths) and
 * `--max-size <n>[KB|MB]`. Unknown arguments are refused, so a typo cannot quietly weaken the check.
 */
export function parseOptions(argv) {
  const options = {
    allow: new Set(),
    allowLarge: new Set(),
    maxBytes: DEFAULT_MAX_BYTES,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--allow', '--allow-large', '--max-size'].includes(name)) {
      throw new Error(`devkit-precommit: unknown argument ${name}`)
    }
    if (!value) throw new Error(`devkit-precommit: ${name} needs a value`)
    index += 1

    if (name === '--allow') options.allow.add(value)
    else if (name === '--allow-large') options.allowLarge.add(value)
    else options.maxBytes = parseSize(value)
  }
  return options
}

/** Turns `5MB`, `512KB` or a plain byte count into bytes. */
export function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(KB|MB|B)?$/i.exec(value.trim())
  if (!match)
    throw new Error(
      `devkit-precommit: --max-size ${value} is not a size such as 5MB`,
    )
  const units = { B: 1, KB: 1024, MB: 1024 * 1024 }
  return Math.round(Number(match[1]) * units[(match[2] ?? 'B').toUpperCase()])
}

/** Why a staged path may never be committed by name alone, or null. */
export function forbiddenName(file) {
  const name = path.posix.basename(file)
  const lower = name.toLowerCase()
  if (file.split('/').includes('.secrets')) return 'is under a .secrets/ folder'
  if (KEY_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return 'is signing material or a key'
  }
  const isEnvFile = name === '.env' || name.startsWith('.env.')
  if (isEnvFile && !name.endsWith('.example')) return 'is an environment file'
  return null
}

/** Runs git in `root` and returns its stdout as a Buffer. */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024 })
}

/**
 * The staged paths that are added, copied, modified or renamed, skipping submodule pointers,
 * which are commits rather than files. `--raw -z` gives `:<modes> <shas> <status>` and then the
 * path (two paths for a rename or copy, the new one last).
 */
function stagedPaths(root) {
  const fields = git(root, [
    'diff',
    '--cached',
    '--raw',
    '-z',
    '--diff-filter=ACMR',
  ])
    .toString('utf8')
    .split('\0')
  const paths = []
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]
    if (!header.startsWith(':')) continue
    const [, newMode, , , status] = header.slice(1).split(' ')
    const pathCount = /^[RC]/.test(status) ? 2 : 1
    const file = fields[index + pathCount]
    index += pathCount
    if (newMode !== '160000') paths.push(file)
  }
  return paths
}

/** True when the staged contents hold a private key; binary files are skipped. */
function holdsPrivateKey(root, file) {
  const contents = git(root, ['show', `:${file}`])
  if (contents.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return false
  return PRIVATE_KEY.test(contents.toString('utf8'))
}

/**
 * Returns every staged file that must not be committed, as `{ file, reason }`. A path in
 * `allow` skips every check; a path in `allowLarge` skips only the size limit.
 */
export function checkStaged(root, options) {
  const problems = []
  for (const file of stagedPaths(root)) {
    if (options.allow.has(file)) continue

    const reason = forbiddenName(file)
    if (reason) {
      problems.push({ file, reason })
      continue
    }

    const bytes = Number(
      git(root, ['cat-file', '-s', `:${file}`])
        .toString()
        .trim(),
    )
    if (bytes > options.maxBytes && !options.allowLarge.has(file)) {
      const megabytes = (bytes / 1024 / 1024).toFixed(1)
      problems.push({ file, reason: `is ${megabytes} MB, over the size limit` })
      continue
    }

    if (holdsPrivateKey(root, file)) {
      problems.push({ file, reason: 'contains a private key' })
    }
  }
  return problems
}
