# Ordem Tracker

Acompanhe em tempo real a audiência das lives de **Ordem Paranormal**, somando YouTube, Twitch, Kick e TikTok em um só lugar.

É um projeto de fãs do Realitas News, sem qualquer vínculo oficial com o Cellbit ou com a Ordem Paranormal.

🔗 **https://ordemtracker.site**

## Funcionalidades

- Leitura da audiência de cada plataforma a cada 10 segundos, com histórico completo de cada episódio.
- Total ao vivo, recorde, picos por plataforma, gráfico da transmissão, média, duração e horas assistidas.
- Contagem regressiva para o próximo episódio quando não há live no ar.
- Página própria para cada episódio, com as métricas de transmissões anteriores.
- Imagem de compartilhamento nos formatos horizontal e vertical.
- Painel privado para cadastrar episódios, definir a tela inicial e acompanhar os acessos ao site.

## Estrutura do projeto

```
server.js            servidor: coleta dos dados, API, painel e arquivos estáticos
public/              páginas e imagens servidas ao navegador
  index.html         página principal
  admin.html         painel de administração
  privacidade.html   política de privacidade
  icones/            logos das plataformas
  temporadas/        artes de prévia de cada temporada
dados/               criada durante o uso e ignorada pelo Git
Dockerfile
docker-compose.yml   aplicação + HTTPS automático com Caddy
Caddyfile
.env.exemplo         modelo das variáveis de ambiente
```

## Como rodar localmente

Requisito: **Node.js 22** ou superior. O projeto não tem dependências externas.

```bash
cp .env.exemplo .env   # preencha com as suas chaves
node server.js         # disponível em http://localhost:3030
```

## Variáveis de ambiente

| Variável | Finalidade |
|---|---|
| `YOUTUBE_API_KEY` | Chave da YouTube Data API v3 |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Credenciais da API Helix da Twitch |
| `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | Credenciais da API pública da Kick |
| `TIKTOK_CANAL` | Canal do TikTok (deixe vazio para desativar) |
| `ADMIN_SENHA` | Senha de acesso ao painel |
| `ADMIN_CAMINHO` | Endereço do painel, iniciado por `/` e com pelo menos 12 caracteres |
| `PORT`, `DATA_DIR` | Opcionais: porta do servidor e pasta dos dados |

Se a chave de alguma plataforma não for informada, ela simplesmente fica de fora da contagem.

## Publicação

Em um servidor com Docker instalado:

```bash
docker compose up -d --build
```

O Caddy emite o certificado HTTPS automaticamente para o domínio configurado no `Caddyfile`. Os dados ficam salvos em `./dados`.

## Cadastro de episódios

No painel, basta colar o link da live agendada no YouTube: título, data e capa são preenchidos automaticamente.
Também é possível cadastrar um episódio apenas com título e data e adicionar o link depois.
Lives do canal com "EPISÓDIO N … Ordem Paranormal" no título são reconhecidas sem cadastro.

## Fontes e créditos

- Dados: YouTube Data API v3, API Helix da Twitch, API pública da Kick e o contador público da live no TikTok.
- Logos das plataformas: Wikimedia Commons, Dashboard Icons (Apache 2.0) e FreePNGLogo.
- Ícones da interface: Lucide (ISC). Fontes: Inter e Inter Tight (OFL). Gráficos: Chart.js (MIT).
- Ordem Paranormal, suas logos, capas e artes pertencem ao Cellbit e aos artistas responsáveis.

## Como contribuir

Contribuições são muito bem-vindas! Leia o [guia de contribuição](CONTRIBUTING.md) antes de abrir uma issue ou um pull request.
Encontrou uma falha de segurança? Siga as orientações da [política de segurança](SECURITY.md).

## Licença

O código está sob a licença [MIT](LICENSE). Logos e artes não fazem parte da licença e continuam pertencendo aos seus respectivos donos.
