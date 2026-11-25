/**
 * Turns a resolved hero job and one locale's text into pixels: builds the layout's SVG, measures
 * text with the same renderer and fonts that draw it, and rasterises at the output size.
 */
import { CANVAS_HEIGHT, dataUri, escapeXml, round } from './draw.mjs'
import { fontFamily } from './fonts.mjs'
import { LAYOUT_BUILDERS, textFreeLayout } from './layouts.mjs'
import { rgbRows } from './png.mjs'

/**
 * A renderer bound to resvg and the pinned fonts. System fonts are never loaded, so a machine's
 * installed fonts cannot change a hero.
 *
 * @param {typeof import('@resvg/resvg-js').Resvg} Resvg
 * @param {string[]} fontFiles the pinned font paths from `ensureFonts`
 */
export function createRenderer(Resvg, fontFiles) {
  const options = {
    font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Noto Sans' },
  }
  const widths = new Map()

  /**
   * How far one line of text reaches from its origin, in layout units: the right edge of its ink.
   * Results are cached, since balancing measures the same candidate lines repeatedly.
   */
  function measure(text, size, weight, family) {
    const key = `${family}|${weight}|${size}|${text}`
    if (!widths.has(key)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="400"><text x="0" y="200" font-family="${family}" font-size="${size}" font-weight="${weight}">${escapeXml(text)}</text></svg>`
      const box = new Resvg(svg, options).getBBox()
      widths.set(key, box ? box.x + box.width : 0)
    }
    return widths.get(key)
  }

  /**
   * Draws one locale's hero, or the job's text-free variant when `output.textFree` is set, from
   * that output's own capture (each locale may have its own; see `loadHeroJobs`).
   *
   * @returns {{ rows: Buffer, notes: Array<{ upscale: number }> }} PNG rows (see `rgbRows`) and
   *   facts worth reporting, such as how far the capture was enlarged
   */
  function render(heroJob, output) {
    // The layouts read `job.capture`, so hand them this output's capture in its place.
    const job = { ...heroJob, capture: output.capture ?? null }
    const { width, height } = job.size
    // The text-free variant has no locale and draws no text, so any family will do.
    const family = output.textFree ? 'Noto Sans' : fontFamily(output.locale)
    const context = {
      width: (CANVAS_HEIGHT * width) / height,
      pixelsPerUnit: height / CANVAS_HEIGHT,
      family,
      captureImage: job.capture ? captureUri(job.capture) : null,
      measureAt: (size, weight) => (text) =>
        measure(text, size, weight, family),
      notes: [],
    }

    const body = output.textFree
      ? textFreeLayout(job, context)
      : LAYOUT_BUILDERS[job.layout](job, output, context)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${round(context.width)} ${CANVAS_HEIGHT}">${body}</svg>`
    const image = new Resvg(svg, options).render()
    return {
      rows: rgbRows(image.pixels, image.width, image.height),
      notes: context.notes,
    }
  }

  return { render, measure }
}

/**
 * A capture as a data URI, encoded once per capture rather than once per locale: locales that
 * share a capture share its resolved object (see `loadHeroJobs`).
 */
const captureUris = new WeakMap()
function captureUri(capture) {
  if (!captureUris.has(capture)) captureUris.set(capture, dataUri(capture.file))
  return captureUris.get(capture)
}
