#!/usr/bin/env node
/**
 * Makes JARVIS start with Windows, or stops him doing so.
 *
 *   npm run inicio-automatico            start-up and desktop shortcuts
 *   npm run inicio-automatico:desligar   removes the start-up one; the desktop one stays
 *
 * Both shortcuts run scripts/autostart.mjs with no console window. A shortcut
 * cannot start Node hidden by itself — Node is a console program, so it brings
 * a console window with it, and everything it starts would share that window.
 * So the shortcut runs wscript on a three-line script written here with this
 * computer's paths, and wscript starts Node hidden. JScript rather than
 * VBScript, which Windows is phasing out.
 *
 * The shortcuts are made by PowerShell, through the same COM object Windows
 * itself uses, because the .lnk format is not something to hand-roll.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnv } from '../bridge/env.mjs'
import { reactorIco } from './icon.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
loadLocalEnv()

const PT = (process.env.JARVIS_LANG ?? 'pt-BR').startsWith('pt')
const say = (pt, en) => (PT ? pt : en)
const action = process.argv[2] ?? 'ligar'
const NAME = 'Jarvis'

if (platform() !== 'win32') {
  console.log(
    say(
      'O início automático é para o Windows. Em outro sistema, ponha `npm run janela` nos programas que abrem com a sua sessão.',
      'Start-up is a Windows feature. Elsewhere, add `npm run janela` to the programs your session starts.',
    ),
  )
  process.exit(0)
}

const DATA = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), NAME)
const SCRIPT = join(DATA, 'iniciar.js')
const ICON = join(DATA, `${NAME.toLowerCase()}.ico`)
const WSCRIPT = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')

/**
 * Runs a PowerShell script with its inputs in environment variables, so no
 * path ever has to survive being quoted into a command line — not even one
 * with an accent or an apostrophe in it.
 */
function powershell(script, env) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true },
  )
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || '').trim() || `PowerShell: ${res.status}`)
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Creates (or, with J_REMOVE=1, deletes) NAME.lnk in each special folder named in J_WHERE. */
const SHORTCUTS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
foreach ($where in $env:J_WHERE.Split(',')) {
  $dir = [Environment]::GetFolderPath($where)
  if (-not $dir) { continue }
  $path = Join-Path $dir ($env:J_NAME + '.lnk')
  if ($env:J_REMOVE -eq '1') {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
      Write-Output $path
    }
    continue
  }
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $env:J_TARGET
  $link.Arguments = $env:J_ARGS
  $link.WorkingDirectory = $env:J_DIR
  $link.IconLocation = $env:J_ICON
  $link.Description = $env:J_NAME
  $link.Save()
  Write-Output $path
}
`

if (action === 'desligar') {
  let gone
  try {
    gone = powershell(SHORTCUTS, { J_WHERE: 'Startup', J_NAME: NAME, J_REMOVE: '1' })
  } catch (err) {
    console.error(say(`Não consegui remover o atalho: ${err.message}`, `Could not remove the shortcut: ${err.message}`))
    process.exit(1)
  }
  console.log(
    gone.length
      ? say(`Pronto: ele não liga mais junto com o Windows (removido ${gone[0]}).`, `Done: he no longer starts with Windows (removed ${gone[0]}).`)
      : say('Ele já não estava ligando junto com o Windows.', 'He was not starting with Windows anyway.'),
  )
  console.log(say('O atalho da área de trabalho continua lá, para ligar quando quiser.', 'The desktop shortcut is still there, to start him when you want.'))
  process.exit(0)
}

if (action !== 'ligar') {
  console.log(say('Use: npm run inicio-automatico  (ou inicio-automatico:desligar)', 'Usage: npm run inicio-automatico  (or inicio-automatico:desligar)'))
  process.exit(1)
}

if (!existsSync(join(ROOT, 'node_modules'))) {
  console.log(say('Rode `npm install` antes.', 'Run `npm install` first.'))
  process.exit(1)
}

mkdirSync(DATA, { recursive: true })
writeFileSync(ICON, reactorIco())

// UTF-16 with a byte-order mark is the encoding wscript reads without
// guessing, so a user folder with an accent in its name survives.
const autostart = join(ROOT, 'scripts', 'autostart.mjs')
const js = [
  `// Gerado por "npm run inicio-automatico": liga o ${NAME} sem janela de console.`,
  'var shell = new ActiveXObject("WScript.Shell");',
  `shell.CurrentDirectory = ${JSON.stringify(ROOT)};`,
  `shell.Run(${JSON.stringify(`"${process.execPath}" "${autostart}"`)}, 0, false);`,
  '',
].join('\r\n')
writeFileSync(SCRIPT, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(js, 'utf16le')]))

let made
try {
  made = powershell(SHORTCUTS, {
    J_WHERE: 'Startup,Desktop',
    J_NAME: NAME,
    J_TARGET: WSCRIPT,
    J_ARGS: `//Nologo //E:jscript "${SCRIPT}"`,
    J_DIR: ROOT,
    J_ICON: `${ICON},0`,
  })
} catch (err) {
  console.error(say(`Não consegui criar os atalhos: ${err.message}`, `Could not create the shortcuts: ${err.message}`))
  process.exit(1)
}

console.log('')
console.log(say(`Pronto. O ${NAME} vai ligar sozinho sempre que você entrar no Windows.`, `Done. ${NAME} will start by himself every time you sign in to Windows.`))
for (const p of made) console.log(`  ${p}`)
console.log('')
console.log(
  say(
    [
      'Para ligar agora, dê dois cliques no atalho da área de trabalho.',
      'Na primeira vez, a janela dele pede o microfone: clique em Permitir.',
      'Fechar a janela desliga tudo depois de uns 45 segundos.',
      `O que acontece fica registrado em ${join(ROOT, 'logs', 'jarvis.log')}.`,
      'Para desfazer: npm run inicio-automatico:desligar',
    ].join('\n'),
    [
      'To start him now, double-click the desktop shortcut.',
      'The first time, his window asks for the microphone: click Allow.',
      'Closing the window switches everything off after about 45 seconds.',
      `What happens is logged in ${join(ROOT, 'logs', 'jarvis.log')}.`,
      'To undo: npm run inicio-automatico:desligar',
    ].join('\n'),
  ),
)
