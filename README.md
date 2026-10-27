# Cineminha

Transmita sua tela para até 4 amigos direto do navegador, com áudio e chat ao vivo. Sem instalar nada: a conexão é ponto a ponto (WebRTC via PeerJS) e o site é estático, hospedado no GitHub Pages.

**Acesse:** https://geraldogg77.github.io/cineminha/

## Como usar

1. Abra o site, escolha um apelido e clique em **Criar minha sala**. Quem cria a sala é o anfitrião: a aba dele precisa ficar aberta para a sala funcionar.
2. Copie o link e envie. Quem abrir o link entra na sala.
3. Cada pessoa aparece num quadrado com a foto no meio. Quem clica em **Transmitir minha tela** (botão com a tela, na barra embaixo) passa a mostrar a tela no próprio quadrado. Várias pessoas podem transmitir ao mesmo tempo.
4. A **câmera** (na barra embaixo ou no menu do seu perfil) aparece no seu quadrado. Se você também transmitir a tela, a câmera vira uma janelinha no canto.
5. Clique num quadrado para ampliar; os outros ficam numa fileira embaixo. Clique de novo ou aperte Esc para voltar à grade. Dois cliques abrem em tela cheia.

As telas que não estão ampliadas chegam em qualidade mais leve, para não pesar no upload de quem transmite.

A foto de perfil aceita imagem ou GIF animado de até 15 MB. O GIF fica parado no primeiro quadro e só se mexe enquanto a pessoa está falando, como no Discord. Ela fica salva no seu navegador; na sala, cada pessoa recebe a foto uma vez só, em pedaços e sem atrasar o chat, e guarda para as próximas visitas.

Funciona melhor no Chrome ou Edge no computador. Quem assiste pode usar qualquer navegador, inclusive no celular.

## Webcam

Em **Configurações → Transmissão → Fonte do vídeo**, escolha **Webcam** para transmitir a câmera em vez da tela (e a câmera, se tiver mais de uma). Ela usa a mesma resolução, taxa de quadros e taxa de bits das configurações, sempre priorizando a fluidez. Se a câmera não entregar o que foi pedido, o site avisa o que ela está entregando. A voz vai pelo microfone da sala (tecla V). A escolha vale a partir da próxima transmissão.

## Voz na sala

Ligue o **Microfone** (botão de microfone ou tecla V) e todos na sala ouvem você, transmitindo a tela ou não, como num canal de voz. Quem está falando ganha um anel verde no avatar. Em **Configurações → Transmissão → Saída de áudio** você escolhe onde ouvir as vozes e as telas, por exemplo o seu headset, e pode tocar um som de teste. O botão de fone (tecla D) desliga todo o som da sala para você.

## Áudio da transmissão

No mixer (botão de controles deslizantes ou **Configurações → Transmissão**), cada fonte tem liga/desliga, volume e medidor:

- **Som da tela**: o áudio que o navegador captura junto com a tela ou aba. Para levar o som, marque a opção de compartilhar áudio na janela de escolha da tela.
- **Entrada extra**: qualquer dispositivo de entrada de áudio, como um cabo virtual.

### Cineminha Áudio (escolher apps no Windows)

O navegador sozinho não separa o som de cada programa. Para escolher app por app, como na lista de compartilhamento do Discord, existe o **Cineminha Áudio**: um programa de 650 KB para Windows 10 e 11, sem instalação, que fica na bandeja perto do relógio.

1. No mixer, clique em **Baixar Cineminha Áudio** e abra o arquivo. Como o programa não tem assinatura digital paga, o Windows pode avisar que protegeu o computador: clique em **Mais informações** › **Executar assim mesmo**.
2. O site conecta sozinho e mostra os apps que estão tocando som. Todo app novo começa **desmarcado**: marque só os que devem entrar na transmissão e deixe o **Som da tela** desligado, porque ele leva o som do computador inteiro.
   O Windows captura um app junto com os programas que ele abriu: o Steam, por exemplo, leva junto os jogos abertos por ele. Quando isso acontece, a lista mostra "Leva junto" embaixo do app.
3. Se o navegador pedir acesso a dispositivos da rede local, clique em **Permitir**: é assim que a página conversa com o programa no seu computador.

**Limites do Windows que nenhum programa contorna** (o OBS tem os mesmos): o som é separado por processo, não por aba. Se o filme e a sala estiverem no mesmo navegador, o som da sala volta para a transmissão (eco). Para evitar:

- **Melhor:** compartilhe a **guia** do filme e marque “Compartilhar áudio da guia”. O navegador entrega só o som dessa guia e o Cineminha usa esse som automaticamente.
- Ou abra a sala em um navegador e o filme em outro (por exemplo, a sala no Edge e o filme no Chrome): aí cada um aparece como um app na lista.
- Alguns programas, como o Microsoft Teams, não deixam o Windows separar o som deles; use o VB-CABLE nesses casos.

Na lista de apps há uma linha de **Diagnóstico** que mostra, enquanto você transmite, quantos pacotes de som chegam do programa por segundo e o pico do som. Se aparecer “silêncio”, o programa não está captando nada daquele app; se mostrar som mas o amigo não ouvir, o problema está depois, no navegador ou na rede.

Marcar e desmarcar um app não recria a captura: ele fica em silêncio por 20 segundos e depois fecha, então ligar de novo é instantâneo. Se uma captura cair, o programa a refaz sozinho. A captura vale para o processo principal do app (como no OBS), então ela não se perde quando o Chrome ou o Discord recriam o processo que toca o som. A marcação que aparece no site é a que vale: se o programa estiver com outro valor, o site corrige.

O programa só captura enquanto você transmite, só aceita conexões do próprio computador vindas do site do Cineminha e não envia nada para a internet: quem manda o som para a sala é o navegador. O código está em `helper/` e o arquivo pronto em `download/`. O `.exe` é gerado sozinho pelo GitHub (aba **Actions** › **Compilar Cineminha Áudio**) sempre que algo em `helper/` muda. Para gerar na sua máquina: `cd helper && cargo zigbuild --release --target x86_64-pc-windows-gnu`.

Sem o Cineminha Áudio também dá: instale o VB-CABLE (gratuito), mande a saída desses apps para **CABLE Input** no Mixer de volume do Windows e escolha **CABLE Output** na entrada extra. O passo a passo completo está dentro do mixer.

## Atalhos

| Tecla | Ação |
| --- | --- |
| F | Tela cheia |
| T | Modo cinema |
| C | Mostrar ou ocultar o chat |
| S | Estatísticas da conexão |
| M | Som de quem você assiste |
| V | Ligar ou desligar seu microfone |
| D | Ligar ou desligar o som da sala |
| Esc | Voltar à grade |
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
- `helper/`: código do Cineminha Áudio (Rust); `download/`: o programa pronto.

Ao publicar uma versão nova, aumente o número em `styles.css?v=` e `app.js?v=` no `index.html` para os navegadores não usarem arquivos antigos do cache.
