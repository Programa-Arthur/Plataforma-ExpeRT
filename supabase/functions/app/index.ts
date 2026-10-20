// ======================================================
// PLATAFORMA EXPERT — EDGE FUNCTION (Deno / Supabase)
// ======================================================
//
// Back-end da Plataforma ExpeRT na Supabase.
//
//   Identidade ....... Supabase Auth (JWT em cookie HttpOnly)
//   Dados ............ MongoDB Atlas (coleções users e downloadStats)
//   Sessões .......... JWT stateless (funciona em serverless)
//
// O front-end é publicado no Vercel e usa um rewrite que
// encaminha /api/* e /download/* para esta function, de modo que
// site e API continuem na mesma origem.
//
// ======================================================

import { randomBytes } from "node:crypto";
import { MongoClient } from "npm:mongodb@6";
import { createClient } from "npm:@supabase/supabase-js@2";


// ======================================================
// CONFIGURAÇÕES DO PROJETO
// ======================================================

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? "";

const MONGODB_URI =
  Deno.env.get("MONGODB_URI") ?? "";

const MONGODB_DATABASE =
  Deno.env.get("MONGODB_DATABASE") ?? "ExpeRT";

const MONGODB_USERS_COLLECTION =
  Deno.env.get("MONGODB_USERS_COLLECTION") ?? "users";

const ADMIN_PASSWORD =
  Deno.env.get("ADMIN_PASSWORD") ?? "";

const ADMIN_SESSION_SECRET =
  Deno.env.get("ADMIN_SESSION_SECRET") ?? "";

// Origem autorizada do front-end (usada no CORS). Vazio
// significa "qualquer origem" — o acesso é protegido pela
// sessão (cookie HttpOnly) e pela validação do token.
const SITE_ORIGIN =
  Deno.env.get("SITE_ORIGIN") ?? "";

// Endereço público do site (usado no redirecionamento da raiz).
const SITE_URL =
  Deno.env.get("SITE_URL") ?? "";

// Repositório da Plataforma ExpeRT (aplicativo desktop).
// Usado para servir as imagens e o código-fonte do projeto.
const PLATFORM_REPO =
  Deno.env.get("PLATFORM_REPO") ?? "bs-laurao/plataforma-expert";

const PLATFORM_BRANCH =
  Deno.env.get("PLATFORM_BRANCH") ?? "main";

// Duração da sessão do usuário (8 horas), igual à versão anterior.
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

const USER_TYPES = ["docente", "discente", "outro"];


// ======================================================
// CHAVES DE API
// ======================================================

// O runtime injeta as chaves legadas (anon e service_role) e,
// em projetos novos, as chaves publicadas (sb_publishable_...)
// e secretas (sb_secret_...). Esta function aceita qualquer uma
// das duas formas.
function readApiKeys(
  variable
) {

  const direct =
    Deno.env.get(variable);

  if (direct) {
    return direct;
  }

  const listName =
    variable === "SUPABASE_PUBLISHABLE_KEY"
      ? "SUPABASE_PUBLISHABLE_KEYS"
      : "SUPABASE_SECRET_KEYS";

  const list =
    Deno.env.get(listName);

  if (!list) {
    return "";
  }

  try {

    const parsed = JSON.parse(list);
    const entries =
      Array.isArray(parsed)
        ? parsed
        : [parsed];

    for (const entry of entries) {

      const key =
        typeof entry === 'string'
          ? entry
          : entry?.api_key;

      if (key) {
        return key;
      }

    }

  } catch {
    // Lista em formato inesperado: segue sem chave.
  }

  return "";

}

const PUBLISHABLE_KEY =
  readApiKeys("SUPABASE_PUBLISHABLE_KEY") ||
  readApiKeys("SUPABASE_ANON_KEY");

const SECRET_KEY =
  readApiKeys("SUPABASE_SECRET_KEY") ||
  readApiKeys("SUPABASE_SERVICE_ROLE_KEY");


// ======================================================
// CLIENTES (SUPABASE AUTH + MONGODB)
// ======================================================

