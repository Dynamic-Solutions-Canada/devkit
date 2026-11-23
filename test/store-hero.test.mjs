import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
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
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { Resvg } from '@resvg/resvg-js'

import { loadHeroJobs, parseSize } from '../src/store-hero/config.mjs'
import {
  cachedFonts,
  ensureFonts,
  fontFamily,
  fontsDir,
} from '../src/store-hero/fonts.mjs'
import {
  checkHeroes,
  orphanedHeroes,
  writeHeroes,
} from '../src/store-hero/index.mjs'
import { splitLayout } from '../src/store-hero/layouts.mjs'
import {
  encodeRgbPng,
  pngHeader,
  readRgbPng,
  rgbRows,
} from '../src/store-hero/png.mjs'
import { breakUnits, fitText, wrapText } from '../src/store-hero/text.mjs'

const devkitRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = path.join(devkitRoot, 'bin/devkit-store-hero.mjs')
const examples = path.join(devkitRoot, 'docs/examples/store-hero')

// The render tests need the pinned fonts (about 27 MB). CI caches them with
// `devkit-store-hero --fetch-fonts`; without them those tests skip rather than download.
const fonts = cachedFonts()
const needsFonts = fonts
  ? {}
  : {
      skip: `the pinned fonts are not in ${fontsDir()}; run devkit-store-hero --fetch-fonts`,
    }

/** A fixed-width measure for layout tests: every character is `size * 0.5` wide. */
const monospace = (size) => (line) => [...line].length * size * 0.5

