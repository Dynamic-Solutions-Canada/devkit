/**
 * SVG building blocks the hero layouts share: colours, embedded images, text lines, the icon and
 * name lockup, the accent bar, and an enlarged window from a capture.
 *
 * Every coordinate is in layout units: the canvas is 768 units tall and as wide as the output's
 * aspect ratio makes it (1366 for 1366 x 768), and the SVG's viewBox scales units to pixels. So
 * one layout serves 1366 x 768, 1920 x 1080 and 2732 x 1536 alike.
 */
import { readFileSync } from 'node:fs'

export const CANVAS_HEIGHT = 768

/** The top two-thirds of the canvas, where Microsoft asks for the critical text and visuals. */
export const SAFE_BOTTOM = (CANVAS_HEIGHT * 2) / 3

/** Noto Sans's ascender and descender, in em, for placing a line's baseline inside its box. */
const ASCENT = 1.069
const DESCENT = 0.293

/** Text colours: near-white for headlines, a softer tone for sublines. */
export const INK = '#F5F7FB'
export const INK_SOFT = '#D5DBE5'

/** The dark base every gradient mixes toward. */
export const NIGHT = '#0B1220'

/** Escapes text for an SVG text node or attribute. */
export function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Mixes two `#RRGGBB` colours in sRGB, as CSS `color-mix(in srgb, a weight, b)` does.
 *
 * @param {number} weight the share of `a`, from 0 to 1
 */
export function mix(a, b, weight) {
  const channel = (hex, index) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)
  const parts = [0, 1, 2].map((index) =>
    Math.round(channel(a, index) * weight + channel(b, index) * (1 - weight))
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${parts.join('').toUpperCase()}`
}

/** A file as a data URI for `<image href>`, PNG or SVG by extension. */
export function dataUri(file) {
  const type = file.toLowerCase().endsWith('.svg')
    ? 'image/svg+xml'
    : 'image/png'
  return `data:${type};base64,${readFileSync(file).toString('base64')}`
}

/** Rounds to two decimals, so the SVG text stays short and stable. */
export function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * Draws wrapped lines as SVG text, the first line's box starting at `top`.
 *
 * @param {{ lines: string[], x: number, top: number, size: number, lineHeight: number,
 *   weight: number, fill: string, family: string, filter?: string }} block
 * @returns {{ svg: string, bottom: number }} the text, and where its last line box ends
 */
export function textBlock({
  lines,
  x,
  top,
  size,
  lineHeight,
  weight,
  fill,
  family,
  filter,
}) {
  const step = size * lineHeight
  // Half the leading above the glyph box, then the ascender, puts the baseline where CSS would.
  const baseline = (step - (ASCENT + DESCENT) * size) / 2 + ASCENT * size
  const filterAttribute = filter ? ` filter="url(#${filter})"` : ''
  const texts = lines
    .map(
      (line, index) =>
        `<text x="${round(x)}" y="${round(top + index * step + baseline)}">${escapeXml(line)}</text>`,
    )
    .join('')
  const svg = `<g font-family="${escapeXml(family)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${filterAttribute}>${texts}</g>`
  return { svg, bottom: top + lines.length * step }
}

/**
 * The icon and app name side by side, centred on one line.
 *
 * @param {{ icon: string, name: string, x: number, y: number, iconSize: number, radius: number,
 *   nameSize: number, family: string, id: string }} lockup `id` keeps the clip path unique
 */
export function lockup({
  icon,
  name,
  x,
  y,
  iconSize,
  radius,
  nameSize,
  family,
  id,
}) {
  const clip = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${iconSize}" height="${iconSize}" rx="${radius}"/></clipPath>`
  const image = `<image x="${x}" y="${y}" width="${iconSize}" height="${iconSize}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid meet" href="${dataUri(icon)}"/>`
  const label = textBlock({
    lines: [name],
    x: x + iconSize + iconSize * 0.3,
    top: y + (iconSize - nameSize * 1.2) / 2,
    size: nameSize,
    lineHeight: 1.2,
    weight: 700,
    fill: INK,
    family,
  })
  return `<defs>${clip}</defs>${image}${label.svg}`
}

/** A rounded bar in the app's two colours. */
export function accentBar({ x, y, width, height, primary, accent, id }) {
  const gradient = `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${primary}"/><stop offset="1" stop-color="${accent}"/></linearGradient>`
  return `<defs>${gradient}</defs><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="url(#${id})"/>`
}

/**
 * The capture's region (a whole window, or a crop around one) at `scale` layout units per
 * logical pixel, clipped to its rounded corners. Windows 11 rounds windows and flyouts by 8
 * logical pixels; a crop keeps the same rounding at its own edge.
 *
 * @param {{ capture: object, image: string, x: number, y: number, scale: number, id: string,
 *   attributes?: string }} placement `image` is the capture's data URI, read once per hero;
 *   `attributes` go on the group (opacity, mask)
 * @returns {{ svg: string, width: number, height: number }}
 */
export function windowImage({
  capture,
  image,
  x,
  y,
  scale,
  id,
  attributes = '',
}) {
  const pixel = scale / (capture.scale / 100)
  const [left, top, width, height] = capture.region
  const shown = { width: width * pixel, height: height * pixel }
  const radius = 8 * scale

  const clip = `<clipPath id="${id}"><rect x="${round(x)}" y="${round(y)}" width="${round(shown.width)}" height="${round(shown.height)}" rx="${round(radius)}"/></clipPath>`
  const placed = `<image x="${round(x - left * pixel)}" y="${round(y - top * pixel)}" width="${round(capture.width * pixel)}" height="${round(capture.height * pixel)}" preserveAspectRatio="none" href="${image}"/>`
  const svg = `<defs>${clip}</defs><g clip-path="url(#${id})"${attributes}>${placed}</g>`
  return { svg, ...shown, radius }
}
