import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Resvg } from '@resvg/resvg-js'

import {
  checkIcons,
  loadRenderer,
  planIcons,
  writeIcons,
} from '../src/icons/index.mjs'

const devkitRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = path.join(devkitRoot, 'bin/devkit-icons.mjs')

// A flat two-path mark: an ink square with a gold bar, the shape outlined art takes.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#17181D" d="M0 0H100V100H0Z"/><path fill="#F7B733" d="M30 20H70V80H30Z"/></svg>'
const MASKABLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#17181D" d="M0 0H100V100H0Z"/><path fill="#F7B733" d="M38 28H62V72H38Z"/></svg>'
const MONO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#FFFFFF" d="M30 20H70V80H30Z"/></svg>'

const ALL_TARGETS = {
  background: '#17181D',
  targets: {
    web: { dir: 'apps/web/public' },
    windows: { images: 'AppMSIX/Images', ico: 'App/Resources/App.ico' },
    android: { res: 'android/app/src/main/res', legacy: true },
  },
}

/** A temporary repo with masters, a config, and devkit's resvg reachable as the repo's own. */
function repo(
  t,
  {
    config = ALL_TARGETS,
    masters = {
      'icon.svg': ICON,
      'icon-maskable.svg': MASKABLE,
      'icon-mono.svg': MONO,
    },
    renderer = true,
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-icons-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'assets/brand'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), '{}')
  writeFileSync(
    path.join(root, 'assets/brand/icons.json'),
    JSON.stringify(config),
  )
  for (const [name, svg] of Object.entries(masters)) {
    writeFileSync(path.join(root, 'assets/brand', name), svg)
  }
  if (renderer) {
    mkdirSync(path.join(root, 'node_modules/@resvg'), { recursive: true })
    symlinkSync(
      path.join(devkitRoot, 'node_modules/@resvg/resvg-js'),
      path.join(root, 'node_modules/@resvg/resvg-js'),
    )
  }
  return root
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buffer) {
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
}

/** RGBA of one pixel of an output's SVG, rendered the way the generator renders it. */
function pixel(output, x, y) {
  const image = new Resvg(output.svg).render()
  const offset = (y * image.width + x) * 4
  return [...image.pixels.subarray(offset, offset + 4)]
}

test('every target writes the size tables from the masters', (t) => {
  const root = repo(t)
  const written = writeIcons(root)

  const sizes = {
    'assets/generated/icon-256.png': [256, 256],
    'apps/web/public/maskable-icon-512.png': [512, 512],
    'apps/web/public/apple-touch-icon.png': [180, 180],
    'AppMSIX/Images/SplashScreen.scale-200.png': [1240, 600],
    'AppMSIX/Images/Square44x44Logo.scale-125.png': [55, 55],
    'AppMSIX/Images/Square44x44Logo.targetsize-256_altform-lightunplated.png': [
      256, 256,
    ],
    'App/Resources/App.png': [256, 256],
    'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png': [192, 192],
    'store-assets/play/icon.png': [512, 512],
  }
  for (const [file, size] of Object.entries(sizes)) {
    assert.ok(written.includes(file), file)
    assert.deepEqual(pngSize(readFileSync(path.join(root, file))), size, file)
  }

  // 4 logos x 5 scales + 14 target sizes x 3 forms + the .ico and its PNG.
  assert.equal(
    written.filter((file) => file.startsWith('AppMSIX/')).length,
    20 + 42,
  )
  assert.equal(
    readFileSync(path.join(root, 'apps/web/public/icon.svg'), 'utf8'),
    ICON,
  )
})

test('the .ico holds every frame Windows asks for, as PNG', (t) => {
  const root = repo(t)
  writeIcons(root)
  const ico = readFileSync(path.join(root, 'App/Resources/App.ico'))
  assert.equal(ico.readUInt16LE(2), 1)
  const count = ico.readUInt16LE(4)
  const frames = Array.from(
    { length: count },
    (_, index) => ico.readUInt8(6 + index * 16) || 256,
  )
  assert.deepEqual(
    frames,
    [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256],
  )
  const firstOffset = ico.readUInt32LE(6 + 12)
  assert.equal(ico.subarray(firstOffset + 1, firstOffset + 4).toString(), 'PNG')
})

test('Windows images stay transparent, opaque icons sit on the background, and the light form is dark', (t) => {
  const outputs = Object.fromEntries(
    planIcons(repo(t)).map((output) => [output.path, output]),
  )

  // The splash centres the art at half height on a transparent canvas.
  assert.equal(pixel(outputs['AppMSIX/Images/SplashScreen.png'], 0, 0)[3], 0)
  assert.deepEqual(
    pixel(outputs['apps/web/public/apple-touch-icon.png'], 0, 0),
    [0x17, 0x18, 0x1d, 255],
  )

  const light = pixel(
    outputs[
      'AppMSIX/Images/Square44x44Logo.targetsize-48_altform-lightunplated.png'
    ],
    24,
    24,
  )
  assert.ok(light[0] < 0x40 && light[3] === 255, `light form is dark: ${light}`)
  const plain = pixel(
    outputs['AppMSIX/Images/Square44x44Logo.targetsize-48.png'],
    24,
    24,
  )
  assert.deepEqual(plain.slice(0, 3), [0xf7, 0xb7, 0x33])

  // Round legacy launcher icons are clipped to a circle.
  assert.equal(
    pixel(
      outputs['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png'],
      0,
      0,
    )[3],
    0,
  )
})