/** Writes `contents` at `file` under `root`, creating its folder. */
function write(root, file, contents) {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

/** A 1920 x 1080 desktop capture with a plain flyout at `window`, as PNG bytes. */
function capture({ x, y, width, height }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#0B1530"/><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#20242D"/><rect x="${x + 16}" y="${y + 60}" width="${width - 32}" height="80" rx="6" fill="#4CC2FF"/></svg>`
  return Buffer.from(new Resvg(svg).render().asPng())
}

const WINDOW = { x: 1500, y: 640, width: 420, height: 380 }
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#17181D" d="M0 0H100V100H0Z"/><path fill="#F7B733" d="M30 20H70V80H30Z"/></svg>'

const HERO_ENTRY = {
  file: 'screenshots/{locale}/00-hero-dark.png',
  source: 'raw/microsoft/00-flyout-dark.png',
  theme: 'dark',
  hero: {
    layout: 'split',
    icon: 'assets/brand/icon.svg',
    primary: '#2563EB',
    accent: '#10B981',
  },
  caption: 'The flyout.',
  alt: 'The flyout, enlarged.',
}

const LOCALES = {
  'en-US': {
    title: 'Sample',
    heroHeadline: 'Every room, one click away.',
    heroSubline: 'A slider for each room.',
  },
  'en-CA': { copyFrom: 'en-US' },
  'ja-JP': {
    title: 'Sample',
    heroHeadline: 'すべての部屋を、ワンクリックで。',
    heroSubline: '部屋ごとにスライダー。',
  },
}

/**
 * A temporary repo with a hero manifest, listings, a capture and its sidecar, an icon, and
 * devkit's resvg reachable as the repo's own.
 */
function repo(
  t,
  {
    entry = HERO_ENTRY,
    locales = LOCALES,
    manifest = {},
    sidecar = { window: WINDOW },
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-store-hero-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  write(root, 'package.json', '{}')
  write(root, 'assets/brand/icon.svg', ICON)
  write(
    root,
    'store-assets/manifest.json',
    JSON.stringify({
      ...manifest,
      microsoft: [entry, { file: 'screenshots/01-more-dark.png' }],
    }),
  )
  write(
    root,
    'store-assets/microsoft/listings.json',
    JSON.stringify({ schemaVersion: 1, locales }),
  )
  write(root, 'store-assets/raw/microsoft/00-flyout-dark.png', capture(WINDOW))
  // Windows tools write the sidecar with a byte-order mark; it must still read.
  write(
    root,
    'store-assets/raw/microsoft/00-flyout-dark.json',
    `\uFEFF${JSON.stringify({ scale: 100, ...sidecar })}`,
  )

  mkdirSync(path.join(root, 'node_modules/@resvg'), { recursive: true })
  symlinkSync(
    path.join(devkitRoot, 'node_modules/@resvg/resvg-js'),
    path.join(root, 'node_modules/@resvg/resvg-js'),
  )
  return root
}

// --- Line breaking ---------------------------------------------------------------------------

test('breakUnits breaks Latin text at spaces and keeps punctuation with its word', () => {
  const units = breakUnits(
    'Plug in your hub. Your PC (and TV) switch.',
    'en-US',
  )
  assert.deepEqual(
    units.map((unit) => unit.text),
    ['Plug', 'in', 'your', 'hub.', 'Your', 'PC', '(and', 'TV)', 'switch.'],
  )
  assert.ok(units.slice(0, -1).every((unit) => unit.spaceAfter))
})

test('breakUnits breaks Japanese and Chinese between words, never before closing punctuation', () => {
  const japanese = breakUnits('すべての部屋を、ワンクリックで。', 'ja-JP').map(
    (unit) => unit.text,
  )
  assert.ok(japanese.length > 3, 'Japanese splits into several words')
  assert.equal(japanese.join(''), 'すべての部屋を、ワンクリックで。')
  for (const unit of japanese) assert.doesNotMatch(unit, /^[、。]/)

  const chinese = breakUnits('在任何耳机上平衡游戏和聊天音频。', 'zh-CN').map(
    (unit) => unit.text,
  )
  assert.ok(chinese.length > 3)
  assert.match(chinese.at(-1), /。$/)
})

test('wrapText balances lines instead of leaving a widow', () => {
  // Greedy breaking at 20 characters would give "aaaa bbbb cccc dddd" and "eeee".
  const lines = wrapText('aaaa bbbb cccc dddd eeee', {
    locale: 'en-US',
    maxWidth: 200,
    measure: monospace(20),
  })
  assert.deepEqual(lines, ['aaaa bbbb cccc', 'dddd eeee'])
})

test('wrapText keeps a forced line break', () => {
  const lines = wrapText('Swipe it away?\nIt comes back.', {
    locale: 'en-US',
    maxWidth: 1000,
    measure: monospace(20),
  })
  assert.deepEqual(lines, ['Swipe it away?', 'It comes back.'])
})

test('fitText steps down to a size that fits, and gives up below the smallest', () => {
  const text = 'Balance game and chat audio on any headset.'
  const fitted = fitText(text, {
    locale: 'en-US',
    sizes: [60, 50, 40],
    maxWidth: 300,
    maxLines: 4,
    measureAt: monospace,
  })
  assert.equal(fitted.size, 50)
  assert.ok(fitted.lines.length <= 4)

  const tooLong = fitText(text, {
    locale: 'en-US',
    sizes: [60, 50],
    maxWidth: 300,
    maxLines: 2,
    measureAt: monospace,
  })
  assert.equal(tooLong, null)

  const tooTall = fitText(text, {
    locale: 'en-US',
    sizes: [40],
    maxWidth: 300,
    maxLines: 9,
    maxHeight: 100,
    lineHeight: 1.1,
    measureAt: monospace,
  })
  assert.equal(tooTall, null)
})

// --- PNG -------------------------------------------------------------------------------------

test('PNG rows round-trip as 8-bit RGB with unfiltered rows, and other PNGs are refused', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255,
  ])
  const rows = rgbRows(rgba, 2, 2)
  const png = encodeRgbPng(rows, 2, 2)
  assert.deepEqual(pngHeader(png), { width: 2, height: 2, depth: 8, colour: 2 })
  assert.ok(readRgbPng(png, 2, 2).equals(rows))

  assert.match(readRgbPng(png, 3, 2), /2 x 2, not 3 x 2/)
  assert.match(
    readRgbPng(Buffer.from(new Resvg(ICON).render().asPng()), 100, 100),
    /not 8-bit RGB/,
  )
  assert.match(readRgbPng(Buffer.from('nope'), 2, 2), /not a PNG/)

  // The same pixels saved with a row filter, as an image editor would.
  const filtered = Buffer.from(rows)
  filtered[0] = 1
  const resaved = Buffer.concat([
    png.subarray(0, 33),
    idat(deflateSync(filtered)),
    png.subarray(png.length - 12),
  ])
  assert.match(readRgbPng(resaved, 2, 2), /rows are filtered/)
})