// Cliente público: login de usuários.
const authClient = createClient(
  SUPABASE_URL,
  PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

// Cliente privilegiado: criação de contas e validação de tokens.
const adminClient = SECRET_KEY
  ? createClient(
      SUPABASE_URL,
      SECRET_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    )
  : null;

// Uma única conexão com o MongoDB por instância da function.
let mongoClient = null;
let mongoDatabase = null;

function database() {

  if (!mongoDatabase) {

    if (!MONGODB_URI) {
      throw new Error(
        'Defina o secret MONGODB_URI antes de iniciar a function.'
      );
    }

    mongoClient = new MongoClient(MONGODB_URI);
    mongoDatabase = mongoClient.db(MONGODB_DATABASE);

  }

  return mongoDatabase;

}

const usersCollection = () =>
  database().collection(MONGODB_USERS_COLLECTION);

const downloadStatsCollection = () =>
  database().collection('downloadStats');


// ======================================================
// CORS
// ======================================================

function corsHeaders(
  request
) {

  const origin =
    request.headers.get('origin');

  if (!origin) {
    return {};
  }

  const allowed =
    !SITE_ORIGIN || origin === SITE_ORIGIN;

  if (!allowed) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods':
      'GET, POST, OPTIONS',
    'Vary': 'Origin'
  };

}


// ======================================================
// ENVIAR JSON
// ======================================================

function sendJson(
  request,
  statusCode,
  body,
  headers = {}
) {

  return new Response(
    JSON.stringify(body),
    {
      status: statusCode,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',
        ...corsHeaders(request),
        ...headers
      }
    }
  );

}


// ======================================================
// LER JSON ENVIADO PELO FRONT-END
// ======================================================

async function readJsonBody(
  request
) {

  const raw = await request.text();

  if (raw.length > 10_000) {
    throw new Error(
      'O corpo da requisição é muito grande.'
    );
  }

  try {

    return JSON.parse(raw || '{}');

  } catch {

    throw new Error(
      'Envie os dados em JSON válido.'
    );

  }

}


// ======================================================
// COOKIES
// ======================================================

function readCookie(
  request,
  name
) {

  const header =
    request.headers.get('cookie') ?? '';

  const part =
    header
      .split(';')
      .map((item) => item.trim())
      .find((item) =>
        item.startsWith(`${name}=`)
      );

  return part
    ? decodeURIComponent(
        part.slice(name.length + 1)
      )
    : null;

}

function sessionCookies(
  session
) {

  const secure = '; Secure';

  return [
    `expert_session=${encodeURIComponent(session.access_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${secure}`,
    `expert_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${secure}`
  ];

}


// ======================================================
// TOKEN ADMINISTRATIVO (JWT HS256, SEM ESTADO)
// ======================================================

function base64UrlEncode(
  value
) {

  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value;

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

}

function base64UrlDecodeToBytes(
  value
) {

  const padded =
    value.replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(
        Math.ceil(value.length / 4) * 4,
        '='
      );

  const binary =
    atob(padded);

  return Uint8Array.from(
    binary,
    (character) =>
      character.charCodeAt(0)
  );

}

function base64UrlDecode(
  value
) {

  return new TextDecoder().decode(
    base64UrlDecodeToBytes(value)
  );

}

async function hmacKey() {

  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(
      ADMIN_SESSION_SECRET
    ),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign', 'verify']
  );

}

async function signAdminToken() {

  const header = base64UrlEncode(
    JSON.stringify({
      alg: 'HS256',
      typ: 'JWT'
    })
  );

  const payload = base64UrlEncode(
    JSON.stringify({
      role: 'admin',
      exp: Math.floor(
        Date.now() / 1000
      ) + SESSION_DURATION_SECONDS
    })
  );

  const data = `${header}.${payload}`;

  const signature =
    await crypto.subtle.sign(
      'HMAC',
      await hmacKey(),
      new TextEncoder().encode(data)
    );

  return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;

}

