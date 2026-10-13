#!/usr/bin/env node
/**
 * AURORA with nobody at the keyboard: the brain and the face if they are not
 * already up, then his own window, which powers itself on.
 *
 * This is what the Windows start-up shortcut runs (`npm run inicio-automatico`
 * creates it), hidden, at every login. It works by hand as well:
 * `npm run janela`.
 *
 * Whoever starts the servers looks after them. They are restarted if they fall
 * over, and switched off once no AURORA window has been open for a while — so
 * closing the window is how you turn him off, and the desktop shortcut is how
 * you turn him back on. If the servers were already running (an `npm start`
 * in a PowerShell window), this only opens a window and leaves: what someone
 * else started is theirs to stop.
 *
 * Everything the servers print goes to logs/aurora.log, since at login there is
 * no console to print it to.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnv } from '../bridge/env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)
loadLocalEnv()

const PT = (process.env.AURORA_LANG ?? 'pt-BR').startsWith('pt')
const say = (pt, en) => (PT ? pt : en)
const WINDOWS = platform() === 'win32'

const FACE_PORT = Number(process.env.PORT) || 5173
const BRIDGE_PORT = Number(process.env.AURORA_BRIDGE_PORT ?? 8787)
const WRITES = process.argv.includes('--writes')

/** How long the servers get to come up. Right after login, with the disk busy, a cold start is slow. */
const READY_MS = 180_000
/** How often the supervisor looks. */
const POLL_MS = 3_000
/** No window for this long, and everything is switched off. Long enough to survive a reload. */
const EMPTY_MS = 45_000
/** Grace before the first window shows up, when there is no browser process of ours to watch. */
const FIRST_PAGE_MS = 300_000
/** A browser that exits this quickly handed the window to one already open on the same profile. */
const HANDOFF_MS = 10_000
/** Restarts allowed inside RESTART_WINDOW_MS before giving up on a crashing server. */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 600_000

const LOG_DIR = join(ROOT, 'logs')
const LOG = join(LOG_DIR, 'aurora.log')
/** Held by the launcher that owns the servers. */
const LOCK = join(LOG_DIR, 'janela.lock')
/** Touched by any other launcher that has just opened a window, so the owner waits for it. */
const KNOCK = join(LOG_DIR, 'janela.pedido')

// -- the log ----------------------------------------------------------------

mkdirSync(LOG_DIR, { recursive: true })
try {
  if (statSync(LOG).size > 5 * 1024 * 1024) renameSync(LOG, `${LOG}.1`)
} catch {
  /* no log yet, or another launcher has it open: either way, append */
}
const logFd = openSync(LOG, 'a')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function log(msg) {
  const line = `[${stamp()}] [janela] ${msg}\n`
  writeSync(logFd, line)
  if (process.stdout.isTTY) process.stdout.write(line)
}

// -- probes -------------------------------------------------------------------

/** A GET to localhost, resolving null rather than throwing when nothing answers. */
function get(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path, timeout: 2500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        if (body.length < 65536) body += c
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

/** The bridge's /health, or null. */
async function bridgeHealth() {
  const r = await get(BRIDGE_PORT, '/health')
  if (r?.status !== 200) return null
  try {
    return JSON.parse(r.body)
  } catch {
    return { ok: true }
  }
}

/** Whether AURORA's face — and not some other app that took the port — answers there. */
async function faceUp(port) {
  const r = await get(port, '/')
  return r?.status === 200 && r.body.includes('<title>A.U.R.O.R.A.</title>')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(test, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await test()
    if (v) return v
    await sleep(1000)
  }
  return null
}

// -- the window -----------------------------------------------------------------

/** Every directory on the PATH, searched for an executable the way a shell would. */
function which(name) {
  const exts = WINDOWS ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of ['', ...exts]) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * Chrome, or Edge where there is no Chrome. Both are Chromium, so the flags
 * below mean the same to either — and both ship a speech recogniser, which
 * Firefox does not. AURORA_NAVEGADOR names another.
 */
function findBrowser() {
  const own = process.env.AURORA_NAVEGADOR
  if (own) return existsSync(own) ? own : which(own)
  if (WINDOWS) {
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const tail of [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ]) {
      for (const base of bases) {
        const p = join(base, ...tail)
        if (existsSync(p)) return p
      }
    }
    return null
  }
  if (platform() === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium']) {
      const p = `/Applications/${app}.app/Contents/MacOS/${app}`
      if (existsSync(p)) return p
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const p = which(name)
    if (p) return p
  }
  return null
}

