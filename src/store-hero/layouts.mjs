/**
 * The two hero layouts (D-123), as SVG built from a resolved job and one locale's text.
 *
 * - **split:** the app's brand panel on the left (icon, name, accent bar, headline, optional
 *   subline) and the app's real window or flyout, whole and enlarged, on the right, over its own
 *   capture blurred and darkened.
 * - **brand-card:** icon, name, accent bar, headline and subline over a brand gradient, with the
 *   app's window optionally ghosted behind on the right.
 *
 * Both keep the headline inside the top two-thirds (Microsoft's guidance for overlays) and fail
 * rather than shrink text below a size that still reads on a 320 x 180 Store search card.
 *
 * A split hero may also have a text-free variant (`textFreeLayout`): its background and window
 * with no text, for a web page that sets the app's name and headline in its own HTML.
 */
import {
  CANVAS_HEIGHT,
  INK,
  INK_SOFT,
  NIGHT,
  SAFE_BOTTOM,
  accentBar,
  lockup,
  mix,
  round,
  textBlock,
  windowImage,
} from './draw.mjs'
import { fitText, sizeSteps } from './text.mjs'

/**
 * Each layout's geometry, in layout units (768 tall). `headline.sizes` runs from the preferred
 * size down to the smallest that reads on a search card (about 0.23x: 44 units become 10 px).
 */
export const GEOMETRY = {
  split: {
    panelWidth: 600,
    padding: 72,
    panelRightPadding: 56,
    icon: { size: 56, radius: 12, nameSizes: sizeSteps(30, 22) },
    bar: { top: 180, width: 120, height: 10 },
    headline: {
      top: 222,
      sizes: sizeSteps(60, 44),
      lineHeight: 1.1,
      maxLines: 5,
    },
    subline: {
      gap: 26,
      sizes: sizeSteps(25, 21),
      lineHeight: 1.35,
      maxLines: 4,
    },
    window: { gap: 48, margin: 64, maxScale: 2 },
  },
  'brand-card': {
    left: 96,
    top: 84,
    copyWidth: 860,
    icon: { size: 72, radius: 16, nameSizes: sizeSteps(40, 30) },
    bar: { gap: 64, width: 560, height: 10 },
    headline: {
      gap: 40,
      sizes: sizeSteps(80, 56),
      lineHeight: 1.08,
      maxLines: 3,
    },
    subline: {
      gap: 28,
      sizes: sizeSteps(27, 23),
      lineHeight: 1.35,
      maxLines: 3,
      width: 720,
    },
    ghost: { left: 640, top: 250, bleed: 160, maxScale: 1.25, opacity: 0.42 },
  },
  textFree: { margin: 64, maxScale: 2 },
}

/** The bottom margin every text block keeps from the canvas edge. */
const BOTTOM_MARGIN = 48

/**
 * Fits one text block or throws a message naming the locale and field, so a translator knows
 * what to shorten.
 */
function fitOrFail(text, options, { locale, field, file }) {
  const fitted = fitText(text, options)
  if (!fitted) {
    throw new Error(
      `devkit-store-hero: ${file}: the ${locale} ${field} does not fit at ${options.sizes.at(-1)} units or larger; shorten it`,
    )
  }
  return fitted
}

/** Fits the app name on one line next to its icon, shrinking it within `sizes` if needed. */
function fitName(output, sizes, maxWidth, context) {
  return fitOrFail(
    output.name.replace(/\s+/g, ' '),
    {
      locale: output.locale,
      sizes,
      maxWidth,
      maxLines: 1,
      measureAt: (size) => context.measureAt(size, 700),
    },
    { locale: output.locale, field: 'title', file: output.path },
  ).size
}

