import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, watch } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

/**
 * The downloads guard.
 *
 * Most of what goes wrong on a home computer comes in through the Downloads
 * folder, and comes in looking like something else: fatura.pdf.exe, a
 * "driver" that is a script, a zip with an installer folded inside it.
 * Windows says nothing until the moment of opening, and by then its warning
 * is one more dialog to click past. So this watches the folder and, when a
 * file of a type that can run things finishes arriving, looks at it at once,
 * while the user still remembers clicking the link, so AURORA can say one
 * sentence about it and put the detail on screen.
 *
 * Looking is all it does. Every check is a read: the bytes for the hash, the
 * header for what kind of program it is, the zip's directory for what is
 * inside, the Mark of the Web for where it came from, Authenticode for who
 * signed it. Nothing is opened, run, unpacked, moved, renamed or deleted. A
 * guard that quarantined files would one day quarantine the wrong one, and
 * the decision belongs to the person who downloaded it. The only thing that
 * ever leaves the machine is the SHA-256, only to VirusTotal, and only when
 * the user has given a key for it.
 *
 * What a program actually does is REA's question. This is the triage in front
 * of it: cheap enough to run on every download, and plain about what a header
 * and a signature cannot tell.
 */

// ---------------------------------------------------------------------------
// What is worth a look
// ---------------------------------------------------------------------------

/**
 * Types worth examining, grouped by what Windows does with them on a double
 * click: run them, install them, mount them, or open them into something that
 * can. A PDF or a photo can carry an exploit too, but that is the viewer's
 * problem, and nothing a header shows.
 */
const TYPES = {
  programa: ['exe', 'com', 'scr', 'pif'],
  instalador: ['msi', 'msix', 'msixbundle', 'appx', 'appxbundle'],
  script: ['bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'reg'],
  biblioteca: ['dll', 'sys', 'ocx', 'cpl'],
  android: ['apk', 'xapk', 'apks', 'aab'],
  java: ['jar'],
  disco: ['iso', 'img', 'vhd', 'vhdx'],
  compactado: ['zip', 'rar', '7z', 'cab'],
}

const TYPE_OF = new Map(Object.entries(TYPES).flatMap(([type, exts]) => exts.map((e) => [`.${e}`, type])))

/** The guard's type for a file name, or null for one it leaves alone. */
export function riskType(name) {
  return TYPE_OF.get(extname(String(name ?? '')).toLowerCase()) ?? null
}

/**
 * What browsers write while a download is still arriving. Chrome and Edge
 * rename a .crdownload into place when it is complete, Firefox a .part, so the
 * finished file appears under its real name in one step and these never need
 * a look of their own.
 */
const PARTIAL = ['.crdownload', '.part', '.partial', '.download', '.tmp', '.opdownload']

function ignored(name) {
  const lower = name.toLowerCase()
  return lower.startsWith('.') || lower.startsWith('~$') || lower === 'desktop.ini' || PARTIAL.includes(extname(lower))
}

/** The types Authenticode is defined for; asking about a .bat only wastes a PowerShell. */
const SIGNABLE = new Set(['programa', 'instalador', 'biblioteca'])
const SIGNABLE_SCRIPTS = new Set(['.ps1', '.psm1'])

/** Containers whose central directory is worth reading. All of them are zips inside. */
const ZIP_LIKE = new Set(['.zip', '.jar', '.apk', '.xapk', '.apks', '.aab'])

/**
 * What a program pretends to be, for spotting fatura.pdf.exe. A list of decoys
 * rather than "any second extension", or node-v22.12.0-x64.msi would be
 * flagged for its version number.
 */
const DECOY =
  /\.(?:pdf|docx?|xlsx?|pptx?|od[tsp]|rtf|txt|csv|jpe?g|png|gif|bmp|webp|heic|tiff?|mp[34]|m4a|wav|avi|mkv|mov|wmv|zip|rar|7z|html?|xml|eml)$/i

/** Spaces and underscores pushed between the decoy and the real extension to hide it. */
const PADDING = /[\s_\u200b-\u200d\u2060\u2800]+$/u

/** The overrides that make fatura‮fdp.exe display as faturaexe.pdf. */
const OVERRIDE = /[\u202d\u202e]/

/** Every direction control: dropped before a name is spoken, made visible before it is shown. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

const HEAD_BYTES = 4 * 1024 * 1024
const ENTROPY_BUDGET = 8 * 1024 * 1024
const ENTROPY_WINDOW = 256 * 1024
const ENTROPY_MIN_BYTES = 512
const ENTROPY_HIGH = 7.2
const MAX_SECTIONS = 96
const MAX_ZIP_DIRECTORY = 16 * 1024 * 1024
const MAX_ZIP_ENTRIES = 200_000
const MAX_RISKY_LISTED = 10

/**
 * Past this a file is a disk image or a game, and hashing it would keep the
 * disk busy for minutes to say very little. It is still looked at; it just
 * gets no SHA-256, and so no VirusTotal lookup.
 */
const MAX_HASH_BYTES = 4 * 1024 ** 3

const SIGNATURE_TIMEOUT_MS = 15_000
const VIRUSTOTAL_TIMEOUT_MS = 8000
const RECENT_KEPT = 20
const DEBOUNCE_MS = 300

/** Errors that mean "someone else has it open right now", worth trying again. */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])

const isPt = (lang) => String(lang ?? 'pt-BR').toLowerCase().startsWith('pt')

/**
 * The upper half of code page 850, the OEM code page of a Brazilian Windows.
 * It is what reg.exe prints in, and what Explorer writes zip entry names in
 * when it does not mark them as UTF-8.
 */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0'

function cp850(bytes) {
  let out = ''
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80]
  return out
}

// ---------------------------------------------------------------------------
// Where Downloads is
// ---------------------------------------------------------------------------

const DOWNLOADS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}'

/** The folder to watch: AURORA_DOWNLOADS, Explorer's own idea of it on Windows, or ~/Downloads. */
export function downloadsDir(env = process.env) {
  if (env.AURORA_DOWNLOADS) return resolve(env.AURORA_DOWNLOADS)
  if (process.platform === 'win32') {
    const moved = registryDownloads(env)
    if (moved) return moved
  }
  return join(homedir(), 'Downloads')
}

/**
 * The Downloads folder as Explorer has it. People move it, usually to a second
 * disk, through the folder's Properties, and that move is recorded only here.
 *
 * reg.exe prints in the console's code page rather than UTF-8, so a path with
 * an accent in it can come back mangled. Each plausible decoding is tried and
 * the first that names a real folder wins; if none does, the default stands.
 */
function registryDownloads(env) {
  const system = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  const out = spawnSync(win32.join(system, 'System32', 'reg.exe'), ['query', DOWNLOADS_KEY, '/v', DOWNLOADS_GUID], {
    windowsHide: true,
    timeout: 5000,
  })
  if (out.status !== 0 || !out.stdout?.length) return null
  for (const text of [out.stdout.toString('utf8'), cp850(out.stdout), out.stdout.toString('latin1')]) {
    const m = /REG_(?:EXPAND_)?SZ[ \t]+([^\r\n]+)/.exec(text)
    const path = m && expandVars(m[1].trim(), env)
    if (!path) continue
    try {
      if (statSync(path).isDirectory()) return path
    } catch {
      /* the next decoding, then the default */
    }
  }
  return null
}

/** %USERPROFILE%\Downloads, expanded. Windows names are case-blind, so the lookup is too. */
function expandVars(text, env) {
  let missing = false
  const out = text.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
    if (key === undefined) missing = true
    return key === undefined ? whole : env[key]
  })
  return missing ? null : out
}

// ---------------------------------------------------------------------------
// Reading a file without trusting it
// ---------------------------------------------------------------------------

/** Up to `length` bytes from `position`; fewer at the end of the file, never an error. */
async function readAt(fh, position, length) {
  const buf = Buffer.alloc(Math.max(0, length))
  let got = 0
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got === buf.length ? buf : buf.subarray(0, got)
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}

const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' }
const SUBSYSTEMS = { 1: 'driver', 2: 'janela', 3: 'console' }

const printable = (s) => s.replace(/[^\x20-\x7e]/g, '?')

/**
 * The PE headers, from bytes that may have been written to mislead a parser.
 *
 * Every offset in the file is checked against what was actually read before it
 * is followed, and every count is capped, so a header that claims sixty
 * thousand sections or points past the end of the file yields less
 * information rather than an exception. Anything that does not hold together
 * as a PE is simply not one: null.
 */
