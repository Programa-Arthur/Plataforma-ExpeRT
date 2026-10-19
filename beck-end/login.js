import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';


// ======================================================
// CONFIGURAÇÕES DO PROJETO
// ======================================================

const directory = resolve(
  fileURLToPath(new URL('.', import.meta.url))
);

const frontendDirectory = resolve(
  directory,
  '../fron-end'
);

const credentialsPath = join(
  directory,
  'atlas-credentials.env'
);

const port = Number(
  process.env.PORT || 3000
);
const adminSessions = new Map();
const userSessions = new Map();
const userSessionDuration = 8 * 60 * 60 * 1000;


// ======================================================
// LER ARQUIVO .ENV
// ======================================================

function loadEnvironment(path) {
  const entries = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)
    )
    .map((line) => {
      const separator = line.indexOf('=');

      return [
        line.slice(0, separator),
        line
          .slice(separator + 1)
          .replace(/^['"]|['"]$/g, '')
      ];
    });

  return Object.fromEntries(entries);
}


const environment = loadEnvironment(credentialsPath);
const adminPassword = environment.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';


// ======================================================
// VERIFICAR CONEXÃO COM MONGODB
// ======================================================

if (!environment.MONGODB_URI) {
  throw new Error(
    'Defina MONGODB_URI em atlas-credentials.env antes de iniciar o servidor.'
  );
}


// ======================================================
// MONGODB
// ======================================================

const client = new MongoClient(
  environment.MONGODB_URI
);


// Banco da Plataforma ExpeRT
const database = client.db(
  environment.MONGODB_DATABASE || 'ExpeRT'
);


// Coleção de usuários
const users = database.collection(
  environment.MONGODB_USERS_COLLECTION || 'users'
);
const downloadStats = database.collection('downloadStats');


// ======================================================
// TIPOS DE CONTEÚDO
// ======================================================

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};


// ======================================================
// ENVIAR JSON
// ======================================================

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });

  response.end(
    JSON.stringify(body)
  );
}


// ======================================================
// LER JSON ENVIADO PELO FRONT-END
// ======================================================

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {

    let body = '';

    request.on('data', (chunk) => {

      body += chunk;

      if (body.length > 10_000) {
        reject(
          new Error(
            'O corpo da requisição é muito grande.'
          )
        );
      }
    });

    request.on('end', () => {

      try {

        resolveBody(
          JSON.parse(body || '{}')
        );

      } catch {

        reject(
          new Error(
            'Envie os dados em JSON válido.'
          )
        );
      }
    });

    request.on('error', reject);
  });
}


// ======================================================
// SENHA
// ======================================================

function passwordMatches(password, passwordHash) {

  // Senhas novas
  if (passwordHash?.startsWith('scrypt$')) {

    const [
      ,
      salt,
      storedHash
    ] = passwordHash.split('$');

    if (!salt || !storedHash) {
      return false;
    }

    const expected =
      Buffer.from(
        storedHash,
        'hex'
      );

    const actual =
      scryptSync(
        password,
        salt,
        64
      );

    return (
      expected.length === actual.length &&
      timingSafeEqual(
        expected,
        actual
      )
    );
  }


  // Compatibilidade com contas antigas
  if (passwordHash?.startsWith('sha256$')) {

    const expected =
      Buffer.from(
        passwordHash.slice(
          'sha256$'.length
        ),
        'hex'
      );

    const actual =
      Buffer.from(
        createHash('sha256')
          .update(password)
          .digest('hex'),
        'hex'
      );

    return (
      expected.length === actual.length &&
      timingSafeEqual(
        expected,
        actual
      )
    );
  }

  return false;
}


// ======================================================
// CRIAR HASH DA SENHA
// ======================================================

function createPasswordHash(password) {

  const salt =
    randomBytes(16)
      .toString('hex');

  const hash =
    scryptSync(
      password,
      salt,
      64
    ).toString('hex');

  return (
    'scrypt$' +
    salt +
    '$' +
    hash
  );
}


// ======================================================
// PROTEGER REGEX DO E-MAIL
// ======================================================

function escapeRegExp(value) {

  return value.replace(
    /[\\^$.*+?()[\]{}|]/g,
    '\\$&'
  );
}


// ======================================================
// LOGIN
// ======================================================

