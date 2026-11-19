/**
 * The icon size tables (ASSET-5 Windows, ASSET-6 Android, ASSET-7 web, ASSET-1 cross-surface
 * exports), as lists of outputs. Each output names its repo-relative path and how to build it from
 * the masters; nothing here draws art or knows an app.
 *
 * An output is `{ path, svg }` for a single render, `{ path, ico }` for a packed icon, or
 * `{ path, text }` for a file written as is (vector XML and the SVG favicon).
 */
import path from 'node:path'

import { canvas, flatPaths, place, recolour } from './svg.mjs'

/** Windows draws the plate itself, so every Windows image stays transparent around the art. */
const WINDOWS_SCALES = [100, 125, 150, 200, 400]
const WINDOWS_TARGET_SIZES = [
  16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256,
]
const WINDOWS_ICO_FRAMES = [
  16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256,
]
const WINDOWS_LOGOS = {
  StoreLogo: [50, 50],
  Square44x44Logo: [44, 44],
  Square150x150Logo: [150, 150],
  SplashScreen: [620, 300],
}
const WINDOWS_TILES = {
  Wide310x150Logo: [310, 150],
  Square71x71Logo: [71, 71],
  Square310x310Logo: [310, 310],
}
/** The light-taskbar form is the monochrome master drawn dark (ASSET-5). */
const LIGHT_TASKBAR_COLOR = '#1F1F1F'

/** Where the 512 px Play icon goes unless `playPath` says otherwise: beside, not among, the screenshots. */
export const DEFAULT_PLAY_PATH = 'store-assets/play/graphics/icon.png'

/** The Play icon's path before 0.21.0, now listed as superseded when it lingers. */
export const OLD_PLAY_PATH = 'store-assets/play/icon.png'

/** Resource names the Android target owns; a same-named file anywhere else in `res/` shadows ours. */
export const ANDROID_RESOURCE_NAMES = [
  'ic_launcher',
  'ic_launcher_round',
  'ic_launcher_foreground',
  'ic_launcher_background',
  'ic_launcher_monochrome',
  'ic_stat',
]

const ANDROID_LEGACY = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
}

/** A master at `width` by `height`, square art centred: full size when square, half height when wide. */
function sized(master, width, height, options) {
  const size = width === height ? width : Math.round(height * 0.5)
  const x = (width - size) / 2
  const y = (height - size) / 2
  return canvas(width, height, place(master, { x, y, size }), options)
}

/** Requires one optional master, naming the target that needs it. */
function need(masters, name, target) {
  if (!masters[name]) {
    throw new Error(
      `devkit-icons: the ${target} target needs assets/brand/${name}`,
    )
  }
  return masters[name]
}

/**
 * The master for one opaque output that a repo may draw from either master: `"icon"` (the
 * default) or `"maskable"`, whose full-bleed art suits a surface that crops its own corners.
 * The output still sits on `background`, so it stays opaque either way.
 */
function chosenMaster(masters, choice, target) {
  if (choice === 'maskable') return need(masters, 'icon-maskable.svg', target)
  return masters['icon.svg']
}

/** ASSET-1: the small exports every surface (README, website, promo catalog) links to. */
export function generatedOutputs(masters) {
  return [256, 512].map((px) => ({
    path: `assets/generated/icon-${px}.png`,
    svg: sized(masters['icon.svg'], px, px),
  }))
}

/** ASSET-7: favicon, manifest icons in both purposes, and the opaque iOS icon. */
export function webOutputs(
  masters,
  { dir, appleTouchMaster = 'icon' },
  { background },
) {
  const icon = masters['icon.svg']
  const maskable = need(masters, 'icon-maskable.svg', 'web')
  const appleTouch = chosenMaster(masters, appleTouchMaster, 'web')
  return [
    {
      path: path.posix.join(dir, 'icon.svg'),
      text: masters.source['icon.svg'],
    },
    ...[192, 512].map((px) => ({
      path: path.posix.join(dir, `icon-${px}.png`),
      svg: sized(icon, px, px),
    })),
    ...[192, 512].map((px) => ({
      path: path.posix.join(dir, `maskable-icon-${px}.png`),
      svg: sized(maskable, px, px),
    })),
    {
      path: path.posix.join(dir, 'apple-touch-icon.png'),
      svg: sized(appleTouch, 180, 180, { background }),
    },
  ]
}