/** An IDAT chunk with a CRC the decoder does not check. */
function idat(data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from('IDAT'), data, Buffer.alloc(4)])
}

// --- Fonts -----------------------------------------------------------------------------------

test('fontFamily gives CJK locales their regional font and refuses scripts with none', () => {
  assert.equal(fontFamily('en-US'), 'Noto Sans')
  assert.equal(fontFamily('pt-BR'), 'Noto Sans')
  assert.equal(fontFamily('ja-JP'), 'Noto Sans JP')
  assert.equal(fontFamily('zh-CN'), 'Noto Sans SC')
  assert.equal(fontFamily('zh-Hans'), 'Noto Sans SC')
  assert.throws(() => fontFamily('zh-TW'), /no font is pinned for zh-TW/)
  assert.throws(() => fontFamily('ko-KR'), /no font is pinned/)
})

test('ensureFonts downloads into DEVKIT_FONTS_DIR, checks the hash, and reuses a good copy', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devkit-fonts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { DEVKIT_FONTS_DIR: dir }
  const bytes = Buffer.from('a font')
  const files = [
    {
      file: 'Test.ttf',
      url: 'https://fonts.example.test/Test.ttf',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ]

  let fetches = 0
  const fetchImpl = async () => {
    fetches += 1
    return { ok: true, arrayBuffer: async () => bytes }
  }
  const paths = await ensureFonts({ env, fetchImpl, files })
  assert.deepEqual(paths, [path.join(dir, 'Test.ttf')])
  assert.equal(readFileSync(paths[0], 'utf8'), 'a font')

  await ensureFonts({ env, fetchImpl, files })
  assert.equal(
    fetches,
    1,
    'a file with the pinned hash is not downloaded again',
  )

  writeFileSync(paths[0], 'tampered')
  await ensureFonts({ env, fetchImpl, files })
  assert.equal(fetches, 2, 'a file with another hash is replaced')

  const wrong = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('not it'),
  })
  rmSync(paths[0])
  await assert.rejects(
    ensureFonts({ env, fetchImpl: wrong, files }),
    /refusing to use it/,
  )
  assert.equal(existsSync(paths[0]), false)

  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }
  await assert.rejects(
    ensureFonts({ env, fetchImpl: offline, files }),
    /set DEVKIT_FONTS_DIR/,
  )
})

// --- Configuration ---------------------------------------------------------------------------

test('loadHeroJobs resolves one output per locale with its own text, skipping copyFrom locales', (t) => {
  const root = repo(t)
  const [job] = loadHeroJobs(root)
  assert.equal(job.layout, 'split')
  assert.deepEqual(job.size, { width: 1366, height: 768 })
  assert.deepEqual(
    job.capture.region,
    [1500, 640, 420, 380],
    'the whole window from the sidecar',
  )
  assert.deepEqual(
    job.outputs.map((output) => [output.locale, output.path, output.headline]),
    [
      [
        'en-US',
        path.join('store-assets/microsoft/screenshots/en-US/00-hero-dark.png'),
        'Every room, one click away.',
      ],
      [
        'ja-JP',
        path.join('store-assets/microsoft/screenshots/ja-JP/00-hero-dark.png'),
        'すべての部屋を、ワンクリックで。',
      ],
    ],
  )
})

test('loadHeroJobs names every locale that lacks a headline', (t) => {
  const locales = {
    'en-US': LOCALES['en-US'],
    'de-DE': { title: 'Sample', heroSubline: 'x' },
    'fr-FR': { title: 'Sample', heroHeadline: ' ', heroSubline: 'x' },
  }
  const root = repo(t, { locales })
  assert.throws(() => loadHeroJobs(root), /no heroHeadline for de-DE, fr-FR/)
})

