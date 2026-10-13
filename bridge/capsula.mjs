import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/**
 * The Cápsula node, read-only.
 *
 * Cápsula keeps its state in ~/.capsula as plain JSON: a hash-chained ledger
 * of blocks, the node's configuration, its peers and an index of sealed cases.
 * This server lets AURORA answer questions about it — is the node configured,
 * how long is the chain, what happened in the last blocks, does the chain
 * still verify — without being able to change any of it.
 *
 * The same directory holds the wallet seed and the signing keys. Those are
 * never read: not by a deny-list check at the moment of reading, which one
 * missed name would defeat, but by an allow-list of the exact files this
 * server has any reason to open. Everything else in the directory might as
 * well not exist. A deny pattern sits on top anyway, and every path is
 * resolved through symlinks and checked to still be inside the directory.
 *
 * Verifying the chain is a real check, not a link count. Each block's hash is
 * SHA-256 over the block without its `hash` field, serialised the way
 * Python's json.dumps(sort_keys=True, separators=(',', ':')) does; the Merkle
 * root is a binary tree over SHA-256 of each event, pairing hex strings. Both
 * were confirmed against the genesis block of a real node. Reproducing them in
 * JavaScript needs one care: Python writes 500000.0 where JavaScript writes
 * 500000, so numbers are carried through as the exact text in the file rather
 * than parsed into doubles and printed back.
 */

/** The files this server may open, relative to the Cápsula directory. */
const ALLOWED = [
  /^node\/node_config\.json$/,
  /^node\/peers\.json$/,
  /^node\/peers_estado\.json$/,
  /^ledger\/chain\.meta$/,
  /^ledger\/blocks\/block_\d+\.block$/,
  /^index\/cases_index\.json$/,
  /^index\/file_hash_index\.json$/,
  /^pricing_state\.json$/,
]

/** Belt and braces: never, whatever the allow-list says. */
const NEVER = /seed|chave|sign_?token|wallet|priv|secret|senha|password|\.key$|\.pem$/i

/** Directories whose entries may be counted or listed by name. */
const LISTABLE = new Set(['ledger/blocks', 'ledger/pending'])

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_BLOCKS = 20_000

/** The node's folder: CAPSULA_DIR, or ~/.capsula. */
export function capsulaDir(env = process.env) {
  return env.CAPSULA_DIR || join(homedir(), '.capsula')
}

// ---------------------------------------------------------------------------
// JSON that remembers how its numbers were written
// ---------------------------------------------------------------------------

/** A number exactly as it appears in the file: "500000.0", "5.1e-07". */
class Raw {
  constructor(text) {
    this.text = text
  }
  valueOf() {
    return Number(this.text)
  }
}

/**
 * A small JSON parser that keeps each number's source text. Python's own
 * NaN and Infinity are accepted, since a Python writer can produce them.
 */
export function parseRaw(source) {
  const s = source.replace(/^﻿/, '')
  let i = 0
  const ws = () => {
    while (i < s.length && ' \t\r\n'.includes(s[i])) i++
  }
  const fail = (what) => {
    throw new Error(`JSON inválido perto da posição ${i}: ${what}`)
  }
  const value = () => {
    ws()
    const c = s[i]
    if (c === '{') {
      i++
      const obj = {}
      ws()
      if (s[i] === '}') return i++, obj
      for (;;) {
        ws()
        if (s[i] !== '"') fail('esperava uma chave')
        const key = string()
        ws()
        if (s[i++] !== ':') fail('esperava ":"')
        obj[key] = value()
        ws()
        if (s[i] === ',') {
          i++
          continue
        }
        if (s[i] === '}') return i++, obj
        fail('esperava "," ou "}"')
      }
    }
    if (c === '[') {
      i++
      const arr = []
      ws()
      if (s[i] === ']') return i++, arr
      for (;;) {
        arr.push(value())
        ws()
        if (s[i] === ',') {
          i++
          continue
        }
        if (s[i] === ']') return i++, arr
        fail('esperava "," ou "]"')
      }
    }
    if (c === '"') return string()
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(word, i)) return (i += word.length), v
    }
    const m = /^(?:-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity)|NaN)/.exec(s.slice(i, i + 64))
    if (!m) fail('valor inesperado')
    i += m[0].length
    return new Raw(m[0])
  }
  const string = () => {
    i++ // opening quote
    let out = ''
    for (;;) {
      const c = s[i++]
      if (c === undefined) fail('texto sem fim')
      if (c === '"') return out
      if (c !== '\\') {
        out += c
        continue
      }
      const e = s[i++]
      if (e === 'u') {
        out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16))
        i += 4
      } else {
        out += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] ?? fail('escape inválido')
      }
    }
  }
  const out = value()
  ws()
  if (i !== s.length) fail('sobra depois do fim')
  return out
}