async function login(request, response) {

  try {

    const {
      email,
      password,
      type
    } = await readJsonBody(request);


    // Verificação dos dados
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !['docente', 'discente', 'outro'].includes(type) ||
      !email.trim() ||
      !password
    ) {

      return sendJson(
        response,
        400,
        {
          sucesso: false,
          mensagem:
            'Informe e-mail e senha.'
        }
      );
    }


    // Procurar usuário pelo e-mail
    const user =
      await users.findOne(
        {
          email: {
            $regex:
              '^' +
              escapeRegExp(
                email.trim()
              ) +
              '$',

            $options: 'i'
          }
        },

        {
          projection: {
            name: 1,
            email: 1,
            passwordHash: 1,
            type: 1,
            institution: 1
          }
        }
      );


    // Usuário não encontrado
    if (
      !user ||
      !passwordMatches(
        password,
        user.passwordHash
      ) ||
      (user.type || 'discente') !== type
    ) {

      return sendJson(
        response,
        401,
        {
          sucesso: false,
          mensagem:
            'E-mail, senha ou tipo de usuário inválidos.'
        }
      );
    }


    // Login realizado: cria uma sessão validada pelo servidor.
    const sessionToken = randomBytes(32).toString('hex');
    userSessions.set(sessionToken, Date.now() + userSessionDuration);
    const secureCookie = request.headers['x-forwarded-proto'] === 'https' || request.socket.encrypted
      ? '; Secure'
      : '';

    return sendJson(
      response,
      200,
      {
        sucesso: true,

        usuario: {

          nome: user.name,

          email: user.email,

          tipo:
            user.type ||
            'discente',

          instituicao:
            user.institution ||
            {
              linked: false,
              name: null
            }
        }
      },
      {
        'Set-Cookie': `expert_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${userSessionDuration / 1000}${secureCookie}`
      }
    );

  } catch (error) {

    console.error(
      'Falha no login:',
      error.message
    );

    return sendJson(
      response,
      500,
      {
        sucesso: false,
        mensagem:
          'Não foi possível validar o acesso agora.'
      }
    );
  }
}


// ======================================================
// CADASTRO
// ======================================================

async function register(request, response) {

  try {

    const {
      name,
      email,
      password,
      type,
      institution
    } = await readJsonBody(request);


    // ------------------------------------------
    // NORMALIZAÇÃO
    // ------------------------------------------

    const normalizedEmail =
      typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';

    const normalizedName =
      typeof name === 'string'
        ? name.trim()
        : '';


    // ------------------------------------------
    // TIPO DO USUÁRIO
    // ------------------------------------------

    // Se o front-end não mandar o tipo,
    // o usuário será considerado discente.

    const normalizedType =
      ['docente', 'discente', 'outro'].includes(type) ? type : '';


    // ------------------------------------------
    // INSTITUIÇÃO
    // ------------------------------------------

    let institutionData = {
      linked: false,
      name: null
    };


    // A instituição só será considerada
    // para usuários docentes.

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


    // ------------------------------------------
    // VALIDAÇÃO
    // ------------------------------------------

    if (
      !normalizedName ||
      !normalizedEmail ||
      typeof password !== 'string' ||
      !normalizedType
    ) {

      return sendJson(
        response,
        400,
        {
          sucesso: false,
          mensagem:
            'Informe nome, e-mail e senha.'
        }
      );
    }


    // Senha mínima
    if (password.length < 8) {

      return sendJson(
        response,
        400,
        {
          sucesso: false,
          mensagem:
            'A senha deve ter pelo menos 8 caracteres.'
        }
      );
    }


    // ------------------------------------------
    // VERIFICAR E-MAIL EXISTENTE
    // ------------------------------------------

    const existingUser =
      await users.findOne(
        {
          email: normalizedEmail
        },
        {
          projection: {
            _id: 1
          }
        }
      );


    if (existingUser) {

      return sendJson(
        response,
        409,
        {
          sucesso: false,
          mensagem:
            'Já existe uma conta com este e-mail.'
        }
      );
    }


    // ------------------------------------------
    // CRIAR USUÁRIO
    // ------------------------------------------

    const newUser = {

      name: normalizedName,

      email: normalizedEmail,

      passwordHash:
        createPasswordHash(
          password
        ),

      type: normalizedType,

      institution:
        institutionData,

      createdAt:
        new Date()
    };


    // ------------------------------------------
    // SALVAR NO MONGODB
    // ------------------------------------------

    await users.insertOne(
      newUser
    );


    // ------------------------------------------
    // RESPOSTA
    // ------------------------------------------

    return sendJson(
      response,
      201,
      {
        sucesso: true,

        mensagem:
          'Conta criada. Agora você já pode entrar.'
      }
    );


  } catch (error) {

    console.error(
      'Falha no cadastro:',
      error.message
    );

    return sendJson(
      response,
      500,
      {
        sucesso: false,
        mensagem:
          'Não foi possível criar a conta agora.'
      }
    );
  }
}