function peHeaders(head) {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null
  const fits = (at, n) => at >= 0 && at + n <= head.length
  const lfanew = head.readUInt32LE(0x3c)
  if (lfanew < 4 || !fits(lfanew, 24) || head.readUInt32LE(lfanew) !== 0x00004550) return null

  const coff = lfanew + 4
  const machine = head.readUInt16LE(coff)
  const count = head.readUInt16LE(coff + 2)
  const stamp = head.readUInt32LE(coff + 4)
  const optSize = head.readUInt16LE(coff + 16)
  const opt = coff + 20

  let subsystem = null
  const dirs = []
  if (optSize >= 2 && fits(opt, 2)) {
    const magic = head.readUInt16LE(opt)
    if (magic === 0x10b || magic === 0x20b) {
      const plus = magic === 0x20b
      if (optSize >= 70 && fits(opt + 68, 2)) subsystem = head.readUInt16LE(opt + 68)
      const countAt = plus ? 108 : 92
      const dirsAt = plus ? 112 : 96
      if (optSize >= countAt + 4 && fits(opt + countAt, 4)) {
        const declared = head.readUInt32LE(opt + countAt)
        const room = Math.max(0, Math.floor((optSize - dirsAt) / 8))
        for (let k = 0; k < Math.min(declared, 16, room); k++) {
          const at = opt + dirsAt + k * 8
          if (!fits(at, 8)) break
          dirs.push({ at: head.readUInt32LE(at), size: head.readUInt32LE(at + 4) })
        }
      }
    }
  }

  const sections = []
  for (let k = 0; k < Math.min(count, MAX_SECTIONS); k++) {
    const at = opt + optSize + k * 40
    if (!fits(at, 40)) break
    const raw = head.toString('latin1', at, at + 8)
    sections.push({
      name: printable(raw.includes('\0') ? raw.slice(0, raw.indexOf('\0')) : raw),
      size: head.readUInt32LE(at + 16),
      at: head.readUInt32LE(at + 20),
    })
  }

  const present = (k) => Boolean(dirs[k]?.at && dirs[k]?.size)
  return {
    arquitetura: MACHINES[machine] ?? `0x${machine.toString(16).padStart(4, '0')}`,
    subsistema: subsystem === null ? null : (SUBSYSTEMS[subsystem] ?? String(subsystem)),
    compilado: stamp ? new Date(stamp * 1000).toISOString() : null,
    dotnet: present(14),
    certificado: present(4),
    secoes: sections.map((s) => s.name),
    upx: false,
    entropiaAlta: false,
    instalador: null,
    sections,
  }
}

const UPX_MAGIC = Buffer.from('UPX!', 'latin1')

/**
 * Installer builders, by strings they leave in their stubs. Each is searched
 * as ASCII and as UTF-16, since the version resource where most of them sign
 * their work is UTF-16. Long strings only: in four megabytes of compressed
 * payload a three-letter needle like "WiX" turns up by chance about one file
 * in four.
 */
const INSTALLERS = [
  ['Inno Setup', ['Inno Setup', 'JR.Inno.Setup']],
  ['NSIS', ['Nullsoft Install System', 'NullsoftInst']],
  ['InstallShield', ['InstallShield']],
  ['WiX', ['Windows Installer XML', 'WiX Toolset', '.wixburn']],
  ['7-Zip SFX', ['7-Zip SFX', '7z SFX', '7zS.sfx', '7zSD.sfx']],
].map(([label, words]) => [label, words.flatMap((w) => [Buffer.from(w, 'latin1'), Buffer.from(w, 'utf16le')])])

const SEVEN_ZIP = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

function installerIn(head, imageEnd) {
  for (const [label, needles] of INSTALLERS) {
    if (needles.some((n) => head.includes(n))) return label
  }
  // A 7z archive appended after the program image, with no strings to name it, is still an SFX.
  return imageEnd > 0 && imageEnd < head.length && head.indexOf(SEVEN_ZIP, imageEnd) >= 0 ? '7-Zip SFX' : null
}

function entropy(counts, total) {
  let h = 0
  for (const c of counts) {
    if (c) {
      const p = c / total
      h -= p * Math.log2(p)
    }
  }
  return h
}

/**
 * Is any section close to random? Compressed or encrypted code is, and code
 * that has been through a packer or a crypter is the usual reason. Sampled
 * rather than read whole: four windows spread across a large section say as
 * much as the whole of it, and the whole of a file is capped at a few
 * megabytes however many sections it claims.
 */
async function highEntropy(fh, sections, fileSize, head) {
  let budget = ENTROPY_BUDGET
  for (const s of sections) {
    if (budget <= 0) break
    const start = s.at
    const end = Math.min(fileSize, s.at + s.size)
    if (!s.size || start >= fileSize || end - start < ENTROPY_MIN_BYTES) continue
    const length = end - start
    const windows =
      length <= 4 * ENTROPY_WINDOW
        ? [[start, length]]
        : [0, 1, 2, 3].map((k) => [start + Math.floor((k * (length - ENTROPY_WINDOW)) / 3), ENTROPY_WINDOW])
    const counts = new Uint32Array(256)
    let total = 0
    for (const [from, size] of windows) {
      const n = Math.min(size, budget)
      if (n <= 0) break
      const chunk = from + n <= head.length ? head.subarray(from, from + n) : await readAt(fh, from, n)
      for (let i = 0; i < chunk.length; i++) counts[chunk[i]]++
      total += chunk.length
      budget -= chunk.length
    }
    if (total >= ENTROPY_MIN_BYTES && entropy(counts, total) > ENTROPY_HIGH) return true
  }
  return false
}

/**
 * The names in a zip, from its central directory, without unpacking anything.
 *
 * The directory is found the way unzip finds it: the end record in the last
 * 64 KB, then back from it by the directory's size, which also works when a
 * program stub has been glued to the front. Zip64 archives are not followed.
 */
