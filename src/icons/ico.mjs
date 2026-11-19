/**
 * Packs PNG images into one Windows `.ico` file. Every frame is stored as PNG, which Windows has
 * read since Vista and which keeps full alpha at every size.
 *
 * @param {{size: number, png: Buffer}[]} frames Square frames, smallest first.
 * @returns {Buffer} The `.ico` file.
 */
export function packIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)

  const directory = Buffer.alloc(16 * frames.length)
  let offset = header.length + directory.length
  frames.forEach(({ size, png }, index) => {
    const entry = index * 16
    // 256 px is written as 0, the format's way of saying "256".
    directory.writeUInt8(size >= 256 ? 0 : size, entry)
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2) // no palette
    directory.writeUInt8(0, entry + 3) // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...frames.map(({ png }) => png)])
}
