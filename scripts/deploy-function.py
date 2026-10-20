#!/usr/bin/env python3
# ======================================================
# DEPLOY DA EDGE FUNCTION (MANAGEMENT API)
# ======================================================
#
# Envia a function (código + arquivos estáticos) para a Supabase
# usando a Management API. Não precisa de Docker.
#
#   python3 scripts/deploy-function.py
#
# O token vem de:
#   - variável SUPABASE_ACCESS_TOKEN; ou
#   - da credencial OAuth do MCP guardada pelo OpenCode.
#
# ======================================================

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF", "xoacnxclwytocrubapap")
FUNCTION_SLUG = os.environ.get("SUPABASE_FUNCTION_SLUG", "app")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
FUNCTION_DIR = PROJECT_ROOT / "supabase" / "functions" / FUNCTION_SLUG

OPENCODE_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"


def find_token():
    """Token da Management API: env ou credencial OAuth do MCP."""
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if token:
        return token

    if not OPENCODE_DB.exists():
        sys.exit("Nenhum token encontrado. Defina SUPABASE_ACCESS_TOKEN.")

    con = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select value from credential where label = ?", ("supabase",)
        ).fetchone()
    finally:
        con.close()

    if not row:
        sys.exit("Nenhum token encontrado. Defina SUPABASE_ACCESS_TOKEN.")

    return json.loads(row[0])["access"]


def collect_files():
    """Arquivos enviados para a function (código + front-end embutido)."""
    files = []

    for path in sorted(FUNCTION_DIR.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(FUNCTION_DIR)
        # Ignora artefatos locais.
        if any(part in {"node_modules", ".git", "static"} for part in relative.parts):
            continue
        files.append((relative.as_posix(), path.read_bytes()))

    return files


def build_multipart(metadata, files):
    """Multipart com a metadata e um campo 'file' por arquivo."""
    boundary = f"----opencode{uuid.uuid4().hex}"
    parts = []

    parts.append(
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="metadata"\r\n\r\n'
            f"{json.dumps(metadata)}\r\n"
        ).encode()
    )

    for name, content in files:
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        parts.append(content)
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode())

    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def read_env_file():
    """Secrets locais (supabase/.env.production), se existirem."""
    env_file = PROJECT_ROOT / "supabase" / ".env.production"

    if not env_file.exists():
        return {}

    values = {}

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"')

    return values


def main():
    token = find_token()

    files = collect_files()
    if not files:
        sys.exit("Nenhum arquivo encontrado na function.")

    metadata = {
        "name": FUNCTION_SLUG,
        "entrypoint_path": "index.ts",
        "import_map_path": "",
        "verify_jwt": False,
    }

    # Variáveis de ambiente da function.
    env = read_env_file()

    if env:
        metadata["env"] = env

    body, content_type = build_multipart(metadata, files)

    print(f"\nEnviando {len(files)} arquivos...")
    for name, content in files:
        print(f"  {name} ({len(content) / 1024:.0f} KB)")

    if env:
        print(f"  env: {', '.join(sorted(env))}")

    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions/deploy?slug={FUNCTION_SLUG}",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request) as response:
            result = json.loads(response.read().decode())
            print(f"\nHTTP {response.status}")
            print(f"  status  : {result.get('status')}")
            print(f"  versão  : {result.get('version')}")
            print(f"  entrypoint: {result.get('entrypoint_path')}")
            print(f"  import_map: {result.get('import_map_path')}")
    except urllib.error.HTTPError as error:
        print(f"\nHTTP {error.code}")
        print(error.read().decode()[:600])
        sys.exit(1)


if __name__ == "__main__":
    main()
