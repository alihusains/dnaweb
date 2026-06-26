#!/usr/bin/env python3
"""
Export production Turso database and generate per-language SQLite files.

Usage:
    python3 generate_language_dbs.py
    TURSO_TOKEN='eyJ...' python3 generate_language_dbs.py

Connects to Turso production (duasandaamalapp) via HTTP API, exports full
database to production_export.sqlite, then generates dna_{lang}.sqlite
for each language.
"""

import sqlite3
import json
import os
import sys
import re
from pathlib import Path

try:
    import httpx
except ImportError:
    print("Error: httpx not installed. Run: pip3 install httpx")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
OUTPUT_DIR = str(SCRIPT_DIR)

TURSO_URL = "libsql://duasandaamalapp-alihusains.aws-ap-northeast-1.turso.io"
TURSO_HTTP_URL = "https://duasandaamalapp-alihusains.aws-ap-northeast-1.turso.io"


def get_token():
    """Get Turso token from env var, config.js, or auto-generate via turso CLI."""
    token = os.environ.get("TURSO_TOKEN")
    if token:
        return token

    # Try turso CLI to generate a fresh token
    import subprocess
    try:
        result = subprocess.run(
            ["turso", "db", "tokens", "create", "duasandaamalapp"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip().startswith("eyJ"):
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Fall back to config.js
    config_path = SCRIPT_DIR.parent / "config.js"
    if config_path.exists():
        content = config_path.read_text()
        match = re.search(r"production:\s*\{[^}]*token:\s*'([^']+)'", content, re.DOTALL)
        if match:
            return match.group(1)

    print("Error: Could not get TURSO_TOKEN.")
    print("Options:")
    print("  1. Install turso CLI: brew install turso")
    print("  2. Set env var: TURSO_TOKEN='eyJ...' python3 generate_language_dbs.py")
    sys.exit(1)


def turso_execute(token, sql, args=None):
    """Execute SQL on Turso via HTTP API."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [
            {"type": "text", "value": str(a)} if a is not None else {"type": "null"}
            for a in args
        ]

    payload = {
        "requests": [
            {"type": "execute", "stmt": stmt},
            {"type": "close"}
        ]
    }

    with httpx.Client(timeout=60) as client:
        resp = client.post(f"{TURSO_HTTP_URL}/v2/pipeline", headers=headers, json=payload)
        resp.raise_for_status()
        result = resp.json()

    # Parse response
    if "results" in result and result["results"]:
        first = result["results"][0]
        if first.get("type") == "ok" and "response" in first:
            response = first["response"]
            if response.get("type") == "execute" and "result" in response:
                res = response["result"]
                cols = [c.get("name", "") for c in res.get("cols", [])]
                rows = []
                for row in res.get("rows", []):
                    parsed = []
                    for val in row:
                        if isinstance(val, dict):
                            parsed.append(val.get("value"))
                        else:
                            parsed.append(val)
                    rows.append(parsed)
                return {"cols": cols, "rows": rows}
    return {"cols": [], "rows": []}


def fetch_all_data(token):
    """Fetch all tables and data from Turso."""
    print("Fetching data from Turso production...")

    # Get table list
    result = turso_execute(token, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    table_names = [row[0] for row in result.get("rows", [])]

    data = {}
    schemas = {}

    for table_name in table_names:
        # Fetch schema
        schema_result = turso_execute(token, f"PRAGMA table_info({table_name})")
        schemas[table_name] = schema_result.get("rows", [])

        # Fetch all data
        data_result = turso_execute(token, f"SELECT * FROM {table_name}")
        cols = data_result.get("cols", [])
        rows = data_result.get("rows", [])
        data[table_name] = {"cols": [c.get("name", c) if isinstance(c, dict) else c for c in cols], "rows": rows}
        print(f"  {table_name}: {len(rows)} rows")

    return data, schemas


def create_local_db(data, schemas, output_path):
    """Create a local SQLite database from fetched data."""
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    cur = conn.cursor()

    # Create tables
    for table_name, col_info in schemas.items():
        col_defs = []
        for col in col_info:
            # col is a list of dicts: [{type, value}, ...]
            # [cid, name, type, notnull, dflt_value, pk]
            def val(i):
                v = col[i] if i < len(col) else None
                if isinstance(v, dict):
                    return v.get("value")
                return v

            cid = val(0)
            name = val(1)
            col_type = val(2) or "TEXT"
            notnull = val(3)
            dflt = val(4)
            pk = val(5)

            parts = [name, col_type]
            if pk and str(pk) == "1":
                parts.append("PRIMARY KEY")
            if notnull and str(notnull) == "1" and str(pk) != "1":
                parts.append("NOT NULL")
            if dflt is not None:
                parts.append(f"DEFAULT {dflt}")
            col_defs.append(" ".join(parts))

        cur.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({', '.join(col_defs)})")

    # Insert data
    for table_name, table_data in data.items():
        rows = table_data["rows"]
        if not rows:
            continue

        col_names = table_data["cols"]
        placeholders = ", ".join(["?"] * len(col_names))
        insert_sql = f"INSERT INTO {table_name} ({', '.join(col_names)}) VALUES ({placeholders})"

        for row in rows:
            cur.execute(insert_sql, row)

    # Create indexes
    cur.execute("CREATE INDEX IF NOT EXISTS idx_categories_english_name ON categories(english_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_categories_sequence ON categories(sequence)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_categories_language_code ON categories(language_code)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_item_translations_category ON item_translations(category_id)")

    conn.commit()
    conn.close()


def create_language_db(source_path, language, output_path):
    """Create a language-specific database from local export."""
    lang_id, lang_code, lang_name, is_rtl = language

    if os.path.exists(output_path):
        os.remove(output_path)

    out_conn = sqlite3.connect(output_path)
    out_cur = out_conn.cursor()
    src_conn = sqlite3.connect(source_path)
    src_cur = src_conn.cursor()

    # Create schema
    out_cur.executescript("""
        CREATE TABLE IF NOT EXISTS languages (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            is_rtl INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER,
            sequence INTEGER DEFAULT 0,
            lang_name TEXT,
            english_name TEXT,
            audio_url TEXT,
            video_url TEXT,
            duas_url TEXT,
            local_audio_url TEXT,
            local_video_url TEXT,
            is_trans INTEGER DEFAULT 0,
            related1 INTEGER,
            related2 INTEGER,
            notify_hijri_date TEXT,
            label1 TEXT,
            label2 TEXT,
            is_last_level INTEGER DEFAULT 0,
            language_code TEXT DEFAULT 'gu',
            content_source_id INTEGER DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS item_translations (
            id INTEGER PRIMARY KEY,
            category_id INTEGER NOT NULL,
            sequence INTEGER DEFAULT 0,
            language_title TEXT,
            arabic TEXT,
            translation TEXT,
            transliteration TEXT,
            is_visible INTEGER DEFAULT 1,
            english TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'editor',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            github_token TEXT
        );

        CREATE TABLE IF NOT EXISTS legacy_bookmark_map (
            source_table TEXT NOT NULL,
            legacy_id INTEGER NOT NULL,
            new_category_id INTEGER,
            new_item_id INTEGER,
            legacy_title TEXT,
            PRIMARY KEY (source_table, legacy_id)
        );

        CREATE INDEX IF NOT EXISTS idx_categories_english_name ON categories(english_name);
        CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
        CREATE INDEX IF NOT EXISTS idx_categories_sequence ON categories(sequence);
        CREATE INDEX IF NOT EXISTS idx_item_translations_category ON item_translations(category_id);
        CREATE INDEX IF NOT EXISTS idx_bookmark_new_item ON legacy_bookmark_map(new_item_id);
        CREATE INDEX IF NOT EXISTS idx_bookmark_new_cat ON legacy_bookmark_map(new_category_id);
    """)

    # Insert language
    out_cur.execute(
        "INSERT INTO languages (id, code, name, is_rtl) VALUES (?, ?, ?, ?)",
        (lang_id, lang_code, lang_name, is_rtl)
    )

    # Get categories for this language
    src_cur.execute("SELECT id FROM categories WHERE language_code = ?", (lang_code,))
    lang_cat_ids = {row[0] for row in src_cur.fetchall()}

    if not lang_cat_ids:
        print(f"  No categories found for '{lang_code}', skipping.")
        out_conn.close()
        src_conn.close()
        os.remove(output_path)
        return 0, 0

    # Include parent chain
    all_needed_ids = set(lang_cat_ids)
    for cat_id in lang_cat_ids:
        current = cat_id
        while current:
            src_cur.execute("SELECT parent_id FROM categories WHERE id = ?", (current,))
            row = src_cur.fetchone()
            if row and row[0] and row[0] not in all_needed_ids:
                all_needed_ids.add(row[0])
                current = row[0]
            else:
                break

    # Copy categories
    ids_list = list(all_needed_ids)
    placeholders = ",".join(["?"] * len(ids_list))
    src_cur.execute(f"""
        SELECT id, parent_id, sequence, lang_name, english_name,
               audio_url, video_url, duas_url, local_audio_url, local_video_url,
               is_trans, related1, related2, notify_hijri_date, label1, label2,
               is_last_level, language_code, content_source_id
        FROM categories WHERE id IN ({placeholders}) ORDER BY id
    """, ids_list)
    cat_rows = src_cur.fetchall()

    for row in cat_rows:
        out_cur.execute("""
            INSERT INTO categories
                (id, parent_id, sequence, lang_name, english_name,
                 audio_url, video_url, duas_url, local_audio_url, local_video_url,
                 is_trans, related1, related2, notify_hijri_date, label1, label2,
                 is_last_level, language_code, content_source_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)

    # Copy item_translations
    src_cur.execute(f"""
        SELECT id, category_id, sequence, language_title,
               arabic, translation, transliteration, is_visible, english
        FROM item_translations WHERE category_id IN ({placeholders}) ORDER BY id
    """, ids_list)
    item_rows = src_cur.fetchall()

    for row in item_rows:
        out_cur.execute("""
            INSERT INTO item_translations
                (id, category_id, sequence, language_title,
                 arabic, translation, transliteration, is_visible, english)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)

    # Copy users
    src_cur.execute("SELECT id, email, password_hash, role, created_at, github_token FROM users")
    for row in src_cur.fetchall():
        out_cur.execute(
            "INSERT INTO users (id, email, password_hash, role, created_at, github_token) VALUES (?, ?, ?, ?, ?, ?)",
            row
        )

    # Copy legacy_bookmark_map if exists
    try:
        src_cur.execute(
            "SELECT source_table, legacy_id, new_category_id, new_item_id, legacy_title FROM legacy_bookmark_map"
        )
        for row in src_cur.fetchall():
            out_cur.execute(
                "INSERT OR IGNORE INTO legacy_bookmark_map (source_table, legacy_id, new_category_id, new_item_id, legacy_title) VALUES (?, ?, ?, ?, ?)",
                row
            )
    except Exception:
        pass

    out_conn.commit()
    out_conn.close()
    src_conn.close()

    return len(cat_rows), len(item_rows)


def main():
    token = get_token()
    export_path = os.path.join(OUTPUT_DIR, "production_export.sqlite")

    # Step 1: Export from Turso
    print(f"Connecting to Turso production...")
    data, schemas = fetch_all_data(token)

    print(f"\nSaving full export to {export_path}...")
    create_local_db(data, schemas, export_path)
    file_size = os.path.getsize(export_path)
    print(f"  Export complete: {file_size / 1024:.1f} KB")

    # Step 2: Get languages
    local_conn = sqlite3.connect(export_path)
    languages = local_conn.execute("SELECT id, code, name, is_rtl FROM languages ORDER BY id").fetchall()

    if not languages:
        print("No languages found in production database.")
        local_conn.close()
        return

    print(f"\nFound {len(languages)} languages:")
    for lang in languages:
        print(f"  {lang[1]} ({lang[2]})")

    # Step 3: Generate per-language databases
    total_files = 0
    for lang in languages:
        lang_code = lang[1]
        output_file = os.path.join(OUTPUT_DIR, f"dna_{lang_code}.sqlite")

        print(f"\nGenerating dna_{lang_code}.sqlite ({lang[2]})...")
        cats, items = create_language_db(export_path, lang, output_file)

        if cats > 0:
            fsize = os.path.getsize(output_file)
            print(f"  {cats} categories, {items} items, {fsize / 1024:.1f} KB")
            total_files += 1
        else:
            print(f"  Skipped (no content)")

    local_conn.close()

    print(f"\nDone! Generated {total_files} language-specific databases.")
    print(f"\nFiles:")
    for f in sorted(Path(OUTPUT_DIR).glob("dna_*.sqlite")):
        size = f.stat().st_size
        print(f"  {f.name} ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
