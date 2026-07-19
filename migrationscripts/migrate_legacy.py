#!/usr/bin/env python3
"""
Migrate legacy.sqlite to production schema format with ID preservation.

Legacy tables:
  - v2: 3-level hierarchy (level1/level2/level3) with Gujarati content
  - quran_final: Quran verses with Arabic, Gujarati, transliteration
  - events: Islamic calendar events

Production tables:
  - categories: Self-referencing hierarchy (parent_id), multi-language
  - item_translations: Quad-column (arabic, transliteration, translation, english)
  - languages: Language definitions
  - users: Admin users (not migrated)

Backward compatibility:
  - v2.id is preserved as item_translations.id (ayat_id starts from 1 for quran)
  - legacy_bookmark_map table maps (source_table, legacy_id) → new item_translations.id
  - Apps can query: SELECT new_id FROM legacy_bookmark_map WHERE source='v2' AND legacy_id=?
"""

import sqlite3
import os
from pathlib import Path

LEGACY_DB = "legacy.sqlite"
OUTPUT_DB = "migrated.sqlite"


def create_production_schema(conn):
    """Create production schema in the output database."""
    cur = conn.cursor()

    cur.executescript("""
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

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY,
            event_group_id INTEGER NOT NULL,
            hijri_date TEXT,
            date_long TEXT,
            color TEXT,
            event_type TEXT,
            deeplink_id TEXT,
            deeplink_id_text TEXT,
            link_type TEXT,
            sequence INTEGER DEFAULT 0,
            language_code TEXT NOT NULL DEFAULT 'gu',
            title TEXT,
            description TEXT,
            is_visible INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS quran (
            ayat_id INTEGER PRIMARY KEY,
            sura_id INTEGER NOT NULL,
            ayat_no INTEGER NOT NULL,
            arabic TEXT,
            is_sajda INTEGER DEFAULT 0,
            juz_no INTEGER,
            ruku_no INTEGER,
            page_no INTEGER,
            sura_name_ar TEXT,
            sura_name_guj TEXT,
            sura_name_en TEXT,
            sura_name_ur TEXT,
            sura_name_ro TEXT,
            sura_name_fa TEXT,
            sura_name_fr TEXT,
            sura_type TEXT,
            total_ayat INTEGER,
            audio_url TEXT,
            video_url TEXT,
            sequence INTEGER DEFAULT 0,
            is_visible INTEGER DEFAULT 1,
            UNIQUE(sura_id, ayat_no)
        );

        CREATE TABLE IF NOT EXISTS quran_translations (
            id INTEGER PRIMARY KEY,
            ayat_id INTEGER NOT NULL,
            language_code TEXT NOT NULL,
            translation TEXT,
            transliteration TEXT,
            is_visible INTEGER DEFAULT 1,
            UNIQUE(ayat_id, language_code)
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
        CREATE INDEX IF NOT EXISTS idx_bookmark_new_item ON legacy_bookmark_map(new_item_id);
        CREATE INDEX IF NOT EXISTS idx_bookmark_new_cat ON legacy_bookmark_map(new_category_id);
        CREATE INDEX IF NOT EXISTS idx_events_group ON events(event_group_id);
        CREATE INDEX IF NOT EXISTS idx_events_hijri ON events(hijri_date);
        CREATE INDEX IF NOT EXISTS idx_events_language ON events(language_code);
        CREATE INDEX IF NOT EXISTS idx_quran_sura ON quran(sura_id, ayat_no);
        CREATE INDEX IF NOT EXISTS idx_quran_translations_language ON quran_translations(language_code);
    """)

    # Match production languages (IDs 1,2,5,6,7)
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (1, 'gu', 'Gujarati', 0)")
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (2, 'en', 'English', 0)")
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (5, 'ur', 'Urdu', 1)")
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (6, 'ro', 'Roman Urdu', 0)")
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (7, 'az', 'Azerbaijani', 0)")

    conn.commit()