async function verifyAdminToken(
  token
) {

  if (!token || !ADMIN_SESSION_SECRET) {
    return false;
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return false;
  }

  const data = `${parts[0]}.${parts[1]}`;

  let valid = false;

  try {

    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      base64UrlDecodeToBytes(parts[2]),
      new TextEncoder().encode(data)
    );

  } catch {
    return false;
  }

  if (!valid) {
    return false;
  }

  try {

    const payload =
      JSON.parse(
        base64UrlDecode(parts[1])
      );

    return (
      payload.role === 'admin' &&
      payload.exp > Math.floor(Date.now() / 1000)
    );

  } catch {
    return false;
  }

}


// ======================================================
// SESSÃO DO USUÁRIO (SUPABASE AUTH)
// ======================================================

// Valida o cookie de sessão. Quando o token de acesso expirou,
// tenta renová-lo com o refresh token e devolve os cookies novos.
async function resolveSession(
  request
) {

  const accessToken =
    readCookie(request, 'expert_session');

  const refreshToken =
    readCookie(request, 'expert_refresh');

  if (accessToken && adminClient) {

    const { data, error } =
      await adminClient.auth.getUser(accessToken);

    if (!error && data?.user) {
      return {
        user: data.user,
        cookies: []
      };
    }

  }

  if (refreshToken) {

    const { data, error } =
      await authClient.auth.refreshSession({
        refresh_token: refreshToken
      });

    if (!error && data?.session?.user) {
      return {
        user: data.session.user,
        cookies: sessionCookies(data.session)
      };
    }

  }

  return null;

}

// Perfil da pessoa usuária (mantido no MongoDB).
async function findProfile(
  email
) {

  return await usersCollection().findOne(
    {
      email: {
        $regex:
          '^' +
          escapeRegExp(email) +
          '$',

        $options: 'i'
      }
    },
    {
      projection: {
        name: 1,
        email: 1,
        type: 1,
        institution: 1
      }
    }
  );

}

// Monta a resposta com os dados da pessoa usuária.
async function publicUser(
  user
) {

  const profile =
    await findProfile(
      user.email ?? ''
    );

  return {
    nome:
      profile?.name ??
      user.user_metadata?.name ??
      null,

    email:
      profile?.email ??
      user.email ??
      null,

    tipo:
      profile?.type || 'discente',

    instituicao:
      profile?.institution || {
        linked: false,
        name: null
      }
  };

}


// ======================================================
// PROTEGER REGEX DO E-MAIL
// ======================================================

function escapeRegExp(
  value
) {

  return value.replace(
    /[\\^$.*+?()[\]{}|]/g,
    '\\$&'
  );

}


// ======================================================
// TIPOS DE USUÁRIO
// ======================================================

function normalizeType(
  type
) {

  return USER_TYPES.includes(type)
    ? type
    : '';

}


// ======================================================
// LOGIN
// ======================================================

async function login(
  request
) {

  try {

    const {
      email,
      password,
      type
    } = await readJsonBody(request);

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !normalizeType(type) ||
      !email.trim() ||
      !password
    ) {

      return sendJson(request, 400, {
        sucesso: false,
        mensagem:
          'Informe e-mail e senha.'
      });

    }

    const normalizedEmail =
      email.trim().toLowerCase();

    // Autenticação no Supabase Auth.
    const { data, error } =
      await authClient.auth.signInWithPassword({
        email: normalizedEmail,
        password
      });

    if (error || !data?.session) {

      return sendJson(request, 401, {
        sucesso: false,
        mensagem:
          'E-mail, senha ou tipo de usuário inválidos.'
      });

    }

    // O tipo escolhido no formulário precisa bater com o cadastro.
    const profile =
      await findProfile(normalizedEmail);

    const profileType =
      profile?.type || 'discente';

    if (profileType !== type) {

      return sendJson(request, 401, {
        sucesso: false,
        mensagem:
          'E-mail, senha ou tipo de usuário inválidos.'
      });

    }

    return sendJson(
      request,
      200,
      {
        sucesso: true,
        usuario: await publicUser(data.user)
      },
      {
        'Set-Cookie': sessionCookies(data.session)
      }
    );

  } catch (error) {

    console.error(
      'Falha no login:',
      error.message
    );

    return sendJson(request, 500, {
      sucesso: false,
      mensagem:
        'Não foi possível validar o acesso agora.'
    });

  }

}