test('Android gets adaptive vector XML with the art in the central 66 dp', (t) => {
  const root = repo(t)
  writeIcons(root)
  const res = path.join(root, 'android/app/src/main/res')
  const foreground = readFileSync(
    path.join(res, 'drawable/ic_launcher_foreground.xml'),
    'utf8',
  )
  assert.match(foreground, /android:scaleX="0\.66"/)
  assert.match(foreground, /android:translateX="21"/)
  assert.match(
    foreground,
    /android:fillColor="#F7B733" android:pathData="M30 20H70V80H30Z"/,
  )
  assert.match(
    readFileSync(path.join(res, 'drawable/ic_launcher_monochrome.xml'), 'utf8'),
    /#FFFFFFFF/,
  )
  assert.match(
    readFileSync(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), 'utf8'),
    /<monochrome /,
  )
  assert.match(
    readFileSync(path.join(res, 'drawable/ic_launcher_background.xml'), 'utf8'),
    /#17181D/,
  )
})

test('the check passes after writing, and names missing or changed files', (t) => {
  const root = repo(t)
  writeIcons(root)
  assert.deepEqual(checkIcons(root), [])

  writeFileSync(path.join(root, 'assets/generated/icon-256.png'), 'edited')
  rmSync(path.join(root, 'apps/web/public/icon-192.png'))
  assert.deepEqual(checkIcons(root).sort(), [
    'apps/web/public/icon-192.png',
    'assets/generated/icon-256.png',
  ])
})

test('a target that needs a missing master, an unknown target or a missing renderer fails clearly', (t) => {
  assert.throws(
    () => planIcons(repo(t, { masters: { 'icon.svg': ICON } })),
    /needs assets\/brand\/icon-maskable\.svg/,
  )
  assert.throws(
    () =>
      planIcons(
        repo(t, {
          config: { targets: { windows: { images: 'I', ico: 'A.ico' } } },
          masters: { 'icon.svg': ICON },
        }),
      ),
    /windows target needs assets\/brand\/icon-mono\.svg/,
  )
  assert.throws(
    () => planIcons(repo(t, { config: { targets: { ios: {} } } })),
    /unknown target "ios"/,
  )
  assert.throws(
    () => planIcons(repo(t, { config: { targets: { web: { dir: 'p' } } } })),
    /"background"/,
  )
  assert.throws(
    () => writeIcons(repo(t, { renderer: false })),
    /install @resvg\/resvg-js/,
  )
})

test('Android vectors accept paths written with closing tags', (t) => {
  const closed =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#000000" d="M0 0H10V10Z"></path></svg>'
  const root = repo(t, {
    config: {
      background: '#000000',
      targets: { android: { res: 'res', play: false } },
    },
    masters: { 'icon.svg': closed, 'icon-mono.svg': closed },
  })
  assert.ok(
    planIcons(root).some(
      (output) => output.path === 'res/drawable/ic_stat.xml',
    ),
  )
})

test('Android vectors refuse masters that are not flat paths', (t) => {
  const grouped =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="scale(2)"><path fill="#000" d="M0 0H10V10Z"/></g></svg>'
  const root = repo(t, {
    config: { background: '#000000', targets: { android: { res: 'res' } } },
    masters: { 'icon.svg': grouped, 'icon-mono.svg': MONO },
  })
  assert.throws(() => planIcons(root), /must be flat <path d fill> elements/)
})

test('devkit-icons --check fails before the icons exist and passes after devkit-icons', (t) => {
  const root = repo(t, {
    config: { background: '#17181D', targets: { web: { dir: 'public' } } },
  })
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(run('--check').status, 1)
  assert.equal(run().status, 0)
  assert.equal(run('--check').status, 0)
  assert.ok(existsSync(path.join(root, 'public/apple-touch-icon.png')))
})

test('DEVKIT_ICONS_RENDERER_DIR loads the renderer from a tools folder or the package itself', (t) => {
  const appRoot = repo(t, { renderer: false })
  const realPackage = path.join(devkitRoot, 'node_modules/@resvg/resvg-js')

  // A tools folder with its own node_modules, as winui-app-kit installs.
  const tools = mkdtempSync(path.join(os.tmpdir(), 'devkit-icons-tools-'))
  t.after(() => rmSync(tools, { recursive: true, force: true }))
  mkdirSync(path.join(tools, 'node_modules/@resvg'), { recursive: true })
  symlinkSync(realPackage, path.join(tools, 'node_modules/@resvg/resvg-js'))

  assert.equal(
    typeof loadRenderer(appRoot, { DEVKIT_ICONS_RENDERER_DIR: tools }),
    'function',
  )
  assert.equal(
    typeof loadRenderer(appRoot, { DEVKIT_ICONS_RENDERER_DIR: realPackage }),
    'function',
  )
  assert.throws(
    () => loadRenderer(appRoot, {}),
    /set DEVKIT_ICONS_RENDERER_DIR/,
  )
  assert.throws(
    () => loadRenderer(appRoot, { DEVKIT_ICONS_RENDERER_DIR: appRoot }),
    /holds neither/,
  )

  // The whole command works from the tools folder in a repo with no node_modules.
  const result = spawnSync(process.execPath, [bin, '--check'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DEVKIT_ICONS_RENDERER_DIR: tools },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /do not match their masters/)
})

test('without the variable the renderer still comes from the repo', (t) => {
  const appRoot = repo(t)
  assert.equal(typeof loadRenderer(appRoot, {}), 'function')
})
