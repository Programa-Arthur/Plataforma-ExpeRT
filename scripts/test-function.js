#!/usr/bin/env node
// ======================================================
// TESTE LOCAL DA EDGE FUNCTION (sem Docker)
// ======================================================
//
// Sobe a function da Supabase com o Deno usando os secrets de
// supabase/.env.production e exercita as rotas principais.
//
//   node scripts/test-function.js
//
// ======================================================

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const FUNCTION_DIR = path.join(
  PROJECT_ROOT,
  "supabase",
  "functions",
  "app"
);

const ENV_FILE = path.join(
  PROJECT_ROOT,
  "supabase",
  ".env.production"
);

const LOG_FILE = path.join(
  PROJECT_ROOT,
  ".function-test.log"
);

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;


// ======================================================
// SECRETS
// ======================================================

function readEnvFile(file) {

  const values = {};

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {

    const line = rawLine.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const index = line.indexOf("=");

    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");

    values[key] = value;

  }

  return values;

}

if (!existsSync(ENV_FILE)) {
  console.error(`Arquivo de secrets não encontrado: ${ENV_FILE}`);
  process.exit(1);
}

const secrets = readEnvFile(ENV_FILE);

const env = {
  ...process.env,
  ...secrets,
  SUPABASE_URL:
    secrets.SUPABASE_URL ??
    "https://xoacnxclwytocrubapap.supabase.co",
  SUPABASE_PUBLISHABLE_KEY:
    secrets.SUPABASE_PUBLISHABLE_KEY ??
    "sb_publishable_owIbyeQ3GTvvv5XU5dY7BQ_OyOV8WWv",
  PORT: String(PORT)
};


// ======================================================
// SERVIDOR
// ======================================================

if (!existsSync(path.join(FUNCTION_DIR, "index.js"))) {
  console.error(
    `Entrypoint não encontrado: ${path.join(FUNCTION_DIR, "index.js")}`
  );
  process.exit(1);
}

console.log(`Subindo a function em ${BASE} ...`);

const logFd = openSync(LOG_FILE, "w");

const server = spawn(
  "deno",
  [
    "run",
    "--node-modules-dir=auto",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-sys",
    "index.js"
  ],
  {
    cwd: FUNCTION_DIR,
    env,
    stdio: ["ignore", logFd, logFd]
  }
);

server.on("error", (error) => {
  console.error(`Não foi possível iniciar o Deno: ${error.message}`);
  closeSync(logFd);
  process.exit(1);
});

function stopServer() {

  try {
    server.kill();
  } catch {
    // Processo já encerrado.
  }

}

process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});


// ======================================================
// UTILITÁRIOS
// ======================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {

  for (let attempt = 0; attempt < 40; attempt += 1) {

    try {

      const response = await fetch(`${BASE}/api/health`);
      await response.text();
      return true;

    } catch {
      await sleep(500);
    }

  }

  return false;

}

async function request(pathname, options = {}) {

  return fetch(`${BASE}${pathname}`, options);

}

async function printRedirect(pathname) {

  const response = await request(pathname, {
    redirect: "manual"
  });

  await response.text();

  console.log(
    `status=${response.status} destino=${response.headers.get("location") ?? ""}`
  );

}

async function printStatus(label, pathname, options) {

  const response = await request(pathname, options);
  await response.text();

  console.log(
    `${label} status=${response.status}`
  );

}


// ======================================================
// TESTES
// ======================================================

async function main() {

  if (!await waitForHealth()) {

    console.error("A function não subiu. Log:");
    console.error(readFileSync(LOG_FILE, "utf8"));
    process.exit(1);

  }

  console.log();
  console.log("== health ==");

  const health = await request("/api/health");
  console.log(await health.text());

  console.log();
  console.log("== download/project (302 + contador) ==");
  await printRedirect("/download/project");

  console.log();
  console.log("== download/installer linux ==");
  await printRedirect(
    "/download/installer?platform=linux"
  );

  console.log();
  console.log("== download/source sem sessão (deve redirecionar) ==");
  await printRedirect("/download/source");

  console.log();
  console.log("== session sem cookie (401) ==");
  await printStatus("session", "/api/session");

  console.log();
  console.log("== admin/login com senha errada ==");
  await printStatus("admin/login", "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "errada" })
  });

  console.log();
  console.log("== admin/login + admin/users ==");

  const adminLogin = await request("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password: secrets.ADMIN_PASSWORD ?? ""
    })
  });

  const adminBody = await adminLogin.text();

  let adminToken = "";

  try {
    adminToken = JSON.parse(adminBody).token ?? "";
  } catch {
    adminToken = "";
  }

  if (adminToken) {

    console.log(
      `token recebido: ${adminToken.length} caracteres`
    );

    const users = await request("/api/admin/users", {
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });

    const usersBody = await users.text();

    console.log(usersBody.slice(0, 400));

  } else {

    console.log("FALHA: token administrativo não obtido");

  }

  console.log();
  console.log("== login com senha errada (401) ==");
  await printStatus("login", "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "ninguem@exemplo.com",
      password: "errada",
      type: "discente"
    })
  });

  console.log();
  console.log("== cadastro sem campos (400) ==");
  await printStatus("register", "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });

  console.log();
  console.log(`Log da function: ${LOG_FILE}`);

}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    closeSync(logFd);
  });