/** Plain JavaScript values, for reading rather than hashing. */
export function plain(v) {
  if (v instanceof Raw) return Number(v.text)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}

/** A string the way Python's json module writes it. */
function pyString(str, ensureAscii) {
  let out = '"'
  for (const ch of str) {
    const code = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) {
      // Astral characters become a surrogate pair, as Python does.
      for (let k = 0; k < ch.length; k++) out += `\\u${ch.charCodeAt(k).toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return `${out}"`
}

/** json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=…). */
export function pyDumps(v, ensureAscii = true) {
  if (v instanceof Raw) return v.text
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'string') return pyString(v, ensureAscii)
  if (Array.isArray(v)) return `[${v.map((x) => pyDumps(x, ensureAscii)).join(',')}]`
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((k) => `${pyString(k, ensureAscii)}:${pyDumps(v[k], ensureAscii)}`).join(',')}}`
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Does the stored hash match the block? Tries both of Python's ASCII modes. */
export function blockHashOk(block) {
  const { hash, ...rest } = block
  if (typeof hash !== 'string') return false
  return sha256(pyDumps(rest, true)) === hash || sha256(pyDumps(rest, false)) === hash
}

/**
 * Does the stored Merkle root match the events? The odd-leaf rule is not
 * visible in a block with an even number of events, so both common ones —
 * duplicate the last, or carry it up unpaired — are accepted.
 */
export function merkleOk(block) {
  const events = Array.isArray(block.events) ? block.events : []
  if (typeof block.merkle_root !== 'string') return false
  if (!events.length) return true
  const roots = new Set()
  for (const ascii of [true, false]) {
    for (const oddRule of ['duplicate', 'carry']) {
      let level = events.map((e) => sha256(pyDumps(e, ascii)))
      while (level.length > 1) {
        const next = []
        for (let k = 0; k < level.length; k += 2) {
          if (k + 1 < level.length) next.push(sha256(level[k] + level[k + 1]))
          else next.push(oddRule === 'duplicate' ? sha256(level[k] + level[k]) : level[k])
        }
        level = next
      }
      roots.add(level[0])
    }
  }
  return roots.has(block.merkle_root)
}

// ---------------------------------------------------------------------------
// Reading the folder
// ---------------------------------------------------------------------------

/**
 * Open one allowed file, or refuse. Resolved through symlinks and checked
 * against the real folder, so a link planted inside cannot point outside it.
 */
async function readAllowed(root, rel) {
  if (!ALLOWED.some((re) => re.test(rel)) || NEVER.test(rel)) {
    throw new Error(`não é um arquivo que esta ferramenta lê: ${rel}`)
  }
  const realRoot = await realpath(root)
  const real = await realpath(join(root, rel))
  const inside = relative(realRoot, real)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || NEVER.test(inside)) {
    throw new Error(`fora da pasta do Cápsula: ${rel}`)
  }
  const info = await stat(real)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`grande demais ou não é arquivo: ${rel}`)
  return readFile(real, 'utf8')
}

async function readJson(root, rel) {
  try {
    return parseRaw(await readAllowed(root, rel))
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

async function listNames(root, rel) {
  if (!LISTABLE.has(rel)) throw new Error(`pasta não listável: ${rel}`)
  try {
    return await readdir(join(root, rel))
  } catch {
    return []
  }
}

async function blockFiles(root) {
  return (await listNames(root, 'ledger/blocks'))
    .filter((n) => /^block_\d+\.block$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
}

const when = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : '—'

const short = (s, n = 12) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : (s ?? '—'))

/** One event, as a line someone can read aloud. */
function describeEvent(e) {
  const m = e.meta && typeof e.meta === 'object' ? e.meta : {}
  const parts = [String(e.type ?? 'EVENTO')]
  if (m.amount !== undefined) parts.push(`${m.amount}${m.token ? ` ${m.token}` : ''}`)
  if (m.from && m.to) parts.push(`${short(m.from, 16)} → ${short(m.to, 16)}`)
  else if (m.to) parts.push(`para ${short(m.to, 16)}`)
  else if (m.from) parts.push(`de ${short(m.from, 16)}`)
  else if (e.address) parts.push(short(e.address, 16))
  if (e.filename) parts.push(`arquivo "${e.filename}"`)
  if (e.size_original) parts.push(`${e.size_original} bytes`)
  if (e.bid) parts.push(`bid ${e.bid}`)
  if (m.reason) parts.push(`(${m.reason})`)
  return parts.join(' ')
}

/** Walk the whole chain: links, hashes, Merkle roots and the head record. */
export async function verifyChain(root) {
  const files = await blockFiles(root)
  const meta = plain((await readJson(root, 'ledger/chain.meta')) ?? {})
  const problems = []
  let prev = null
  let checked = 0
  for (const name of files.slice(0, MAX_BLOCKS)) {
    const raw = await readJson(root, `ledger/blocks/${name}`)
    const b = plain(raw)
    checked++
    const expectedIndex = prev ? prev.index + 1 : b.index
    if (b.index !== expectedIndex) problems.push(`bloco ${b.index}: esperava o índice ${expectedIndex}`)
    if (prev && b.prev_hash !== prev.hash) problems.push(`bloco ${b.index}: prev_hash não aponta para o bloco ${prev.index}`)
    if (!prev && b.index === 1 && !/^0+$/.test(String(b.prev_hash))) problems.push('bloco 1: prev_hash da gênese não é zero')
    if (!blockHashOk(raw)) problems.push(`bloco ${b.index}: o hash não confere com o conteúdo`)
    if (!merkleOk(raw)) problems.push(`bloco ${b.index}: a raiz de Merkle não confere com os eventos`)
    prev = b
    if (problems.length > 20) break
  }
  if (prev && meta.last_index !== undefined && meta.last_index !== prev.index) {
    problems.push(`chain.meta diz que o último bloco é ${meta.last_index}, mas o último no disco é ${prev.index}`)
  }
  if (prev && meta.last_hash && meta.last_hash !== prev.hash) {
    problems.push('chain.meta guarda um hash final diferente do último bloco')
  }
  return { checked, total: files.length, last: prev, problems }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const refuse = (s) => ({ isError: true, content: [{ type: 'text', text: s }] })

export function capsulaServer(root = capsulaDir()) {
  const guarded = (fn) => async (args) => {
    try {
      if (!(await stat(root).then((s) => s.isDirectory(), () => false))) {
        return refuse(`Não encontrei a pasta do Cápsula em ${root}. Defina CAPSULA_DIR se ela estiver em outro lugar.`)
      }
      return text(await fn(args ?? {}))
    } catch (err) {
      return refuse(`Não consegui ler o Cápsula: ${err?.message ?? err}`)
    }
  }

  return createSdkMcpServer({
    name: 'aurora_capsula',
    version: '1.0.0',
    instructions:
      "The user's own Cápsula node, read-only: its configuration, ledger, " +
      'peers and sealed cases. Nothing here can send, sign or change anything.',
    alwaysLoad: true,
    tools: [
      tool(
        'estado',
        'Status of the Cápsula node on this machine: its address and storage, ' +
          'the length and head of its ledger, pending entries, peers, sealed ' +
          'cases and the current storage price. Use it for any question about ' +
          'whether the node is set up, how big the chain is, or what state it is in.',
        {},
        guarded(async () => {
          const cfg = plain((await readJson(root, 'node/node_config.json')) ?? {})
          const meta = plain((await readJson(root, 'ledger/chain.meta')) ?? {})
          const peers = plain((await readJson(root, 'node/peers.json')) ?? [])
          const price = plain((await readJson(root, 'pricing_state.json')) ?? {})
          const cases = plain((await readJson(root, 'index/cases_index.json')) ?? {})
          const filesIndex = plain((await readJson(root, 'index/file_hash_index.json')) ?? {})
          const blocks = await blockFiles(root)
          const pending = await listNames(root, 'ledger/pending')
          const peerCount = Array.isArray(peers)
            ? peers.length
            : Array.isArray(peers?.peers)
              ? peers.peers.length
              : Object.keys(peers ?? {}).length
          const caseList = Object.values(cases.cases ?? {})
          const sealed = caseList.filter((c) => c?.contract_status === 'sealed').length
          return [
            `Pasta: ${root}`,
            `Nó: endereço ${cfg.address ?? '—'}, impressão ${cfg.fingerprint ?? '—'}, porta ${cfg.port ?? '—'}, ` +
              `armazenamento ${cfg.storage_gb ?? '—'} GB, bootstrap ${cfg.bootstrap ?? '—'}`,
            `Cadeia: último bloco ${meta.last_index ?? '—'} (hash ${short(meta.last_hash)}), ` +
              `atualizada em ${when(meta.updated_at)}; ${blocks.length} blocos no disco, ${pending.length} pendentes`,
            `Pares conhecidos: ${peerCount}`,
            `Casos: ${caseList.length} (${sealed} ${sealed === 1 ? 'selado' : 'selados'})`,
            `Arquivos indexados: ${Object.keys(filesIndex.files ?? filesIndex ?? {}).length}`,
            price.price_per_kb !== undefined
              ? `Preço por KB: ${price.price_per_kb}; taxa de recompensa: ${price.reward_rate ?? '—'}`
              : 'Preço: —',
          ].join('\n')
        }),
      ),
      tool(
        'blocos',
        'The latest blocks of the Cápsula ledger, or one block by number: when ' +
          'it was made and what each event in it did — mints, transfers, ' +
          'airdrops, stored files.',
        {
          ultimos: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .catch(undefined)
            .describe('How many of the latest blocks. Default 3.'),
          indice: z
            .number()
            .int()
            .min(1)
            .optional()
            .catch(undefined)
            .describe('One block by its index instead.'),
        },
        guarded(async ({ ultimos, indice }) => {
          const files = await blockFiles(root)
          if (!files.length) return 'O ledger não tem blocos.'
          const chosen =
            indice !== undefined
              ? files.filter((n) => Number(n.match(/\d+/)[0]) === indice)
              : files.slice(-(ultimos ?? 3))
          if (!chosen.length) return `Não existe o bloco ${indice}. O último é o ${Number(files.at(-1).match(/\d+/)[0])}.`
          const out = []
          for (const name of chosen) {
            const b = plain(await readJson(root, `ledger/blocks/${name}`))
            const events = Array.isArray(b.events) ? b.events : []
            out.push(
              `Bloco ${b.index} — ${when(b.timestamp)}, ${events.length} ${events.length === 1 ? 'evento' : 'eventos'}, hash ${short(b.hash)}\n` +
                events.slice(0, 25).map((e) => `  · ${describeEvent(e)}`).join('\n') +
                (events.length > 25 ? `\n  · … mais ${events.length - 25}` : ''),
            )
          }
          return out.join('\n\n')
        }),
      ),
      tool(
        'casos',
        'The cases (sealed contracts) in the Cápsula index: title, status, ' +
          'participants, when sealed and how stored.',
        {},
        guarded(async () => {
          const idx = plain((await readJson(root, 'index/cases_index.json')) ?? {})
          const entries = Object.entries(idx.cases ?? {})
          if (!entries.length) return 'Nenhum caso no índice.'
          return entries
            .slice(0, 50)
            .map(
              ([id, c]) =>
                `${id}: "${c?.case_title ?? '—'}", ${c?.contract_status ?? '—'}` +
                `${c?.sealed_at ? ` em ${when(c.sealed_at)}` : ''}, ` +
                `${Object.keys(c?.participants ?? {}).length} participante(s), ` +
                `modo ${c?.storage_mode ?? '—'}, ${c?.views ?? 0} visualizações`,
            )
            .join('\n')
        }),
      ),
      tool(
        'verificar',
        'Verify the whole Cápsula ledger: every block linked to the one before, ' +
          'every hash recomputed from its contents, every Merkle root recomputed ' +
          'from its events, and the head record agreeing with the last block. ' +
          'Use it when asked whether the chain is intact, valid or tampered with.',
        {},
        guarded(async () => {
          const r = await verifyChain(root)
          if (!r.total) return 'O ledger não tem blocos para verificar.'
          const head = `${r.checked} de ${r.total} blocos verificados, até o bloco ${r.last?.index ?? '—'}.`
          return r.problems.length
            ? `${head}\nProblemas:\n${r.problems.map((p) => `- ${p}`).join('\n')}`
            : `${head}\nTudo confere: ligações, hashes, raízes de Merkle e o registro do topo.`
        }),
      ),
    ],
  })
}
