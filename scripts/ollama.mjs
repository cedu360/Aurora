#!/usr/bin/env node
/**
 * Sets up AURORA's free brain: Ollama, a model, and a copy of it made to fit.
 *
 *   npm run ollama                  install what is missing and prepare aurora-local
 *   npm run ollama -- qwen2.5:14b   the same, built on another model
 *
 * When the Claude plan's limit is reached, the bridge hands questions to a
 * model running on this computer (bridge/local.mjs). This script is the one
 * thing that has to happen first. It installs Ollama if it is not there (with
 * winget on Windows; elsewhere it says how), starts it, downloads the model,
 * and creates `aurora-local` from it — the same weights with a context long
 * enough for AURORA's prompt. Ollama's own default on a graphics card under
 * 24 GB is 4096 tokens, which her instructions alone would fill, and an
 * overflowing context is cut from the start, which is where the instructions
 * are. Then it asks the model one question through the same endpoint the
 * bridge uses and says how long the answer took.
 *
 * The default model is qwen2.5:7b on a computer with 16 GB of memory or more,
 * llama3.2:3b below that: both call tools reliably, both speak Portuguese, and
 * neither stops to think out loud before answering, which a voice cannot
 * afford. Nothing else on the computer is changed.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform, totalmem } from 'node:os'
import { join } from 'node:path'
import { loadLocalEnv } from '../bridge/env.mjs'

loadLocalEnv()

const PT = (process.env.AURORA_LANG ?? 'pt-BR').startsWith('pt')
const say = (pt, en) => (PT ? pt : en)
const OS = platform()
const URL_BASE = (process.env.AURORA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const NAME = 'aurora-local'
const CONTEXT = Number(process.env.AURORA_OLLAMA_CONTEXT) || 16384
const BIG = totalmem() >= 15.5 * 1024 ** 3
const BASE = process.argv[2] || process.env.AURORA_OLLAMA_BASE || (BIG ? 'qwen2.5:7b' : 'llama3.2:3b')
const TTY = Boolean(process.stdout.isTTY)

const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}

async function api(path, body, timeoutMs = 4000) {
  const res = await fetch(URL_BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res
}

const version = () =>
  api('/api/version', null, 2000)
    .then((r) => r.json())
    .then((j) => j.version)
    .catch(() => null)

function atLeast(v, min = [0, 14, 0]) {
  const parts = String(v).split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]
  return true
}

/** Where an installed Ollama lives, or null. */
function findOllama() {
  if (OS === 'win32') {
    const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama')
    for (const exe of ['ollama app.exe', 'ollama.exe']) if (existsSync(join(dir, exe))) return { dir, exe: join(dir, exe) }
  }
  if (OS === 'darwin' && existsSync('/Applications/Ollama.app')) return { app: '/Applications/Ollama.app' }
  const which = spawnSync(OS === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', windowsHide: true })
  const path = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : ''
  return path ? { exe: path } : null
}

/** Starts the server the way its installer would: the tray app if there is one. */
function startOllama(found) {
  const detach = { detached: true, stdio: 'ignore', windowsHide: true }
  if (found.app) return spawn('open', ['-a', found.app], detach).unref()
  if (OS === 'win32' && found.dir && existsSync(join(found.dir, 'ollama app.exe'))) {
    return spawn(join(found.dir, 'ollama app.exe'), [], detach).unref()
  }
  spawn(found.exe, ['serve'], detach).unref()
}

async function waitUp(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await version()
    if (v) return v
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** Reads Ollama's newline-delimited JSON progress and keeps one line of it on screen. */
async function follow(res, label) {
  let last = ''
  let shown = -10
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.error) throw new Error(msg.error)
      if (msg.total && msg.completed != null) {
        const pct = Math.floor((msg.completed / msg.total) * 100)
        const size = (msg.total / 1024 ** 3).toFixed(1)
        const text = `  ${label}: ${say(`${pct}% de ${size.replace('.', ',')} GB`, `${pct}% of ${size} GB`)}`
        if (TTY) process.stdout.write(`\r${text.padEnd(60)}`)
        else if (pct >= shown + 10) {
          console.log(text)
          shown = pct
        }
      } else if (msg.status && msg.status !== last) {
        if (TTY) process.stdout.write(`\r${`  ${label}: ${msg.status}`.padEnd(60)}`)
        last = msg.status
      }
    }
  }
  if (TTY) process.stdout.write('\n')
}

console.log(say('Preparando o modelo local da AURORA (Ollama).', "Preparing AURORA's local model (Ollama)."))