function adminLogin(request, response) {
  return readJsonBody(request).then(({ password }) => {
    if (!adminPassword) {
      return sendJson(response, 503, {
        mensagem: 'Configure ADMIN_PASSWORD no beck-end/atlas-credentials.env para ativar o painel administrativo.'
      });
    }
    if (typeof password !== 'string' || password !== adminPassword) {
      return sendJson(response, 401, { mensagem: 'Senha administrativa inválida.' });
    }
    const token = randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    return sendJson(response, 200, { token });
  }).catch(() => sendJson(response, 400, { mensagem: 'Não foi possível validar o acesso administrativo.' }));
}

async function listAdminUsers(request, response) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    adminSessions.delete(token);
    return sendJson(response, 401, { mensagem: 'Sessão administrativa expirada.' });
  }
  try {
    const usersList = await users.find({}, {
      projection: { name: 1, email: 1, type: 1, institution: 1, createdAt: 1 }
    }).sort({ createdAt: -1 }).toArray();
    const downloadInfo = await downloadStats.findOne({ _id: 'project-repository' });
    const safeUsers = usersList.map((user) => ({
      name: user.name,
      email: user.email,
      type: ['docente', 'discente', 'outro'].includes(user.type) ? user.type : 'discente',
      institution: user.institution || { linked: false, name: null },
      createdAt: user.createdAt
    }));
    const docentes = safeUsers.filter((user) => user.type === 'docente');
    const discentes = safeUsers.filter((user) => user.type === 'discente');
    const outros = safeUsers.filter((user) => user.type === 'outro');
    return sendJson(response, 200, {
      total: safeUsers.length,
      docentes: docentes.length,
      discentes: discentes.length,
      outros: outros.length,
      docentesComInstituicao: docentes.filter((user) => user.institution.linked).length,
      downloadClicks: downloadInfo?.count || 0,
      users: safeUsers
    });
  } catch (error) {
    console.error('Falha ao listar usuários:', error.message);
    return sendJson(response, 500, { mensagem: 'Não foi possível carregar os usuários.' });
  }
}

