import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

import {
  buildBrowserExtension,
  trackedVsixName,
  trackedVsixPath,
} from './build-browser-extension.mjs'

// The tracked .vsix is the one build output devkit commits (D-042): apps install devkit from a
// git tag with no build step, and src/browser.mjs installs this file from the package. This check
// rebuilds it from source and fails when the result differs. The packager stamps each zip entry
// with the build time, so the archives never match byte for byte; the entries' names and contents
// are compared instead.

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

/**
 * Reads every entry of a zip archive into a Map of name to uncompressed contents. Handles the
 * stored and deflate methods, which is all the packager writes; anything else throws.
 */
export function readZipEntries(file) {
  const zip = readFileSync(file)

  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let end = -1
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error(`${file} is not a zip archive`)

  const count = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  const entries = new Map()

  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`${file} has a damaged central directory`)
    }
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localHeader = zip.readUInt32LE(cursor + 42)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    // The data starts after the local header, whose own name and extra lengths may differ.
    if (zip.readUInt32LE(localHeader) !== LOCAL_FILE_HEADER) {
      throw new Error(`${file} has a damaged entry: ${name}`)
    }
    const dataStart =
      localHeader +
      30 +
      zip.readUInt16LE(localHeader + 26) +
      zip.readUInt16LE(localHeader + 28)
    const data = zip.subarray(dataStart, dataStart + compressedSize)

    if (method === 0) entries.set(name, Buffer.from(data))
    else if (method === 8) entries.set(name, inflateRawSync(data))
    else
      throw new Error(`${file}: unsupported compression ${method} for ${name}`)

    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** Lists the entry names that are missing from either side or whose contents differ. */
export function compareEntries(expected, actual) {
  const differences = []
  for (const [name, contents] of expected) {
    if (!actual.has(name)) differences.push(`only in the rebuild: ${name}`)
    else if (!contents.equals(actual.get(name)))
      differences.push(`differs: ${name}`)
  }
  for (const name of actual.keys()) {
    if (!expected.has(name))
      differences.push(`only in the tracked file: ${name}`)
  }
  return differences
}

/** Rebuilds the extension into a temporary folder and compares it with the tracked file. */
function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), 'devkit-vsix-'))
  try {
    const rebuilt = path.join(workDir, trackedVsixName)
    const status = buildBrowserExtension(rebuilt)
    if (status !== 0) {
      process.exitCode = status
    } else {
      const differences = compareEntries(
        readZipEntries(rebuilt),
        readZipEntries(trackedVsixPath),
      )
      if (differences.length > 0) {
        console.error(
          `vscode-extension/${trackedVsixName} does not match a rebuild from source:`,
        )
        for (const line of differences) console.error(`  ${line}`)
        console.error(
          'Run `npm run build:browser-extension` and commit the result. Bump the extension version too if its behaviour changed, so installed copies update.',
        )
        process.exitCode = 1
      } else {
        console.log(
          `vscode-extension/${trackedVsixName} matches a rebuild from source.`,
        )
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