// 1. Ollama itself, running.
let running = await version()
if (!running) {
  let found = findOllama()
  if (!found) {
    if (OS !== 'win32') {
      fail(
        OS === 'darwin'
          ? say('Instale o Ollama de https://ollama.com/download (ou `brew install ollama`) e rode este comando de novo.', 'Install Ollama from https://ollama.com/download (or `brew install ollama`) and run this again.')
          : say('Instale o Ollama com `curl -fsSL https://ollama.com/install.sh | sh` e rode este comando de novo.', 'Install Ollama with `curl -fsSL https://ollama.com/install.sh | sh` and run this again.'),
      )
    }
    console.log(say('Instalando o Ollama pelo winget…', 'Installing Ollama with winget…'))
    const got = spawnSync(
      'winget',
      ['install', '--id', 'Ollama.Ollama', '-e', '--accept-source-agreements', '--accept-package-agreements'],
      { stdio: 'inherit', windowsHide: false },
    )
    if (got.error || got.status !== 0) {
      fail(
        say(
          'Não consegui instalar pelo winget. Baixe o instalador em https://ollama.com/download, instale e rode este comando de novo.',
          'winget could not install it. Get the installer from https://ollama.com/download, install it and run this again.',
        ),
      )
    }
    found = findOllama()
  }
  // The installer usually starts it by itself; if not, start it here.
  running = await waitUp(5)
  if (!running && found) {
    startOllama(found)
    running = await waitUp(60)
  }
  if (!running) fail(say(`O Ollama não respondeu em ${URL_BASE}. Abra o Ollama pelo menu Iniciar e rode este comando de novo.`, `Ollama did not answer at ${URL_BASE}. Open Ollama from the Start menu and run this again.`))
}
console.log(say(`  Ollama ${running} rodando em ${URL_BASE}`, `  Ollama ${running} running at ${URL_BASE}`))
if (!atLeast(running)) {
  fail(
    say(
      `Esta versão do Ollama é antiga demais: a AURORA precisa da 0.14 ou mais nova. ${OS === 'win32' ? 'Atualize com `winget upgrade --id Ollama.Ollama`' : 'Baixe a nova em https://ollama.com/download'} e rode este comando de novo.`,
      `This Ollama is too old: AURORA needs 0.14 or newer. ${OS === 'win32' ? 'Update with `winget upgrade --id Ollama.Ollama`' : 'Get the new one from https://ollama.com/download'} and run this again.`,
    ),
  )
}

// 2. The model.
console.log(say(`Baixando ${BASE} (só na primeira vez; alguns gigabytes)…`, `Downloading ${BASE} (first time only; a few gigabytes)…`))
try {
  await follow(await api('/api/pull', { model: BASE, stream: true }, 6 * 60 * 60_000), BASE)
} catch (err) {
  fail(say(`O download de ${BASE} falhou: ${err.message}`, `Downloading ${BASE} failed: ${err.message}`))
}
const show = await api('/api/show', { model: BASE })
  .then((r) => r.json())
  .catch(() => ({}))
if (!(show.capabilities ?? []).includes('tools')) {
  console.log(
    say(
      `  Atenção: ${BASE} não usa ferramentas, então no modelo local ela não pesquisa nem lembra. Prefira qwen2.5:7b ou llama3.2:3b.`,
      `  Note: ${BASE} cannot use tools, so on the local model she will neither search nor remember. Prefer qwen2.5:7b or llama3.2:3b.`,
    ),
  )
}

// 3. aurora-local: the same model with room for her prompt.
console.log(say(`Criando ${NAME} a partir de ${BASE}, com contexto de ${CONTEXT} tokens…`, `Creating ${NAME} from ${BASE}, with a ${CONTEXT}-token context…`))
try {
  await follow(await api('/api/create', { model: NAME, from: BASE, parameters: { num_ctx: CONTEXT }, stream: true }, 10 * 60_000), NAME)
} catch (err) {
  fail(say(`Não consegui criar ${NAME}: ${err.message}`, `Could not create ${NAME}: ${err.message}`))
}

// 4. One question, through the endpoint the bridge will use.
console.log(say('Testando uma pergunta (a primeira carrega o modelo na memória)…', 'Asking one question (the first one loads the model)…'))
const started = Date.now()
try {
  const res = await api(
    '/v1/messages',
    {
      model: NAME,
      max_tokens: 40,
      messages: [{ role: 'user', content: say('Responda apenas com a palavra: pronta.', 'Reply with one word only: ready.') }],
    },
    5 * 60_000,
  )
  const body = await res.json()
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(say(`  Respondeu "${text}" em ${secs.replace('.', ',')} s.`, `  Answered "${text}" in ${secs} s.`))
  if (Date.now() - started > 30_000) {
    console.log(
      say(
        '  Está lento neste computador. A segunda pergunta é mais rápida; se continuar lento, um modelo menor ajuda: npm run ollama -- llama3.2:3b',
        '  It is slow on this computer. The second question is quicker; if it stays slow, a smaller model helps: npm run ollama -- llama3.2:3b',
      ),
    )
  }
} catch (err) {
  fail(say(`O modelo não respondeu: ${err.message}`, `The model did not answer: ${err.message}`))
}

console.log('')
console.log(
  say(
    [
      `Pronto. Quando o limite do plano do Claude acabar, a AURORA continua com o ${NAME} (${BASE}), de graça, neste computador.`,
      'Ela avisa uma vez quando troca e volta para o Claude sozinha quando o limite renova.',
      'Para usar só o modelo local, sem gastar nada do plano: ponha AURORA_BRAIN=local no .env.local.',
    ].join('\n'),
    [
      `Done. When the Claude plan's limit runs out, AURORA carries on with ${NAME} (${BASE}), free, on this computer.`,
      'She says so once when she switches, and goes back to Claude by herself when the limit resets.',
      'To use the local model only, spending nothing from the plan: set AURORA_BRAIN=local in .env.local.',
    ].join('\n'),
  ),
)