async function redirectToProjectRepository(response) {
  try {
    await downloadStats.updateOne(
      { _id: 'project-repository' },
      { $inc: { count: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    response.writeHead(302, {
      Location: 'https://github.com/bs-laurao/plataforma-expert',
      'Cache-Control': 'no-store'
    });
    return response.end();
  } catch (error) {
    console.error('Falha ao registrar acesso ao repositório:', error.message);
    return sendJson(response, 500, {
      mensagem: 'Não foi possível abrir o repositório agora.'
    });
  }
}

async function redirectToLatestInstaller(response, platform) {
  const platformAssetExtensions = {
    windows: ['.exe'],
    macos: ['.dmg'],
    linux: ['.deb'],
    'linux-appimage': ['.AppImage']
  };
  const allowedExtensions = platformAssetExtensions[platform];

  if (!allowedExtensions) {
    return sendJson(response, 400, {
      mensagem: 'Sistema operacional não reconhecido.'
    });
  }

  try {
    const releaseResponse = await fetch(
      'https://api.github.com/repos/bs-laurao/plataforma-expert/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Plataforma-ExpeRT-website'
        },
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!releaseResponse.ok) throw new Error(`GitHub respondeu ${releaseResponse.status}`);

    const release = await releaseResponse.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = assets.find((asset) =>
      allowedExtensions.some((extension) => asset.name.toLowerCase().endsWith(extension.toLowerCase()))
    );

    if (!installer?.browser_download_url) {
      response.writeHead(302, {
        Location: '/tutorial.html?installer=not-ready#download-title',
        'Cache-Control': 'no-store'
      });
      return response.end();
    }

    response.writeHead(302, {
      Location: installer.browser_download_url,
      'Cache-Control': 'no-store'
    });
    return response.end();
  } catch (error) {
    console.error('Falha ao localizar instalador da Plataforma ExpeRT:', error.message);
    response.writeHead(302, {
      Location: '/tutorial.html?installer=unavailable#download-title',
      'Cache-Control': 'no-store'
    });
    return response.end();
  }
}


// ======================================================
// ENVIAR ARQUIVOS DO FRONT-END
// ======================================================

async function sendFile(
  response,
  filePath
) {

  try {

    const content =
      await readFile(
        filePath
      );

    response.writeHead(
      200,
      {
        'Content-Type':
          contentTypes[
            extname(filePath)
          ] ||
          'application/octet-stream'
      }
    );

    response.end(
      content
    );

  } catch {

    sendJson(
      response,
      404,
      {
        mensagem:
          'Arquivo não encontrado.'
      }
    );
  }
}


// ======================================================
// SERVIDOR
// ======================================================

const server =
  createServer(
    async (
      request,
      response
    ) => {

      const url =
        new URL(
          request.url,
          'http://' +
          (
            request.headers.host ||
            'localhost'
          )
        );

      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        return adminLogin(request, response);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/users') {
        return listAdminUsers(request, response);
      }
      if (request.method === 'GET' && url.pathname === '/download/project') {
        return redirectToProjectRepository(response);
      }
      if (request.method === 'GET' && url.pathname === '/download/installer') {
        return redirectToLatestInstaller(response, url.searchParams.get('platform'));
      }


      // ------------------------------------------
      // LOGIN
      // ------------------------------------------

      if (
        request.method === 'POST' &&
        url.pathname === '/api/login'
      ) {

        return login(
          request,
          response
        );
      }


      // ------------------------------------------
      // CADASTRO
      // ------------------------------------------

      if (
        request.method === 'POST' &&
        url.pathname === '/api/register'
      ) {

        return register(
          request,
          response
        );
      }


      // ------------------------------------------
      // TESTE DA API
      // ------------------------------------------

      if (
        request.method === 'GET' &&
        url.pathname === '/api/health'
      ) {

        return sendJson(
          response,
          200,
          {
            status: 'ok',
            banco: 'ExpeRT',
            colecao: 'users'
          }
        );
      }

      // O tutorial e os arquivos da aplicação só podem ser acessados com sessão válida.
      const protectedTutorialPath = url.pathname === '/tutorial.html' ||
        url.pathname.startsWith('/downloads/plataforma-expert/');
      if (request.method === 'GET' && protectedTutorialPath) {
        const sessionCookie = request.headers.cookie
          ?.split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('expert_session='));
        const sessionToken = sessionCookie?.slice('expert_session='.length);
        const expiresAt = userSessions.get(sessionToken);

        if (!expiresAt || expiresAt <= Date.now()) {
          userSessions.delete(sessionToken);
          response.writeHead(302, { Location: '/login.html?redirect=tutorial.html' });
          return response.end();
        }
      }


      // ------------------------------------------
      // MÉTODO NÃO PERMITIDO
      // ------------------------------------------

      if (
        request.method !== 'GET'
      ) {

        return sendJson(
          response,
          405,
          {
            mensagem:
              'Método não permitido.'
          }
        );
      }


      // ------------------------------------------
      // FRONT-END
      // ------------------------------------------

      const relativePath =
        url.pathname === '/'
          ? 'index.html'
          : url.pathname.slice(1);


      const filePath =
        resolve(
          frontendDirectory,
          normalize(
            relativePath
          )
        );


      // Impedir acesso fora da pasta do front-end
      if (
        !filePath.startsWith(
          frontendDirectory + '/'
        )
      ) {

        return sendJson(
          response,
          403,
          {
            mensagem:
              'Acesso não permitido.'
          }
        );
      }


      return sendFile(
        response,
        filePath
      );
    }
  );


// ======================================================
// CONECTAR AO MONGODB
// ======================================================

await client.connect();

console.log(
  'Conectado ao MongoDB.'
);

console.log(
  'Banco utilizado: ExpeRT'
);

console.log(
  'Coleção utilizada: users'
);


// ======================================================
// ÍNDICE ÚNICO PARA E-MAIL
// ======================================================

await users.createIndex(
  {
    email: 1
  },
  {
    unique: true
  }
);


// ======================================================
// INICIAR SERVIDOR
// ======================================================

server.listen(
  port,
  () => {

    console.log(
      'Plataforma ExpeRT disponível em http://localhost:' +
      port
    );
  }
);


// ======================================================
// ENCERRAMENTO
// ======================================================

async function shutdown() {

  console.log(
    'Encerrando servidor...'
  );

  await client.close();

  server.close();
}


process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);
