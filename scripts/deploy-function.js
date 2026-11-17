#!/usr/bin/env node
// ======================================================
// DEPLOY DA EDGE FUNCTION (MANAGEMENT API)
// ======================================================
//
// Envia a function (código + arquivos) para a Supabase
// usando a Management API. Não precisa de Docker.
//
//   node scripts/deploy-function.js
//
// O token vem de:
//   - variável SUPABASE_ACCESS_TOKEN; ou
//   - da credencial OAuth do MCP guardada pelo OpenCode.
//
// ======================================================

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const PROJECT_REF =
  process.env.SUPABASE_PROJECT_REF ?? "xoacnxclwytocrubapap";

const FUNCTION_SLUG =
  process.env.SUPABASE_FUNCTION_SLUG ?? "app";

const FUNCTION_DIR = path.join(
  PROJECT_ROOT,
  "supabase",
  "functions",
  FUNCTION_SLUG
);

const ENTRYPOINT = "index.js";

const OPENCODE_DB = path.join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db"
);


// ======================================================
// TOKEN DA MANAGEMENT API
// ======================================================

// Lê a credencial OAuth do MCP guardada pelo OpenCode.
async function tokenFromOpencode() {

  if (!existsSync(OPENCODE_DB)) {
    return null;
  }

  try {

    // Módulo nativo de SQLite (Node 22.5+).
    const { DatabaseSync } = await import("node:sqlite");

    const database = new DatabaseSync(OPENCODE_DB, {
      readOnly: true
    });

    try {

      const row = database
        .prepare(
          "select value from credential where label = ?"
        )
        .get("supabase");

      if (!row?.value) {
        return null;
      }

      return JSON.parse(row.value).access ?? null;

    } finally {
      database.close();
    }

  } catch {
    return null;
  }

}

async function findToken() {

  const fromEnv =
    process.env.SUPABASE_ACCESS_TOKEN;

  if (fromEnv) {
    return fromEnv;
  }

  const fromDb = await tokenFromOpencode();

  if (!fromDb) {
    console.error(
      "Nenhum token encontrado. Defina SUPABASE_ACCESS_TOKEN."
    );
    process.exit(1);
  }

  return fromDb;

}


// ======================================================
// ARQUIVOS DA FUNCTION
// ======================================================

function collectFiles() {

  const files = [];

  function walk(directory) {

    for (const entry of readdirSync(directory)) {

      const absolute = path.join(directory, entry);
      const info = statSync(absolute);

      if (info.isDirectory()) {

        // Ignora artefatos locais.
        if (
          ["node_modules", ".git", "static"].includes(entry)
        ) {
          continue;
        }

        walk(absolute);
        continue;
      }

      const relative = path
        .relative(FUNCTION_DIR, absolute)
        .split(path.sep)
        .join("/");

      files.push({
        name: relative,
        content: readFileSync(absolute)
      });

    }

  }

  walk(FUNCTION_DIR);

  return files.sort((a, b) =>
    a.name.localeCompare(b.name)
  );

}


// ======================================================
// SECRETS LOCAIS
// ======================================================

function readEnvFile() {

  const envFile = path.join(
    PROJECT_ROOT,
    "supabase",
    ".env.production"
  );

  if (!existsSync(envFile)) {
    return {};
  }

  const values = {};

  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {

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


// ======================================================
// DEPLOY
// ======================================================

async function main() {

  const token = await findToken();

  const files = collectFiles();

  if (!files.length) {
    console.error(
      "Nenhum arquivo encontrado na function."
    );
    process.exit(1);
  }

  const metadata = {
    name: FUNCTION_SLUG,
    entrypoint_path: ENTRYPOINT,
    import_map_path: "",
    verify_jwt: false
  };

  // Variáveis de ambiente da function.
  const env = readEnvFile();

  if (Object.keys(env).length) {
    metadata.env = env;
  }

  const form = new FormData();

  form.append("metadata", JSON.stringify(metadata));

  for (const file of files) {
    form.append(
      "file",
      new Blob([file.content]),
      file.name
    );
  }

  console.log(`\nEnviando ${files.length} arquivos...`);

  for (const file of files) {
    console.log(
      `  ${file.name} (${Math.round(file.content.length / 1024)} KB)`
    );
  }

  if (Object.keys(env).length) {
    console.log(
      `  env: ${Object.keys(env).sort().join(", ")}`
    );
  }

  const url =
    `https://api.supabase.com/v1/projects/${PROJECT_REF}` +
    `/functions/deploy?slug=${FUNCTION_SLUG}`;

  let response;

  try {

    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });

  } catch (error) {

    console.error(
      `\nFalha de rede: ${error.message}`
    );
    process.exit(1);

  }

  const text = await response.text();

  if (!response.ok) {

    console.log(`\nHTTP ${response.status}`);
    console.log(text.slice(0, 600));
    process.exit(1);

  }

  let result = {};

  try {
    result = JSON.parse(text);
  } catch {
    result = {};
  }

  console.log(`\nHTTP ${response.status}`);
  console.log(`  status    : ${result.status}`);
  console.log(`  versão    : ${result.version}`);
  console.log(`  entrypoint: ${result.entrypoint_path}`);
  console.log(`  import_map: ${result.import_map_path}`);

}

main();