/** The headline and the optional subline, fitted and drawn from `top` down. */
function copyBlock(
  output,
  { x, top, width, sublineWidth = width, headline, subline },
  context,
) {
  const where = { locale: output.locale, file: output.path }
  const fittedHeadline = fitOrFail(
    output.headline,
    {
      locale: output.locale,
      sizes: headline.sizes,
      maxWidth: width,
      maxLines: headline.maxLines,
      maxHeight: SAFE_BOTTOM - top,
      lineHeight: headline.lineHeight,
      measureAt: (size) => context.measureAt(size, 700),
    },
    { ...where, field: 'heroHeadline' },
  )
  const headlineBlock = textBlock({
    ...fittedHeadline,
    x,
    top,
    lineHeight: headline.lineHeight,
    weight: 700,
    fill: INK,
    family: context.family,
    filter: context.textShadow,
  })
  if (!output.subline) return headlineBlock.svg

  const sublineTop = headlineBlock.bottom + subline.gap
  const fittedSubline = fitOrFail(
    output.subline,
    {
      locale: output.locale,
      sizes: subline.sizes,
      maxWidth: sublineWidth,
      maxLines: subline.maxLines,
      maxHeight: CANVAS_HEIGHT - BOTTOM_MARGIN - sublineTop,
      lineHeight: subline.lineHeight,
      measureAt: (size) => context.measureAt(size, 400),
    },
    { ...where, field: 'heroSubline' },
  )
  const sublineBlock = textBlock({
    ...fittedSubline,
    x,
    top: sublineTop,
    lineHeight: subline.lineHeight,
    weight: 400,
    fill: INK_SOFT,
    family: context.family,
  })
  return headlineBlock.svg + sublineBlock.svg
}

/** The capture, covering the canvas, blurred, desaturated and darkened: Windows context only. */
function backdrop(job, context) {
  const { capture } = job
  const cover =
    Math.max(context.width / capture.width, CANVAS_HEIGHT / capture.height) *
    1.1
  const width = capture.width * cover
  const height = capture.height * cover
  const filter =
    '<filter id="backdrop" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">' +
    '<feGaussianBlur stdDeviation="28"/>' +
    '<feColorMatrix type="saturate" values="0.35"/>' +
    '<feComponentTransfer><feFuncR type="linear" slope="0.5"/><feFuncG type="linear" slope="0.5"/><feFuncB type="linear" slope="0.5"/></feComponentTransfer>' +
    '</filter>'
  const image = `<image x="${round((context.width - width) / 2)}" y="${round((CANVAS_HEIGHT - height) / 2)}" width="${round(width)}" height="${round(height)}" preserveAspectRatio="none" href="${context.captureImage}" filter="url(#backdrop)"/>`
  return `<defs>${filter}</defs>${image}`
}

/** A soft shadow under a rounded rectangle, for the enlarged window. */
function dropShadow({ x, y, width, height, radius }) {
  const filter =
    '<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="30"/></filter>'
  const rect = `<rect x="${round(x)}" y="${round(y + 24)}" width="${round(width)}" height="${round(height)}" rx="${round(radius)}" fill="#000000" fill-opacity="0.55" filter="url(#shadow)"/>`
  return `<defs>${filter}</defs>${rect}`
}

/**
 * A mask that fades a cut window out over its lower part, ending fully transparent at the cut, so
 * the UI clearly continues below rather than ending at a hard edge (D-123, policy 10.1). The fade
 * runs over a fifth of the shown height, at least 96 units, so it reads at card size too.
 */
function bottomFade(context, { y, height }) {
  const length = Math.max(96, height * 0.2)
  const start = y + height - length
  return (
    '<defs>' +
    `<linearGradient id="cut-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="${round(start)}" x2="0" y2="${round(y + height)}"><stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>` +
    `<mask id="cut-fade"><rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#cut-gradient)"/></mask>` +
    '</defs>'
  )
}

/** The brand panel's gradient (`url(#panel)`): the primary colour darkened toward night. */
function panelGradient(primary) {
  return `<linearGradient id="panel" x1="0" y1="0" x2="0.55" y2="1"><stop offset="0" stop-color="${mix(primary, NIGHT, 0.4)}"/><stop offset="1" stop-color="${mix(primary, NIGHT, 0.12)}"/></linearGradient>`
}

/** A soft glow of the accent colour toward the bottom-right corner (`url(#tint-b)`). */
function accentGlow(accent) {
  return `<radialGradient id="tint-b" cx="0.88" cy="0.9" r="0.6"><stop offset="0" stop-color="${accent}" stop-opacity="0.3"/><stop offset="0.7" stop-color="${accent}" stop-opacity="0"/></radialGradient>`
}

/**
 * The split layout's background: the blurred capture, then the brand tint over it. It also defines
 * the panel gradient the layout draws later.
 */
function brandBackdrop(job, context) {
  const { primary, accent } = job
  return (
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="${NIGHT}"/>` +
    backdrop(job, context) +
    '<defs>' +
    `<radialGradient id="tint-a" cx="0.2" cy="0.18" r="0.8"><stop offset="0" stop-color="${primary}" stop-opacity="0.55"/><stop offset="0.72" stop-color="${primary}" stop-opacity="0"/></radialGradient>` +
    accentGlow(accent) +
    panelGradient(primary) +
    '<filter id="panel-shadow" x="-10%" y="-10%" width="130%" height="120%"><feGaussianBlur stdDeviation="30"/></filter>' +
    '</defs>' +
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#tint-a)"/>` +
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#tint-b)"/>`
  )
}

