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
 *
 * @returns {Array<Array<{ text: string, spaceAfter: boolean }>>} the units on each line
 */
function greedyLines(units, width, measure) {
  const lines = []
  let current = []
  for (const unit of units) {
    const candidate = [...current, unit]
    if (current.length > 0 && measure(lineText(candidate)) > width) {
      lines.push(current)
      current = [unit]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/**
 * Breaks one paragraph into balanced lines no wider than `maxWidth`: the fewest lines greedy
 * breaking needs, then the narrowest width that still needs no more, so the lines come out even.
 *
 * @returns {Array<Array<{ text: string, spaceAfter: boolean }>>} the units on each line
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
    const overflows = attempt.some((line) => measure(lineText(line)) > width)
    if (attempt.length <= lines.length && !overflows) {
      best = attempt
      high = width - 1
    } else {
      low = width + 1
    }
  }
  return best
}

/** A unit that ends a sentence: a full stop, question or exclamation mark, then any closers. */
const SENTENCE_END = /[.!?。！？][)\]}»’”」』】）]*$/u

/**
 * Whether a line ends one sentence and starts another ("anschließen. Der"), which reads worse than
 * keeping each sentence's words together, even when it avoids a lone word.
 */
function straddlesSentences(line) {
  return line.slice(0, -1).some((unit) => SENTENCE_END.test(unit.text))
}

/** How many of a paragraph's lines hold one word split off from the others. */
function countLoneWords(lines, units) {
  // A one-word paragraph has no other way to break, so only count words that were split off.
  if (units.length < 2) return 0
  return lines.filter((line) => line.length === 1).length
}

/**
 * How awkward a line is when choosing between breaks: one for a lone word (when the paragraph
 * has several units, `several`), and one for a line that straddles two sentences.
 */
function lineCost(line, several) {
  const lone = several && line.length === 1 ? 1 : 0
  return lone + (straddlesSentences(line) ? 1 : 0)
}

/** The summed `lineCost` of a paragraph's lines. */
function breakCost(lines, units) {
  return lines.reduce((sum, line) => sum + lineCost(line, units.length > 1), 0)
}

/**
 * `lineCount` lines, broken anywhere that fits `maxWidth`, chosen for the lowest `lineCost`
 * (lone words, and lines that straddle two sentences) and then the narrowest longest line, so
 * they stay as even as balancing makes them. Balancing alone takes the narrowest width that keeps
 * the line count, which can strand the first or last word ("Your / reminders, one / click from
 * the / Windows tray.") when a wider, still even, break keeps it ("Your reminders, / one click /
 * from the / Windows tray.").
 *
 * A dynamic programme over (lines used, units placed): costs add up and widths take the maximum,
 * so the lexicographic best for each prefix is the best start for every ending.
 *
 * @returns {Array<Array<{ text: string, spaceAfter: boolean }>> | null} the lines, or null when
 *   no break into that many lines fits
 */
function leastAwkwardLines(units, lineCount, maxWidth, measure) {
  const count = units.length
  const several = count > 1
  // best[used][placed] = { cost, widest, breaks } for the first `placed` units on `used` lines.
  const best = Array.from({ length: lineCount + 1 }, () =>
    new Array(count + 1).fill(null),
  )
  best[0][0] = { cost: 0, widest: 0, breaks: [] }

  for (let used = 1; used <= lineCount; used += 1) {
    for (let placed = used; placed <= count; placed += 1) {
      for (let start = used - 1; start < placed; start += 1) {
        const before = best[used - 1][start]
        if (!before) continue
        const line = units.slice(start, placed)
        const width = measure(lineText(line))
        if (width > maxWidth) continue

        const cost = before.cost + lineCost(line, several)
        const widest = Math.max(before.widest, width)
        const current = best[used][placed]
        const better =
          !current ||
          cost < current.cost ||
          (cost === current.cost && widest < current.widest)
        if (better) {
          best[used][placed] = {
            cost,
            widest,
            breaks: [...before.breaks, placed],
          }
        }
      }
    }
  }

  const found = best[lineCount][count]
  if (!found) return null
  let start = 0
  return found.breaks.map((end) => {
    const line = units.slice(start, end)
    start = end
    return line
  })
}

/**
 * Breaks one paragraph: balanced, or, when balancing leaves a word alone, the least awkward break
 * into the same number of lines (`leastAwkwardLines`) if it has fewer lone words and is less
 * awkward overall. So a sentence-ending word alone ("anschließen.") is not traded for a line that
 * runs into the next sentence ("anschließen. Der"), and a paragraph that balances with no lone
 * word keeps its balanced lines exactly.
 *
 * @returns {Array<Array<{ text: string, spaceAfter: boolean }>>} the units on each line
 */