async function zipListing(fh, size, ext) {
  if (size < 22) return null
  const tailLength = Math.min(size, 22 + 0xffff)
  const tail = await readAt(fh, size - tailLength, tailLength)
  let end = -1
  let loose = -1
  for (let k = tail.length - 22; k >= 0; k--) {
    if (tail[k] !== 0x50 || tail.readUInt32LE(k) !== 0x06054b50) continue
    const stop = k + 22 + tail.readUInt16LE(k + 20)
    if (stop === tail.length) {
      end = k
      break
    }
    if (stop <= tail.length && loose < 0) loose = k
  }
  if (end < 0) end = loose
  if (end < 0) return null

  const declared = tail.readUInt16LE(end + 10)
  const dirSize = tail.readUInt32LE(end + 12)
  const dirOffset = tail.readUInt32LE(end + 16)
  if (declared === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return null
  const dirStart = size - tailLength + end - dirSize
  if (dirStart < 0) return null
  const dir = await readAt(fh, dirStart, Math.min(dirSize, MAX_ZIP_DIRECTORY))

  let entries = 0
  let manifest = false
  let password = false
  const risky = []
  for (let k = 0; k + 46 <= dir.length && entries < MAX_ZIP_ENTRIES; ) {
    if (dir.readUInt32LE(k) !== 0x02014b50) break
    const flags = dir.readUInt16LE(k + 8)
    const nameLength = dir.readUInt16LE(k + 28)
    if (k + 46 + nameLength > dir.length) break
    const raw = dir.subarray(k + 46, k + 46 + nameLength)
    const name = flags & 0x800 ? raw.toString('utf8') : cp850(raw)
    entries++
    if (flags & 1) password = true
    if (name === 'AndroidManifest.xml') manifest = true
    const leaf = name.split(/[\\/]/).pop()
    const type = leaf && !name.startsWith('__MACOSX/') ? riskType(leaf) : null
    // A zip inside a zip is not a program, and the guard does not unpack it to find out.
    if (type && type !== 'compactado' && risky.length < MAX_RISKY_LISTED) risky.push(name)
    k += 46 + nameLength + dir.readUInt16LE(k + 30) + dir.readUInt16LE(k + 32)
  }
  return {
    entradas: Math.max(entries, declared),
    arriscadas: risky,
    ...(password ? { senha: true } : {}),
    ...(ext === '.apk' ? { android: manifest } : {}),
  }
}

/** The header and, for zips, the directory. A parser that trips is a missing field, not a failed exam. */
async function lookInside(path, size, ext, log) {
  const fh = await open(path, 'r')
  try {
    const head = await readAt(fh, 0, Math.min(size, HEAD_BYTES))
    let pe = null
    let zip = null
    try {
      const found = peHeaders(head)
      if (found) {
        const { sections, ...info } = found
        info.upx =
          sections.some((s) => /^UPX[0-9!]?$/i.test(s.name)) || head.subarray(0, 4096).includes(UPX_MAGIC)
        info.entropiaAlta = await highEntropy(fh, sections, size, head)
        const imageEnd = Math.max(0, ...sections.map((s) => Math.min(size, s.at + s.size)))
        info.instalador = installerIn(head, imageEnd)
        pe = info
      }
    } catch (err) {
      if (isIoError(err)) throw err
      log?.(`[aurora] cabeçalho PE ilegível em ${basename(path)}: ${err.message}`)
    }
    if (ZIP_LIKE.has(ext)) {
      try {
        zip = await zipListing(fh, size, ext)
      } catch (err) {
        if (isIoError(err)) throw err
        log?.(`[aurora] zip ilegível em ${basename(path)}: ${err.message}`)
      }
    }
    return { pe, zip }
  } finally {
    await fh.close()
  }
}

const isIoError = (err) => typeof err?.code === 'string' && /^E[A-Z]+$/.test(err.code)

// ---------------------------------------------------------------------------
// Where it came from, and who signed it
// ---------------------------------------------------------------------------

/** The Mark of the Web: the browser's note of where a file came from, in an NTFS stream beside it. */
async function readZoneFile(path) {
  try {
    return await readFile(`${path}:Zone.Identifier`)
  } catch {
    return null
  }
}

function decodeText(data) {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  const buf = Buffer.from(data)
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

/** Host of a URL, looking through blob: to the page that made it. */
function hostOf(raw) {
  if (!raw) return null
  try {
    let url = new URL(raw)
    if (url.protocol === 'blob:') url = new URL(url.pathname)
    return /^(?:https?|ftp):$/.test(url.protocol) && url.hostname ? url.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * ZoneId 3 is the internet, 4 a restricted site. Chrome in incognito writes
 * HostUrl=about:internet, which has no host; the referring page is the next
 * best answer to "where from".
 */
function parseZone(text) {
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) fields[m[1].toLowerCase()] = m[2]
  }
  if (fields.zoneid === undefined && !fields.hosturl && !fields.referrerurl) return null
  const url = fields.hosturl || null
  const referencia = fields.referrerurl || null
  return {
    zona: /^\d+$/.test(fields.zoneid ?? '') ? Number(fields.zoneid) : null,
    url,
    referencia,
    host: hostOf(url) ?? hostOf(referencia),
  }
}

/**
 * Asks Windows. The path travels in an environment variable rather than in the
 * command, so a file named to break out of a PowerShell string has nothing to
 * break out of; the subject comes back as base64, so the console's code page
 * cannot mangle a publisher's name either.
 */
const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$s = Get-AuthenticodeSignature -LiteralPath $env:J_PATH',
  "$who = ''",
  'if ($s.SignerCertificate) { $who = $s.SignerCertificate.Subject }',
  '"STATUS=$($s.Status)"',
  '"SUBJECT=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($who))',
].join('\n')

function authenticode(path) {
  return new Promise((done) => {
    const system = process.env.SystemRoot || 'C:\\Windows'
    try {
      execFile(
        win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SIGNATURE_SCRIPT, 'utf16le').toString('base64')],
        { env: { ...process.env, J_PATH: path }, windowsHide: true, timeout: SIGNATURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (_err, stdout) => {
          const status = /^STATUS=(\w+)/m.exec(String(stdout ?? ''))
          const subject = /^SUBJECT=([A-Za-z0-9+/=]*)/m.exec(String(stdout ?? ''))
          done(status ? { status: status[1], subject: subject ? Buffer.from(subject[1], 'base64').toString('utf8') : '' } : null)
        },
      )
    } catch {
      done(null)
    }
  })
}

/**
 * The CN of a distinguished name, read the way .NET writes one: values with a
 * comma in them come quoted ("Zoom Video Communications, Inc."). Tokenised
 * rather than matched, so an organisation named `x, CN=Microsoft` cannot
 * pass for a common name.
 */
function commonName(subject) {
  const s = String(subject ?? '')
  let i = 0
  while (i < s.length) {
    const eq = s.indexOf('=', i)
    if (eq < 0) break
    const key = s.slice(i, eq).trim().toUpperCase()
    let j = eq + 1
    while (s[j] === ' ') j++
    let value = ''
    if (s[j] === '"') {
      for (j++; j < s.length; j++) {
        if (s[j] !== '"') value += s[j]
        else if (s[j + 1] === '"') value += s[j++]
        else break
      }
      j = s.indexOf(',', j)
      if (j < 0) j = s.length
    } else {
      j = s.indexOf(',', j)
      if (j < 0) j = s.length
      value = s.slice(eq + 1, j)
    }
    if (key === 'CN') return value.trim() || null
    i = j + 1
  }
  return null
}

/**
 * Authenticode's verdict, in the guard's words. NotSupportedFileFormat is not
 * a bad signature, it is no answer, and calling it invalid would put a false
 * alarm on every file Windows cannot sign; every other status is a signature
 * that did not check out.
 */
function signatureFrom(raw) {
  if (!raw || typeof raw.status !== 'string') return { status: 'desconhecida' }
  const status =
    { Valid: 'valida', NotSigned: 'ausente', NotTrusted: 'nao_confiavel', NotSupportedFileFormat: 'desconhecida' }[
      raw.status
    ] ?? 'invalida'
  const editor = status === 'ausente' ? null : commonName(raw.subject)
  return { status, ...(editor ? { editor } : {}), bruto: raw.status }
}

// ---------------------------------------------------------------------------
// VirusTotal, by hash only
// ---------------------------------------------------------------------------

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`sem resposta em ${ms / 1000} s`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * What VirusTotal already knows about these bytes. Only the hash is sent:
 * uploading the file would hand someone's private download to a public
 * service. A hash it has never seen is an answer too, and a common one for
 * anything freshly built.
 */