/**
 * The app's window, whole (or cut at the bottom and faded), enlarged to fit `area` and centred in
 * it, with its shadow and outline. The scale never exceeds `maxScale` times the window's logical
 * size, and how far the capture is enlarged is noted for the soft-capture advice.
 *
 * @param {{ left: number, width: number, height: number }} area where the window may go; it is
 *   placed `margin` units from the top at the least
 * @param {{ margin: number, maxScale: number, lift: number }} fit `lift` raises the window above
 *   the vertical centre by that many units
 */
function enlargedWindow(job, context, area, { margin, maxScale, lift }) {
  const [, , regionWidth, regionHeight] = job.capture.region
  const logical = job.capture.scale / 100
  const scale = Math.min(
    maxScale,
    area.width / (regionWidth / logical),
    area.height / (regionHeight / logical),
  )
  const shownWidth = (regionWidth / logical) * scale
  const shownHeight = (regionHeight / logical) * scale
  const x = area.left + (area.width - shownWidth) / 2
  const y = Math.max(margin, (CANVAS_HEIGHT - shownHeight) / 2 - lift)
  const window = windowImage({
    capture: job.capture,
    image: context.captureImage,
    x,
    y,
    scale,
    id: 'window',
  })
  const shadow = dropShadow({
    x,
    y,
    width: window.width,
    height: window.height,
    radius: window.radius,
  })
  const outline = `<rect x="${round(x)}" y="${round(y)}" width="${round(window.width)}" height="${round(window.height)}" rx="${round(window.radius)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="1"/>`
  context.notes.push({ upscale: (scale * context.pixelsPerUnit) / logical })

  if (job.capture.fade === 'bottom') {
    return (
      bottomFade(context, { y, height: window.height }) +
      `<g mask="url(#cut-fade)">${shadow}${window.svg}${outline}</g>`
    )
  }
  return shadow + window.svg + outline
}

/**
 * The split layout. The window is scaled to fit the space right of the panel (never above
 * `maxScale` times its logical size) and centred there, a little above the middle so its top,
 * where flyouts put their title and main control, sits in the top two-thirds.
 */
export function splitLayout(job, output, context) {
  const g = GEOMETRY.split
  const { primary, accent } = job
  const parts = [brandBackdrop(job, context)]

  // The enlarged window, whole (or cut at the bottom and faded), in the space right of the panel.
  parts.push(
    enlargedWindow(
      job,
      context,
      {
        left: g.panelWidth + g.window.gap,
        width: context.width - g.panelWidth - g.window.gap * 2,
        height: CANVAS_HEIGHT - g.window.margin * 2,
      },
      { margin: g.window.margin, maxScale: g.window.maxScale, lift: 40 },
    ),
  )

  // The brand panel and its copy, drawn last so the panel's shadow falls on the backdrop.
  parts.push(
    `<rect x="-40" y="-40" width="${g.panelWidth + 40}" height="${CANVAS_HEIGHT + 80}" fill="#000000" fill-opacity="0.35" filter="url(#panel-shadow)"/>`,
  )
  parts.push(
    `<rect width="${g.panelWidth}" height="${CANVAS_HEIGHT}" fill="url(#panel)"/>`,
  )

  const textWidth = g.panelWidth - g.padding - g.panelRightPadding
  const nameX = g.padding + g.icon.size * 1.3
  const nameSize = fitName(
    output,
    g.icon.nameSizes,
    g.panelWidth - g.panelRightPadding - nameX,
    context,
  )
  parts.push(
    lockup({
      icon: job.icon,
      name: output.name,
      x: g.padding,
      y: g.padding,
      iconSize: g.icon.size,
      radius: g.icon.radius,
      nameSize,
      family: context.family,
      id: 'icon',
    }),
  )
  parts.push(
    accentBar({
      x: g.padding,
      y: g.bar.top,
      width: g.bar.width,
      height: g.bar.height,
      primary,
      accent,
      id: 'bar',
    }),
  )
  parts.push(
    copyBlock(
      output,
      {
        x: g.padding,
        top: g.headline.top,
        width: textWidth,
        headline: g.headline,
        subline: g.subline,
      },
      context,
    ),
  )

  return parts.join('')
}