// ======================================================
// CADASTRO
// ======================================================

async function register(
  request
) {

  try {

    const {
      name,
      email,
      password,
      type,
      institution
    } = await readJsonBody(request);

    const normalizedEmail =
      typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';

    const normalizedName =
      typeof name === 'string'
        ? name.trim()
        : '';

    const normalizedType =
      normalizeType(type);

    let institutionData = {
      linked: false,
      name: null
    };

    if (normalizedType === 'docente') {

      const institutionName =
        typeof institution === 'string'
          ? institution.trim()
          : '';

      if (institutionName) {
        institutionData = {
          linked: true,
          name: institutionName
        };
      }

    }

    if (
      !normalizedName ||
      !normalizedEmail ||
      typeof password !== 'string' ||
      !normalizedType
    ) {

      return sendJson(request, 400, {
        sucesso: false,
        mensagem:
          'Informe nome, e-mail e senha.'
      });

    }

    if (password.length < 8) {

      return sendJson(request, 400, {
        sucesso: false,
        mensagem:
          'A senha deve ter pelo menos 8 caracteres.'
      });

    }

    // Verifica se o e-mail já existe no MongoDB.
    const existingUser =
      await findProfile(normalizedEmail);

    if (existingUser) {

      return sendJson(request, 409, {
        sucesso: false,
        mensagem:
          'Já existe uma conta com este e-mail.'
      });

    }

    // Cria a identidade no Supabase Auth.
    if (!adminClient) {

      return sendJson(request, 503, {
        sucesso: false,
        mensagem:
          'O serviço de autenticação não está configurado.'
      });

    }

    const { data, error } =
      await adminClient.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: {
          name: normalizedName,
          type: normalizedType
        }
      });

    if (error || !data?.user) {

      const alreadyExists =
        /already|registered|exists/i.test(
          error?.message ?? ''
        );

      return sendJson(
        request,
        alreadyExists ? 409 : 500,
        {
          sucesso: false,
          mensagem:
            alreadyExists
              ? 'Já existe uma conta com este e-mail.'
              : 'Não foi possível criar a conta agora.'
        }
      );

    }

    // Grava o perfil da pessoa usuária no MongoDB.
    await usersCollection().insertOne({
      name: normalizedName,
      email: normalizedEmail,
      type: normalizedType,
      institution: institutionData,
      authUserId: data.user.id,
      createdAt: new Date()
    });

    return sendJson(request, 201, {
      sucesso: true,

      mensagem:
        'Conta criada. Agora você já pode entrar.'
    });

  } catch (error) {

    console.error(
      'Falha no cadastro:',
      error.message
    );

    return sendJson(request, 500, {
      sucesso: false,
      mensagem:
        'Não foi possível criar a conta agora.'
    });

  }

}


// ======================================================
// SESSÃO ATUAL
// ======================================================

async function currentSession(
  request
) {

  const session =
    await resolveSession(request);

  if (!session) {

    return sendJson(request, 401, {
      autenticado: false,
      mensagem:
        'Sessão expirada.'
    });

  }

  return sendJson(
    request,
    200,
    {
      autenticado: true,
      usuario: await publicUser(session.user)
    },
    session.cookies.length
      ? { 'Set-Cookie': session.cookies }
      : {}
  );

}


// ======================================================
// PAINEL ADMINISTRATIVO
// ======================================================

async function adminLogin(
  request
) {

  try {

    const { password } =
      await readJsonBody(request);

    if (!ADMIN_PASSWORD) {

      return sendJson(request, 503, {
        mensagem:
          'Configure o secret ADMIN_PASSWORD para ativar o painel administrativo.'
      });

    }

    if (
      typeof password !== 'string' ||
      password !== ADMIN_PASSWORD
    ) {

      return sendJson(request, 401, {
        mensagem:
          'Senha administrativa inválida.'
      });

    }

    if (!ADMIN_SESSION_SECRET) {

      return sendJson(request, 503, {
        mensagem:
          'Configure o secret ADMIN_SESSION_SECRET para ativar o painel administrativo.'
      });

    }

    return sendJson(request, 200, {
      token: await signAdminToken()
    });

  } catch {

    return sendJson(request, 400, {
      mensagem:
        'Não foi possível validar o acesso administrativo.'
    });

  }

}

