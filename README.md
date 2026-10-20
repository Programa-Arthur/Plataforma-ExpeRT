https://plataforma-expert-fron-end.vercel.app/admin.html
# Plataforma ExpeRT — site e back-end

Site institucional da Plataforma ExpeRT (Instituto Federal Catarinense —
Campus Sombrio) e o back-end que o sustenta.

## Onde cada parte roda

| Parte | Onde | Observação |
|---|---|---|
| Site (HTML/CSS/imagens) | **Vercel** (pasta `fron-end/`) | Estático, com rewrite para a API |
| API (login, cadastro, painel, downloads) | **Supabase Edge Function** (`supabase/functions/app`) | Runtime Deno, deploy sem Docker |
| Identidade (login/senha) | **Supabase Auth** | JWT em cookie `HttpOnly` |
| Perfis de usuário e contador de downloads | **MongoDB Atlas** (base `ExpeRT`) | Coleções `users` e `downloadStats` |

Por que o site não fica na Supabase: a plataforma força
`Content-Type: text/plain` e uma CSP restritiva em qualquer resposta HTML
(tanto em Edge Functions quanto em buckets do Storage) — uma proteção
anti-XSS. Páginas HTML, portanto, só podem ser servidas por um host
estático como o Vercel. O `vercel.json` faz o proxy transparentemente:
o navegador chama `/api/...` no domínio do site e a Vercel encaminha para
a Edge Function, mantendo site e API na mesma origem (sem CORS, cookie
`SameSite=Lax` funciona).

## Estrutura

```
beck-end/            servidor Node (uso local; faz proxy para a Edge Function)
fron-end/            site estático publicado no Vercel
supabase/
  config.toml        configuração do projeto Supabase
  functions/app/     Edge Function (back-end de produção)
scripts/
  build-static.mjs   (removido — o site não é mais empacotado na function)
  deploy-function.py deploy da Edge Function pela Management API
  test-function.sh   teste local da Edge Function (sem Docker)
vercel.json          rewrites /api/* e /download/* para a Supabase
```

## Rodando o site localmente

```bash
# terminal 1 — o back-end real, na Supabase
node beck-end/login.js      # http://localhost:3000

# o servidor local serve o site e encaminha /api/* e /download/*
# para a Edge Function implantada
```

Para testar a implementação antiga (MongoDB + scrypt) que mora no mesmo
arquivo:

```bash
LEGACY_BACKEND=1 node beck-end/login.js
```

## Testando a Edge Function localmente (sem Docker)

```bash
# secrets locais (não versionar)
cp supabase/.env.production.example supabase/.env.production

node scripts/test-function.sh
```

O script sobe a function com o Deno e exercita as rotas: health, login,
cadastro, sessão, painel administrativo e downloads.

## Implantação

### 1. Secrets da Edge Function

```bash
npx supabase secrets set \
  --project-ref xoacnxclwytocrubapap \
  --env-file supabase/.env.production
```

| Secret | Para quê |
|---|---|
| `MONGODB_URI` | Conexão com o MongoDB Atlas |
| `MONGODB_DATABASE` | Nome da base (`ExpeRT`) |
| `MONGODB_USERS_COLLECTION` | Coleção de perfis (`users`) |
| `ADMIN_PASSWORD` | Senha do painel administrativo |
| `ADMIN_SESSION_SECRET` | Chave do token de assinatura do painel |
| `SITE_ORIGIN` | (opcional) origem autorizada no CORS |
| `SITE_URL` | (opcional) endereço do site, usado no redirect da raiz |

### 2. Edge Function

```bash
python3 scripts/deploy-function.py
```

O script usa a Management API (sem Docker). O token vem de
`SUPABASE_ACCESS_TOKEN` ou da credencial OAuth do MCP do OpenCode.

### 3. Site no Vercel

1. Importe o repositório no Vercel
2. Defina **Root Directory** = `fron-end`
3. Mantenha o `vercel.json` da raiz do repositório (os rewrites valem
   para toda a publicação)

## Rotas da API

| Rota | Método | Descrição |
|---|---|---|
| `/api/login` | POST | Autentica e devolve o cookie de sessão |
| `/api/register` | POST | Cria a conta no Supabase Auth e o perfil no MongoDB |
| `/api/session` | GET | Informa a sessão atual (401 quando não há sessão) |
| `/api/admin/login` | POST | Token do painel administrativo (8 h) |
| `/api/admin/users` | GET | Lista de usuários e contador de downloads |
| `/api/health` | GET | Estado da API e da conexão com o banco |
| `/download/project` | GET | Redireciona para o repositório e conta o clique |
| `/download/installer` | GET | Redireciona para o instalador da plataforma |
| `/download/source` | GET | Código-fonte em ZIP (exige sessão) |

## Segurança

- A senha do MongoDB **não** fica no repositório: use
  `supabase/.env.production` (ignorado pelo git) e a Management API.
  O arquivo antigo `beck-end/atlas-credentials.env` saiu do versionamento
  — **troque a senha no Atlas**, pois ela ficou exposta no histórico.
- O painel administrativo usa token JWT assinado (HS256), sem estado em
  memória — funciona em ambiente serverless.
- As senhas de usuários ficam no Supabase Auth (bcrypt); o MongoDB guarda
  apenas o perfil (nome, e-mail, tipo, instituição).
- O tutorial e o código-fonte exigem sessão; a verificação do tutorial é
  feita no navegador, porque a página é estática.
