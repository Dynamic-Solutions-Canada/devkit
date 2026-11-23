/**
 * The fonts every hero is drawn with, pinned by hash and fetched once into a cache.
 *
 * Segoe UI, the Windows face, is licensed only with Windows and is absent from Linux, CI and
 * containers, so heroes use Noto Sans for Latin text and Noto Sans CJK (the SC and JP subsets)
 * for Chinese and Japanese, all under the SIL Open Font License. Japanese and Simplified Chinese
 * draw some shared Han characters differently, so each CJK locale gets its own regional font.
 *
 * The files total about 27 MB, too much to ship to every app that installs devkit, so they are
 * downloaded from the upstream Noto repositories on first use, checked against a SHA-256, and
 * kept in a per-user cache. `DEVKIT_FONTS_DIR` points at another folder instead (a CI cache, or
 * an offline copy); files there are checked by hash too. Pinned bytes are what make `--check`
 * reproducible: the same font, renderer and inputs should draw the same pixels on every machine
 * (shown so far on Linux x64; see "Store heroes" in the README).
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LATIN_BASE =
  'https://raw.githubusercontent.com/notofonts/notofonts.github.io/682229039c5a594f247890d94e3fb497be8d58dd/fonts/NotoSans/unhinted/ttf'
const CJK_BASE =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF'

/** Every font file, with where it comes from and the hash it must have. */
export const FONT_FILES = [
  {
    file: 'NotoSans-Regular.ttf',
    url: `${LATIN_BASE}/NotoSans-Regular.ttf`,
    sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  },
  {
    file: 'NotoSans-Bold.ttf',
    url: `${LATIN_BASE}/NotoSans-Bold.ttf`,
    sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
  },
  {
    file: 'NotoSansSC-Regular.otf',
    url: `${CJK_BASE}/SC/NotoSansSC-Regular.otf`,
    sha256: 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9',
  },
  {
    file: 'NotoSansSC-Bold.otf',
    url: `${CJK_BASE}/SC/NotoSansSC-Bold.otf`,
    sha256: 'c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0',
  },
  {
    file: 'NotoSansJP-Regular.otf',
    url: `${CJK_BASE}/JP/NotoSansJP-Regular.otf`,
    sha256: 'dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073',
  },
  {
    file: 'NotoSansJP-Bold.otf',
    url: `${CJK_BASE}/JP/NotoSansJP-Bold.otf`,
    sha256: '1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f',
  },
]

const LATIN = 'Noto Sans'

/**
 * The font family for a locale's text. Japanese and Simplified Chinese use their regional Noto
 * Sans CJK font for the whole text, Latin letters included (it has its own matching Latin), rather
 * than Noto Sans with a CJK fallback: resvg picks a fallback font without regard to weight, so a
 * bold headline would come out regular. Every other locale uses Noto Sans.
 *
 * @throws for Chinese other than Simplified, and for Korean, which have no pinned font yet
 */
export function fontFamily(locale) {
  const [language, ...rest] = locale.toLowerCase().split('-')
  if (language === 'ja') return 'Noto Sans JP'
  if (language === 'zh') {
    const simplified =
      rest.length === 0 ||
      rest.some((part) => ['cn', 'sg', 'hans'].includes(part))
    if (simplified) return 'Noto Sans SC'
  }
  if (language === 'zh' || language === 'ko') {
    throw new Error(
      `devkit-store-hero: no font is pinned for ${locale} yet; devkit has Latin, Japanese and Simplified Chinese`,
    )
  }
  return LATIN
}

/** The folder fonts are read from: `DEVKIT_FONTS_DIR`, or devkit's per-user cache. */
export function fontsDir(env = process.env) {
  const configured = env.DEVKIT_FONTS_DIR?.trim()
  if (configured) return path.resolve(configured)

  const cacheRoot =
    process.platform === 'win32'
      ? (env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
      : (env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'))
  return path.join(cacheRoot, 'devkit', 'fonts')
}

/** SHA-256 of `bytes`, as hex. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** True when `file` exists and has the pinned hash. */
function isPinned(file, expected) {
  return existsSync(file) && sha256(readFileSync(file)) === expected
}

/**
 * Downloads one font, checks its hash, and moves it into place, so an interrupted download never
 * leaves a partial file under the final name.
 */
async function download(font, target, fetchImpl) {
  let bytes
  try {
    const response = await fetchImpl(font.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(
      `devkit-store-hero: could not download ${font.file} from ${font.url} (${error.message}). Connect to the internet once, or set DEVKIT_FONTS_DIR to a folder holding ${FONT_FILES.map(({ file }) => file).join(', ')}.`,
      { cause: error },
    )
  }

  const actual = sha256(bytes)
  if (actual !== font.sha256) {
    throw new Error(
      `devkit-store-hero: ${font.url} has SHA-256 ${actual}, not the pinned ${font.sha256}; refusing to use it`,
    )
  }
  const partial = `${target}.partial-${process.pid}`
  writeFileSync(partial, bytes)
  renameSync(partial, target)
}

/**
 * Makes sure every pinned font is in the fonts folder, downloading what is missing or differs,
 * and returns their paths. `log` reports each download, since the first one takes a while.
 *
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, log?: (message: string) => void,
 *   files?: typeof FONT_FILES }} options `files` replaces the pinned list, for tests
 * @returns {Promise<string[]>}
 */
export async function ensureFonts({
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
  files = FONT_FILES,
} = {}) {
  const dir = fontsDir(env)
  mkdirSync(dir, { recursive: true })

  const paths = []
  for (const font of files) {
    const target = path.join(dir, font.file)
    if (!isPinned(target, font.sha256)) {
      log(`devkit-store-hero: downloading ${font.file} into ${dir}`)
      await download(font, target, fetchImpl)
    }
    paths.push(target)
  }
  return paths
}

/** The pinned font paths when every one is already in place, else null; never downloads. */
export function cachedFonts(env = process.env) {
  const dir = fontsDir(env)
  const paths = FONT_FILES.map((font) => path.join(dir, font.file))
  const ready = FONT_FILES.every((font, index) =>
    isPinned(paths[index], font.sha256),
  )
  return ready ? paths : null
}