async function listAdminUsers(
  request
) {

  const token =
    request.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      ?.trim() ?? '';

  if (!await verifyAdminToken(token)) {

    return sendJson(request, 401, {
      mensagem:
        'Sessão administrativa expirada.'
    });

  }

  try {

    const usersList =
      await usersCollection()
        .find(
          {},
          {
            projection: {
              name: 1,
              email: 1,
              type: 1,
              institution: 1,
              createdAt: 1
            }
          }
        )
        .sort({ createdAt: -1 })
        .toArray();

    const downloadInfo =
      await downloadStatsCollection().findOne(
        {
          _id: 'project-repository'
        }
      );

    const safeUsers =
      usersList.map((user) => ({
        name: user.name,
        email: user.email,
        type: USER_TYPES.includes(user.type)
          ? user.type
          : 'discente',
        institution:
          user.institution || {
            linked: false,
            name: null
          },
        createdAt: user.createdAt
      }));

    const docentes =
      safeUsers.filter((user) => user.type === 'docente');

    const discentes =
      safeUsers.filter((user) => user.type === 'discente');

    const outros =
      safeUsers.filter((user) => user.type === 'outro');

    return sendJson(request, 200, {
      total: safeUsers.length,
      docentes: docentes.length,
      discentes: discentes.length,
      outros: outros.length,
      docentesComInstituicao:
        docentes.filter(
          (user) => user.institution.linked
        ).length,
      downloadClicks:
        downloadInfo?.count || 0,
      users: safeUsers
    });

  } catch (error) {

    console.error(
      'Falha ao listar usuários:',
      error.message
    );

    return sendJson(request, 500, {
      mensagem:
        'Não foi possível carregar os usuários.'
    });

  }

}


// ======================================================
// MIGRAÇÃO DE CONTAS LEGADAS
// ======================================================

// Cria a identidade no Supabase Auth para os perfis que ainda
// não têm uma (contas herdadas do MongoDB com senha scrypt).
// A senha provisória é devolvida na resposta.
async function syncLegacyUsers(
  request
) {

  const token =
    request.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      ?.trim() ?? '';

  if (!await verifyAdminToken(token)) {

    return sendJson(request, 401, {
      mensagem:
        'Sessão administrativa expirada.'
    });

  }

  if (!adminClient) {

    return sendJson(request, 503, {
      mensagem:
        'O serviço de autenticação não está configurado.'
    });

  }

  const profiles =
    await usersCollection()
      .find(
        {
          authUserId: {
            $exists: false
          }
        },
        {
          projection: {
            name: 1,
            email: 1,
            type: 1,
            createdAt: 1
          }
        }
      )
      .toArray();

  const created = [];

  for (const profile of profiles) {

    const temporaryPassword =
      `${randomBytes(12).toString('base64url')}Ex1!`;

    const { data, error } =
      await adminClient.auth.admin.createUser({
        email: profile.email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: {
          name: profile.name,
          type: profile.type
        }
      });

    if (error || !data?.user) {

      created.push({
        email: profile.email,
        erro: error?.message ?? 'falha ao criar'
      });

      continue;
    }

    await usersCollection().updateOne(
      { _id: profile._id },
      {
        $set: {
          authUserId: data.user.id
        }
      }
    );

    created.push({
      email: profile.email,
      senhaProvisoria: temporaryPassword
    });

  }

  return sendJson(request, 200, {
    total: profiles.length,
    contas: created
  });

}


// ======================================================
// DOWNLOADS
// ======================================================