def get_or_create_category(cur, categories_cache, parent_id, lang_name, english_name,
                           sequence=0, is_last_level=0, language_code='gu', **extra):
    """Get existing category ID or create new one. Returns category ID."""
    cache_key = (parent_id, lang_name, english_name, language_code)
    if cache_key in categories_cache:
        return categories_cache[cache_key]

    cur.execute("""
        INSERT INTO categories (parent_id, sequence, lang_name, english_name,
            audio_url, video_url, duas_url, local_audio_url, local_video_url,
            is_trans, is_last_level, language_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        parent_id, sequence, lang_name, english_name,
        extra.get('audio_url'), extra.get('video_url'), extra.get('duas_url'),
        extra.get('local_audio_url'), extra.get('local_video_url'),
        extra.get('is_trans', 0), is_last_level, language_code
    ))

    cat_id = cur.lastrowid
    categories_cache[cache_key] = cat_id
    return cat_id


def migrate_v2(legacy_conn, output_conn):
    """Migrate v2 table → categories + item_translations with preserved IDs."""
    print("Migrating v2 (duas, ziyarat, namaz)...")
    legacy_cur = legacy_conn.cursor()
    output_cur = output_conn.cursor()

    legacy_cur.execute("""
        SELECT id, l1position, l2position, l3position,
               level1, level2, level3, Title,
               gujTransliteration, gujTranslation, gujArabic,
               audioUrl, videoUrl, duas_url
        FROM v2
        ORDER BY
            CASE WHEN l1position = '' OR l1position IS NULL THEN 9999 ELSE CAST(l1position AS INTEGER) END,
            CASE WHEN l2position = '' OR l2position IS NULL THEN 9999 ELSE CAST(l2position AS INTEGER) END,
            CASE WHEN l3position = '' OR l3position IS NULL THEN 9999 ELSE CAST(l3position AS INTEGER) END,
            CAST(id AS INTEGER)
    """)
    rows = legacy_cur.fetchall()

    categories_cache = {}
    level1_cache = {}
    level2_cache = {}
    migrated_items = 0
    migrated_categories = 0

    for row in rows:
        (row_id, l1pos, l2pos, l3pos,
         level1, level2, level3, title,
         guj_transliteration, guj_translation, guj_arabic,
         audio_url, video_url, duas_url) = row

        legacy_id = int(row_id) if row_id and str(row_id).isdigit() else 0
        level1 = (level1 or '').strip()
        level2 = (level2 or '').strip()
        level3 = (level3 or '').strip()
        title = (title or '').strip()

        if not level1:
            continue

        # Level 1 category
        if level1 not in level1_cache:
            l1_seq = int(l1pos) if l1pos and l1pos.isdigit() else 0
            cat_id = get_or_create_category(
                output_cur, categories_cache,
                parent_id=None,
                lang_name=level1,
                english_name=level1,
                sequence=l1_seq,
                is_last_level=0,
                language_code='gu'
            )
            level1_cache[level1] = cat_id
            migrated_categories += 1

        parent_id = level1_cache[level1]

        # Level 2 category
        l2_key = (level1, level2)
        if level2 and l2_key not in level2_cache:
            l2_seq = int(l2pos) if l2pos and l2pos.isdigit() else 0
            cat_id = get_or_create_category(
                output_cur, categories_cache,
                parent_id=parent_id,
                lang_name=level2,
                english_name=level2,
                sequence=l2_seq,
                is_last_level=0,
                language_code='gu',
                audio_url=audio_url if not level3 else None,
                video_url=video_url if not level3 else None,
                duas_url=duas_url if not level3 else None,
                is_trans=1 if (guj_arabic or guj_translation) and not level3 else 0
            )
            level2_cache[l2_key] = cat_id
            migrated_categories += 1

        if level2:
            parent_id = level2_cache[l2_key]

        # Level 3 category or leaf
        if level3:
            l3_key = (level1, level2, level3)
            l3_seq = int(l3pos) if l3pos and l3pos.isdigit() else 0

            if l3_key not in categories_cache:
                cat_id = get_or_create_category(
                    output_cur, categories_cache,
                    parent_id=parent_id,
                    lang_name=level3,
                    english_name=level3,
                    sequence=l3_seq,
                    is_last_level=1,
                    language_code='gu',
                    audio_url=audio_url,
                    video_url=video_url,
                    duas_url=duas_url,
                    is_trans=1 if (guj_arabic or guj_translation) else 0
                )
                level2_cache[l3_key] = cat_id
                migrated_categories += 1

            content_cat_id = level2_cache[l3_key]
        elif not level2:
            content_cat_id = parent_id
        else:
            content_cat_id = parent_id

        # Insert item_translation with PRESERVED legacy ID
        has_content = any([title, guj_arabic, guj_transliteration, guj_translation])
        if has_content:
            output_cur.execute(
                "SELECT COALESCE(MAX(sequence), 0) FROM item_translations WHERE category_id = ?",
                (content_cat_id,)
            )
            next_seq = output_cur.fetchone()[0] + 1

            # Check if this legacy_id already exists (duplicate in legacy data)
            output_cur.execute("SELECT id FROM item_translations WHERE id = ?", (legacy_id,))
            if output_cur.fetchone():
                # Duplicate legacy ID — assign a new ID in the v2 safe range
                # v2 IDs go up to ~1100, use 2000+ for overflow
                overflow_id = 2000
                while True:
                    output_cur.execute("SELECT id FROM item_translations WHERE id = ?", (overflow_id,))
                    if not output_cur.fetchone():
                        break
                    overflow_id += 1
                new_id = overflow_id
            else:
                new_id = legacy_id

            output_cur.execute("""
                INSERT INTO item_translations
                    (id, category_id, sequence, language_title, arabic, transliteration, translation, english, is_visible)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            """, (
                new_id,
                content_cat_id, next_seq,
                title or None,
                guj_arabic or None,
                guj_transliteration or None,
                guj_translation or None,
                None
            ))

            # Record in bookmark map (both legacy_id and new_id if different)
            output_cur.execute("""
                INSERT OR REPLACE INTO legacy_bookmark_map
                    (source_table, legacy_id, new_category_id, new_item_id, legacy_title)
                VALUES (?, ?, ?, ?, ?)
            """, ('v2', legacy_id, content_cat_id, new_id, title or level3 or level2 or level1))

            migrated_items += 1

    output_conn.commit()
    print(f"  v2: {migrated_categories} categories, {migrated_items} translation items (IDs preserved)")
    return migrated_categories, migrated_items


def migrate_quran(legacy_conn, output_conn):
    """Migrate quran_final table → quran + quran_translations tables."""
    print("Migrating quran_final...")
    legacy_cur = legacy_conn.cursor()
    output_cur = output_conn.cursor()

    legacy_cur.execute("""
        SELECT id, sura_id, ayat_no, ayat_ar, ayat_guj, transliteration,
               ayat_notes, sura_name_guj, sura_name_ar, ayat_sajda,
               juz_no, ruku_no, page_no, sura_type, sura_ayat,
               surawise_audio, video, juz_audio_1, juz_audio_2
        FROM quran_final
        ORDER BY CAST(sura_id AS INTEGER), CAST(ayat_no AS INTEGER)
    """)
    rows = legacy_cur.fetchall()

    sura_cache = {}
    migrated_suras = 0
    migrated_ayat = 0
    ayat_id_counter = 0

    for row in rows:
        (row_id, sura_id, ayat_no, ayat_ar, ayat_guj, transliteration,
         ayat_notes, sura_name_guj, sura_name_ar, ayat_sajda,
         juz_no, ruku_no, page_no, sura_type, sura_ayat,
         surawise_audio, video, juz_audio_1, juz_audio_2) = row

        legacy_id = int(row_id) if row_id and str(row_id).isdigit() else 0
        sura_id_int = int(sura_id) if sura_id and str(sura_id).isdigit() else 0
        ayat_no_int = int(ayat_no) if ayat_no and str(ayat_no).isdigit() else 0

        # Insert ayat into quran table (per-ayat with Arabic + shared metadata)
        ayat_id_counter += 1

        # Cache sura metadata for reuse
        if sura_id_int not in sura_cache:
            sura_cache[sura_id_int] = {
                'sura_name_ar': (sura_name_ar or '').strip() or None,
                'sura_name_guj': (sura_name_guj or '').strip() or f'Sura {sura_id_int}',
                'sura_type': sura_type or None,
                'total_ayat': int(sura_ayat) if sura_ayat and str(sura_ayat).isdigit() else None,
                'audio_url': surawise_audio or None,
                'video_url': video or None,
            }
            migrated_suras += 1

        sm = sura_cache[sura_id_int]

        output_cur.execute("""
            INSERT INTO quran
                (ayat_id, sura_id, ayat_no, arabic, is_sajda, juz_no, ruku_no, page_no,
                 sura_name_ar, sura_name_guj, sura_name_en, sura_name_ur, sura_name_ro,
                 sura_name_fa, sura_name_fr, sura_type, total_ayat, audio_url, video_url,
                 sequence, is_visible)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 1)
        """, (
            ayat_id_counter,
            sura_id_int,
            ayat_no_int,
            ayat_ar or None,
            int(ayat_sajda) if ayat_sajda and str(ayat_sajda).isdigit() else 0,
            int(juz_no) if juz_no and str(juz_no).isdigit() else None,
            int(ruku_no) if ruku_no and str(ruku_no).isdigit() else None,
            int(page_no) if page_no and str(page_no).isdigit() else None,
            sm['sura_name_ar'],
            sm['sura_name_guj'],
            sm['sura_type'],
            sm['total_ayat'],
            sm['audio_url'],
            sm['video_url'],
            ayat_no_int,
        ))

        # Insert translation (language-specific only)
        output_cur.execute("""
            INSERT INTO quran_translations
                (ayat_id, language_code, translation, transliteration, is_visible)
            VALUES (?, 'gu', ?, ?, 1)
        """, (
            ayat_id_counter,
            ayat_guj or None,
            transliteration or None,
        ))

        # Record in bookmark map for backward compatibility
        output_cur.execute("""
            INSERT OR REPLACE INTO legacy_bookmark_map
                (source_table, legacy_id, new_category_id, new_item_id, legacy_title)
            VALUES (?, ?, NULL, ?, ?)
        """, ('quran_final', legacy_id, ayat_id_counter, f'Sura {sura_id_int} Ayat {ayat_no_int}'))

        migrated_ayat += 1

    output_conn.commit()
    print(f"  quran_final: {migrated_suras} suras, {migrated_ayat} ayat items")
    return 0, migrated_ayat


def migrate_events(legacy_conn, output_conn):
    """Migrate events table → dedicated events table."""
    print("Migrating events...")
    legacy_cur = legacy_conn.cursor()
    output_cur = output_conn.cursor()

    legacy_cur.execute("""
        SELECT rowid, date, date_long, event, color, deeplink_id_text,
               link_type, deeplink_id, event_type
        FROM events
        ORDER BY date
    """)
    rows = legacy_cur.fetchall()

    migrated_events = 0
    event_group_id = 0

    for row in rows:
        (rowid, date, date_long, event, color, deeplink_id_text,
         link_type, deeplink_id, event_type) = row

        event = (event or '').strip()
        date_long = (date_long or '').strip()
        date = (date or '').strip()

        if not event:
            continue

        event_group_id += 1

        output_cur.execute("""
            INSERT INTO events
                (event_group_id, hijri_date, date_long, color, event_type,
                 deeplink_id, deeplink_id_text, link_type, sequence,
                 language_code, title, description, is_visible)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'gu', ?, NULL, 1)
        """, (
            event_group_id,
            date or None,
            date_long or None,
            color or None,
            event_type or None,
            deeplink_id or None,
            deeplink_id_text or None,
            link_type or None,
            migrated_events + 1,
            event,
        ))

        migrated_events += 1

    output_conn.commit()
    print(f"  events: {migrated_events} event rows (dedicated events table)")
    return 0, migrated_events


def print_bookmark_examples(output_conn):
    """Show sample bookmark mappings for verification."""
    cur = output_conn.cursor()
    print("\n--- Bookmark mapping samples ---")
    cur.execute("""
        SELECT source_table, legacy_id, new_item_id, legacy_title
        FROM legacy_bookmark_map
        WHERE source_table = 'v2'
        LIMIT 5
    """)
    print("v2 bookmarks:")
    for row in cur.fetchall():
        print(f"  legacy v2.id={row[1]} → item_translations.id={row[2]} | {row[3][:50]}")

    cur.execute("""
        SELECT source_table, legacy_id, new_item_id, legacy_title
        FROM legacy_bookmark_map
        WHERE source_table = 'quran_final'
        LIMIT 5
    """)
    print("quran_final bookmarks:")
    for row in cur.fetchall():
        print(f"  legacy quran.id={row[1]} → item_translations.id={row[2]} | {row[3]}")


def main():
    legacy_path = Path(LEGACY_DB)
    output_path = Path(OUTPUT_DB)

    if not legacy_path.exists():
        print(f"Error: {LEGACY_DB} not found in current directory")
        return

    if output_path.exists():
        os.remove(output_path)
        print(f"Removed existing {OUTPUT_DB}")

    legacy_conn = sqlite3.connect(str(legacy_path))
    output_conn = sqlite3.connect(str(output_path))

    try:
        print("Creating production schema...")
        create_production_schema(output_conn)

        total_cats = 0
        total_items = 0

        c, i = migrate_v2(legacy_conn, output_conn)
        total_cats += c
        total_items += i

        c, i = migrate_quran(legacy_conn, output_conn)
        total_cats += c
        total_items += i

        c, i = migrate_events(legacy_conn, output_conn)
        total_cats += c
        total_items += i

        print(f"\nMigration complete!")
        print(f"  Output: {OUTPUT_DB}")
        print(f"  Total categories: {total_cats}")
        print(f"  Total translation items: {total_items}")

        # Verify
        cur = output_conn.cursor()
        for table in ['categories', 'item_translations', 'events', 'quran', 'quran_translations', 'languages', 'legacy_bookmark_map']:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            count = cur.fetchone()[0]
            print(f"  {table}: {count} rows")

        print_bookmark_examples(output_conn)

        # Show example queries for new schema
        print("\n--- Example queries ---")
        print("-- Fetch Quran for a language:")
        print("  SELECT q.ayat_id, q.sura_id, q.ayat_no, q.arabic,")
        print("         q.sura_name_ar, q.sura_name_guj, q.sura_name_en,")
        print("         q.sura_type, q.juz_no, q.ruku_no, q.page_no, q.is_sajda,")
        print("         t.translation, t.transliteration")
        print("  FROM quran q")
        print("  JOIN quran_translations t ON q.ayat_id = t.ayat_id")
        print("  WHERE t.language_code = 'gu'")
        print("  ORDER BY q.sura_id, q.ayat_no;")
        print("")
        print("-- Fetch all events for a language:")
        print("  SELECT * FROM events WHERE language_code = 'gu' ORDER BY sequence;")
        print("")
        print("-- Fetch bookmarks:")
        print("  SELECT new_item_id FROM legacy_bookmark_map")
        print("  WHERE source_table='v2' AND legacy_id=<old_bookmark_id>;")
        print("  SELECT new_item_id FROM legacy_bookmark_map")
        print("  WHERE source_table='quran_final' AND legacy_id=<old_bookmark_id>;")

    finally:
        legacy_conn.close()
        output_conn.close()


if __name__ == "__main__":
    main()