/**
 * A profile of his own. Two reasons. Flags only reach the first Chrome process
 * on a profile, so with the user's everyday Chrome already open, the
 * autoplay flag would be silently dropped. And the microphone permission he
 * needs then lives here, granted once, instead of in the user's browsing.
 */
function profileDir() {
  return WINDOWS
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Aurora', 'Navegador')
    : join(homedir(), '.aurora', 'navegador')
}

const browser = { alive: false, everAlive: false }

function openWindow(port) {
  const url = `http://localhost:${port}/?ligar=1`
  const exe = findBrowser()
  if (!exe) {
    // Without the flag he cannot switch himself on, so the page will show the
    // ignition button. Still better than no window at all.
    log(say('Chrome e Edge não encontrados; abrindo no navegador padrão (lá ele pede um clique)', 'no Chrome or Edge found; opening the default browser (it will ask for a click)'))
    const opener = WINDOWS ? ['explorer.exe', [url]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return
  }
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  const args = [
    `--app=${url}`,
    `--user-data-dir=${dir}`,
    // What lets the page speak, play the boot score and start listening with
    // nobody clicking anything. Only this profile gets it.
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--start-maximized',
  ]
  log(say(`abrindo a janela: ${exe}`, `opening the window: ${exe}`))
  const started = Date.now()
  // Detached: on Windows a child that is not is killed along with this process.
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  browser.alive = true
  browser.everAlive = true
  child.on('error', (err) => {
    browser.alive = false
    log(say(`não consegui abrir o navegador: ${err.message}`, `could not start the browser: ${err.message}`))
  })
  child.on('exit', () => {
    browser.alive = false
    if (Date.now() - started < HANDOFF_MS) {
      log(say('o navegador passou a janela para outra já aberta', 'the browser handed the window to one already open'))
    } else {
      log(say('a janela foi fechada', 'the window was closed'))
    }
  })
  child.unref()
}

// -- ownership ------------------------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** True when this launcher now owns the servers; false when a live one already does. */
function takeLock() {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(LOCK, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if (err.code !== 'EEXIST') return true // cannot lock at all: carry on unguarded
      let pid = 0
      try {
        pid = Number(readFileSync(LOCK, 'utf8').trim())
      } catch {
        /* vanished between the two calls: try again */
      }
      if (pid && pid !== process.pid && alive(pid)) return false
      rmSync(LOCK, { force: true }) // left behind by a launcher that died
    }
  }
  return false
}

function releaseLock() {
  try {
    if (Number(readFileSync(LOCK, 'utf8').trim()) === process.pid) rmSync(LOCK, { force: true })
  } catch {
    /* already gone */
  }
}

function knock() {
  try {
    const now = new Date()
    if (existsSync(KNOCK)) utimesSync(KNOCK, now, now)
    else closeSync(openSync(KNOCK, 'w'))
  } catch {
    /* only a courtesy */
  }
}

function knockedRecently() {
  try {
    return Date.now() - statSync(KNOCK).mtimeMs < 60_000
  } catch {
    return false
  }
}

// -- the servers ------------------------------------------------------------------

let servers = null
let facePort = FACE_PORT
let finishing = false