test('loadHeroJobs wants a subline in every locale or none, and always for the brand card', (t) => {
  const partial = {
    'en-US': LOCALES['en-US'],
    'ja-JP': { title: 'Sample', heroHeadline: 'x' },
  }
  assert.throws(
    () => loadHeroJobs(repo(t, { locales: partial })),
    /no heroSubline for ja-JP; set it in every locale or none/,
  )

  const none = { 'en-US': { title: 'Sample', heroHeadline: 'x' } }
  assert.equal(
    loadHeroJobs(repo(t, { locales: none }))[0].outputs[0].subline,
    '',
  )

  const card = {
    ...HERO_ENTRY,
    hero: { ...HERO_ENTRY.hero, layout: 'brand-card' },
  }
  assert.throws(
    () => loadHeroJobs(repo(t, { entry: card, locales: none })),
    /the brand card needs one in every locale/,
  )
})

test('loadHeroJobs refuses a crop that cuts the window, and accepts one around it', (t) => {
  const cut = {
    ...HERO_ENTRY,
    hero: { ...HERO_ENTRY.hero, crop: [1500, 640, 420, 243] },
  }
  assert.throws(
    () => loadHeroJobs(repo(t, { entry: cut })),
    /must contain the whole window/,
  )

  const around = {
    ...HERO_ENTRY,
    hero: { ...HERO_ENTRY.hero, crop: [1480, 620, 440, 420] },
  }
  assert.deepEqual(
    loadHeroJobs(repo(t, { entry: around }))[0].capture.region,
    [1480, 620, 440, 420],
  )
})

test('fade: "bottom" lets a split crop cut only the window\'s bottom, and fades it out', (t) => {
  const withHero = (extra) => ({
    ...HERO_ENTRY,
    hero: { ...HERO_ENTRY.hero, ...extra },
  })

  // The top and sides stay whole; the bottom is cut and faded.
  const top = withHero({ crop: [1500, 640, 420, 200], fade: 'bottom' })
  const [job] = loadHeroJobs(repo(t, { entry: top }))
  assert.deepEqual(job.capture.region, [1500, 640, 420, 200])
  assert.equal(job.capture.fade, 'bottom')

  const refused = [
    [
      withHero({ crop: [1500, 640, 420, 200] }),
      /must contain the whole window/,
    ],
    [
      withHero({ crop: [1520, 640, 400, 200], fade: 'bottom' }),
      /may cut only the window's bottom edge/,
    ],
    [
      withHero({ crop: [1500, 660, 420, 200], fade: 'bottom' }),
      /may cut only the window's bottom edge/,
    ],
    [
      withHero({ crop: [1500, 640, 420, 380], fade: 'bottom' }),
      /keeps the whole window; remove fade/,
    ],
    [
      withHero({ crop: [1500, 600, 420, 30], fade: 'bottom' }),
      /ends above the window/,
    ],
    [withHero({ fade: 'bottom' }), /fade needs a crop/],
    [
      withHero({ crop: [1500, 640, 420, 200], fade: 'top' }),
      /fade can only be "bottom"/,
    ],
    [
      withHero({
        layout: 'brand-card',
        crop: [1500, 640, 420, 200],
        fade: 'bottom',
      }),
      /applies only to the split layout/,
    ],
  ]
  for (const [entry, message] of refused) {
    assert.throws(() => loadHeroJobs(repo(t, { entry })), message)
  }

  // The layout masks the window with a fade ending at the cut; a whole window has no mask.
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-store-hero-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'icon.svg', ICON)
  const draw = (capture) =>
    splitLayout(
      {
        primary: '#2563EB',
        accent: '#10B981',
        icon: path.join(root, 'icon.svg'),
        capture,
      },
      {
        locale: 'en-US',
        name: 'Sample',
        headline: 'Every room.',
        subline: '',
        path: 'hero.png',
      },
      {
        width: 1366,
        pixelsPerUnit: 1,
        family: 'Noto Sans',
        captureImage: 'data:image/png;base64,',
        measureAt: monospace,
        notes: [],
      },
    )
  const base = { width: 1920, height: 1080, scale: 100 }
  assert.match(
    draw({ ...base, region: [1500, 640, 420, 200], fade: 'bottom' }),
    /<g mask="url\(#cut-fade\)">/,
  )
  assert.doesNotMatch(
    draw({ ...base, region: [1500, 640, 420, 380], fade: null }),
    /cut-fade/,
  )
})

