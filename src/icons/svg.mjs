/**
 * SVG handling for the icon generator: reading a master's viewBox, placing it on a canvas,
 * recolouring a monochrome master, and turning a flat master into Android vector paths.
 *
 * Masters are trusted repo files with text already outlined (ASSET-2), so this works on the SVG
 * text directly instead of carrying an XML parser. Anything it cannot handle fails loudly.
 */

/** Reads the root `<svg>` element of a master: its viewBox and everything inside it. */
export function parseMaster(svg, name) {
  const root = /<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg.trim())
  if (!root) throw new Error(`devkit-icons: ${name} has no root <svg> element`)
  const viewBox = /\bviewBox="([^"]+)"/.exec(root[1])
  if (!viewBox) throw new Error(`devkit-icons: ${name} needs a viewBox`)
  const box = viewBox[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) {
    throw new Error(`devkit-icons: ${name} has an unreadable viewBox`)
  }
  return { name, viewBox: box, inner: root[2] }
}

/** Places a master inside a canvas at `x, y`, scaled to a `size` square. */
export function place(master, { x, y, size }) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${master.viewBox.join(' ')}">${master.inner}</svg>`
}

/**
 * Builds a `width` by `height` SVG holding `content`, on `background` when given and
 * transparent otherwise. `clipCircle` crops to the inscribed circle (Android round icons).
 */
export function canvas(
  width,
  height,
  content,
  { background, clipCircle } = {},
) {
  const fill = background
    ? `<rect width="${width}" height="${height}" fill="${background}"/>`
    : ''
  const clip = clipCircle
    ? `<defs><clipPath id="c"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 2}"/></clipPath></defs>`
    : ''
  const body = clipCircle
    ? `<g clip-path="url(#c)">${fill}${content}</g>`
    : fill + content
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${clip}${body}</svg>`
}

/**
 * Returns a monochrome master with every fill and stroke colour replaced by `color`, keeping
 * `none`. Used for the Windows light-taskbar form (drawn dark) and Android's single-colour icons.
 */
export function recolour(master, color) {
  const inner = master.inner
    .replace(/\b(fill|stroke)="(?!none")[^"]*"/g, `$1="${color}"`)
    .replace(/\b(fill|stroke)\s*:\s*(?!none\b)[^;"]+/g, `$1:${color}`)
  return { ...master, inner }
}

/**
 * Reads a master made only of `<path d fill>` elements, the shape outlined text and simple marks
 * take, as `{ d, fill }` pairs. Anything else (groups, transforms, gradients, strokes, shapes other
 * than paths) throws, because converting it faithfully needs a real converter.
 */
export function flatPaths(master) {
  const withoutComments = master.inner.replace(/<!--[\s\S]*?-->/g, '').trim()
  // Closing tags carry nothing; `<path ...></path>` and `<path .../>` read the same.
  const elements = (withoutComments.match(/<[^>]+>/g) ?? []).filter(
    (element) => !element.startsWith('</'),
  )
  const paths = []
  for (const element of elements) {
    const d = /\bd="([^"]+)"/.exec(element)?.[1]
    const fill = /\bfill="([^"]+)"/.exec(element)?.[1] ?? '#000000'
    const isPlainPath =
      /^<path\b/.test(element) &&
      d &&
      !/\b(transform|stroke|style|class|clip-path|mask|filter)=/.test(element)
    if (!isPlainPath || fill.startsWith('url(')) {
      throw new Error(
        `devkit-icons: ${master.name} must be flat <path d fill> elements for Android vectors; found ${element.slice(0, 60)}`,
      )
    }
    if (fill !== 'none') paths.push({ d, fill })
  }
  if (paths.length === 0)
    throw new Error(`devkit-icons: ${master.name} has no paths`)
  return paths
}
