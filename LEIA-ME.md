# AURORA em português, para Windows

Este é um fork do [AURORA do adewaskar](https://github.com/adewaskar/jarvis) (licença MIT): um assistente de voz com a interface holográfica do Homem de Ferro, em que o "cérebro" é o Claude Code rodando no seu computador. Esta versão acrescenta:

- **Português do Brasil**: ele entende "Ei Aurora", responde em português, com voz brasileira e as telas traduzidas.
- **Windows**: o controle do Chrome, a inicialização e os servidores MCP funcionam no Windows.
- **Memória em disco**: ele lembra das conversas e do que o senhor pedir para anotar, mesmo depois de fechar tudo. A memória fica no disco D: e é copiada automaticamente para o E:.
- **REA**: ele pode fazer engenharia reversa de programas, bibliotecas, APKs e sites usando o REA.
- **Cápsula**: ele lê o estado do seu nó Cápsula e verifica a cadeia de blocos, sem nunca tocar na carteira ou nas chaves.

## O que precisa ter instalado

1. **Node.js 22** (LTS) — [nodejs.org](https://nodejs.org). A AURORA precisa do 20 ou mais novo; o REA precisa do 22.19 ou mais novo.
2. **Claude Code** — no PowerShell:
   ```powershell
   npm install -g @anthropic-ai/claude-code
   claude
   ```
   Faça o login quando ele pedir e depois feche com `/exit`. A AURORA usa esse mesmo login; não precisa de chave de API.
3. **Google Chrome** — o reconhecimento de voz do navegador funciona melhor nele.
4. *(Opcional)* **Extensão Claude para Chrome**, para a AURORA usar o seu próprio navegador (já logado nos seus sites).
5. *(Opcional)* **REA**, para engenharia reversa:
   ```powershell
   npx rea-agents setup
   ```

## Instalar e rodar

1. Extraia o zip direto no `C:\`. Vai ficar uma pasta `C:\Aurora`.
2. No PowerShell:
   ```powershell
   cd C:\Aurora
   npm install
   npm run setup
   ```
   O `setup` não muda nada: só mostra o que está pronto e o que falta (Claude Code, discos, REA, Cápsula, Chrome).
3. Para ligar:
   ```powershell
   npm start
   ```
4. Abra **http://localhost:5173** no Chrome, clique em **INICIALIZAR** (ou bata palmas), permita o microfone e diga: **"Ei Aurora, que horas são?"**

`Ctrl+C` no PowerShell desliga tudo.

### Teclas úteis

| Tecla | O que faz |
|---|---|
| Espaço | falar sem dizer "Ei Aurora" |
| V | trocar a voz |
| D | painel de diagnóstico (por que ele não ouve / não fala) |
| T | teste de áudio |
| G | controle com as mãos pela câmera |

## A voz em português

Sem configurar nada, ele usa as vozes do próprio Windows/navegador e escolhe sozinho a melhor voz masculina brasileira que encontrar, nesta ordem: **Antonio** (só no Edge), **Daniel**, **Felipe**, depois qualquer voz pt-BR.

Se ele falar com sotaque inglês, falta a voz brasileira no Windows: **Configurações → Hora e idioma → Fala → Adicionar vozes → Português (Brasil)**, depois recarregue a página.

Para uma voz melhor, ponha uma chave da ElevenLabs no `.env.local` (`ELEVENLABS_API_KEY=...`) e, em `AURORA_VOICE_ID`, o código de uma voz brasileira da biblioteca da ElevenLabs.

## Memória

Ele guarda duas coisas, em arquivos de texto que o senhor pode abrir e editar:

- `D:\AuroraMemoria\memoria.md` — as anotações. Cada linha é uma anotação com um número, como `- [#3] 2026-10-13 10:41 — A reunião com o fornecedor é sexta às 10.`
- `D:\AuroraMemoria\conversas\AAAA-MM-DD.md` — todas as conversas, um arquivo por dia.

Tudo é copiado na hora para `E:\AuroraMemoria`. Se um dos discos falhar, nada se perde: quando a AURORA liga, ele compara as duas pastas e recupera o que estiver faltando ou mais antigo.

Quando ele liga, já começa sabendo as anotações e as últimas conversas. Para o resto:

- "Ei Aurora, **lembre que** o fornecedor de cabos é a Elétrica Silva."
- "**O que você lembra sobre** o fornecedor?"
- "**Esqueça** a anotação três."

Ele se recusa a guardar senhas, chaves ou sementes de carteira.

**Privacidade:** tudo o que é dito a ele fica gravado em texto nessas pastas. Para não gravar nada, ponha `AURORA_MEMORY=off` no `.env.local`.

Se o computador não tiver o disco D:, a memória vai para `C:\Users\<seu usuário>\AuroraMemoria`. Os caminhos podem ser trocados no `.env.local` (veja abaixo).

## Ações: por que ele às vezes diz que não pode

Por padrão a AURORA **olha tudo e não muda nada**: pode pesquisar, ler páginas, ler arquivos, analisar com o REA e consultar o Cápsula, mas não pode apagar arquivos, rodar comandos, clicar e digitar no navegador, instalar coisas no celular etc. Para liberar as ações:

```powershell
npm start -- --writes
```

## Chrome

Com a extensão Claude ativa no Chrome, ele usa o seu navegador de verdade, já logado nos seus sites, e mostra o resultado na interface. No Windows ele se conecta direto ao canal da extensão (`\\.\pipe\claude-mcp-browser-bridge-<usuário>`). Se o Chrome estiver fechado, ele avisa e segue sem o navegador.

## REA (engenharia reversa)

Depois do `npx rea-agents setup`, o REA fica registrado no Claude Code e a AURORA o encontra sozinho na próxima vez que ligar.

- "Ei Aurora, analise o programa em `E:\AuroraArquivos\app.exe` e me diga o que ele faz."
- "Que bibliotecas esse APK usa?"

As ferramentas de leitura e análise estática do REA ficam liberadas (125 na versão 6.4). As que executam, se conectam a programas ou aparelhos, instalam ou gravam arquivos (45) só funcionam com `--writes`, e o mesmo vale para qualquer ferramenta nova que uma versão futura do REA trouxer. Resultados grandes ficam em `E:\AuroraArquivos`.

Use só em software seu ou que o senhor tenha autorização para analisar.

## Cápsula

Se existir a pasta `C:\Users\<seu usuário>\.capsula`, a AURORA ganha quatro consultas, todas **só de leitura**:

- "Como está o meu nó do Cápsula?" — endereço, armazenamento, tamanho da cadeia, pares, casos, preço.
- "O que aconteceu nos últimos blocos?"
- "Quais casos estão selados?"
- "**A cadeia do Cápsula está íntegra?**" — recalcula o hash de cada bloco e a raiz de Merkle dos eventos, confere a ligação com o bloco anterior e o registro do topo.

Ele **nunca** abre `wallet.seed`, a chave de assinatura, `sign_tokens` nem nada da carteira: só lê uma lista fechada de arquivos (configuração do nó, ledger, pares, índice de casos, preço).

## Configuração (`.env.local`)

Copie `.env.example` para `.env.local` e descomente só o que quiser mudar. A ponte e a página leem o mesmo arquivo.

| Variável | Padrão | Para quê |
|---|---|---|
| `AURORA_LANG` e `VITE_LANG` | `pt-BR` | idioma (os dois iguais); `en-GB` volta ao original |
| `AURORA_MEMORY_DIR` | `D:\AuroraMemoria` | onde fica a memória |
| `AURORA_MEMORY_BACKUP` | `E:\AuroraMemoria` | a cópia; vazio desliga a cópia |
| `AURORA_MEMORY` | ligado | `off` desliga a memória |
| `AURORA_FILES_DIR` | `E:\AuroraArquivos` | arquivos grandes |
| `CAPSULA_DIR` | `C:\Users\<você>\.capsula` | pasta do nó Cápsula |
| `AURORA_MODEL` | `claude-opus-5` | modelo; um modelo Sonnet responde mais rápido |
| `ELEVENLABS_API_KEY` | — | voz e transcrição melhores |

## Problemas comuns

- **"A ponte não responde"**: o `npm start` precisa estar rodando no PowerShell.
- **Ele não me ouve**: aperte D. Se aparecer "não estou ouvindo você", confira a permissão do microfone no cadeado da barra de endereço do Chrome.
- **Ele fala com sotaque inglês**: instale a voz Português (Brasil) do Windows (veja "A voz em português").
- **Ele não entende "Ei Aurora"**: o reconhecimento às vezes ouve "Jarbas", "Travis" ou "Jervis", e todos funcionam. Também dá para apertar Espaço e falar direto.
- **O REA demora na primeira vez**: o `npx` baixa o REA na primeira chamada.

## Créditos

AURORA original: [adewaskar/jarvis](https://github.com/adewaskar/jarvis), licença MIT (arquivo `LICENSE`). Esta adaptação mantém a mesma licença.