/**
 * The brand card. With a capture, the window is ghosted behind the copy on the right, fading in
 * from the left and running off the canvas: texture, not information, so the copy stays the
 * subject.
 */
export function brandCardLayout(job, output, context) {
  const g = GEOMETRY['brand-card']
  const { primary, accent } = job
  const parts = []

  parts.push(
    '<defs>' +
      `<linearGradient id="card" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mix(primary, NIGHT, 0.22)}"/><stop offset="1" stop-color="#1C2333"/></linearGradient>` +
      `<radialGradient id="glow" cx="0.1" cy="0.1" r="0.7"><stop offset="0" stop-color="${primary}" stop-opacity="0.34"/><stop offset="0.75" stop-color="${primary}" stop-opacity="0"/></radialGradient>` +
      '<filter id="text-shadow" x="-5%" y="-20%" width="110%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="12" flood-color="#000000" flood-opacity="0.45"/></filter>' +
      '</defs>',
  )
  parts.push(
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#card)"/>`,
  )
  parts.push(
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#glow)"/>`,
  )

  if (job.capture) {
    const [, , regionWidth] = job.capture.region
    const logical = job.capture.scale / 100
    const targetWidth = context.width - g.ghost.left + g.ghost.bleed
    const scale = Math.min(
      g.ghost.maxScale,
      targetWidth / (regionWidth / logical),
    )
    const shownWidth = (regionWidth / logical) * scale
    parts.push(
      '<defs>' +
        `<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="${g.ghost.left}" y1="0" x2="${round(g.ghost.left + shownWidth * 0.45)}" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="1"/></linearGradient>` +
        `<mask id="ghost-mask"><rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#fade)"/></mask>` +
        '</defs>',
    )
    const ghost = windowImage({
      capture: job.capture,
      image: context.captureImage,
      x: g.ghost.left,
      y: g.ghost.top,
      scale,
      id: 'ghost',
      attributes: ` opacity="${g.ghost.opacity}" mask="url(#ghost-mask)"`,
    })
    parts.push(ghost.svg)
  }

  const nameX = g.left + g.icon.size * 1.3
  const nameSize = fitName(
    output,
    g.icon.nameSizes,
    g.left + g.copyWidth - nameX,
    context,
  )
  parts.push(
    lockup({
      icon: job.icon,
      name: output.name,
      x: g.left,
      y: g.top,
      iconSize: g.icon.size,
      radius: g.icon.radius,
      nameSize,
      family: context.family,
      id: 'icon',
    }),
  )
  const barTop = g.top + g.icon.size + g.bar.gap
  parts.push(
    accentBar({
      x: g.left,
      y: barTop,
      width: g.bar.width,
      height: g.bar.height,
      primary,
      accent,
      id: 'bar',
    }),
  )
  parts.push(
    copyBlock(
      output,
      {
        x: g.left,
        top: barTop + g.bar.height + g.headline.gap,
        width: g.copyWidth,
        sublineWidth: g.subline.width,
        headline: g.headline,
        subline: g.subline,
      },
      { ...context, textShadow: 'text-shadow' },
    ),
  )

  return parts.join('')
}

/**
 * The split hero's brand panel gradient across the whole canvas, with the accent glow, so the
 * text-free variant reads as the same brand colour as the hero's panel.
 */
function brandPanelBackground(job, context) {
  const { primary, accent } = job
  return (
    '<defs>' +
    panelGradient(primary) +
    accentGlow(accent) +
    '</defs>' +
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#panel)"/>` +
    `<rect width="${round(context.width)}" height="${CANVAS_HEIGHT}" fill="url(#tint-b)"/>`
  )
}

/**
 * The text-free variant of the split layout: the hero's brand colour and enlarged window, with no
 * icon, name or text, for pages that set their own headline above the image. The panel's gradient
 * fills the canvas and the window is centred on it, so a wide window has room to be drawn larger,
 * which keeps the UI legible when the image is shown small, as on a phone.
 */
export function textFreeLayout(job, context) {
  const g = GEOMETRY.textFree
  return (
    brandPanelBackground(job, context) +
    enlargedWindow(
      job,
      context,
      {
        left: g.margin,
        width: context.width - g.margin * 2,
        height: CANVAS_HEIGHT - g.margin * 2,
      },
      { margin: g.margin, maxScale: g.maxScale, lift: 0 },
    )
  )
}

export const LAYOUT_BUILDERS = {
  split: splitLayout,
  'brand-card': brandCardLayout,
}