async function virustotal(sha256, key, fetcher, log) {
  try {
    return await withTimeout(
      (async () => {
        const res = await fetcher(`https://www.virustotal.com/api/v3/files/${sha256}`, {
          headers: { 'x-apikey': key, accept: 'application/json' },
          signal: AbortSignal.timeout(VIRUSTOTAL_TIMEOUT_MS),
        })
        if (res.status === 404) return { conhecido: false }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const stats = (await res.json())?.data?.attributes?.last_analysis_stats
        if (!stats || typeof stats !== 'object') throw new Error('resposta sem last_analysis_stats')
        const n = (k) => (Number.isFinite(stats[k]) ? stats[k] : 0)
        return {
          conhecido: true,
          maliciosos: n('malicious'),
          suspeitos: n('suspicious'),
          total: n('malicious') + n('suspicious') + n('undetected') + n('harmless'),
        }
      })(),
      VIRUSTOTAL_TIMEOUT_MS,
    )
  } catch (err) {
    log?.(`[aurora] VirusTotal: ${err?.message ?? err}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Alert labels as stored in reports, Portuguese whatever the language, as other code reads them. */
const ALERT = {
  invertido: 'nome com caractere invertido',
  dupla: 'extensão dupla',
  invalida: 'assinatura inválida',
  naoConfiavel: 'assinatura não confiável',
  semAssinatura: 'baixado da internet sem assinatura',
  script: 'script baixado da internet',
  upx: 'empacotado com UPX',
  embaralhado: 'conteúdo embaralhado',
  programaDentro: 'compactado com programa dentro',
  senha: 'compactado com senha',
}

const ALERT_EN = new Map([
  [ALERT.invertido, 'reversing character in the name'],
  [ALERT.dupla, 'double extension'],
  [ALERT.invalida, 'invalid signature'],
  [ALERT.naoConfiavel, 'untrusted signature'],
  [ALERT.semAssinatura, 'downloaded from the internet unsigned'],
  [ALERT.script, 'script downloaded from the internet'],
  [ALERT.upx, 'packed with UPX'],
  [ALERT.embaralhado, 'scrambled contents'],
  [ALERT.programaDentro, 'archive with a program inside'],
  [ALERT.senha, 'password-protected archive'],
])

/** Alerts that are a disguise or a broken promise, not merely an absence. */
const SERIOUS = new Set([ALERT.invertido, ALERT.dupla, ALERT.invalida])

function alertText(label, pt) {
  if (pt) return label
  const vt = /^VirusTotal: (malicioso|suspeito) para (\d+) de (\d+)$/.exec(label)
  if (vt) return `VirusTotal: ${vt[1] === 'malicioso' ? 'malicious' : 'suspicious'} for ${vt[2]} of ${vt[3]}`
  return ALERT_EN.get(label) ?? label
}

/**
 * Alerts and level from what was found.
 *
 * High entropy alone is common in honest files, since installers carry
 * compressed payloads and many programs carry compressed resources, so it
 * only counts when the file is neither a known installer nor validly signed.
 * Behind UPX it is expected and says nothing new.
 */
function judge(r) {
  const alerts = []
  const internet = r.origem?.zona === 3 || r.origem?.zona === 4
  const sig = r.assinatura?.status
  const stem = r.nome.slice(0, r.nome.length - extname(r.nome).length)

  if (OVERRIDE.test(r.nome)) alerts.push(ALERT.invertido)
  if (r.tipo && r.tipo !== 'compactado' && r.tipo !== 'disco' && DECOY.test(stem.replace(PADDING, ''))) {
    alerts.push(ALERT.dupla)
  }
  if (sig === 'invalida') alerts.push(ALERT.invalida)
  if (sig === 'nao_confiavel') alerts.push(ALERT.naoConfiavel)
  if (r.tipo === 'script') {
    if (internet) alerts.push(ALERT.script)
  } else if (sig === 'ausente' && internet) {
    alerts.push(ALERT.semAssinatura)
  }
  if (r.pe?.upx) alerts.push(ALERT.upx)
  else if (r.pe?.entropiaAlta && !r.pe.instalador && sig !== 'valida') alerts.push(ALERT.embaralhado)
  if (r.tipo === 'compactado' && r.zip?.arriscadas?.length) {
    alerts.push(ALERT.programaDentro)
    if (r.zip.senha) alerts.push(ALERT.senha)
  }
  const vt = r.virustotal
  if (vt?.conhecido && vt.maliciosos > 0) alerts.push(`VirusTotal: malicioso para ${vt.maliciosos} de ${vt.total}`)
  else if (vt?.conhecido && vt.suspeitos > 0) alerts.push(`VirusTotal: suspeito para ${vt.suspeitos} de ${vt.total}`)

  const nivel =
    alerts.some((a) => SERIOUS.has(a)) || (vt?.conhecido && vt.maliciosos > 0)
      ? 'perigo'
      : alerts.length || r.tipo === 'script'
        ? 'atencao'
        : 'ok'
  return { alertas: alerts, nivel }
}

/**
 * Examine one file, read-only.
 *
 * @param {string} path
 * @param {{ platform?: string, readZone?: (path: string) => any,
 *           checkSignature?: (path: string) => any, fetch?: typeof fetch,
 *           virustotalKey?: string, log?: (msg: string) => void }} [opts]
 *   platform decides the defaults for readZone and checkSignature, which on
 *   Windows read the Zone.Identifier stream and ask Get-AuthenticodeSignature;
 *   injected ones are used on any platform. readZone returns the stream's text
 *   or bytes (null when there is none); checkSignature returns
 *   { status, subject } with Authenticode's own status name, or null.
 *   VirusTotal is asked only when virustotalKey is set.
 */
export async function examine(path, opts = {}) {
  const windows = (opts.platform ?? process.platform) === 'win32'
  const caminho = resolve(String(path))
  const info = await stat(caminho)
  if (!info.isFile()) throw new Error(`não é um arquivo comum: ${caminho}`)
  const quando = new Date().toISOString()
  const nome = basename(caminho)
  const ext = extname(nome).toLowerCase()
  const tipo = riskType(nome)

  const readZone = opts.readZone ?? (windows ? readZoneFile : null)
  const checkSignature = opts.checkSignature ?? (windows ? authenticode : null)
  const signable = SIGNABLE.has(tipo) || SIGNABLE_SCRIPTS.has(ext)

  const [sha256, inside, origem, assinatura] = await Promise.all([
    info.size <= MAX_HASH_BYTES ? sha256File(caminho) : null,
    lookInside(caminho, info.size, ext, opts.log),
    readZone
      ? Promise.resolve()
          .then(() => readZone(caminho))
          .then((data) => parseZone(decodeText(data)))
          .catch(() => null)
      : null,
    !signable
      ? null
      : checkSignature
        ? Promise.resolve()
            .then(() => checkSignature(caminho))
            .then(signatureFrom)
            .catch(() => ({ status: 'desconhecida' }))
        : { status: 'desconhecida' },
  ])

  const fetcher = opts.fetch ?? globalThis.fetch
  const vt = opts.virustotalKey && sha256 && fetcher ? await virustotal(sha256, opts.virustotalKey, fetcher, opts.log) : undefined

  const report = {
    caminho,
    nome,
    tipo,
    tamanho: info.size,
    sha256,
    quando,
    origem,
    assinatura,
    pe: inside.pe,
    zip: inside.zip,
    alertas: [],
    nivel: 'ok',
  }
  if (vt) report.virustotal = vt
  Object.assign(report, judge(report))
  return report
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/** Written whole or not at all, the way memory.mjs writes its files. */
let tmpSeq = 0
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, path)
  } catch {
    // A rename over a file another program holds open fails on Windows.
    await writeFile(path, text, 'utf8')
    await rm(tmp, { force: true })
  }
}

/**
 * Watch a folder and examine what arrives in it.
 *
 * The first run ever only takes stock: everything already in the folder is
 * recorded as seen and nothing is announced, because a list of last year's
 * installers is not news. After that the record is what makes the guard
 * honest across restarts: on start, anything risky that is not in it arrived
 * while AURORA was off, and is reported as such.
 *
 * A file counts as arrived when its size and time have held still for
 * `stableMs`. Browsers already write under a temporary name and rename at the
 * end, but other programs write in place, Firefox leaves an empty placeholder
 * under the final name, and antivirus and the browser itself touch a file
 * just after it lands. Each version of a file is examined once, keyed by
 * name, size and time, and announced only if its bytes are new: a touch that
 * changes nothing but the time updates the record quietly.
 *
 * Nothing here throws out of the watcher. A file that cannot be read now is
 * tried again; a folder that cannot be watched is polled instead.
 *
 * @param {{ dir?: string, stateFile?: string, lang?: string,
 *           onFound?: (report: object) => void, log?: (msg: string) => void,
 *           examineOptions?: object, stableMs?: number, pollMs?: number }} options
 *   examineOptions go to examine(); virustotalKey defaults to
 *   AURORA_VIRUSTOTAL_KEY. stableMs and pollMs are there for tests.
 */
export function createGuard({
  dir = downloadsDir(),
  stateFile = join(homedir(), '.aurora', 'guarda-downloads.json'),
  lang = 'pt-BR',
  onFound = () => {},
  log = console.warn,
  examineOptions = {},
  stableMs = 2000,
  pollMs = 10_000,
} = {}) {
  const root = resolve(dir)
  const pt = isPt(lang)
  const quietly = (fn) => {
    try {
      fn()
    } catch {
      /* a logger's problem, not the guard's */
    }
  }
  const warn = (ptText, enText) =>
    quietly(() => log(`[aurora] ${pt ? `guarda de downloads: ${ptText}` : `downloads guard: ${enText}`}`))
  const options = {
    virustotalKey: process.env.AURORA_VIRUSTOTAL_KEY,
    log: (msg) => quietly(() => log(msg)),
    ...examineOptions,
  }

  let state = null
  let firstRun = false
  let running = false
  let generation = 0
  let watcher = null
  let poller = null
  let rescanTimer = null
  let unreadable = false
  let queue = Promise.resolve()
  let writing = Promise.resolve()
  const timers = new Map()
  const pending = new Map()
  const failures = new Map()
  const offline = new Set()
  const busy = new Set()

  const alive = (gen) => running && gen === generation

  const fresh = () => {
    const now = new Date().toISOString()
    return { versao: 1, baseline: now, ultimaVarredura: now, vistos: Object.create(null), recentes: [] }
  }

  /** The record, read once. Unreadable counts as a first run: better silence than a flood. */
  function load() {
    if (state) return state
    let text = null
    try {
      text = readFileSync(stateFile, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') warn(`não consegui ler ${stateFile}: ${err.message}`, `could not read ${stateFile}: ${err.message}`)
    }
    if (text !== null) {
      try {
        const saved = JSON.parse(text.replace(/^\uFEFF/, ''))
        const seen = saved?.vistos && typeof saved.vistos === 'object' && !Array.isArray(saved.vistos) ? saved.vistos : {}
        state = {
          versao: 1,
          baseline: typeof saved.baseline === 'string' ? saved.baseline : new Date().toISOString(),
          ultimaVarredura: typeof saved.ultimaVarredura === 'string' ? saved.ultimaVarredura : null,
          vistos: Object.assign(Object.create(null), seen),
          recentes: Array.isArray(saved.recentes) ? saved.recentes.filter((r) => r && typeof r === 'object').slice(0, RECENT_KEPT) : [],
        }
        return state
      } catch {
        warn(
          `${stateFile} está ilegível; recomeço sem anunciar o que já está na pasta`,
          `${stateFile} is unreadable; starting over without announcing what is already there`,
        )
      }
    }
    firstRun = true
    state = fresh()
    return state
  }

  function save() {
    const text = JSON.stringify(state, null, 2)
    writing = writing
      .then(() => writeAtomic(stateFile, text))
      .catch((err) => warn(`não consegui gravar ${stateFile}: ${err.message}`, `could not write ${stateFile}: ${err.message}`))
    return writing
  }

  async function listDir() {
    try {
      const names = await readdir(root)
      unreadable = false
      return names
    } catch (err) {
      if (!unreadable) warn(`não consigo ler ${root}: ${err.code ?? err.message}`, `cannot read ${root}: ${err.code ?? err.message}`)
      unreadable = true
      return null
    }
  }

  const wanted = (name) => !ignored(name) && riskType(name) !== null

  function later(name, ms) {
    clearTimeout(timers.get(name))
    const gen = generation
    const timer = setTimeout(() => {
      timers.delete(name)
      check(name, gen).catch((err) => warn(`${name}: ${err.message}`, `${name}: ${err.message}`))
    }, ms)
    timer.unref?.()
    timers.set(name, timer)
  }

  function touch(name, delay = DEBOUNCE_MS) {
    if (running && wanted(name)) later(name, delay)
  }

  async function partialBeside(name) {
    for (const suffix of PARTIAL) {
      if (await lstat(join(root, name + suffix)).then(() => true, () => false)) return true
    }
    return false
  }

  /** Has this version of the file held still long enough? If so, queue its exam. */
  async function check(name, gen) {
    if (!alive(gen) || busy.has(`${gen}:${name}`)) return
    const info = await lstat(join(root, name)).catch(() => null)
    if (!alive(gen)) return
    if (!info?.isFile()) {
      pending.delete(name)
      offline.delete(name)
      return
    }
    const seen = state.vistos[name]
    if (seen && seen.tamanho === info.size && seen.mtimeMs === info.mtimeMs) {
      pending.delete(name)
      offline.delete(name)
      return
    }
    const now = Date.now()
    const p = pending.get(name)
    if (!p || p.size !== info.size || p.mtimeMs !== info.mtimeMs) {
      pending.set(name, { size: info.size, mtimeMs: info.mtimeMs, since: now })
      // An empty file is a placeholder: whatever fills it will bring an event of its own.
      if (info.size > 0) later(name, stableMs)
      return
    }
    if (info.size === 0) return
    if (now - p.since < stableMs) {
      later(name, p.since + stableMs - now)
      return
    }
    // Firefox's placeholder under the final name, with the real bytes still in a .part beside it.
    const unfinished = await partialBeside(name)
    if (!alive(gen)) return
    if (unfinished) {
      later(name, stableMs * 5)
      return
    }
    pending.delete(name)
    const key = `${gen}:${name}`
    busy.add(key)
    const run = queue.then(() => settle(name, info, gen))
    queue = run.catch((err) => warn(`${name}: ${err.message}`, `${name}: ${err.message}`)).finally(() => busy.delete(key))
  }

  /** Examine one settled file, record it, and announce it if its bytes are new. */
  async function settle(name, info, gen) {
    if (!alive(gen)) return
    const path = join(root, name)
    let report
    try {
      report = await examine(path, options)
    } catch (err) {
      if (!alive(gen) || err?.code === 'ENOENT') return
      const tries = (failures.get(name) ?? 0) + 1
      if (RETRYABLE.has(err?.code) && tries < 4) {
        failures.set(name, tries)
        return later(name, stableMs * 2 * tries)
      }
      failures.delete(name)
      warn(`não consegui examinar ${name}: ${err.message}`, `could not examine ${name}: ${err.message}`)
      state.vistos[name] = { tamanho: info.size, mtimeMs: info.mtimeMs, sha256: null }
      await save()
      return
    }
    failures.delete(name)
    const after = await lstat(path).catch(() => null)
    if (!alive(gen) || !after?.isFile()) return
    // Still being written after all: let it settle again rather than report half a file.
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) return touch(name)

    const before = state.vistos[name]
    state.vistos[name] = { tamanho: info.size, mtimeMs: info.mtimeMs, sha256: report.sha256 }
    if (offline.delete(name)) report.enquantoDesligada = true
    if (before?.sha256 && before.sha256 === report.sha256) {
      // The same bytes with a new time: antivirus, or the browser adding the Mark of the Web.
      const at = state.recentes.findIndex((r) => r.nome === name && r.sha256 === report.sha256)
      if (at >= 0) state.recentes[at] = { ...report, ...(state.recentes[at].enquantoDesligada ? { enquantoDesligada: true } : {}) }
      await save()
      return
    }
    state.recentes.unshift(report)
    state.recentes.length = Math.min(state.recentes.length, RECENT_KEPT)
    await save()
    Promise.resolve()
      .then(() => onFound(report))
      .catch((err) => warn(`onFound falhou: ${err?.message ?? err}`, `onFound failed: ${err?.message ?? err}`))
  }

  /** Everything risky in the folder goes through check(); records of files that are gone are dropped. */
  async function scan(gen, whileOff) {
    const names = await listDir()
    if (!names || !alive(gen)) return
    const present = new Set(names)
    for (const name of Object.keys(state.vistos)) if (!present.has(name)) delete state.vistos[name]
    state.ultimaVarredura = new Date().toISOString()
    for (const name of names) {
      if (!wanted(name)) continue
      if (whileOff) offline.add(name)
      touch(name, 0)
    }
  }

  async function takeStock(gen) {
    const names = (await listDir()) ?? []
    for (const name of names) {
      const info = await lstat(join(root, name)).catch(() => null)
      if (!alive(gen)) return
      if (info?.isFile()) state.vistos[name] = { tamanho: info.size, mtimeMs: info.mtimeMs, sha256: null }
    }
    const now = new Date().toISOString()
    state.baseline = now
    state.ultimaVarredura = now
    await save()
  }

  function poll(gen) {
    if (poller || !alive(gen)) return
    poller = setInterval(() => {
      if (alive(gen)) scan(gen, false).catch((err) => warn(err.message, err.message))
    }, pollMs)
    poller.unref?.()
  }

  function fallBack(gen, err) {
    watcher?.close()
    watcher = null
    warn(
      `não consigo vigiar ${root} (${err?.code ?? err?.message}); passo a olhar a pasta a cada ${pollMs / 1000} s`,
      `cannot watch ${root} (${err?.code ?? err?.message}); checking the folder every ${pollMs / 1000} s instead`,
    )
    poll(gen)
  }

  function watchFolder(gen) {
    try {
      watcher = watch(root, { persistent: false }, (_event, filename) => {
        if (!alive(gen)) return
        if (filename) return touch(String(filename))
        // No name: the event buffer overflowed. Look at everything.
        clearTimeout(rescanTimer)
        rescanTimer = setTimeout(() => scan(gen, false).catch(() => {}), DEBOUNCE_MS)
        rescanTimer.unref?.()
      })
      watcher.on('error', (err) => alive(gen) && fallBack(gen, err))
    } catch (err) {
      fallBack(gen, err)
    }
  }

  async function start() {
    if (running) return
    running = true
    const gen = ++generation
    load()
    if (firstRun) {
      firstRun = false
      await takeStock(gen)
      if (alive(gen)) watchFolder(gen)
      return
    }
    // Watch first, so nothing that lands during the scan falls between the two.
    watchFolder(gen)
    await scan(gen, true)
    if (alive(gen)) await save()
  }

  async function stop() {
    if (!running) return
    running = false
    generation++
    watcher?.close()
    watcher = null
    clearInterval(poller)
    poller = null
    clearTimeout(rescanTimer)
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    pending.clear()
    offline.clear()
    failures.clear()
    if (state) await save()
  }

  /** The latest reports, newest first. */
  function recent(n = 10) {
    const k = Math.max(0, Math.min(RECENT_KEPT, Math.floor(Number(n)) || 0))
    return load().recentes.slice(0, k)
  }

  return { dir: root, start, stop, recent, examine: (path) => examine(path, options) }
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

/** What each type is called aloud, with the gender its adjectives take. */
const KINDS = {
  programa: { pt: 'o programa', en: 'the program', g: 'o' },
  instalador: { pt: 'o instalador', en: 'the installer', g: 'o' },
  script: { pt: 'o script', en: 'the script', g: 'o' },
  biblioteca: { pt: 'a biblioteca', en: 'the library', g: 'a' },
  android: { pt: 'o aplicativo Android', en: 'the Android app', g: 'o' },
  java: { pt: 'o programa Java', en: 'the Java program', g: 'o' },
  disco: { pt: 'a imagem de disco', en: 'the disk image', g: 'a' },
  compactado: { pt: 'o arquivo compactado', en: 'the archive', g: 'o' },
  arquivo: { pt: 'o arquivo', en: 'the file', g: 'o' },
}

const UNITS_PT = 'zero um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete dezoito dezenove'.split(' ')
const TENS_PT = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const UNITS_EN = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS_EN = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** Counts as they are said: "três antivírus", not "3 antivírus". */
function inWords(n, pt) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n)
  const units = pt ? UNITS_PT : UNITS_EN
  if (n < 20) return units[n]
  const tens = (pt ? TENS_PT : TENS_EN)[Math.floor(n / 10)]
  return n % 10 ? `${tens}${pt ? ' e ' : '-'}${units[n % 10]}` : tens
}

/**
 * Words AURORA does not say, in either language. Phishing names its files
 * "URGENTE - boleto" precisely to hurry the reader, and reading that aloud
 * would lend the bait her voice; so they are dropped from a spoken name, and
 * a publisher or host containing one goes unnamed.
 */
const ALARM = new Set(
  (
    'perigo perigos perigoso perigosa perigosos perigosas urgente urgentes urgencia ' +
    'rapido rapida rapidos rapidas rapidamente critico critica criticos criticas ' +
    'imediato imediata imediatamente danger dangerous urgent urgently quick quickly ' +
    'critical hurry immediately now'
  ).split(' '),
)

const fold = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
const alarming = (word) => ALARM.has(fold(word).replace(/[^a-z]/g, ''))
const calm = (text) => !String(text).split(/[^\p{L}]+/u).some((w) => w && alarming(w))

/** Cut at a word boundary near `max`, for speech: no ellipsis to read aloud. */
function clip(s, max) {
  if (s.length <= max) return s
  // One character more than fits, so a cut that lands exactly between two words keeps the first.
  const cut = s.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s.,]+$/, '')
}

/** fatura_final-v2.pdf.exe → "fatura final v2.pdf": the name a person would say. */
function spokenName(nome) {
  const name = String(nome ?? '')
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  const words = stem
    .replace(BIDI, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.,()&+']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !alarming(w))
  return clip(words.join(' ').replace(/^[\s.,]+|[\s.,]+$/g, ''), 40)
}

/** Legal suffixes nobody says aloud: "Zoom Video Communications, Inc." is Zoom Video Communications. */
const LEGAL =
  /[\s,]+(?:inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|ltda\.?|s\.?\/?a\.?|gmbh|ag|co\.?|corp\.?|corporation|b\.v\.?|plc|oy|ab|s\.r\.l\.?|sas|s\.a\.s\.?|pty|k\.?k\.?|me|eireli|epp)$/i

function spokenPublisher(cn) {
  let s = String(cn ?? '')
    .replace(BIDI, '')
    .replace(/[^\p{L}\p{N}\s.,&'+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (let k = 0; k < 4; k++) {
    const next = s.replace(/[\s,]+$/, '').replace(LEGAL, '')
    if (next === s || !next.trim()) break
    s = next
  }
  s = clip(s.replace(/[\s,]+$/, ''), 40)
  return s && calm(s) ? s : ''
}

const spokenHost = (host) => {
  const h = String(host ?? '').replace(/^www\./i, '')
  return h && calm(h) ? h : ''
}

/**
 * One or two sentences for AURORA to say about a report, unprompted.
 *
 * Unsolicited, so it opens on the vocative, the way she raises anything he did
 * not ask about. The worse the finding, the barer the line: a disguise gets
 * its reason and one plain recommendation, never a raised voice. The file is
 * named the way a person would say it, the source by its host alone, the
 * signer without the Inc.
 */
export function announce(report, lang = 'pt-BR') {
  const pt = isPt(lang)
  const r = report ?? {}
  const kind = r.tipo === 'programa' && r.pe?.instalador ? KINDS.instalador : (KINDS[r.tipo] ?? KINDS.arquivo)
  const g = kind.g
  const who = [pt ? kind.pt : kind.en, spokenName(r.nome)].filter(Boolean).join(' ')
  const host = spokenHost(r.origem?.host)
  const from = host ? (pt ? `, vind${g} de ${host}` : `, from ${host}`) : ''
  const off = Boolean(r.enquantoDesligada)
  const alerts = new Set(Array.isArray(r.alertas) ? r.alertas : [])
  const vt = r.virustotal?.conhecido ? r.virustotal : null
  const and = pt ? ' e ' : ' and '
  const engines = (n) => (pt ? `${inWords(n, true)} antivírus` : `${inWords(n, false)} antivirus ${n === 1 ? 'engine' : 'engines'}`)

  if (r.nivel === 'perigo') {
    const why = []
    if (alerts.has(ALERT.invertido)) why.push(pt ? 'um caractere oculto que inverte o nome' : 'a hidden character that reverses its name')
    if (alerts.has(ALERT.dupla)) why.push(pt ? 'extensão dupla' : 'a double extension')
    if (alerts.has(ALERT.invalida)) why.push(pt ? 'a assinatura digital inválida' : 'an invalid digital signature')
    if (vt?.maliciosos > 0) {
      why.push(pt ? `alerta de ${engines(vt.maliciosos)}` : `${vt.maliciosos === 1 ? 'an alert' : 'alerts'} from ${engines(vt.maliciosos)}`)
    }
    const reasons = why.slice(0, 2).join(and)
    const withWhat = reasons ? `${off ? ',' : ''} ${pt ? 'com' : 'with'} ${reasons}` : ''
    return pt
      ? `Senhor, ${who} chegou em Downloads${off ? ' enquanto eu estava desligada' : ''}${withWhat}${from}. Melhor não abrir antes de examinar.`
      : `Sir, ${who} ${off ? 'arrived' : 'has arrived'} in Downloads${off ? ' while I was off' : ''}${withWhat}${from}. Best left unopened until it has been examined.`
  }

  const quals = []
  if (r.nivel === 'atencao') {
    const inside = r.zip?.arriscadas?.length ?? 0
    if (alerts.has(ALERT.naoConfiavel)) quals.push(pt ? 'com assinatura digital não confiável' : 'with an untrusted signature')
    if (alerts.has(ALERT.semAssinatura)) quals.push(pt ? 'sem assinatura digital' : 'unsigned')
    if (vt?.suspeitos > 0) {
      quals.push(pt ? `com suspeita de ${engines(vt.suspeitos)}` : `flagged as suspicious by ${engines(vt.suspeitos)}`)
    }
    if (alerts.has(ALERT.programaDentro)) {
      quals.push(pt ? (inside === 1 ? 'com um programa dentro' : 'com programas dentro') : inside === 1 ? 'with a program inside' : 'with programs inside')
    }
    if (alerts.has(ALERT.senha)) quals.push(pt ? `protegid${g} por senha` : 'password-protected')
    if (alerts.has(ALERT.upx)) quals.push(pt ? `empacotad${g} com UPX` : 'packed with UPX')
    if (alerts.has(ALERT.embaralhado)) quals.push(pt ? 'com conteúdo embaralhado' : 'with scrambled contents')
    if (alerts.has(ALERT.script) && !host) quals.push(pt ? `baixad${g} da internet` : 'downloaded from the internet')
  }
  const kept = quals.slice(0, 2)
  if (kept.length < 2 && r.assinatura?.status === 'valida') {
    const publisher = spokenPublisher(r.assinatura.editor)
    if (publisher) kept.push(pt ? `assinad${g} por ${publisher}` : `signed by ${publisher}`)
    else kept.push(pt ? 'com assinatura digital válida' : 'with a valid signature')
  }
  const tail = `${kept.length ? `, ${kept.join(and)}` : ''}${from}`
  return pt
    ? `Senhor, ${off ? 'enquanto eu estava desligada, ' : ''}chegou em Downloads ${who}${tail}.`
    : `Sir, ${off ? 'while I was off, ' : ''}${who} ${off ? 'arrived' : 'has arrived'} in Downloads${tail}.`
}

// ---------------------------------------------------------------------------
// Showing it
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

/**
 * Direction controls made visible, control characters dropped. On screen an
 * override would do to the card what it did to the file name, and the point
 * of showing the name is to show what it really is.
 */
const visible = (s) =>
  String(s ?? '')
    .replace(BIDI, (c) => `‹U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}›`)
    .replace(/\p{Cc}/gu, '')

const show = (s) => esc(visible(s))

const TYPE_LABEL = {
  programa: ['programa', 'program'],
  instalador: ['instalador', 'installer'],
  script: ['script', 'script'],
  biblioteca: ['biblioteca', 'library'],
  android: ['aplicativo Android', 'Android app'],
  java: ['programa Java', 'Java program'],
  disco: ['imagem de disco', 'disk image'],
  compactado: ['arquivo compactado', 'archive'],
}
const typeLabel = (tipo, pt) => (TYPE_LABEL[tipo] ?? ['arquivo', 'file'])[pt ? 0 : 1]

/** On screen too the level reads as advice, not as an alarm. */
const LEVEL_LABEL = { ok: ['sem alertas', 'no alerts'], atencao: ['atenção', 'caution'], perigo: ['alto risco', 'high risk'] }
const levelLabel = (nivel, pt) => (LEVEL_LABEL[nivel] ?? [String(nivel ?? '—'), String(nivel ?? '—')])[pt ? 0 : 1]

const ZONE_LABEL = {
  0: ['este computador', 'this computer'],
  1: ['rede local', 'local network'],
  2: ['site confiável', 'trusted site'],
  3: ['internet', 'internet'],
  4: ['site restrito', 'restricted site'],
}
const zoneLabel = (zona, pt) => (ZONE_LABEL[zona] ? ZONE_LABEL[zona][pt ? 0 : 1] : '')

const SIGNATURE_LABEL = {
  valida: ['válida', 'valid'],
  ausente: ['sem assinatura', 'unsigned'],
  nao_confiavel: ['não confiável', 'untrusted'],
  invalida: ['inválida', 'invalid'],
  desconhecida: ['não verificada', 'not checked'],
}
const signatureLabel = (status, pt) => (SIGNATURE_LABEL[status] ?? [String(status), String(status)])[pt ? 0 : 1]

const SUBSYSTEM_EN = { janela: 'GUI', console: 'console', driver: 'driver' }

function size(bytes, pt) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(bytes) || 0
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${new Intl.NumberFormat(pt ? 'pt-BR' : 'en-GB', { maximumFractionDigits: u ? 1 : 0 }).format(v)} ${units[u]}`
}

const day = (iso, pt) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(pt ? 'pt-BR' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' })
}

const moment = (iso, pt) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(pt ? 'pt-BR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

function vtLine(vt, pt) {
  if (!vt.conhecido) return { text: pt ? 'nunca visto pelo VirusTotal' : 'never seen by VirusTotal', hot: false }
  if (vt.maliciosos > 0) {
    return { text: pt ? `malicioso para ${vt.maliciosos} de ${vt.total}` : `malicious for ${vt.maliciosos} of ${vt.total}`, hot: true }
  }
  if (vt.suspeitos > 0) {
    return { text: pt ? `suspeito para ${vt.suspeitos} de ${vt.total}` : `suspicious for ${vt.suspeitos} of ${vt.total}`, hot: true }
  }
  return { text: pt ? `nenhum alerta em ${vt.total}` : `no alerts from ${vt.total}`, hot: false }
}

/**
 * The card for a blade: one row per thing found, in the HUD's own classes and
 * no others, every value escaped. The SHA-256 goes in groups of sixteen so it
 * wraps instead of running off the edge.
 */
export function reportHtml(report, lang = 'pt-BR') {
  const pt = isPt(lang)
  const r = report ?? {}
  const L = (a, b) => (pt ? a : b)
  const rows = []
  const row = (label, { sub = '', tag = '', hot = false, dim = false } = {}) => {
    rows.push(
      `<div class="hud-row${dim ? ' hud-dim' : ''}">` +
        `<span class="hud-idx">${String(rows.length + 1).padStart(2, '0')}</span>` +
        `<span class="hud-main"><span class="hud-label${hot ? ' hud-hot' : ''}">${show(label)}</span>` +
        (sub ? `<span class="hud-sub">${show(sub)}</span>` : '') +
        '</span>' +
        (tag ? `<span class="hud-tag">${show(tag)}</span>` : '') +
        '</div>',
    )
  }
  const alerts = Array.isArray(r.alertas) ? r.alertas : []

  row(r.nome ?? '—', {
    sub: [typeLabel(r.tipo, pt), size(r.tamanho, pt), r.enquantoDesligada ? L('chegou com a AURORA desligada', 'arrived while AURORA was off') : '']
      .filter(Boolean)
      .join(' · '),
    tag: L('arquivo', 'file'),
  })
  row(levelLabel(r.nivel, pt), {
    sub: alerts.length ? '' : L('nada fora do comum', 'nothing out of the ordinary'),
    tag: L('nível', 'level'),
    hot: r.nivel !== 'ok',
  })
  for (const a of alerts) row(alertText(a, pt), { tag: L('alerta', 'alert'), hot: true })

  if (r.origem) {
    const zone = zoneLabel(r.origem.zona, pt)
    const via = hostOf(r.origem.referencia)
    row(r.origem.host ?? (zone || '—'), {
      sub: [r.origem.host ? zone : '', via && via !== r.origem.host ? `${L('a partir de', 'via')} ${via}` : ''].filter(Boolean).join(' · '),
      tag: L('origem', 'source'),
    })
  }

  if (r.assinatura) {
    const st = r.assinatura.status
    row(signatureLabel(st, pt), {
      sub:
        r.assinatura.editor ??
        (st === 'desconhecida' && r.pe?.certificado ? L('o arquivo traz um certificado', 'the file carries a certificate') : ''),
      tag: L('assinatura', 'signature'),
      hot: st === 'invalida' || st === 'nao_confiavel',
    })
  }

  if (r.pe) {
    const subsystem = pt ? r.pe.subsistema : (SUBSYSTEM_EN[r.pe.subsistema] ?? r.pe.subsistema)
    row([r.pe.arquitetura, subsystem].filter(Boolean).join(' · ') || '—', {
      sub: r.pe.compilado ? `${L('compilado em', 'compiled')} ${day(r.pe.compilado, pt)}` : '',
      tag: 'PE',
    })
    const flags = [
      r.pe.instalador,
      r.pe.upx && 'UPX',
      r.pe.dotnet && '.NET',
      r.pe.entropiaAlta && L('entropia alta', 'high entropy'),
      r.pe.certificado && L('certificado embutido', 'embedded certificate'),
    ].filter(Boolean)
    const names = Array.isArray(r.pe.secoes) ? r.pe.secoes : []
    if (flags.length || names.length) {
      row(flags.join(' · ') || L('nada de especial', 'nothing unusual'), {
        sub: names.length ? `${L('seções', 'sections')}: ${names.join(' ')}` : '',
        tag: L('estrutura', 'structure'),
      })
    }
  }

  if (r.zip) {
    const n = r.zip.entradas
    const inside = Array.isArray(r.zip.arriscadas) ? r.zip.arriscadas : []
    row(
      [
        pt ? `${n} ${n === 1 ? 'entrada' : 'entradas'}` : `${n} ${n === 1 ? 'entry' : 'entries'}`,
        r.zip.senha ? L('com senha', 'password-protected') : '',
        r.zip.android === true ? L('com AndroidManifest.xml', 'has AndroidManifest.xml') : '',
        r.zip.android === false ? L('sem AndroidManifest.xml', 'no AndroidManifest.xml') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      {
        sub: inside.length ? `${L('programas dentro', 'programs inside')}: ${inside.join(', ')}` : L('nenhum programa dentro', 'no programs inside'),
        tag: L('conteúdo', 'contents'),
        hot: r.tipo === 'compactado' && inside.length > 0,
      },
    )
  }

  if (r.virustotal) {
    const { text, hot } = vtLine(r.virustotal, pt)
    row(text, { sub: L('consultado só pelo hash', 'looked up by hash only'), tag: 'VirusTotal', hot })
  }

  row(r.sha256 ? r.sha256.match(/.{1,16}/g).join(' ') : L('não calculado: arquivo grande demais', 'not computed: file too large'), {
    tag: 'SHA-256',
    dim: true,
  })

  const note = L(
    'Exame só de leitura: nada foi aberto, executado nem movido.',
    'Read-only check: nothing was opened, run or moved.',
  )
  return `<div class="hud-rows">${rows.join('')}</div><p class="hud-note">${esc(note)}</p>`
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** One report as text for the model: everything it may want to say or show, nothing to read aloud. */
function describe(r, pt, full) {
  const L = (a, b) => (pt ? a : b)
  const alerts = Array.isArray(r.alertas) ? r.alertas : []
  const sig = r.assinatura
  const editor = sig?.editor ? visible(sig.editor) : ''
  const signature = !sig
    ? L('não se aplica a este tipo', 'not applicable to this type')
    : sig.status === 'desconhecida'
      ? `${signatureLabel(sig.status, pt)}${r.pe?.certificado ? L(' (o arquivo traz um certificado)', ' (the file carries a certificate)') : ''}`
      : `${signatureLabel(sig.status, pt)}${editor ? ` — ${editor}` : ''}${sig.status === 'invalida' && sig.bruto ? ` (${sig.bruto})` : ''}`
  const via = hostOf(r.origem?.referencia)
  const source = r.origem
    ? `${r.origem.host ?? '—'}${zoneLabel(r.origem.zona, pt) ? ` (${zoneLabel(r.origem.zona, pt)})` : ''}` +
      (via && via !== r.origem.host ? `, ${L('a partir de', 'via')} ${via}` : '')
    : L('sem marca de origem', 'no mark of origin')

  const lines = [
    `${visible(r.nome)} — ${typeLabel(r.tipo, pt)}, ${size(r.tamanho, pt)}, ${L('examinado em', 'examined')} ${moment(r.quando, pt)}` +
      (r.enquantoDesligada ? L(', chegou com a AURORA desligada', ', arrived while AURORA was off') : ''),
    `   ${L('nível', 'level')}: ${levelLabel(r.nivel, pt)}`,
    `   ${L('alertas', 'alerts')}: ${alerts.length ? alerts.map((a) => alertText(a, pt)).join('; ') : L('nenhum', 'none')}`,
    `   ${L('assinatura', 'signature')}: ${signature}`,
    `   ${L('origem', 'source')}: ${source}`,
  ]
  if (full && r.pe) {
    const flags = [r.pe.instalador, r.pe.upx && 'UPX', r.pe.dotnet && '.NET', r.pe.entropiaAlta && L('entropia alta', 'high entropy')]
    lines.push(
      `   PE: ${[r.pe.arquitetura, r.pe.subsistema, r.pe.compilado && `${L('compilado em', 'compiled')} ${day(r.pe.compilado, pt)}`, ...flags]
        .filter(Boolean)
        .join(', ')}; ${L('seções', 'sections')}: ${r.pe.secoes.join(' ') || '—'}`,
    )
  }
  if (full && r.zip) {
    lines.push(
      `   ${L('conteúdo', 'contents')}: ${r.zip.entradas} ${L('entradas', 'entries')}` +
        (r.zip.senha ? L(', com senha', ', password-protected') : '') +
        (r.zip.android !== undefined ? `, AndroidManifest.xml ${r.zip.android ? L('presente', 'present') : L('ausente', 'missing')}` : '') +
        `; ${L('programas dentro', 'programs inside')}: ${r.zip.arriscadas.length ? r.zip.arriscadas.map(visible).join(', ') : L('nenhum', 'none')}`,
    )
  }
  if (full && r.virustotal) lines.push(`   VirusTotal: ${vtLine(r.virustotal, pt).text}`)
  lines.push(`   SHA-256: ${r.sha256 ?? L('não calculado (arquivo grande demais)', 'not computed (file too large)')}`)
  lines.push(`   ${L('caminho', 'path')}: ${visible(r.caminho)}`)
  return lines.join('\n')
}

/** Never examined, whatever the request: names that suggest keys or wallets, and the folders that hold them. */
const SECRET_NAME = /seed|chave|wallet|sign_?token|\.pem$|\.key$/i
const MAX_TOOL_BYTES = 4 * 1024 ** 3

const within = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Why a path will not be examined, or null when it will. */
async function refusal(given, pt) {
  const L = (a, b) => (pt ? a : b)
  const path = String(given ?? '').trim()
  if (!path || !isAbsolute(path)) return L('Preciso do caminho completo do arquivo.', 'An absolute path is required.')
  const real = await realpath(path).catch(() => null)
  if (!real) return L(`Esse arquivo não existe: ${path}`, `No such file: ${path}`)
  const roots = [join(homedir(), '.capsula'), join(homedir(), '.ssh'), process.env.CAPSULA_DIR].filter(Boolean)
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)))
  for (const p of [resolve(path), real]) {
    if (SECRET_NAME.test(basename(p))) {
      return L(
        'Esse arquivo não é examinado: pelo nome, pode guardar uma chave ou uma carteira.',
        'That file is not examined: by its name, it may hold a key or a wallet.',
      )
    }
    if ([...roots, ...realRoots].some((root) => root && within(root, p))) {
      return L('Arquivos dessa pasta não são examinados: ela guarda chaves.', 'Files in that folder are not examined: it holds keys.')
    }
  }
  const info = await stat(real)
  if (info.isDirectory()) return L('Isso é uma pasta, não um arquivo.', 'That is a folder, not a file.')
  if (!info.isFile()) return L('Isso não é um arquivo comum.', 'That is not a regular file.')
  if (info.size > MAX_TOOL_BYTES) return L('O arquivo passa de 4 GB; não examino algo desse tamanho.', 'The file is over 4 GB, too large to examine.')
  return null
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const refuse = (s) => ({ isError: true, content: [{ type: 'text', text: s }] })

/**
 * The guard's two questions for the model: what has arrived, and what is this
 * file. Both read; neither can open, run, move or delete anything.
 *
 * @param {ReturnType<typeof createGuard>} guard
 */
export function downloadsServer(guard, { lang = 'pt-BR' } = {}) {
  const pt = isPt(lang)
  const L = (a, b) => (pt ? a : b)
  return createSdkMcpServer({
    name: 'aurora_downloads',
    version: '1.0.0',
    instructions:
      "The downloads guard: it watches the user's Downloads folder and examines programs, " +
      'installers, scripts, archives and disk images as they arrive, read-only. New files are ' +
      'announced without being asked; these tools answer the questions that follow.',
    alwaysLoad: true,
    tools: [
      tool(
        'downloads_recentes',
        "What the downloads guard found most recently in the user's Downloads folder, newest " +
          'first. The guard examines every program, installer, script, library, archive, disk ' +
          'image and Android package as it finishes arriving: what it is, who signed it, which ' +
          'site it came from, what an archive holds and, when configured, what VirusTotal knows ' +
          'of its hash. Each file comes with a level (sem alertas / atenção / alto risco) and its ' +
          'alerts. Use it when the user asks about something that just arrived, about an alert you ' +
          'gave, or what they downloaded recently. The guard announces new files by itself, so do ' +
          'not call this to check for them. Answer in one sentence and put the detail on a blade; ' +
          'never read paths or hashes aloud. This is triage, not analysis: for what a program ' +
          'actually does, use the REA tools on the path given here.',
        {
          quantos: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .catch(undefined)
            .describe('How many of the latest files. Default 5.'),
        },
        async ({ quantos }) => {
          try {
            const list = guard.recent(quantos ?? 5)
            if (!list.length) return text(L('Nenhum download examinado ainda.', 'No downloads examined yet.'))
            return text(
              `${L('Pasta vigiada', 'Watched folder')}: ${guard.dir}\n\n` +
                list.map((r, i) => `${i + 1}. ${describe(r, pt, false)}`).join('\n\n'),
            )
          } catch (err) {
            return refuse(`${L('Não consegui ler os downloads', 'Could not read the downloads')}: ${err?.message ?? err}`)
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'examinar_arquivo',
        'Examine one file on this computer now, the way the downloads guard examines new ' +
          'downloads: type, size, SHA-256, the Mark of the Web (which site it was downloaded ' +
          'from), its Authenticode signature and publisher, the program header (architecture, ' +
          'compile date, .NET, UPX packing, high entropy, known installer builders), what an ' +
          'archive contains, and VirusTotal\'s verdict on the hash when a key is configured. ' +
          'Read-only: nothing is opened, run, moved or deleted, and only the hash ever leaves the ' +
          'machine. Use it when the user asks whether a particular file is safe, signed or where ' +
          'it came from, or wants a download checked again. Give the verdict in a sentence and put ' +
          'the detail on a blade. It cannot tell what a program does; for that, use the REA tools. ' +
          'Absolute paths only. Folders, files over 4 GB, and anything that may hold keys or a ' +
          'wallet are refused.',
        {
          caminho: z.string().min(1).max(4096).describe('Absolute path of the file to examine.'),
        },
        async ({ caminho }) => {
          try {
            const why = await refusal(caminho, pt)
            if (why) return refuse(why)
            const report = await guard.examine(await realpath(String(caminho).trim()))
            return text(describe(report, pt, true))
          } catch (err) {
            return refuse(`${L('Não consegui examinar o arquivo', 'Could not examine the file')}: ${err?.message ?? err}`)
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
}
