#!/usr/bin/env python3
"""
Migrate legacy.sqlite to production schema format.

Legacy tables:
  - v2: 3-level hierarchy (level1/level2/level3) with Gujarati content
  - quran_final: Quran verses with Arabic, Gujarati, transliteration
  - events: Islamic calendar events

Production tables:
  - categories: Self-referencing hierarchy (parent_id), multi-language
  - item_translations: Quad-column (arabic, transliteration, translation, english)
  - languages: Language definitions
  - users: Admin users (not migrated)
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
            language_code TEXT DEFAULT 'en',
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
            role TEXT NOT NULL DEFAULT 'editor',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            github_token TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
        CREATE INDEX IF NOT EXISTS idx_categories_sequence ON categories(sequence);
        CREATE INDEX IF NOT EXISTS idx_categories_language_code ON categories(language_code);
        CREATE INDEX IF NOT EXISTS idx_categories_english_name ON categories(english_name);
        CREATE INDEX IF NOT EXISTS idx_item_translations_category ON item_translations(category_id);
        CREATE INDEX IF NOT EXISTS idx_item_translations_sequence ON item_translations(category_id, sequence);
    """)

    # Insert default language
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (1, 'gu', 'Gujarati', 0)")
    cur.execute("INSERT INTO languages (id, code, name, is_rtl) VALUES (2, 'en', 'English', 0)")

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
    """Migrate v2 table → categories + item_translations."""
    print("Migrating v2 (duas, ziyarat, namaz)...")
    legacy_cur = legacy_conn.cursor()
    output_cur = output_conn.cursor()

    # Fetch all v2 rows ordered by position
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

    categories_cache = {}  # (parent_id, lang_name, english_name, lang_code) → id
    level1_cache = {}      # level1 name → category_id
    level2_cache = {}      # (level1_name, level2_name) → category_id
    migrated_items = 0
    migrated_categories = 0

    for row in rows:
        (row_id, l1pos, l2pos, l3pos,
         level1, level2, level3, title,
         guj_transliteration, guj_translation, guj_arabic,
         audio_url, video_url, duas_url) = row

        level1 = (level1 or '').strip()
        level2 = (level2 or '').strip()
        level3 = (level3 or '').strip()
        title = (title or '').strip()

        if not level1:
            continue

        # Level 1 category (top-level)
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

        # Level 2 category (if exists)
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

        # Level 3 category or leaf content
        if level3:
            l3_key = (level1, level2, level3)
            l3_seq = int(l3pos) if l3pos and l3pos.isdigit() else 0

            # Check if this level3 already exists
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
                level2_cache[l3_key] = cat_id  # reuse for content lookup
                migrated_categories += 1

            content_cat_id = level2_cache[l3_key]
        elif not level2:
            # Direct under level1, no level2 or level3
            content_cat_id = parent_id
        else:
            content_cat_id = parent_id

        # Create item_translation if content exists
        has_content = any([title, guj_arabic, guj_transliteration, guj_translation])
        if has_content:
            # Get next sequence for this category
            output_cur.execute(
                "SELECT COALESCE(MAX(sequence), 0) FROM item_translations WHERE category_id = ?",
                (content_cat_id,)
            )
            next_seq = output_cur.fetchone()[0] + 1

            output_cur.execute("""
                INSERT INTO item_translations
                    (category_id, sequence, language_title, arabic, transliteration, translation, english, is_visible)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """, (
                content_cat_id, next_seq,
                title or None,
                guj_arabic or None,
                guj_transliteration or None,
                guj_translation or None,
                None  # english not in legacy
            ))
            migrated_items += 1

    output_conn.commit()
    print(f"  v2: {migrated_categories} categories, {migrated_items} translation items created")
    return migrated_categories, migrated_items


