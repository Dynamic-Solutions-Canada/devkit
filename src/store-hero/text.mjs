/**
 * Line breaking for hero text. SVG has no text wrapping, so devkit breaks lines itself: it finds
 * break opportunities with `Intl.Segmenter` (which knows Japanese and Chinese words), measures
 * candidate lines with a caller-supplied function, and balances the lines the way CSS
 * `text-wrap: balance` does, so a two-line headline is two similar lines rather than a long line
 * and a widow.
 *
 * Measuring is injected so this module stays pure and testable; the renderer measures with resvg
 * and the real fonts.
 */

/** Opening brackets and quotes, which stay with the word after them. */
const OPENING = new Set('([{«‘“〈《「『【〔（［｛')

/** Han, kana, Hangul and full-width forms: scripts that break between words without spaces. */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u

/**
 * Splits a paragraph into unbreakable units, each `{ text, spaceAfter }`. A line may break after
 * any unit: at a space (which is then dropped) or, between CJK words, with no space at all.
 * Punctuation stays with the word before it, and an opening bracket with the word after it.
 */
export function breakUnits(text, locale) {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  const units = []
  let prefix = ''

  for (const { segment, isWordLike } of segmenter.segment(text)) {
    const previous = units.at(-1)

    // Whitespace is a break opportunity, not content.
    if (/^\s+$/u.test(segment)) {
      if (previous) previous.spaceAfter = true
      continue
    }

    // An opening bracket waits for the word it opens.
    if (
      !isWordLike &&
      [...segment].every((character) => OPENING.has(character))
    ) {
      prefix += segment
      continue
    }

    const piece = prefix + segment
    prefix = ''

    // Other punctuation, and a word that touches the previous one in a non-CJK script, cannot
    // start a line, so they join the unit before them.
    const touchesCjk =
      previous && (CJK.test(previous.text.at(-1)) || CJK.test(piece[0]))
    const joinsPrevious =
      previous && !previous.spaceAfter && (!isWordLike || !touchesCjk)
    if (joinsPrevious) {
      previous.text += piece
      continue
    }
    units.push({ text: piece, spaceAfter: false })
  }

  if (prefix) units.push({ text: prefix, spaceAfter: false })
  return units
}

/** Joins units into the text of one line, keeping the spaces between them. */
function lineText(units) {
  return units
    .map((unit, index) =>
      index < units.length - 1 && unit.spaceAfter ? `${unit.text} ` : unit.text,
    )
    .join('')
}

/**
 * Greedy line breaking: as many units per line as fit in `width`. A unit wider than `width` gets
 * a line of its own and overflows it; the caller sees that in the measured widths.
 */
function greedyLines(units, width, measure) {
  const lines = []
  let current = []
  for (const unit of units) {
    const candidate = [...current, unit]
    if (current.length > 0 && measure(lineText(candidate)) > width) {
      lines.push(lineText(current))
      current = [unit]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(lineText(current))
  return lines
}

/**
 * Breaks one paragraph into balanced lines no wider than `maxWidth`: the fewest lines greedy
 * breaking needs, then the narrowest width that still needs no more, so the lines come out even.
 */
function balancedLines(units, maxWidth, measure) {
  const lines = greedyLines(units, maxWidth, measure)
  if (lines.length < 2) return lines

  let low = 1
  let high = Math.floor(maxWidth)
  let best = lines
  while (low <= high) {
    const width = Math.floor((low + high) / 2)
    const attempt = greedyLines(units, width, measure)
    const overflows = attempt.some((line) => measure(line) > width)
    if (attempt.length <= lines.length && !overflows) {
      best = attempt
      high = width - 1
    } else {
      low = width + 1
    }
  }
  return best
}

/**
 * Wraps `text` into balanced lines. A `\n` in the text forces a break, for a headline whose
 * phrasing matters more than balance.
 *
 * @param {string} text
 * @param {{ locale: string, maxWidth: number, measure: (line: string) => number }} options
 * @returns {string[]}
 */
export function wrapText(text, { locale, maxWidth, measure }) {
  return text
    .split('\n')
    .flatMap((paragraph) =>
      balancedLines(breakUnits(paragraph.trim(), locale), maxWidth, measure),
    )
}

/**
 * Finds the largest font size, from `sizes` (largest first), at which `text` wraps into lines
 * that each fit `maxWidth`, number at most `maxLines`, and, with `lineHeight` (a multiple of the
 * size), stack no taller than `maxHeight`.
 *
 * @param {string} text
 * @param {{ locale: string, sizes: number[], maxWidth: number, maxLines: number,
 *   maxHeight?: number, lineHeight?: number,
 *   measureAt: (size: number) => (line: string) => number }} options
 * @returns {{ size: number, lines: string[] } | null} null when even the smallest size does not fit
 */
export function fitText(
  text,
  {
    locale,
    sizes,
    maxWidth,
    maxLines,
    maxHeight = Infinity,
    lineHeight = 1,
    measureAt,
  },
) {
  for (const size of sizes) {
    const measure = measureAt(size)
    const lines = wrapText(text, { locale, maxWidth, measure })
    const fitsLines =
      lines.length <= maxLines && lines.length * size * lineHeight <= maxHeight
    if (fitsLines && lines.every((line) => measure(line) <= maxWidth))
      return { size, lines }
  }
  return null
}

/** Font sizes from `largest` down to `smallest` in steps of 2, for `fitText`. */
export function sizeSteps(largest, smallest) {
  const sizes = []
  for (let size = largest; size >= smallest; size -= 2) sizes.push(size)
  return sizes
}
