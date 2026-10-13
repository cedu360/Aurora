/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'

const PT = (process.env.JARVIS_LANG ?? 'pt-BR').startsWith('pt')
const say = (pt, en) => (PT ? pt : en)

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log(say('  runtime do rastreamento de mãos copiado para public/mediapipe.', '  vendored the hand-tracking runtime into public/mediapipe.'))
  } catch (err) {
    console.warn(say(`  não consegui copiar o runtime do rastreamento de mãos: ${err.message}`, `  could not vendor the hand-tracking runtime: ${err.message}`))
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable. Plain when
// the output is a file — the launcher's log — where colour codes are noise.
const COLOUR = Boolean(process.stdout.isTTY)
const tagged = (tag, colour) => (COLOUR ? `\x1b[${colour}m${tag}\x1b[0m` : tag)
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `${tagged(tag, colour)} ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`${tagged(name, colour)} ${say(`saiu (${code}); parando o resto.`, `exited (${code}); stopping the rest.`)}`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(say(`  interface na porta ${port}; a ponte vai aceitá-la.\n`, `  serving the face on port ${port}; the bridge will accept it.\n`))
}

vendorWasm()

console.log(say('\nJ.A.R.V.I.S. iniciando — o cérebro e a interface.\n', '\nJ.A.R.V.I.S. starting — the brain and the face.\n'))
// process.execPath rather than 'node': the same Node that is running this
// script, wherever it lives, with no PATH lookup to go wrong on Windows.
run('bridge', process.execPath, ['bridge/server.mjs', ...(writes ? ['--writes'] : [])], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  say(
    '\nQuando aparecer que o servidor está pronto, abra no Chrome o endereço que ele mostrar,\n' +
      'clique em INICIALIZAR e diga "Ei Jarvis". Ctrl-C para tudo.\n',
    '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
      'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
  ),
)
