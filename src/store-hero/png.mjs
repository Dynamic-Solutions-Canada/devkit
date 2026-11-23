/**
 * The PNG handling the hero renderer needs, with no image library: reading a capture's size,
 * writing a render as 8-bit RGB, and reading back a hero devkit wrote.
 *
 * Heroes are written the way winui-app-kit's screenshot renderer writes its crops (8-bit RGB, no
 * alpha, every row unfiltered), so both kinds of Store screenshot share one format and a stdlib
 * reader can decode either. `--check` compares decoded pixels rather than file bytes, because
 * Node's bundled zlib may pick different matches on different CPUs; the pixels are what resvg
 * guarantees.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RGB = 2

/** The CRC-32 table PNG chunks use, built once. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** CRC-32 of `bytes`, as PNG computes it over a chunk's type and data. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data and CRC. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Splits a PNG into its chunks, in order, as `{ type, data }`.
 *
 * @throws when `bytes` is not a PNG; `name` labels the error
 */
function chunks(bytes, name) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${name} is not a PNG`)
  }
  const found = []
  let position = 8
  while (position + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(position)
    const type = bytes.toString('latin1', position + 4, position + 8)
    found.push({
      type,
      data: bytes.subarray(position + 8, position + 8 + length),
    })
    position += 12 + length
  }
  return found
}

/**
 * Reads a PNG's header: `{ width, height, depth, colour }` (`colour` is the PNG colour type:
 * 2 for RGB, 6 for RGBA).
 */
export function pngHeader(bytes, name = 'image') {
  const header = chunks(bytes, name)[0]
  if (header?.type !== 'IHDR') throw new Error(`${name} has no PNG header`)
  return {
    width: header.data.readUInt32BE(0),
    height: header.data.readUInt32BE(4),
    depth: header.data[8],
    colour: header.data[9],
  }
}

/**
 * Converts opaque RGBA pixels (resvg's output) to PNG rows of 8-bit RGB, each led by filter
 * type 0 (none). Alpha is dropped, so the caller must have drawn an opaque background first.
 */
export function rgbRows(rgba, width, height) {
  const stride = width * 3 + 1
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    // Each row's first byte is its filter type; the zeroed buffer already holds 0.
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const to = y * stride + 1 + x * 3
      rows[to] = rgba[from]
      rows[to + 1] = rgba[from + 1]
      rows[to + 2] = rgba[from + 2]
    }
  }
  return rows
}

/** Encodes rows from `rgbRows` as an 8-bit RGB PNG. */
export function encodeRgbPng(rows, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = RGB
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Decodes a PNG that `encodeRgbPng` wrote back into its rows, in `rgbRows` form, or returns a
 * message saying why it cannot: another size or colour type, or filtered rows, which mean another
 * tool saved it.
 *
 * @returns {Buffer | string}
 */
export function readRgbPng(bytes, width, height, name = 'image') {
  let header
  try {
    header = pngHeader(bytes, name)
  } catch (error) {
    return error.message
  }
  if (header.width !== width || header.height !== height) {
    return `${header.width} x ${header.height}, not ${width} x ${height}`
  }
  if (header.depth !== 8 || header.colour !== RGB) {
    return `not 8-bit RGB without alpha (bit depth ${header.depth}, colour type ${header.colour})`
  }

  const compressed = Buffer.concat(
    chunks(bytes, name)
      .filter(({ type }) => type === 'IDAT')
      .map(({ data }) => data),
  )
  let raw
  try {
    raw = inflateSync(compressed)
  } catch {
    return 'its image data does not decompress'
  }

  const stride = width * 3 + 1
  if (raw.length !== stride * height)
    return 'its image data does not match its size'
  for (let y = 0; y < height; y += 1) {
    if (raw[y * stride] !== 0) {
      return 'its rows are filtered, so another tool saved it; render it again'
    }
  }
  return raw
}
