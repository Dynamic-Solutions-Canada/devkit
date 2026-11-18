import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareEntries,
  readZipEntries,
} from '../scripts/check-browser-extension.mjs'
import { trackedVsixPath } from '../scripts/build-browser-extension.mjs'

test('the tracked bridge package reads as a zip with the extension source inside', () => {
  const entries = readZipEntries(trackedVsixPath)
  assert.ok(entries.has('extension.vsixmanifest'))
  assert.ok(entries.has('extension/extension.js'))
  assert.match(
    entries.get('extension/package.json').toString('utf8'),
    /"name": "devkit-browser"/,
  )
})

test('a rebuild is compared by entry names and contents, not archive bytes', () => {
  const tracked = readZipEntries(trackedVsixPath)
  assert.deepEqual(compareEntries(tracked, new Map(tracked)), [])

  const changed = new Map(tracked)
  changed.set('extension/extension.js', Buffer.from('changed'))
  changed.delete('extension/url.cjs')
  changed.set('extension/extra.js', Buffer.from(''))
  assert.deepEqual(compareEntries(changed, tracked).sort(), [
    'differs: extension/extension.js',
    'only in the rebuild: extension/extra.js',
    'only in the tracked file: extension/url.cjs',
  ])
})
