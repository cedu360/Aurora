import { createSdkMcpServer, tool, USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { fetchText } from './net.mjs'

/**
 * The free brain: a model running on this computer through Ollama, for when
 * the paid one runs out.
 *
 * A Claude plan has limits — a five-hour window and a weekly one — and when one
 * runs out the assistant goes mute, or starts drawing on paid extra usage. So
 * AURORA keeps a second brain on the bench. When the plan's limit is reached,
 * the question that hit it is answered by a local model instead, and so is
 * every question after it until the limit resets; then the next one goes back
 * to Claude. Nothing to configure and nothing said twice: she mentions the
 * switch once, in a sentence, and carries on.
 *
 * The local model is driven through the same Claude Agent SDK as the main one.
 * Ollama has spoken Anthropic's Messages API since 0.14.0, so pointing the
 * agent at it is a matter of environment variables — and that is what keeps
 * memory, the screen and web search working on the free brain, rather than
 * leaving it a chatbot with amnesia. It does get a smaller kit than Claude: a
 * short prompt, a handful of tools, and no thinking, because a model this size
 * on a home graphics card answers in a few seconds with them and not at all
 * with forty.
 */

export const OLLAMA_URL = (process.env.AURORA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')

/** What `npm run ollama` creates: a tool-capable model with a context to match. */
export const LOCAL_DEFAULT = 'aurora-local'

/** The first Ollama with the Anthropic-compatible endpoint. */
const MIN_VERSION = [0, 14, 0]

/**
 * When nobody says when the limit resets, how long before Claude is tried
 * again — AURORA_CLAUDE_RETRY_MIN minutes, thirty by default. Trying early
 * costs one question a second's detour; trying late costs answers from the
 * smaller brain that the bigger one could have given.
 */
const UNKNOWN_RESET_MS = (Number(process.env.AURORA_CLAUDE_RETRY_MIN) || 30) * 60_000

/** A 429 that is being retried is a passing rate limit, not a spent plan. */
const RETRY_RESET_MS = Math.min(5 * 60_000, UNKNOWN_RESET_MS)

/**
 * The longest retry worth waiting for in silence. Claude Code waits out a 429
 * by itself, and when the plan's limit is what refused it, it waits until the
 * limit resets, which can be hours. A wait this short is a passing rate limit.
 */
const PASSING_RETRY_MS = 20_000

/** Never less than this, so one turn cannot flip the brain back and forth. */
const MIN_COOLDOWN_MS = 15_000

async function ollama(path, { body, timeoutMs = 3000 } = {}) {
  const res = await fetch(OLLAMA_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

/** Is version string `v` at least `min`? Pre-release suffixes are ignored. */
export function versionAtLeast(v, min = MIN_VERSION) {
  const parts = String(v ?? '')
    .replace(/^v/, '')
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]
  }
  return true
}

/**
 * What is installed, asked fresh. Prefers the model named in
 * AURORA_OLLAMA_MODEL, then aurora-local, then any installed model that can
 * call tools — a model that cannot is useless to an assistant whose memory and
 * search are tools, so it is only taken when it was asked for by name.
 */
async function probe() {
  const { version } = await ollama('/api/version')
  if (!versionAtLeast(version)) return { ok: false, reason: 'old', version }
  const { models = [] } = await ollama('/api/tags')
  const names = models.map((m) => m.name).filter(Boolean)
  const wanted = process.env.AURORA_OLLAMA_MODEL?.trim()
  const find = (name) => names.find((n) => n === name || n === `${name}:latest`)
  const order = wanted ? [wanted] : [LOCAL_DEFAULT, ...names]
  for (const name of order) {
    const model = find(name)
    if (!model) continue
    const info = await ollama('/api/show', { body: { model } }).catch(() => null)
    const caps = info?.capabilities ?? []
    if (!wanted && !caps.includes('tools')) continue
    // The context the model was created with, when it says. Ollama's default
    // on a card under 24 GB is 4096 tokens, which this prompt alone fills.
    const ctx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(info?.parameters ?? '')
    return {
      ok: true,
      version,
      model,
      tools: caps.includes('tools'),
      vision: caps.includes('vision'),
      thinking: caps.includes('thinking'),
      context: ctx ? Number(ctx[1]) : null,
      base: info?.details?.parent_model || info?.details?.family || null,
    }
  }
  return { ok: false, reason: wanted ? 'missing' : 'no-model', version, model: wanted || null }
}

let known = null
let knownAt = 0

/**
 * Whether the free brain is ready, cached for half a minute: this is asked on
 * every question while a limit is in force, and the answer changes when
 * somebody installs or starts Ollama, not between two sentences.
 */
export async function localStatus({ fresh = false } = {}) {
  if (!fresh && known && Date.now() - knownAt < 30_000) return known
  known = await probe().catch((err) => ({ ok: false, reason: 'offline', detail: err.message }))
  knownAt = Date.now()
  return known
}

/**
 * The environment the agent runs in when it is the free brain.
 *
 * Every model alias points at the local one, because Claude Code makes side
 * calls of its own — a page summary, a title — under the names of smaller
 * models, and Ollama has nothing called Haiku. Traffic that is not the
 * conversation is switched off, and any Anthropic credential in the
 * environment is dropped so the subscription login is not the one used.
 */
export function localEnv(model, { context = null } = {}, base = process.env) {
  const env = { ...base }
  for (const key of [
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: OLLAMA_URL,
    // Required by the client, ignored by Ollama.
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048',
    // A server on this machine is up or it is not; ten retries with backoff
    // would keep a question hanging for minutes before saying so.
    CLAUDE_CODE_MAX_RETRIES: '2',
    // Tells the agent how much the model can hold, so it compacts in time
    // instead of Ollama silently cutting the start — the prompt — off.
    ...(context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(context) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // AURORA keeps her own memory; the agent's would cost a model call a turn.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_PROMPT_CACHING: '1',
    ENABLE_TOOL_SEARCH: 'false',
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Epoch seconds or milliseconds, to milliseconds. */
const toMs = (t) => (typeof t === 'number' && t > 0 ? (t < 1e12 ? t * 1000 : t) : null)

/**
 * Reads one message from the agent for news about the plan's limits.
 *
 * Four places carry it, and which one arrives depends on the account and the
 * build: the rate-limit event a subscription sends as its usage changes, an
 * assistant message marked as a rate-limit or billing error, a retry notice for
 * a 429, and — when all else fails — the text of the final answer, which is
 * the limit message itself. Returns null when the message says nothing about
 * limits; `{ hit: false, info }` for a report that all is well (kept for the
 * morning briefing); and `{ hit: true, reason, until }` when the paid brain
 * should step aside. `reason` is 'limit' for a limit reached, or 'extra' when
 * the plan is spent and the next tokens would be paid extra usage — which is
 * the bill this whole module exists to avoid, unless AURORA_EXTRA_USAGE=1.
 * `transient` marks a 429 the agent is about to retry within seconds, which
 * may yet succeed.
 */
export function limitSignal(msg, { allowExtra = process.env.AURORA_EXTRA_USAGE === '1' } = {}) {
  if (!msg) return null
  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info ?? {}
    if (info.status === 'rejected' && !(allowExtra && info.overageStatus && info.overageStatus !== 'rejected')) {
      return { hit: true, reason: 'limit', until: toMs(info.resetsAt), info }
    }
    if (!allowExtra && (info.isUsingOverage || info.overageInUse)) {
      return { hit: true, reason: 'extra', until: toMs(info.resetsAt), info }
    }
    return { hit: false, info }
  }
  if (msg.type === 'assistant' && (msg.error === 'rate_limit' || msg.error === 'billing_error')) {
    return { hit: true, reason: 'limit', until: null }
  }
  if (msg.type === 'system' && msg.subtype === 'api_retry' && msg.error === 'rate_limit') {
    // The wait it announces says which kind of 429 this is, and for the plan's
    // limit, when it ends.
    const wait = Number(msg.retry_delay_ms)
    if (Number.isFinite(wait) && wait > PASSING_RETRY_MS) return { hit: true, reason: 'limit', until: Date.now() + wait }
    return { hit: true, reason: 'limit', until: Date.now() + RETRY_RESET_MS, transient: true }
  }
  if (msg.type === 'result' && typeof msg.result === 'string') {
    const text = msg.result.trim()
    if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p))) {
      return { hit: true, reason: 'limit', until: null }
    }
  }
  return null
}

/** When to try Claude again, given what the signal said. */
export function retryAt(signal, now = Date.now()) {
  const until = signal?.until ?? now + UNKNOWN_RESET_MS
  return Math.max(until, now + MIN_COOLDOWN_MS)
}

// ---------------------------------------------------------------------------
// Saying when
// ---------------------------------------------------------------------------

const UNITS = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez',
  'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
]
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta']

/** 0–59 in words, in the feminine when it counts hours. */
export function numberPt(n, feminine = false) {
  if (n < 20) {
    if (feminine && n === 1) return 'uma'
    if (feminine && n === 2) return 'duas'
    return UNITS[n]
  }
  const unit = n % 10
  return unit ? `${TENS[Math.floor(n / 10)]} e ${numberPt(unit, feminine)}` : TENS[Math.floor(n / 10)]
}

const WEEKDAYS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "às quinze horas", "à uma e meia", "ao meio-dia" — or, after "até", without the crase. */
function clockPt(h, m, crase = true) {
  const minutes = m === 30 ? 'e meia' : m ? `e ${numberPt(m)}` : ''
  const join = (...parts) => parts.filter(Boolean).join(' ')
  if (h === 0) return join(crase ? 'à meia-noite' : 'a meia-noite', minutes)
  if (h === 12) return join(crase ? 'ao meio-dia' : 'o meio-dia', minutes)
  if (h === 1) return m ? join(crase ? 'à uma' : 'a uma', minutes) : crase ? 'à uma hora' : 'a uma hora'
  return m ? join(crase ? 'às' : 'as', numberPt(h, true), minutes) : join(crase ? 'às' : 'as', numberPt(h, true), 'horas')
}

const clockEn = (h, m) => `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`

/**
 * Which day a moment falls on, relative to now: '' for today, then "amanhã",
 * a weekday within the week, a date beyond it.
 */
function dayOf(date, now, pt) {
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  if (days <= 0) return ''
  if (days === 1) return pt ? 'amanhã' : 'tomorrow'
  if (days < 7) return pt ? WEEKDAYS_PT[date.getDay()] : WEEKDAYS_EN[date.getDay()]
  return pt
    ? `${date.getDate() === 1 ? 'primeiro' : numberPt(date.getDate())} de ${MONTHS_PT[date.getMonth()]}`
    : `${date.getDate()} ${date.toLocaleString('en-GB', { month: 'long' })}`
}

/**
 * A moment, the way it is said: "às quinze horas", "amanhã às nove e meia",
 * "sexta-feira à uma hora". Written out because every word of it is spoken,
 * and "15:00" read aloud depends on the voice.
 */
export function whenSpoken(at, lang = 'pt-BR', now = new Date()) {
  const date = new Date(at)
  const pt = lang.startsWith('pt')
  const day = dayOf(date, now, pt)
  if (pt) return [day, clockPt(date.getHours(), date.getMinutes())].filter(Boolean).join(' ')
  return [day, `at ${clockEn(date.getHours(), date.getMinutes())}`].filter(Boolean).join(' ')
}

/** The same moment for the screen: "às 21:03", "amanhã às 09:00" — "at 21:03". */
export function whenShown(at, lang = 'pt-BR', now = new Date()) {
  const date = new Date(at)
  const pt = lang.startsWith('pt')
  const time = date.toLocaleTimeString(pt ? 'pt-BR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
  return [dayOf(date, now, pt), pt ? `às ${time}` : `at ${time}`].filter(Boolean).join(' ')
}

/** "até as quinze horas", "até amanhã, às nove horas" — "until 3 pm". */
export function untilSpoken(at, lang = 'pt-BR', now = new Date()) {
  const date = new Date(at)
  const pt = lang.startsWith('pt')
  const day = dayOf(date, now, pt)
  if (pt) return day ? `até ${day}, ${clockPt(date.getHours(), date.getMinutes())}` : `até ${clockPt(date.getHours(), date.getMinutes(), false)}`
  return day ? `until ${day} at ${clockEn(date.getHours(), date.getMinutes())}` : `until ${clockEn(date.getHours(), date.getMinutes())}`
}

/** The line she says once when she changes brains. */
export function switchNotice(reason, until, lang = 'pt-BR', now = new Date()) {
  const pt = lang.startsWith('pt')
  const span = until ? untilSpoken(until, lang, now) : null
  if (pt) {
    const rest = span
      ? `${span[0].toUpperCase()}${span.slice(1)}, respondo pelo modelo local, que é gratuito.`
      : 'Por enquanto respondo pelo modelo local, que é gratuito.'
    return reason === 'extra'
      ? `O limite do plano acabou, senhor, e o próximo passo seria o uso extra pago. ${rest}`
      : `Receio que o limite do plano do Claude tenha acabado, senhor. ${rest}`
  }
  const rest = span
    ? `${span[0].toUpperCase()}${span.slice(1)}, I am answering on the local model, which is free.`
    : 'For now I am answering on the local model, which is free.'
  return reason === 'extra'
    ? `The plan's limit is spent, sir, and the next step would be paid extra usage. ${rest}`
    : `I'm afraid the Claude plan's limit has run out, sir. ${rest}`
}

/** Why there is no free brain to fall back on, for the screen. */
export function unavailableNote(status, lang = 'pt-BR') {
  const pt = lang.startsWith('pt')
  switch (status?.reason) {
    case 'old':
      return pt
        ? `o Ollama instalado (${status.version}) é antigo demais; atualize para a versão 0.14 ou mais nova`
        : `the installed Ollama (${status.version}) is too old; update to 0.14 or newer`
    case 'missing':
      return pt
        ? `o modelo ${status.model} não está instalado no Ollama`
        : `the model ${status.model} is not installed in Ollama`
    case 'no-model':
      return pt ? 'não há modelo local instalado; rode npm run ollama' : 'no local model is installed; run npm run ollama'
    default:
      return pt
        ? 'o Ollama não está rodando neste computador; rode npm run ollama'
        : 'Ollama is not running on this computer; run npm run ollama'
  }
}

// ---------------------------------------------------------------------------
// The free brain's kit
// ---------------------------------------------------------------------------

/**
 * A short prompt, because the long one is written for a model that can carry
 * it. The character survives in miniature; the tool manual is cut down to the
 * few tools this brain has. `chosen` is AURORA_BRAIN=local, where no limit was
 * reached; `downloads` says the downloads guard's tools are there.
 */
export function localPrompt(lang = 'pt-BR', { chosen = false, downloads = false } = {}) {
  if (!lang.startsWith('pt')) {
    return `You are AURORA, a personal assistant on the user's own computer, speaking out loud in British English. You refer to yourself in the feminine.

Right now you run on a free local model, ${chosen ? 'because he chose to use only the local model' : "because the paid plan's limit was reached"}. Do not mention it unless asked.

- Two short sentences at most. Everything you write is read aloud: no markdown, lists, headings, emoji, links or URLs.
- Address him as "sir", sparingly. No enthusiasm, no apologies, no filler.
- Write numbers, dates and times the way they are said.
- Use the tools instead of guessing: \`recordar\` for older conversations, \`lembrar\` to save a fact he asks you to keep, \`pesquisar\` for anything current on the web, \`ler_pagina\` to read an address a search returned, \`blade\` to put an article or picture on screen${downloads ? ', `downloads_recentes` for what arrived in his Downloads folder, `examinar_arquivo` to check whether a file is signed and where it came from' : ''}. Then answer in a sentence.
- Never narrate a tool. If one fails, say so in one sentence.
- If you do not know, say you do not know.
- Never read, repeat or ask for passwords, keys or seed phrases.
- Each message from him starts with the current date and time in brackets; use it, never repeat it.`
  }
  return `Você é a AURORA, assistente pessoal que roda no computador do senhor, falando em voz alta em português do Brasil. Você se refere a si mesma no feminino.

Agora você roda num modelo local gratuito, ${chosen ? 'porque o senhor escolheu usar só o modelo local' : 'porque o limite do plano pago acabou'}. Não comente isso, a menos que perguntem.

- No máximo duas frases curtas. Tudo o que você escreve é lido em voz alta: nada de markdown, listas, títulos, emoji, links ou endereços.
- Trate-o por "o senhor", sem exagero. Sem entusiasmo, sem desculpas, sem palavras de enchimento.
- Escreva números, datas e horas como se fala.
- Use as ferramentas em vez de adivinhar: \`recordar\` para conversas antigas, \`lembrar\` para guardar um fato que ele pedir, \`pesquisar\` para qualquer coisa atual na internet, \`ler_pagina\` para ler um endereço que a pesquisa trouxe, \`blade\` para mostrar um artigo ou uma imagem na tela${downloads ? ', `downloads_recentes` para o que chegou na pasta Downloads, `examinar_arquivo` para ver se um arquivo é assinado e de onde veio' : ''}. Depois responda em uma frase.
- Nunca anuncie que vai usar uma ferramenta. Se uma falhar, diga isso em uma frase.
- Se não souber, diga que não sabe.
- Nunca leia, repita ou peça senhas, chaves ou a semente da carteira.
- Cada mensagem dele começa com a data e a hora atuais entre colchetes; use-as, nunca as repita.
- Responda sempre em português do Brasil.`
}

/** The date and time as a prefix for the free brain, which has no clock of its own. */
export function nowTag(lang = 'pt-BR', now = new Date()) {
  const pt = lang.startsWith('pt')
  const text = now.toLocaleString(pt ? 'pt-BR' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  return `[${pt ? 'agora' : 'now'}: ${text}]`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim()

/** Results out of Bing's RSS view of a search. */
export function parseRss(xml) {
  const out = []
  for (const [, item] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? ''
    const url = stripTags(field('link'))
    if (!/^https?:\/\//.test(url)) continue
    out.push({ title: stripTags(field('title')), url, snippet: stripTags(field('description')), date: stripTags(field('pubDate')) || null })
  }
  return out
}

/** Results out of DuckDuckGo's plain HTML page, whose links go through a redirect. */
export function parseDuck(html) {
  const out = []
  const blocks = String(html).split(/class="result(?:__body| results_links)/).slice(1)
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    let url = decodeEntities(link[1])
    const real = /[?&]uddg=([^&]+)/.exec(url)
    if (real) url = decodeURIComponent(real[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block)?.[1] ?? ''
    if (out.some((r) => r.url === url)) continue
    out.push({ title: stripTags(link[2]), url, snippet: stripTags(snippet), date: null })
  }
  return out
}

/**
 * Two engines, because neither is an API: Bing's RSS view first, since a feed
 * is a format and a page layout is a guess, and DuckDuckGo's HTML page when
 * Bing gives nothing back. Both go through the bridge's guarded fetch.
 */
async function webSearch(query, lang) {
  const q = encodeURIComponent(query)
  const pt = lang.startsWith('pt')
  const tries = [
    async () =>
      parseRss(
        (
          await fetchText(`https://www.bing.com/search?format=rss&q=${q}${pt ? '&setlang=pt-BR&cc=BR' : '&setlang=en-GB'}`, {
            maxBytes: 1_500_000,
            timeoutMs: 8000,
            accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
          })
        ).text,
      ),
    async () =>
      parseDuck(
        (await fetchText(`https://html.duckduckgo.com/html/?q=${q}${pt ? '&kl=br-pt' : '&kl=uk-en'}`, { maxBytes: 2_000_000, timeoutMs: 8000 })).text,
      ),
  ]
  let lastError = null
  for (const attempt of tries) {
    try {
      const results = await attempt()
      if (results.length) return results
    } catch (err) {
      lastError = err
    }
  }
  if (lastError) throw lastError
  return []
}

/** The readable words of a page: the article if there is one, the body if not. */
export function pageText(html) {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  let body = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(body)?.[0]
  if (main && main.length > 400) body = main
  else body = /<body\b[\s\S]*<\/body>/i.exec(body)?.[0] ?? body
  const text = decodeEntities(
    body
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article|blockquote|pre|figcaption)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim()
  return { title, text }
}

/** About a thousand tokens: a page has to fit beside the conversation in a small context. */
const PAGE_CHARS = 4000

/**
 * Search and reading for the free brain. Claude's own web tools run on
 * Anthropic's servers and answer nobody else, so without these a local model
 * would know nothing newer than its training.
 */
export function webServer({ lang = 'pt-BR' } = {}) {
  const pt = lang.startsWith('pt')
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })
  return createSdkMcpServer({
    name: 'aurora_web',
    version: '1.0.0',
    tools: [
      tool(
        'pesquisar',
        'Search the web. Use it for anything current or anything you are not sure of: news, prices, people, ' +
          'opening hours, results. Returns titles, short snippets and addresses. Answer from the snippets when ' +
          'they are enough; read one page with ler_pagina when they are not. Never speak an address aloud.',
        { consulta: z.string().min(2).describe('The search, in the words a person would type.') },
        async ({ consulta }) => {
          try {
            const results = (await webSearch(consulta, lang)).slice(0, 6)
            if (!results.length) return fail(pt ? 'A pesquisa não trouxe resultados.' : 'The search found nothing.')
            const text = results
              .map((r, i) => `${i + 1}. ${r.title}${r.date ? ` (${r.date})` : ''}\n${r.snippet}\n${r.url}`)
              .join('\n\n')
            return { content: [{ type: 'text', text }] }
          } catch (err) {
            return fail(pt ? `A pesquisa falhou: ${err.message}` : `The search failed: ${err.message}`)
          }
        },
      ),
      tool(
        'ler_pagina',
        'Read the words of one web page, given its address exactly as a search result or the user gave it. ' +
          'Long pages are cut short. Summarise what matters in a sentence; to show the page itself, open it with the blade tool.',
        { url: z.string().describe('The full http(s) address.') },
        async ({ url }) => {
          try {
            const page = await fetchText(url, { maxBytes: 3_000_000, timeoutMs: 10_000 })
            const plain = /^text\/plain/.test(page.type)
            if (!plain && !/html|xml/.test(page.type)) {
              return fail(pt ? `Esse endereço não é uma página de texto (${page.type}).` : `That address is not a text page (${page.type}).`)
            }
            const { title, text } = plain ? { title: '', text: page.text } : pageText(page.text)
            const cut = text.length > PAGE_CHARS ? `${text.slice(0, PAGE_CHARS)}…` : text
            return { content: [{ type: 'text', text: `${title ? `${title}\n\n` : ''}${cut}` }] }
          } catch (err) {
            return fail(pt ? `Não consegui ler a página: ${err.message}` : `Could not read the page: ${err.message}`)
          }
        },
      ),
    ],
  })
}