test('loadHeroJobs checks the entry itself', (t) => {
  const cases = [
    [
      { ...HERO_ENTRY, file: 'screenshots/00-hero-dark.png' },
      /must be a .png path containing \{locale\}/,
    ],
    [
      { ...HERO_ENTRY, hero: { ...HERO_ENTRY.hero, layout: 'poster' } },
      /layout must be "split" or "brand-card"/,
    ],
    [
      { ...HERO_ENTRY, hero: { ...HERO_ENTRY.hero, primary: 'blue' } },
      /primary must be a #RRGGBB colour/,
    ],
    [
      {
        ...HERO_ENTRY,
        hero: { ...HERO_ENTRY.hero, icon: 'assets/missing.png' },
      },
      /icon \(assets\/missing.png\) is missing/,
    ],
    [{ ...HERO_ENTRY, source: undefined }, /source must name the raw capture/],
  ]
  for (const [entry, message] of cases)
    assert.throws(() => loadHeroJobs(repo(t, { entry })), message)

  // A brand card may leave out the capture; it then has no ghosted window.
  const card = {
    ...HERO_ENTRY,
    source: undefined,
    hero: { ...HERO_ENTRY.hero, layout: 'brand-card' },
  }
  assert.equal(loadHeroJobs(repo(t, { entry: card }))[0].capture, null)
})

test('loadHeroJobs wants the hero first in its list', (t) => {
  const root = repo(t)
  const manifestFile = path.join(root, 'store-assets/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.microsoft.reverse()
  writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.throws(() => loadHeroJobs(root), /the hero must be the first entry/)
})

test('parseSize follows the manifest and keeps to the Store range and 16:9', () => {
  assert.deepEqual(parseSize(undefined), { width: 1366, height: 768 })
  assert.deepEqual(parseSize('1920x1080'), { width: 1920, height: 1080 })
  assert.deepEqual(parseSize('2732x1536'), { width: 2732, height: 1536 })
  assert.throws(() => parseSize('1080x1920'), /about 16:9/)
  assert.throws(() => parseSize('1280x720'), /from 1366x768/)
  assert.throws(() => parseSize('big'), /is not WIDTHxHEIGHT/)
})

test('a 200% capture draws its window at the same size as a 100% one, from twice the pixels', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-store-hero-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'icon.svg', ICON)

  /** The window's clip rectangle in the split layout's SVG, for a capture at `scale` percent. */
  const windowClip = (scale) => {
    const factor = scale / 100
    const job = {
      primary: '#2563EB',
      accent: '#10B981',
      icon: path.join(root, 'icon.svg'),
      capture: {
        width: 1920 * factor,
        height: 1080 * factor,
        scale,
        region: [WINDOW.x, WINDOW.y, WINDOW.width, WINDOW.height].map(
          (value) => value * factor,
        ),
      },
    }
    const output = {
      locale: 'en-US',
      name: 'Sample',
      headline: 'Every room.',
      subline: '',
      path: 'hero.png',
    }
    const context = {
      width: 1366,
      pixelsPerUnit: 1,
      family: 'Noto Sans',
      captureImage: 'data:image/png;base64,',
      measureAt: monospace,
      notes: [],
    }
    const svg = splitLayout(job, output, context)
    return {
      clip: /<clipPath id="window"><rect ([^/]+)\/>/.exec(svg)[1],
      upscale: context.notes[0].upscale,
    }
  }

  const normal = windowClip(100)
  const sharp = windowClip(200)
  assert.equal(sharp.clip, normal.clip)
  assert.ok(
    Math.abs(sharp.upscale - normal.upscale / 2) < 1e-9,
    'each captured pixel is enlarged half as much',
  )
})