async function redirectToProjectRepository(
  request
) {

  try {

    await downloadStatsCollection().updateOne(
      { _id: 'project-repository' },
      {
        $inc: { count: 1 },
        $set: { updatedAt: new Date() }
      },
      { upsert: true }
    );

    return new Response(null, {
      status: 302,
      headers: {
        Location:
          `https://github.com/${PLATFORM_REPO}`,
        'Cache-Control': 'no-store',
        ...corsHeaders(request)
      }
    });

  } catch (error) {

    console.error(
      'Falha ao registrar acesso ao repositório:',
      error.message
    );

    return sendJson(request, 500, {
      mensagem:
        'Não foi possível abrir o repositório agora.'
    });

  }

}

// Código-fonte da Plataforma ExpeRT (arquivo ZIP do repositório).
function redirectToSourceArchive(
  request
) {

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        `https://codeload.github.com/${PLATFORM_REPO}/zip/refs/heads/${PLATFORM_BRANCH}`,
      'Cache-Control': 'no-store',
      ...corsHeaders(request)
    }
  });

}

async function redirectToLatestInstaller(
  request,
  platform
) {

  const platformAssetExtensions = {
    windows: ['.exe'],
    macos: ['.dmg'],
    linux: ['.deb'],
    'linux-appimage': ['.AppImage']
  };

  const allowedExtensions =
    platformAssetExtensions[platform];

  if (!allowedExtensions) {

    return sendJson(request, 400, {
      mensagem:
        'Sistema operacional não reconhecido.'
    });

  }

  try {

    const releaseResponse =
      await fetch(
        `https://api.github.com/repos/${PLATFORM_REPO}/releases/latest`,
        {
          headers: {
            Accept:
              'application/vnd.github+json',
            'User-Agent':
              'Plataforma-ExpeRT-website'
          },
          signal:
            AbortSignal.timeout(5000)
        }
      );

    if (!releaseResponse.ok) {
      throw new Error(
        `GitHub respondeu ${releaseResponse.status}`
      );
    }

    const release =
      await releaseResponse.json();

    const assets =
      Array.isArray(release.assets)
        ? release.assets
        : [];

    const installer =
      assets.find((asset) =>
        allowedExtensions.some(
          (extension) =>
            asset.name
              .toLowerCase()
              .endsWith(
                extension.toLowerCase()
              )
        )
      );

    if (!installer?.browser_download_url) {

      return new Response(null, {
        status: 302,
        headers: {
          Location:
            '/tutorial.html?installer=not-ready#download-title',
          'Cache-Control': 'no-store',
          ...corsHeaders(request)
        }
      });

    }

    return new Response(null, {
      status: 302,
      headers: {
        Location:
          installer.browser_download_url,
        'Cache-Control': 'no-store',
        ...corsHeaders(request)
      }
    });

  } catch (error) {

    console.error(
      'Falha ao localizar instalador da Plataforma ExpeRT:',
      error.message
    );

    return new Response(null, {
      status: 302,
      headers: {
        Location:
          '/tutorial.html?installer=unavailable#download-title',
        'Cache-Control': 'no-store',
        ...corsHeaders(request)
      }
    });

  }

}


// ======================================================
// SERVIDOR
// ======================================================

