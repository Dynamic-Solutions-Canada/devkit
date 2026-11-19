/**
 * Reads the production dependency closure of one package folder, and what each third-party
 * package in it declares and ships about its licence.
 *
 * The closure comes from `npm ls --omit=dev --all --parseable`, run in the folder itself when it
 * has its own lockfile, and from the repo root with `--workspace <folder>` otherwise. Only the
 * paths npm prints are used to find files; none of them reaches the output.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

/** File names that hold a licence or a notice a package ships. */
const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense)(\..*)?$/i

/** npm's `license` value naming a file instead of an SPDX id. */
const SEE_LICENSE_IN = /^SEE LICEN[SC]E IN (.+)$/i

/**
 * Returns the real directories of every package in `folder`'s production closure, including the
 * repo's own packages; the caller decides what is third party. Throws with npm's message when the
 * installed tree is missing or invalid.
 */
export function closureDirectories(root, folder, { npm = 'npm' } = {}) {
  const packageDir = path.join(root, folder)
  const standalone = existsSync(path.join(packageDir, 'package-lock.json'))
  const args = ['ls', '--omit=dev', '--all', '--parseable']
  if (!standalone) args.push('--workspace', folder)

  let output
  try {
    output = execFileSync(npm, args, {
      cwd: standalone ? packageDir : root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim()
    throw new Error(
      `devkit-notices: npm ls failed for ${folder}; install its dependencies first.\n${detail}`,
      { cause: error },
    )
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((directory) => realpath(directory))
}

/** The real path of `directory`, or the path itself when it cannot be resolved. */
function realpath(directory) {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/**
 * True for an installed dependency. A package whose real folder is not inside a `node_modules`
 * folder is the repo's own: the root, a workspace, or a `file:` link.
 */
export function isThirdParty(directory) {
  return directory.split(path.sep).includes('node_modules')
}

/**
 * Reads one package's record: name, version, declared licence (null when it declares none),
 * publisher, repository and the licence text it ships. Returns null when it has no readable
 * `package.json` with a name.
 */
export function readPackage(directory) {
  let manifest
  try {
    manifest = JSON.parse(
      readFileSync(path.join(directory, 'package.json'), 'utf8'),
    )
  } catch {
    return null
  }
  if (!manifest.name) return null

  const license = readLicenseId(manifest)
  return {
    name: manifest.name,
    version: manifest.version ?? '',
    license,
    publisher: readPublisher(manifest),
    repository: readRepository(manifest),
    text: readLicenseText(directory, license),
  }
}

/** Normalises the shapes `license` and the older `licenses` field take; null when neither says. */
export function readLicenseId(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) {
    return manifest.license.trim()
  }
  if (manifest.license && typeof manifest.license === 'object') {
    if (manifest.license.type) return manifest.license.type
  }
  if (Array.isArray(manifest.licenses)) {
    const ids = manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean)
    if (ids.length > 0) return ids.join(' OR ')
  }
  return null
}

/** The package's author on one line, or an empty string. */
function readPublisher(manifest) {
  const author = manifest.author
  if (typeof author === 'string') return author
  if (author && typeof author === 'object' && author.name) {
    return author.email ? `${author.name} <${author.email}>` : author.name
  }
  return ''
}

/** The package's repository as a URL, falling back to its home page, or an empty string. */
function readRepository(manifest) {
  const repository = manifest.repository
  if (typeof repository === 'string') return repository
  if (repository && typeof repository === 'object' && repository.url) {
    return repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  }
  return manifest.homepage || ''
}

/**
 * The licence and notice files a package ships, each under a heading, with line endings made LF
 * so the result is the same on every checkout. Includes the file a `SEE LICENSE IN <file>`
 * licence names, when it is inside the package. Shortest name first, so LICENSE leads.
 */
function readLicenseText(directory, license) {
  let names
  try {
    names = readdirSync(directory).filter((name) => LICENSE_FILE.test(name))
  } catch {
    return ''
  }

  const named = SEE_LICENSE_IN.exec(license ?? '')?.[1]?.trim()
  if (named && !names.includes(named) && isInside(directory, named)) {
    names.push(named)
  }

  const files = names
    .filter((name) => isFile(path.join(directory, name)))
    .sort(
      (first, second) => first.length - second.length || compare(first, second),
    )

  const chunks = []
  for (const name of files) {
    try {
      const text = readFileSync(path.join(directory, name), 'utf8')
      chunks.push(`----- ${name} -----\n${text.replace(/\r\n?/g, '\n').trim()}`)
    } catch {
      // An unreadable file is skipped; the declared licence still appears.
    }
  }
  return chunks.join('\n\n')
}

/** True when the relative `name` stays inside `directory`. */
function isInside(directory, name) {
  const resolved = path.resolve(directory, name)
  return resolved.startsWith(directory + path.sep)
}

/** True when `file` exists and is a regular file. */
function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Code-point order, so sorting does not depend on the machine's locale. */
export function compare(first, second) {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}