function breakParagraph(units, maxWidth, measure) {
  const balanced = balancedLines(units, maxWidth, measure)
  if (countLoneWords(balanced, units) === 0) return balanced

  const alternative = leastAwkwardLines(
    units,
    balanced.length,
    maxWidth,
    measure,
  )
  const better =
    alternative &&
    countLoneWords(alternative, units) < countLoneWords(balanced, units) &&
    breakCost(alternative, units) < breakCost(balanced, units)
  return better ? alternative : balanced
}

/**
 * Wraps `text` into lines (see `breakParagraph`), keeping each line's units. A `\n` in the text
 * forces a break.
 *
 * @returns {{ lines: string[], loneWords: number }} the lines, and how many of them hold a single
 *   word from a paragraph of several (a line such as "every" between two fuller ones)
 */
function wrapParagraphs(text, { locale, maxWidth, measure }) {
  const lines = []
  let loneWords = 0
  for (const paragraph of text.split('\n')) {
    const units = breakUnits(paragraph.trim(), locale)
    const wrapped = breakParagraph(units, maxWidth, measure)
    for (const line of wrapped) lines.push(lineText(line))
    loneWords += countLoneWords(wrapped, units)
  }
  return { lines, loneWords }
}

/**
 * Wraps `text` into balanced lines. A `\n` in the text forces a break, for a headline whose
 * phrasing matters more than balance.
 *
 * @param {string} text
 * @param {{ locale: string, maxWidth: number, measure: (line: string) => number }} options
 * @returns {string[]}
 */
export function wrapText(text, options) {
  return wrapParagraphs(text, options).lines
}

/**
 * How far below the largest size that fits `fitText` may go to avoid a lone word, as a fraction
 * of that size. Small enough that the text still reads as the same size; large enough to pull a
 * word that only just overflows back onto its line.
 */
export const LONE_WORD_SHRINK = 0.1

/**
 * Finds the largest font size, from `sizes` (largest first), at which `text` wraps into lines
 * that each fit `maxWidth`, number at most `maxLines`, and, with `lineHeight` (a multiple of the
 * size), stack no taller than `maxHeight`.
 *
 * Each size's wrap already avoids a lone word where another break in as many lines can (see
 * `wrapParagraphs`). When the largest size that fits still leaves one (for example "Every printer,
 * / every / project, on / every device."), it tries the sizes up to `LONE_WORD_SHRINK` smaller and
 * takes the largest that leaves fewer lone words (or as many in fewer lines, so a lone word that
 * no size removes does not keep an extra line), so the headline breaks at phrases rather than one
 * word short. If none does, the largest fitting size stands.
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
  /** The wrap at `size`, or null when it breaks one of the limits. */
  function fitAt(size) {
    const measure = measureAt(size)
    const wrapped = wrapParagraphs(text, { locale, maxWidth, measure })
    const { lines } = wrapped
    const fitsLines =
      lines.length <= maxLines && lines.length * size * lineHeight <= maxHeight
    const fitsWidth = lines.every((line) => measure(line) <= maxWidth)
    return fitsLines && fitsWidth ? { size, ...wrapped } : null
  }

  // The largest size that fits at all.
  let largestIndex = -1
  let best = null
  for (const [index, size] of sizes.entries()) {
    best = fitAt(size)
    if (best) {
      largestIndex = index
      break
    }
  }
  if (!best) return null

  // A lone word: look a little smaller for a size that keeps it with its neighbours.
  const floor = best.size * (1 - LONE_WORD_SHRINK)
  for (const size of sizes.slice(largestIndex + 1)) {
    if (best.loneWords === 0 || size < floor) break
    const candidate = fitAt(size)
    if (candidate && isFewerLoneWords(candidate, best)) best = candidate
  }
  return { size: best.size, lines: best.lines }
}

/**
 * Whether a smaller size's wrap beats the current best: fewer lone words, or as many in fewer
 * lines.
 */
function isFewerLoneWords(candidate, best) {
  if (candidate.loneWords !== best.loneWords)
    return candidate.loneWords < best.loneWords
  return candidate.lines.length < best.lines.length
}

/** Font sizes from `largest` down to `smallest` in steps of 2, for `fitText`. */
export function sizeSteps(largest, smallest) {
  const sizes = []
  for (let size = largest; size >= smallest; size -= 2) sizes.push(size)
  return sizes
}