Deno.serve(
  {
    port: Number(
      Deno.env.get("PORT") ?? 8000
    )
  },
  async (
    request
  ) => {

    // URL completa recebida: o runtime entrega o caminho
    // público, incluindo /functions/v1/<nome>.
    const url =
      new URL(
        request.url,
        `http://${request.headers.get('host') ?? 'localhost'}`
      );

    let path = url.pathname;

    // Dependendo da versão do gateway, o caminho chega como
    // "/functions/v1/app/..." ou "/app/...". Os dois formatos
    // são removidos para deixar apenas o caminho interno.
    for (
      const candidate of [
        '/functions/v1/app',
        '/app'
      ]
    ) {

      if (
        path === candidate ||
        path.startsWith(`${candidate}/`)
      ) {
        path = path.slice(candidate.length);
        break;
      }

    }

    if (!path.startsWith('/')) {
      path = `/${path}`;
    }

    // Remove barras duplicadas.
    path = path.replace(/\/{2,}/g, '/');


    // ------------------------------------------
    // CORS (pré-requisição)
    // ------------------------------------------

    if (request.method === 'OPTIONS') {

      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });

    }


    // ------------------------------------------
    // LOGIN
    // ------------------------------------------

    if (
      request.method === 'POST' &&
      path === '/api/login'
    ) {

      return login(request);

    }


    // ------------------------------------------
    // CADASTRO
    // ------------------------------------------

    if (
      request.method === 'POST' &&
      path === '/api/register'
    ) {

      return register(request);

    }


    // ------------------------------------------
    // SESSÃO ATUAL
    // ------------------------------------------

    if (
      request.method === 'GET' &&
      path === '/api/session'
    ) {

      return currentSession(request);

    }


    // ------------------------------------------
    // PAINEL ADMINISTRATIVO
    // ------------------------------------------

    if (
      request.method === 'POST' &&
      path === '/api/admin/login'
    ) {

      return adminLogin(request);

    }

    if (
      request.method === 'GET' &&
      path === '/api/admin/users'
    ) {

      return listAdminUsers(request);

    }

    if (
      request.method === 'POST' &&
      path === '/api/admin/sync-users'
    ) {

      return syncLegacyUsers(request);

    }


    // ------------------------------------------
    // DOWNLOADS
    // ------------------------------------------

    if (
      request.method === 'GET' &&
      path === '/download/project'
    ) {

      return redirectToProjectRepository(request);

    }

    if (
      request.method === 'GET' &&
      path === '/download/installer'
    ) {

      return redirectToLatestInstaller(
        request,
        url.searchParams.get('platform')
      );

    }

    if (
      request.method === 'GET' &&
      path === '/download/source'
    ) {

      const session =
        await resolveSession(request);

      if (!session) {

        return new Response(null, {
          status: 302,
          headers: {
            Location:
              '/login.html?redirect=tutorial.html',
            'Cache-Control': 'no-store',
            ...corsHeaders(request)
          }
        });

      }

      return redirectToSourceArchive(request);

    }


    // ------------------------------------------
    // TESTE DA API
    // ------------------------------------------

    if (
      request.method === 'GET' &&
      path === '/api/health'
    ) {

      let databaseStatus = 'ok';

      try {
        await usersCollection()
          .estimatedDocumentCount();
      } catch (error) {
        databaseStatus = error.message;
      }

      return sendJson(request, 200, {
        status:
          databaseStatus === 'ok'
            ? 'ok'
            : 'erro',
        banco:
          `MongoDB Atlas (${MONGODB_DATABASE})`,
        colecao:
          MONGODB_USERS_COLLECTION,
        auth: 'supabase',
        detalhe: databaseStatus
      });

    }


    // ------------------------------------------
    // RAIZ DA FUNCTION
    // ------------------------------------------

    if (path === '/') {

      if (SITE_URL) {

        return new Response(null, {
          status: 302,
          headers: {
            Location: SITE_URL,
            'Cache-Control': 'no-store'
          }
        });

      }

      return sendJson(request, 200, {
        servico: 'Plataforma ExpeRT — API',
        endpoints: [
          '/api/login',
          '/api/register',
          '/api/session',
          '/api/admin/login',
          '/api/admin/users',
          '/api/health',
          '/download/project',
          '/download/installer',
          '/download/source'
        ]
      });

    }


    // ------------------------------------------
    // RECURSOS PROTEGIDOS
    // ------------------------------------------

    // O código-fonte só pode ser acessado com sessão válida.
    if (
      request.method === 'GET' &&
      path.startsWith('/downloads/plataforma-expert/')
    ) {

      const session =
        await resolveSession(request);

      if (!session) {

        return new Response(null, {
          status: 302,
          headers: {
            Location:
              '/login.html?redirect=tutorial.html',
            'Cache-Control': 'no-store',
            ...corsHeaders(request)
          }
        });

      }

      return redirectToSourceArchive(request);

    }


    // ------------------------------------------
    // MÉTODO NÃO PERMITIDO
    // ------------------------------------------

    if (request.method !== 'GET') {

      return sendJson(request, 405, {
        mensagem:
          'Método não permitido.'
      });

    }

    return sendJson(request, 404, {
      mensagem:
        'Rota não encontrada.'
    });

  }
);