/** ASSET-5: MSIX logos at every scale, taskbar target sizes in three forms, and the `.ico`. */
export function windowsOutputs(masters, { images, ico, tiles = false }) {
  const icon = masters['icon.svg']
  const light = recolour(
    need(masters, 'icon-mono.svg', 'windows'),
    LIGHT_TASKBAR_COLOR,
  )
  const outputs = []

  const logos = tiles ? { ...WINDOWS_LOGOS, ...WINDOWS_TILES } : WINDOWS_LOGOS
  for (const [name, [width, height]] of Object.entries(logos)) {
    for (const scale of WINDOWS_SCALES) {
      const suffix = scale === 100 ? '' : `.scale-${scale}`
      outputs.push({
        path: path.posix.join(images, `${name}${suffix}.png`),
        svg: sized(
          icon,
          Math.round((width * scale) / 100),
          Math.round((height * scale) / 100),
        ),
      })
    }
  }

  for (const size of WINDOWS_TARGET_SIZES) {
    const base = path.posix.join(images, `Square44x44Logo.targetsize-${size}`)
    outputs.push({ path: `${base}.png`, svg: sized(icon, size, size) })
    outputs.push({
      path: `${base}_altform-unplated.png`,
      svg: sized(icon, size, size),
    })
    outputs.push({
      path: `${base}_altform-lightunplated.png`,
      svg: sized(light, size, size),
    })
  }

  outputs.push({
    path: ico,
    ico: WINDOWS_ICO_FRAMES.map((size) => ({
      size,
      svg: sized(icon, size, size),
    })),
  })
  outputs.push({
    path: ico.replace(/\.ico$/, '.png'),
    svg: sized(icon, 256, 256),
  })
  return outputs
}

/**
 * One Android vector drawable on the 108 dp adaptive canvas, with the art scaled into the central
 * `artDp`. `color` overrides every fill (monochrome and notification icons).
 */
function vectorDrawable(master, { canvasDp = 108, artDp = 66, color } = {}) {
  const [minX, minY, width, height] = master.viewBox
  const scale = artDp / Math.max(width, height)
  const offset = (canvasDp - artDp) / 2
  const paths = flatPaths(master)
    .map(
      ({ d, fill }) =>
        `    <path android:fillColor="${color ?? fill}" android:pathData="${d}"/>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by devkit-icons. Do not edit: change the master in assets/brand/ and regenerate. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${canvasDp}dp" android:height="${canvasDp}dp" android:viewportWidth="${canvasDp}" android:viewportHeight="${canvasDp}">
  <group android:translateX="${offset - minX * scale}" android:translateY="${offset - minY * scale}" android:scaleX="${scale}" android:scaleY="${scale}">
${paths}
  </group>
</vector>
`
}

/** The adaptive icon definition, shared by the square and round launcher entries. */
const ADAPTIVE_ICON = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by devkit-icons. Do not edit: change the master in assets/brand/ and regenerate. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@drawable/ic_launcher_background"/>
  <foreground android:drawable="@drawable/ic_launcher_foreground"/>
  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
`

/** ASSET-6: adaptive vector icon, notification icon, optional legacy rasters, and the Play icon. */
export function androidOutputs(
  masters,
  {
    res,
    legacy = false,
    play = true,
    playPath = DEFAULT_PLAY_PATH,
    playMaster = 'icon',
  },
  { background },
) {
  const icon = masters['icon.svg']
  const mono = need(masters, 'icon-mono.svg', 'android')
  const backgroundVector = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by devkit-icons. Do not edit: set "background" in assets/brand/icons.json and regenerate. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="${background}" android:pathData="M0,0h108v108h-108z"/>
</vector>
`
  const outputs = [
    {
      path: path.posix.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'),
      text: ADAPTIVE_ICON,
    },
    {
      path: path.posix.join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'),
      text: ADAPTIVE_ICON,
    },
    {
      path: path.posix.join(res, 'drawable/ic_launcher_background.xml'),
      text: backgroundVector,
    },
    {
      path: path.posix.join(res, 'drawable/ic_launcher_foreground.xml'),
      text: vectorDrawable(icon),
    },
    {
      path: path.posix.join(res, 'drawable/ic_launcher_monochrome.xml'),
      text: vectorDrawable(mono, { color: '#FFFFFFFF' }),
    },
    {
      path: path.posix.join(res, 'drawable/ic_stat.xml'),
      text: vectorDrawable(mono, {
        canvasDp: 24,
        artDp: 20,
        color: '#FFFFFFFF',
      }),
    },
  ]

  if (legacy) {
    for (const [density, px] of Object.entries(ANDROID_LEGACY)) {
      const folder = path.posix.join(res, `mipmap-${density}`)
      outputs.push({
        path: `${folder}/ic_launcher.png`,
        svg: sized(icon, px, px, { background }),
      })
      outputs.push({
        path: `${folder}/ic_launcher_round.png`,
        svg: sized(icon, px, px, { background, clipCircle: true }),
      })
    }
  }
  if (play) {
    outputs.push({
      path: playPath,
      svg: sized(
        chosenMaster(masters, playMaster, 'android Play icon'),
        512,
        512,
        { background },
      ),
    })
  }
  return outputs
}
