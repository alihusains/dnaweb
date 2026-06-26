#!/usr/bin/env python3
"""
Generate language-specific SQLite databases from migrated.sqlite.

Reads the migrated database and creates per-language files:
  dna_gu.sqlite  (Gujarati)
  dna_en.sqlite  (English)
  dna_ur.sqlite  (Urdu)
  dna_ro.sqlite  (Roman Urdu)
  dna_az.sqlite  (Azerbaijani)

Each output contains:
  - categories: filtered by language_code
  - item_translations: only for categories in that language
  - languages: single row for that language
  - legacy_bookmark_map: full copy for bookmark resolution
  - users: full copy
"""

import sqlite3
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SOURCE_DB = str(SCRIPT_DIR / "migrated.sqlite")
OUTPUT_DIR = str(SCRIPT_DIR)


def get_languages(conn):
    """Get all languages from the source database."""
    cur = conn.cursor()
    cur.execute("SELECT id, code, name, is_rtl FROM languages ORDER BY id")
    return cur.fetchall()


def create_language_db(source_conn, language, output_path):
    """Create a language-specific database."""
    lang_id, lang_code, lang_name, is_rtl = language

    if os.path.exists(output_path):
        os.remove(output_path)

    out_conn = sqlite3.connect(output_path)
    out_cur = out_conn.cursor()
    src_cur = source_conn.cursor()

    # Create tables (same schema as production)
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

    # Insert this language
    out_cur.execute(
        "INSERT INTO languages (id, code, name, is_rtl) VALUES (?, ?, ?, ?)",
        (lang_id, lang_code, lang_name, is_rtl)
    )

    # Get all category IDs for this language
    src_cur.execute(
        "SELECT id FROM categories WHERE language_code = ?",
        (lang_code,)
    )
    lang_cat_ids = {row[0] for row in src_cur.fetchall()}

    if not lang_cat_ids:
        print(f"  No categories found for language '{lang_code}', skipping.")
        out_conn.close()
        os.remove(output_path)
        return 0, 0

    # Also include parent categories that might be in a different language
    # (e.g., a 'gu' category whose parent is also 'gu' but we need the full tree)
    # Collect all ancestor IDs
    all_needed_ids = set(lang_cat_ids)
    for cat_id in lang_cat_ids:
        src_cur.execute("SELECT parent_id FROM categories WHERE id = ?", (cat_id,))
        row = src_cur.fetchone()
        while row and row[0] is not None:
            parent_id = row[0]
            if parent_id not in all_needed_ids:
                all_needed_ids.add(parent_id)
                src_cur.execute("SELECT parent_id FROM categories WHERE id = ?", (parent_id,))
                row = src_cur.fetchone()
            else:
                break

    # Copy categories
    placeholders = ','.join('?' * len(all_needed_ids))
    src_cur.execute(f"""
        SELECT id, parent_id, sequence, lang_name, english_name,
               audio_url, video_url, duas_url, local_audio_url, local_video_url,
               is_trans, related1, related2, notify_hijri_date, label1, label2,
               is_last_level, language_code, content_source_id
        FROM categories
        WHERE id IN ({placeholders})
        ORDER BY id
    """, list(all_needed_ids))

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

    # Copy item_translations for these categories
    src_cur.execute(f"""
        SELECT id, category_id, sequence, language_title,
               arabic, translation, transliteration, is_visible, english
        FROM item_translations
        WHERE category_id IN ({placeholders})
        ORDER BY id
    """, list(all_needed_ids))

    item_rows = src_cur.fetchall()
    for row in item_rows:
        out_cur.execute("""
            INSERT INTO item_translations
                (id, category_id, sequence, language_title,
                 arabic, translation, transliteration, is_visible, english)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)

    # Copy full bookmark map (for cross-language bookmark resolution)
    src_cur.execute("""
        SELECT source_table, legacy_id, new_category_id, new_item_id, legacy_title
        FROM legacy_bookmark_map
    """)
    for row in src_cur.fetchall():
        out_cur.execute("""
            INSERT OR IGNORE INTO legacy_bookmark_map
                (source_table, legacy_id, new_category_id, new_item_id, legacy_title)
            VALUES (?, ?, ?, ?, ?)
        """, row)

    # Copy users
    src_cur.execute("""
        SELECT id, email, password_hash, role, created_at, github_token
        FROM users
    """)
    for row in src_cur.fetchall():
        out_cur.execute("""
            INSERT INTO users (id, email, password_hash, role, created_at, github_token)
            VALUES (?, ?, ?, ?, ?, ?)
        """, row)

    out_conn.commit()
    out_conn.close()

    return len(cat_rows), len(item_rows)


def main():
    # Allow override via command-line argument
    source = sys.argv[1] if len(sys.argv) > 1 else SOURCE_DB
    source_path = Path(source)
    if not source_path.exists():
        print(f"Error: {source} not found. Run migrate_legacy.py first.")
        return

    source_conn = sqlite3.connect(str(source_path))
    languages = get_languages(source_conn)

    if not languages:
        print("No languages found in source database.")
        source_conn.close()
        return

    print(f"Found {len(languages)} languages in {SOURCE_DB}:")
    for lang in languages:
        print(f"  {lang[1]} ({lang[2]})")
    print()

    total_files = 0
    for lang in languages:
        lang_code = lang[1]
        output_file = os.path.join(OUTPUT_DIR, f"dna_{lang_code}.sqlite")

        print(f"Generating dna_{lang_code}.sqlite ({lang[2]})...")
        cats, items = create_language_db(source_conn, lang, output_file)

        if cats > 0:
            file_size = os.path.getsize(output_file)
            print(f"  {cats} categories, {items} items, {file_size / 1024:.1f} KB")
            total_files += 1
        else:
            print(f"  Skipped (no content)")

    source_conn.close()

    print(f"\nDone! Generated {total_files} language-specific databases.")
    print(f"\nFiles:")
    for f in sorted(Path(OUTPUT_DIR).glob("dna_*.sqlite")):
        size = f.stat().st_size
        print(f"  {f.name} ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