function startServers() {
  if (finishing) return { child: null, exited: true, code: null }
  log(say('ligando a ponte e a interface', 'starting the bridge and the face'))
  const child = spawn(process.execPath, [join('scripts', 'start.mjs'), ...(WRITES ? ['--writes'] : [])], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No console window for this or anything it starts.
    windowsHide: true,
    // Its own process group elsewhere, so stopping it reaches the whole tree.
    detached: !WINDOWS,
  })
  const state = { child, exited: false, code: null }
  let tail = ''
  const take = (chunk) => {
    writeSync(logFd, chunk)
    // Vite moves to the next port when 5173 is taken, and says where it went.
    tail = (tail + chunk.toString()).slice(-600)
    // eslint-disable-next-line no-control-regex
    const m = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(tail.replace(/\x1b\[[0-9;]*m/g, ''))
    if (m) facePort = Number(m[1])
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  child.on('error', (err) => {
    state.exited = true
    log(say(`não consegui ligar os servidores: ${err.message}`, `could not start the servers: ${err.message}`))
  })
  child.on('exit', (code) => {
    state.exited = true
    state.code = code
    log(say(`os servidores pararam (código ${code})`, `the servers stopped (code ${code})`))
  })
  return state
}

async function stopServers() {
  if (!servers?.child || servers.exited) return
  const pid = servers.child.pid
  if (WINDOWS) {
    // The whole tree: start.mjs, the bridge, Vite, Claude Code and its MCP
    // servers. Signals do not exist there; this is what Ctrl-C would reach.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    if (!(await waitFor(() => servers.exited, 5000))) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

/** Opens the log where the user can read it, since at login there is no console. */
function showLog() {
  if (!WINDOWS || process.stdout.isTTY) {
    console.error(say(`Veja o que aconteceu em ${LOG}`, `See what happened in ${LOG}`))
    return
  }
  spawn('notepad.exe', [LOG], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

async function finish(code) {
  if (finishing) return
  finishing = true
  await stopServers()
  releaseLock()
  log(say('fim', 'done'))
  closeSync(logFd)
  process.exit(code)
}

process.on('SIGINT', () => void finish(0))
process.on('SIGTERM', () => void finish(0))

/** Both halves answering, on whichever port the face ended up on. */
async function up() {
  return Boolean((await bridgeHealth()) && (await faceUp(facePort)))
}

// -- main -------------------------------------------------------------------------

log(say('início', 'start'))

if (await up()) {
  log(say('a AURORA já estava no ar; só abrindo a janela', 'AURORA was already running; only opening a window'))
  knock()
  openWindow(facePort)
  closeSync(logFd)
  process.exit(0)
}

if (!takeLock()) {
  // A second click on the shortcut while the first is still bringing it up.
  // That one opens the window when it is ready; a second would be a duplicate.
  log(say('outro lançador já está ligando a AURORA; a janela dela vai abrir', 'another launcher is starting AURORA; its window will open'))
  knock()
  closeSync(logFd)
  process.exit(0)
}

servers = startServers()
const ready = await waitFor(async () => (servers.exited ? 'dead' : (await up()) ? 'up' : null), READY_MS)
if (ready !== 'up') {
  log(
    ready === 'dead'
      ? say('os servidores pararam antes de ficarem prontos', 'the servers stopped before they were ready')
      : say(`os servidores não ficaram prontos em ${READY_MS / 1000} s`, `the servers were not ready within ${READY_MS / 1000} s`),
  )
  showLog()
  await finish(1)
}

log(say(`pronto em http://localhost:${facePort}`, `ready at http://localhost:${facePort}`))
openWindow(facePort)

/**
 * Keep the servers alive while any AURORA window is open, and no longer.
 *
 * "Open" is any of: the browser process this launcher started is still
 * running, the bridge has a page connected (a window opened another way, or
 * one this browser handed off to), or another launcher has just opened one.
 * The bridge alone is not enough, because a page only connects once it has
 * powered on — a window still showing the ignition button counts for nothing
 * there.
 */
const restarts = []
let seen = false
let emptySince = null
let last = Date.now()
const began = Date.now()

// `finishing` ends the loop: a Ctrl-C lands in the middle of it, and the
// servers it is stopping must not look like a crash to restart.
while (!finishing) {
  await sleep(POLL_MS)
  if (finishing) break
  const now = Date.now()
  // A gap far longer than the poll means the computer slept. Pages need a
  // moment to reconnect after that, so the clock on an empty room restarts.
  const woke = now - last > POLL_MS * 5
  last = now

  if (servers.exited) {
    restarts.push(now)
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift()
    if (restarts.length > MAX_RESTARTS) {
      log(say('os servidores caíram vezes demais; desisto', 'the servers keep falling over; giving up'))
      showLog()
      await finish(1)
    }
    log(say('os servidores caíram; religando', 'the servers fell over; restarting them'))
    servers = startServers()
    await waitFor(async () => servers.exited || (await up()), READY_MS)
    continue
  }

  const pages = (await bridgeHealth())?.pages
  if (browser.alive || pages > 0 || knockedRecently()) {
    seen = true
    emptySince = null
    continue
  }
  if (typeof pages !== 'number' || woke) {
    // The bridge is busy or did not say, or we have just woken: never stop on a guess.
    emptySince = null
    continue
  }
  if (!seen && !browser.everAlive && now - began < FIRST_PAGE_MS) continue
  emptySince ??= now
  if (now - emptySince >= EMPTY_MS) {
    log(say('nenhuma janela da AURORA aberta; desligando', 'no AURORA window open; switching off'))
    await finish(0)
  }
}
