#!/usr/bin/env node
// JARVIS preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the command that starts
// JARVIS. Every check degrades to a single friendly line if something is not
// there, and the script always exits 0 — it is advice, not a gate.
//
// Portuguese unless JARVIS_LANG says otherwise, like the bridge.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const PT = (process.env.JARVIS_LANG ?? 'pt-BR').startsWith('pt');
const say = (pt, en) => (PT ? pt : en);
const WINDOWS = platform() === 'win32';

const tick = '  ok  ';
const warn = say(' nota ', ' note ');
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

console.log('');
console.log(say('JARVIS — conferindo o computador (nada é alterado)', 'JARVIS preflight — checking your machine (nothing is changed)'));
console.log('------------------------------------------------------------');

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 20) {
    line(tick, say(`Node.js ${process.versions.node} (precisa 20 ou mais).`, `Node.js ${process.versions.node} (20+ required).`));
  } else {
    line(warn, say(`O Node.js ${process.versions.node} é anterior ao 20. Atualize: a ponte precisa do 20 ou mais novo.`, `Node.js ${process.versions.node} is below 20. Please upgrade — the bridge needs Node 20 or newer.`));
  }
} catch {
  line(warn, say('Não consegui ler a versão do Node.js. O JARVIS precisa do 20 ou mais novo.', 'Could not read the Node.js version. JARVIS needs Node 20 or newer.'));
}

// --- Claude CLI on PATH ---------------------------------------------------
// Through the shell on Windows: installed with npm, `claude` is a .cmd script,
// which a direct spawn cannot find even when it is right there on the PATH.
let claudeFound = false;
try {
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, shell: WINDOWS });
  if (res.status === 0 && res.stdout) {
    claudeFound = true;
    line(tick, say(`Claude Code encontrado: ${res.stdout.trim()}`, `Claude CLI found: ${res.stdout.trim()}`));
  }
} catch {
  // ignore — handled below
}
if (!claudeFound) {
  line(warn, say('Claude Code não está no PATH.', 'Claude CLI not found on your PATH.'));
  line(info, say('Instale: npm install -g @anthropic-ai/claude-code', 'Install it: npm install -g @anthropic-ai/claude-code'));
  line(info, say('Depois rode `claude` uma vez e faça o login. A ponte usa esse login — não precisa de chave de API.', 'Then run `claude` once and complete login. The bridge uses that login — no API key needed.'));
}

// --- ~/.claude.json and MCP servers --------------------------------------
const claudeJsonPath = join(homedir(), '.claude.json');
let servers = {};
try {
  const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers ? parsed.mcpServers : {};
  const n = Object.keys(servers).length;
  if (n > 0) {
    line(tick, say(`~/.claude.json com ${n} servidor(es) MCP configurado(s).`, `~/.claude.json found with ${n} MCP server${n === 1 ? '' : 's'} configured.`));
  } else {
    line(info, say('~/.claude.json existe, mas sem servidores MCP. O JARVIS responde e controla a própria interface mesmo assim.', '~/.claude.json found, but no MCP servers are configured yet. JARVIS still answers and drives its own interface.'));
  }
} catch {
  line(info, say('~/.claude.json ainda não existe. Ele aparece depois do primeiro `claude` com login.', '~/.claude.json not found yet. It appears once you run `claude` and log in.'));
}

// --- REA -----------------------------------------------------------------
if (servers.rea) {
  line(tick, say('REA (engenharia reversa) registrado no Claude Code.', 'REA (reverse engineering) is registered with Claude Code.'));
} else {
  line(info, say('REA não está registrado. Opcional: `npx rea-agents setup` (precisa do Node 22.19 ou mais novo).', 'REA is not registered. Optional: `npx rea-agents setup` (needs Node 22.19+).'));
}

// --- Memory and the disks -------------------------------------------------
try {
  const { memoryPlaces } = await import('../bridge/memory.mjs');
  const places = memoryPlaces();
  if (!places) {
    line(info, say('Memória desligada (JARVIS_MEMORY=off).', 'Memory is off (JARVIS_MEMORY=off).'));
  } else {
    line(tick, say(`Memória em ${places.dir}`, `Memory in ${places.dir}`));
    line(
      places.backup ? tick : info,
      places.backup
        ? say(`Cópia automática em ${places.backup}`, `Mirrored to ${places.backup}`)
        : say('Sem cópia em outro disco (defina JARVIS_MEMORY_BACKUP para ter uma).', 'No mirror on another disk (set JARVIS_MEMORY_BACKUP for one).'),
    );
  }
} catch {
  line(info, say('Rode `npm install` antes para ver onde a memória vai ficar.', 'Run `npm install` first to see where memory will live.'));
}

// --- Cápsula ----------------------------------------------------------------
const capsula = process.env.CAPSULA_DIR || join(homedir(), '.capsula');
line(
  existsSync(capsula) ? tick : info,
  existsSync(capsula)
    ? say(`Cápsula encontrado em ${capsula} (o JARVIS só lê; nunca a carteira nem as chaves).`, `Cápsula found at ${capsula} (read-only; never the wallet or keys).`)
    : say(`Cápsula não encontrado em ${capsula}. Defina CAPSULA_DIR se estiver em outro lugar.`, `No Cápsula at ${capsula}. Set CAPSULA_DIR if it lives elsewhere.`),
);

// --- Chrome ----------------------------------------------------------------
try {
  const { chromeAvailable } = await import('../bridge/chrome.mjs');
  if (await chromeAvailable()) {
    line(tick, say('Extensão Claude do Chrome acessível.', 'Claude Chrome extension reachable.'));
  } else {
    line(info, say('Extensão Claude do Chrome não encontrada agora. Abra o Chrome com a extensão ativa para o JARVIS usar o seu navegador.', 'Claude Chrome extension not reachable right now. Open Chrome with it enabled so JARVIS can use your browser.'));
  }
} catch {
  // Not installed yet; the line above about npm install covers it.
}

// --- ElevenLabs key (env or the elevenlabs MCP entry) --------------------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
    return say('variável de ambiente (ELEVENLABS_API_KEY)', 'environment (ELEVENLABS_API_KEY)');
  }
  const env = servers.elevenlabs && servers.elevenlabs.env ? servers.elevenlabs.env : {};
  if (env.ELEVENLABS_API_KEY && String(env.ELEVENLABS_API_KEY).trim()) {
    return say('o servidor MCP elevenlabs em ~/.claude.json', 'the elevenlabs MCP server in ~/.claude.json');
  }
  return null;
}

const elSource = findElevenLabsKey();
if (elSource) {
  line(tick, say(`Voz premium disponível — chave da ElevenLabs encontrada em ${elSource}.`, `Premium voice available — ElevenLabs key found via ${elSource}.`));
} else {
  line(info, say('Sem chave da ElevenLabs — o JARVIS usa a voz do navegador (funciona bem).', 'No ElevenLabs key found — JARVIS will use browser speech (that is completely fine).'));
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log(say('Para rodar o JARVIS:', 'To run JARVIS:'));
console.log(say('  npm start                 # ponte e interface juntas', '  npm start                 # the brain and the face together'));
console.log(say('  npm start -- --writes     # permitindo ações (arquivos, celular, cliques no navegador)', '  npm start -- --writes     # allowing actions (files, phone, browser clicks)'));
console.log('');
console.log(say('Depois abra http://localhost:5173 no Chrome, clique em INICIALIZAR e diga "Ei Jarvis".', 'Then open http://localhost:5173 in Chrome, click INITIALISE and say "Hey Jarvis".'));
console.log('');

process.exit(0);
