# Cineminha

Transmita sua tela para até 4 amigos direto do navegador, com áudio e chat ao vivo. Sem instalar nada: a conexão é ponto a ponto (WebRTC via PeerJS) e o site é estático, hospedado no GitHub Pages.

**Acesse:** https://geraldogg77.github.io/cineminha/

## Como usar

1. Abra o site, escolha um apelido e clique em **Criar minha sala**.
2. Clique em **Iniciar transmissão** e escolha a tela, janela ou aba. Para levar o som, marque a opção de compartilhar áudio.
3. Copie o convite e envie. Quem abrir o link entra como espectador.

Mantenha a aba do anfitrião aberta durante a transmissão. Funciona melhor no Chrome ou Edge no computador.

## Atalhos

| Tecla | Ação |
| --- | --- |
| F | Tela cheia |
| T | Modo cinema |
| C | Mostrar ou ocultar o chat |
| S | Estatísticas da conexão |
| M | Som (espectador) |
| P | Pausar a imagem (anfitrião) |

## Arquivos

- `index.html`: estrutura da página e ícones.
- `styles.css`: sistema visual (temas, componentes, animações).
- `app.js`: transmissão, chat, configurações e componentes de interface.

Ao publicar uma versão nova, aumente o número em `styles.css?v=` e `app.js?v=` no `index.html` para os navegadores não usarem arquivos antigos do cache.