def migrate_quran(legacy_conn, output_conn):
    """Migrate quran_final table → categories + item_translations."""
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

    # Create top-level "Quran" category
    output_cur.execute("""
        INSERT INTO categories (parent_id, sequence, lang_name, english_name,
            is_trans, is_last_level, language_code)
        VALUES (NULL, 99, 'કુરઆન', 'Quran', 0, 0, 'gu')
    """)
    quran_root_id = output_cur.lastrowid

    sura_cache = {}  # sura_id → category_id
    migrated_items = 0
    migrated_categories = 1  # root

    for row in rows:
        (row_id, sura_id, ayat_no, ayat_ar, ayat_guj, transliteration,
         ayat_notes, sura_name_guj, sura_name_ar, ayat_sajda,
         juz_no, ruku_no, page_no, sura_type, sura_ayat,
         surawise_audio, video, juz_audio_1, juz_audio_2) = row

        sura_id_str = str(sura_id).strip() if sura_id else '0'
        sura_name_guj = (sura_name_guj or '').strip()
        sura_name_ar = (sura_name_ar or '').strip()

        # Create per-sura category if not exists
        if sura_id_str not in sura_cache:
            output_cur.execute("""
                INSERT INTO categories (parent_id, sequence, lang_name, english_name,
                    audio_url, video_url, is_trans, is_last_level, language_code)
                VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'gu')
            """, (
                quran_root_id,
                int(sura_id_str) if sura_id_str.isdigit() else 0,
                sura_name_guj or f'Sura {sura_id_str}',
                sura_name_ar or f'Sura {sura_id_str}',
                surawise_audio or None,
                video or None,
            ))
            sura_cache[sura_id_str] = output_cur.lastrowid
            migrated_categories += 1

        cat_id = sura_cache[sura_id_str]

        # Insert ayat as translation item
        output_cur.execute("""
            INSERT INTO item_translations
                (category_id, sequence, language_title, arabic, transliteration, translation, english, is_visible)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            cat_id,
            int(ayat_no) if ayat_no and str(ayat_no).isdigit() else 0,
            f'Ayat {ayat_no}' if ayat_no else None,
            ayat_ar or None,
            transliteration or None,
            ayat_guj or None,
            ayat_notes or None,
        ))
        migrated_items += 1

    output_conn.commit()
    print(f"  quran_final: {migrated_categories} categories, {migrated_items} ayat items created")
    return migrated_categories, migrated_items


def migrate_events(legacy_conn, output_conn):
    """Migrate events table → categories + item_translations."""
    print("Migrating events...")
    legacy_cur = legacy_conn.cursor()
    output_cur = output_conn.cursor()

    legacy_cur.execute("""
        SELECT date, date_long, event, color, deeplink_id_text,
               link_type, deeplink_id, event_type
        FROM events
        ORDER BY date
    """)
    rows = legacy_cur.fetchall()

    # Create top-level "Events" category
    output_cur.execute("""
        INSERT INTO categories (parent_id, sequence, lang_name, english_name,
            is_trans, is_last_level, language_code)
        VALUES (NULL, 100, 'ઇવેન્ટ્સ', 'Events', 0, 0, 'gu')
    """)
    events_root_id = output_cur.lastrowid
    migrated_categories = 1
    migrated_items = 0

    for row in rows:
        (date, date_long, event, color, deeplink_id_text,
         link_type, deeplink_id, event_type) = row

        event = (event or '').strip()
        date_long = (date_long or '').strip()
        date = (date or '').strip()

        if not event:
            continue

        # Each event becomes a leaf category with translation
        output_cur.execute("""
            INSERT INTO categories (parent_id, sequence, lang_name, english_name,
                notify_hijri_date, is_trans, is_last_level, language_code)
            VALUES (?, ?, ?, ?, ?, 1, 1, 'gu')
        """, (
            events_root_id,
            migrated_categories,
            date_long or date,
            event[:100],  # english_name is shorter
            date,
        ))
        cat_id = output_cur.lastrowid
        migrated_categories += 1

        # Event detail as translation
        output_cur.execute("""
            INSERT INTO item_translations
                (category_id, sequence, language_title, arabic, translation, is_visible)
            VALUES (?, 1, ?, ?, ?, 1)
        """, (
            cat_id,
            date_long or date,
            None,
            event,
        ))
        migrated_items += 1

    output_conn.commit()
    print(f"  events: {migrated_categories} categories, {migrated_items} event items created")
    return migrated_categories, migrated_items


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
        for table in ['categories', 'item_translations', 'languages']:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            count = cur.fetchone()[0]
            print(f"  {table}: {count} rows")

    finally:
        legacy_conn.close()
        output_conn.close()


if __name__ == "__main__":
    main()
