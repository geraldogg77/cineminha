# Cineminha

Transmita sua tela para até 4 amigos direto do navegador, com áudio e chat ao vivo. Sem instalar nada: a conexão é ponto a ponto (WebRTC via PeerJS) e o site é estático, hospedado no GitHub Pages.

**Acesse:** https://geraldogg77.github.io/cineminha/

## Como usar

1. Abra o site, escolha um apelido e clique em **Criar minha sala**. Quem cria a sala é o anfitrião: a aba dele precisa ficar aberta para a sala funcionar.
2. Copie o link e envie. Quem abrir o link entra na sala.
3. Qualquer pessoa pode clicar em **Transmitir minha tela**. Várias pessoas podem transmitir ao mesmo tempo, e cada uma escolhe qual tela assistir pelas abas acima do vídeo ou pela lista de pessoas.

Funciona melhor no Chrome ou Edge no computador. Quem assiste pode usar qualquer navegador, inclusive no celular.

## Áudio da transmissão

No mixer (botão de controles deslizantes ou **Configurações → Transmissão**), cada fonte tem liga/desliga, volume e medidor:

- **Som da tela**: o áudio que o navegador captura junto com a tela ou aba. Para levar o som, marque a opção de compartilhar áudio na janela de escolha da tela.
- **Microfone**: sua voz para quem assiste sua tela. Também liga e desliga pelo botão de microfone ou pela tecla V.
- **Entrada extra**: qualquer dispositivo de entrada de áudio, como um cabo virtual.

O navegador não consegue separar o som de cada programa. Para transmitir só alguns apps, instale o VB-CABLE (gratuito), mande a saída desses apps para **CABLE Input** no Mixer de volume do Windows e escolha **CABLE Output** na entrada extra. O passo a passo completo está dentro do mixer.

## Atalhos

| Tecla | Ação |
| --- | --- |
| F | Tela cheia |
| T | Modo cinema |
| C | Mostrar ou ocultar o chat |
| S | Estatísticas da conexão |
| M | Som de quem você assiste |
| V | Ligar ou desligar seu microfone |
| P | Pausar sua imagem |

## Servidor TURN (Cloudflare)

Quando dois navegadores não conseguem se conectar direto (comum em 4G e em redes com IP compartilhado), o vídeo passa por um servidor TURN. O Cineminha usa o TURN da Cloudflare através de um Worker que gera credenciais temporárias, porque o site é público e não pode guardar a chave. Sem o Worker configurado, o site usa o servidor público gratuito do Open Relay, que é instável.

Custo: os primeiros 1.000 GB por mês são gratuitos; depois, US$ 0,05 por GB.

1. No painel da Cloudflare, abra **Realtime** (ou **Calls**) → **TURN Server** e crie uma chave. Guarde o **Token ID** e o **API Token**.
2. Em **Workers & Pages** → **Create** → **Worker**, dê o nome `cineminha-turn`, publique, clique em **Edit code**, cole o conteúdo de `worker/turn.js` e publique de novo.
3. No Worker, em **Settings** → **Variables and Secrets**, adicione dois segredos (tipo *Secret*): `TURN_KEY_ID` com o Token ID e `TURN_KEY_API_TOKEN` com o API Token.
4. Abra `https://cineminha-turn.SEU-SUBDOMINIO.workers.dev` no navegador. A resposta esperada é `Origem não autorizada.` (o Worker só responde ao site).
5. Coloque esse endereço em `TURN_URL`, no topo do `app.js`, e aumente a versão dos arquivos no `index.html`.

Para confirmar, transmita e abra as estatísticas (S): uma conexão intermediada aparece como `via Cloudflare`.

Pelo terminal, o passo 2 e 3 equivalem a `cd worker && npx wrangler deploy && npx wrangler secret put TURN_KEY_ID && npx wrangler secret put TURN_KEY_API_TOKEN`.

## Arquivos

- `index.html`: estrutura da página e ícones.
- `styles.css`: sistema visual (temas, componentes, animações).
- `app.js`: transmissão, chat, configurações e componentes de interface.
- `worker/`: Worker da Cloudflare que gera as credenciais TURN.

Ao publicar uma versão nova, aumente o número em `styles.css?v=` e `app.js?v=` no `index.html` para os navegadores não usarem arquivos antigos do cache.
