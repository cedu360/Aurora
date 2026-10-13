/**
 * The arc reactor as a Windows icon, drawn here rather than shipped.
 *
 * The shortcuts that start AURORA want an .ico, and a binary in the repository
 * is a thing nobody can review or change. So the same reactor as
 * public/favicon.svg is painted pixel by pixel and packed as PNG frames inside
 * an ICO, with nothing but node:zlib. Four sizes, so Windows never has to
 * scale one: 16 and 32 for lists and the taskbar, 48 and 256 for the desktop.
 */

import { deflateSync } from 'node:zlib'

const CYAN = [0.31, 0.82, 1]
const NAVY = [0.004, 0.024, 0.047]

/** Colour and coverage of one point, in coordinates where the icon spans -1..1. */
function shade(x, y) {
  const r = Math.hypot(x, y)
  if (r > 0.98) return null
  let c = NAVY
  const over = (top, a) => {
    c = c.map((v, i) => v * (1 - a) + top[i] * a)
  }
  // The glow the core throws on the housing.
  if (r < 0.66) over(CYAN, 0.38 * (1 - r / 0.66) ** 2)
  // The inner ring.
  if (r > 0.52 && r < 0.58) over(CYAN, 0.7)
  // The outer ring, in ten segments, one of them centred at the top.
  if (r > 0.7 && r < 0.87) {
    const k = (((((Math.atan2(y, x) * 180) / Math.PI + 90) % 36) + 36) % 36)
    if (Math.abs(k - 18) > 2.25) over(CYAN, 1)
  }
  // The core: white at the heart, ice blue at its edge.
  if (r < 0.36) {
    const t = r / 0.36
    over([1 - 0.44 * t, 1 - 0.09 * t, 1], 1)
  }
  return c
}

/** One frame as straight RGBA, four by four samples to a pixel for clean edges. */
function paint(size) {
  const px = Buffer.alloc(size * size * 4)
  const n = 4
  for (let py = 0; py < size; py++) {
    for (let qx = 0; qx < size; qx++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = ((qx + (sx + 0.5) / n) / size) * 2 - 1
          const y = ((py + (sy + 0.5) / n) / size) * 2 - 1
          const c = shade(x, y)
          if (!c) continue
          r += c[0]
          g += c[1]
          b += c[2]
          a += 1
        }
      }
      const o = (py * size + qx) * 4
      if (a) {
        px[o] = Math.round((r / a) * 255)
        px[o + 1] = Math.round((g / a) * 255)
        px[o + 2] = Math.round((b / a) * 255)
        px[o + 3] = Math.round((a / (n * n)) * 255)
      }
    }
  }
  return px
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** The reactor as a PNG of the given size. */
export function reactorPng(size) {
  const rgba = paint(size)
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bits per channel
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The reactor as a Windows .ico holding 16, 32, 48 and 256 pixel frames. */
export function reactorIco() {
  const sizes = [16, 32, 48, 256]
  const frames = sizes.map(reactorPng)
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(sizes.length, 4)
  const dir = Buffer.alloc(16 * sizes.length)
  let offset = head.length + dir.length
  sizes.forEach((size, i) => {
    const e = i * 16
    dir[e] = size === 256 ? 0 : size // 0 means 256
    dir[e + 1] = size === 256 ? 0 : size
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(frames[i].length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += frames[i].length
  })
  return Buffer.concat([head, dir, ...frames])
}