// --- Rendering (needs the pinned fonts) ------------------------------------------------------

test(
  'writeHeroes draws every locale, and checkHeroes passes until an input changes',
  needsFonts,
  async (t) => {
    const root = repo(t)
    const { written } = await writeHeroes(root)
    assert.equal(written.length, 2)
    for (const file of written) {
      assert.deepEqual(pngHeader(readFileSync(path.join(root, file))), {
        width: 1366,
        height: 768,
        depth: 8,
        colour: 2,
      })
    }
    assert.deepEqual(await checkHeroes(root), [])

    // A changed headline makes only that locale's hero stale.
    const listingsFile = path.join(root, 'store-assets/microsoft/listings.json')
    const listings = JSON.parse(readFileSync(listingsFile, 'utf8'))
    listings.locales['ja-JP'].heroHeadline = 'すべての部屋を、トレイから。'
    writeFileSync(listingsFile, JSON.stringify(listings))
    assert.deepEqual(await checkHeroes(root), [
      {
        path: path.join(
          'store-assets/microsoft/screenshots/ja-JP/00-hero-dark.png',
        ),
        reason: 'differs from its inputs',
      },
    ])
  },
)

test('the hero follows the manifest size', needsFonts, async (t) => {
  const root = repo(t, {
    manifest: { size: '1920x1080' },
    locales: { 'en-US': LOCALES['en-US'] },
  })
  const { written } = await writeHeroes(root)
  assert.deepEqual(pngHeader(readFileSync(path.join(root, written[0]))), {
    width: 1920,
    height: 1080,
    depth: 8,
    colour: 2,
  })
})

test(
  'a headline too long for the layout fails, naming the locale',
  needsFonts,
  async (t) => {
    const long =
      'Balance game and chat audio on any headset with a slider for every device you own '.repeat(
        3,
      )
    const root = repo(t, {
      locales: { 'de-DE': { title: 'Sample', heroHeadline: long } },
    })
    await assert.rejects(
      writeHeroes(root),
      /the de-DE heroHeadline does not fit/,
    )
  },
)

test(
  'devkit-store-hero --check fails on a stale hero and a removed locale, and passes when current',
  needsFonts,
  async (t) => {
    const root = repo(t)
    const run = (...args) =>
      spawnSync(process.execPath, [bin, ...args], {
        cwd: root,
        encoding: 'utf8',
      })

    assert.equal(run('--check').status, 1, 'nothing written yet')
    assert.equal(run().status, 0)
    assert.equal(run('--check').status, 0)

    // A hero for a locale the listing dropped is named, not deleted.
    write(
      root,
      'store-assets/microsoft/screenshots/fr-FR/00-hero-dark.png',
      'old',
    )
    assert.deepEqual(orphanedHeroes(root), [
      path.join('store-assets/microsoft/screenshots/fr-FR/00-hero-dark.png'),
    ])
    const result = run('--check')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /fr-FR\/00-hero-dark.png/)
  },
)

test(
  '--assets reads a store-assets folder that is not at the repo root',
  needsFonts,
  async (t) => {
    const root = repo(t, { locales: { 'en-US': LOCALES['en-US'] } })
    cpSync(
      path.join(root, 'store-assets'),
      path.join(root, 'apps/desktop/store-assets'),
      { recursive: true },
    )
    rmSync(path.join(root, 'store-assets'), { recursive: true })
    const { written } = await writeHeroes(root, {
      assetsDir: 'apps/desktop/store-assets',
    })
    assert.deepEqual(written, [
      path.join(
        'apps/desktop/store-assets/microsoft/screenshots/en-US/00-hero-dark.png',
      ),
    ])
  },
)

test('the committed examples match what devkit draws', needsFonts, async () => {
  for (const layout of ['split', 'brand-card']) {
    assert.deepEqual(
      await checkHeroes(path.join(examples, layout), {
        env: { ...process.env, DEVKIT_ICONS_RENDERER_DIR: devkitRoot },
      }),
      [],
      layout,
    )
  }
})
