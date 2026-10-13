# AURORA — guia completo

A AURORA é uma assistente de voz com interface holográfica em que o "cérebro" é o Claude Code rodando no seu computador. Ela fala português do Brasil, liga junto com o Windows, guarda memória em disco e analisa programas com o REA. Começou como um fork do [JARVIS do adewaskar](https://github.com/adewaskar/jarvis) (licença MIT).

## O que precisa ter instalado

1. **Node.js 22** (LTS) — [nodejs.org](https://nodejs.org). A AURORA precisa do 20 ou mais novo; o REA precisa do 22.19 ou mais novo.
2. **Claude Code** — no PowerShell:
   ```powershell
   npm install -g @anthropic-ai/claude-code
   claude
   ```
   Faça o login quando ele pedir e depois feche com `/exit`. A AURORA usa esse mesmo login; não precisa de chave de API.
3. **Google Chrome** (ou o Edge, que já vem no Windows). O reconhecimento de voz do navegador é o que ouve você.
4. *(Opcional)* **Extensão Claude para Chrome**, para a AURORA usar o seu próprio navegador, já logado nos seus sites.
5. *(Opcional)* **REA**, para engenharia reversa:
   ```powershell
   npx rea-agents setup
   ```

## Instalar

Com o Git:

```powershell
git clone https://github.com/cedu360/Aurora C:\Aurora
```

Ou baixe o zip pelo botão **Code → Download ZIP** do GitHub e extraia de modo que fique a pasta `C:\Aurora`. Depois:

```powershell
cd C:\Aurora
npm install
npm run setup
```

O `setup` não muda nada: só mostra o que está pronto e o que falta (Claude Code, discos, REA, Cápsula, Chrome, início automático).

## Como ela liga

### Sozinha, junto com o Windows (recomendado)

```powershell
npm run inicio-automatico
```

Isso cria dois atalhos **Aurora**, com o ícone do reator: um na pasta de inicialização do Windows e outro na área de trabalho. A partir daí:

1. Você entra no Windows.
2. A ponte e a interface sobem escondidas, sem janela de terminal.
3. A janela da AURORA abre (Chrome em modo aplicativo, com um perfil só dela), a sequência de inicialização toca e ela diz "Bom dia, senhor. Todos os sistemas prontos."
4. Diga **"Ei Aurora"** e fale.

Na primeira vez, a janela pede o microfone: clique em **Permitir**. Ela lembra da permissão nas próximas.

- **Fechar a janela** desliga tudo depois de uns 45 segundos.
- **O atalho da área de trabalho** liga de novo. Se ela já estiver ligada, ele só abre a janela.
- **Se a ponte cair**, ela religa sozinha (até três vezes em dez minutos).
- O que acontece fica registrado em `C:\Aurora\logs\aurora.log`. Se ela não conseguir ligar, abre esse arquivo no Bloco de Notas.
- Para parar de ligar junto com o Windows: `npm run inicio-automatico:desligar` (o atalho da área de trabalho continua).

Ela liga sozinha porque a janela dela é aberta com uma permissão para tocar som sem clique, que vale só para aquele perfil. Aberta de outro jeito, a página mostra o botão **INICIALIZAR**, como antes.

### À mão

```powershell
npm start
```

Abra **http://localhost:5173** no Chrome, clique em **INICIALIZAR** (ou bata palmas), permita o microfone e diga: **"Ei Aurora, que horas são?"** `Ctrl+C` no PowerShell desliga tudo.

`npm run janela` faz o mesmo que o atalho: liga tudo e abre a janela própria, que liga sozinha.

### Teclas úteis

| Tecla | O que faz |
|---|---|
| Espaço | falar sem dizer "Ei Aurora" |
| V | trocar a voz |
| D | painel de diagnóstico (por que ela não ouve / não fala) |
| T | teste de áudio |
| G | controle com as mãos pela câmera |
| Esc | pôr em espera |
| F11 | tela cheia |

## O que ela pode fazer

Sem configurar nada além do login do Claude Code:

- **Conversar** em português, em voz alta, com respostas curtas.
- **Pesquisar na web** e **ler páginas e artigos**, mostrando o que achou em painéis na tela (artigo em modo leitura, imagens, vídeos).
- **Ver pela câmera**: "o que você está vendo?", "observe por cinco segundos".
- **Mudar a própria interface**: cor, forma do reator, imagens em órbita.
- **Lembrar**: anotações e conversas em disco (veja "Memória").
- **Ser controlada pelas mãos** pela câmera (tecla G).

Com as extensões opcionais:

- **O seu Chrome** (extensão Claude): abrir e ler os sites em que você já está logado, como e-mail, bancos e painéis.
- **Engenharia reversa** (REA): explicar o que um programa, biblioteca, APK ou site faz por dentro.
- **Cápsula**: estado do nó, últimos blocos, casos e verificação da cadeia.
- **Os seus servidores MCP**: tudo o que você já configurou no Claude Code também fica disponível para ela.

Com `--writes` (veja "Ações"): rodar comandos, criar e apagar arquivos, clicar e digitar no navegador, mexer no celular pelo adb.

## A voz

Sem configurar nada, ela usa as vozes do próprio Windows e do navegador e escolhe sozinha a melhor voz feminina brasileira que encontrar, nesta ordem: **Francisca** e **Thalita** (as vozes "Natural" do Edge), **Maria** (do Windows), **Luciana** (do macOS), depois a voz do Google e qualquer outra voz pt-BR. A tecla **V** passa para a próxima.

Se ela falar com sotaque inglês, falta a voz brasileira no Windows: **Configurações → Hora e idioma → Fala → Adicionar vozes → Português (Brasil)**, depois recarregue a página.

Para uma voz melhor, ponha uma chave da ElevenLabs no `.env.local` (`ELEVENLABS_API_KEY=...`) e, em `AURORA_VOICE_ID`, o código de uma voz brasileira da biblioteca da ElevenLabs. Com a chave, a transcrição também passa a ser da ElevenLabs.

## Memória

Ela guarda duas coisas, em arquivos de texto que você pode abrir e editar:

- `D:\AuroraMemoria\memoria.md` — as anotações. Cada linha é uma anotação com um número, como `- [#3] 2026-10-13 10:41 — A reunião com o fornecedor é sexta às 10.`
- `D:\AuroraMemoria\conversas\AAAA-MM-DD.md` — todas as conversas, um arquivo por dia.

Tudo é copiado na hora para `E:\AuroraMemoria`. Se um dos discos falhar, nada se perde: quando a AURORA liga, ela compara as duas pastas e recupera o que estiver faltando ou mais antigo.

Quando ela liga, já começa sabendo as anotações e as últimas conversas. Para o resto:

- "Ei Aurora, **lembre que** o fornecedor de cabos é a Elétrica Silva."
- "**O que você lembra sobre** o fornecedor?"
- "**Esqueça** a anotação três."

Ela se recusa a guardar senhas, chaves ou sementes de carteira.

**Privacidade:** tudo o que é dito a ela fica gravado em texto nessas pastas. Para não gravar nada, ponha `AURORA_MEMORY=off` no `.env.local`.

Se o computador não tiver o disco D:, a memória vai para `C:\Users\<seu usuário>\AuroraMemoria`. Os caminhos podem ser trocados no `.env.local` (veja "Configuração").

## Ações: por que ela às vezes diz que não pode

Por padrão a AURORA **olha tudo e não muda nada**: pode pesquisar, ler páginas, ler arquivos, analisar com o REA e consultar o Cápsula, mas não pode apagar arquivos, rodar comandos, clicar e digitar no navegador, instalar coisas no celular etc. Para liberar as ações:

```powershell
npm start -- --writes
```

Para liberar também quando ela liga sozinha com o Windows, ponha `AURORA_ALLOW_WRITES=1` no `.env.local`.

## Chrome

Com a extensão Claude ativa no Chrome, ela usa o seu navegador de verdade, já logado nos seus sites, e mostra o resultado na interface. No Windows ela se conecta direto ao canal da extensão (`\\.\pipe\claude-mcp-browser-bridge-<usuário>`). Se o Chrome estiver fechado, ela avisa e segue sem o navegador.

A janela da própria AURORA é outro perfil do Chrome, separado do seu: o que ela abre ali não mexe nas suas abas.

## REA (engenharia reversa)

Depois do `npx rea-agents setup`, o REA fica registrado no Claude Code e a AURORA o encontra sozinha na próxima vez que ligar.

- "Ei Aurora, analise o programa em `E:\AuroraArquivos\app.exe` e me diga o que ele faz."
- "Que bibliotecas esse APK usa?"

As ferramentas de leitura e análise estática do REA ficam liberadas (125 na versão 6.4). As que executam, se conectam a programas ou aparelhos, instalam ou gravam arquivos (45) só funcionam com `--writes`, e o mesmo vale para qualquer ferramenta nova que uma versão futura do REA trouxer. Resultados grandes ficam em `E:\AuroraArquivos`.

Use só em software seu ou que você tenha autorização para analisar.

## Cápsula

Se existir a pasta `C:\Users\<seu usuário>\.capsula`, a AURORA ganha quatro consultas, todas **só de leitura**:

- "Como está o meu nó do Cápsula?" — endereço, armazenamento, tamanho da cadeia, pares, casos, preço.
- "O que aconteceu nos últimos blocos?"
- "Quais casos estão selados?"
- "**A cadeia do Cápsula está íntegra?**" — recalcula o hash de cada bloco e a raiz de Merkle dos eventos, confere a ligação com o bloco anterior e o registro do topo.

Ela **nunca** abre `wallet.seed`, a chave de assinatura, `sign_tokens` nem nada da carteira: só lê uma lista fechada de arquivos (configuração do nó, ledger, pares, índice de casos, preço).

## Configuração (`.env.local`)

Copie `.env.example` para `.env.local` e descomente só o que quiser mudar. A ponte, a página e o lançador leem o mesmo arquivo.

| Variável | Padrão | Para quê |
|---|---|---|
| `AURORA_LANG` e `VITE_LANG` | `pt-BR` | idioma (os dois iguais); `en-GB` fala inglês britânico |
| `AURORA_MEMORY_DIR` | `D:\AuroraMemoria` | onde fica a memória |
| `AURORA_MEMORY_BACKUP` | `E:\AuroraMemoria` | a cópia; vazio desliga a cópia |
| `AURORA_MEMORY` | ligado | `off` desliga a memória |
| `AURORA_FILES_DIR` | `E:\AuroraArquivos` | arquivos grandes |
| `AURORA_ALLOW_WRITES` | desligado | `1` libera as ações também no início automático |
| `AURORA_NAVEGADOR` | Chrome, ou Edge | o navegador da janela da AURORA |
| `CAPSULA_DIR` | `C:\Users\<você>\.capsula` | pasta do nó Cápsula |
| `AURORA_MODEL` | `claude-opus-5` | modelo; um modelo Sonnet responde mais rápido |
| `ELEVENLABS_API_KEY` | — | voz e transcrição melhores |
| `AURORA_VOICE_ID` | Alice | voz da ElevenLabs |

## Problemas comuns

- **A janela não abriu no login**: veja `C:\Aurora\logs\aurora.log`. O motivo mais comum é o `npm install` não ter sido feito, ou o Node ter sido reinstalado em outro lugar; rode `npm run inicio-automatico` de novo.
- **Ela abriu, mas mostra o botão INICIALIZAR**: a janela foi aberta por outro caminho. Clique no botão, ou abra pelo atalho **Aurora**.
- **"A ponte não responde"**: a ponte não está rodando. Abra pelo atalho, ou rode `npm start` no PowerShell.
- **Ela não me ouve**: aperte D. Se aparecer "não estou ouvindo você", confira a permissão do microfone no cadeado da barra de endereço.
- **Ela fala com sotaque inglês**: instale a voz Português (Brasil) do Windows (veja "A voz").
- **Ela não entende "Ei Aurora"**: também dá para apertar Espaço e falar direto.
- **O REA demora na primeira vez**: o `npx` baixa o REA na primeira chamada.

## Créditos

Baseada no [JARVIS do Aditya Dewaskar](https://github.com/adewaskar/jarvis), licença MIT (arquivo `LICENSE`), que fez a interface, a ponte com o Claude Code e o laço de voz. Esta versão mantém a mesma licença. Música de Kevin MacLeod, CC BY 4.0 ([créditos](public/audio/CREDITS.md)). Engenharia reversa pelo [REA](https://github.com/morluto/rea).
