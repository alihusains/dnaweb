#!/usr/bin/env node
/**
 * Export production Turso database and generate per-language SQLite files.
 *
 * Usage: node generate_language_dbs.js
 *
 * Reads config.js for Turso credentials, exports full database to
 * production_export.sqlite, then generates dna_{lang}.sqlite for each language.
 */

const { createClient } = require('@libsql/client');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const OUTPUT_DIR = SCRIPT_DIR;

// Read Turso credentials from config.js or env vars
function getTursoConfig() {
  // Check env vars first
  if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
    return { url: process.env.TURSO_URL, token: process.env.TURSO_TOKEN };
  }

  // Fall back to config.js (reads the first branch with a token)
  const configPath = path.join(SCRIPT_DIR, '..', 'config.js');
  const configContent = fs.readFileSync(configPath, 'utf8');

  const urlMatch = configContent.match(/url:\s*'([^']+)'/);
  const tokenMatch = configContent.match(/token:\s*'([^']+)'/);

  if (!urlMatch || !tokenMatch) {
    throw new Error('Could not find URL or Token. Set TURSO_URL and TURSO_TOKEN env vars or update config.js');
  }

  return { url: urlMatch[1], token: tokenMatch[1] };
}

// Fetch all data from Turso
async function fetchAllData(client) {
  console.log('Fetching data from Turso production...');

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  const data = {};
  for (const table of tables.rows) {
    const name = table.name;
    const result = await client.execute(`SELECT * FROM ${name}`);
    data[name] = result.rows;
    console.log(`  ${name}: ${result.rows.length} rows`);
  }

  // Also fetch schema for each table
  const schemas = {};
  for (const table of tables.rows) {
    const name = table.name;
    const schema = await client.execute(`PRAGMA table_info(${name})`);
    schemas[name] = schema.rows;
  }

  return { data, schemas };
}

// Create a local SQLite database from the fetched data
function createLocalDb(data, schemas, outputPath) {
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const db = new Database(outputPath);

  // Create tables
  for (const [tableName, columns] of Object.entries(schemas)) {
    const colDefs = columns.map(col => {
      let def = `${col.name} ${col.type || 'TEXT'}`;
      if (col.pk) def += ' PRIMARY KEY';
      if (col.notnull) def += ' NOT NULL';
      if (col.dflt_value !== null) def += ` DEFAULT ${col.dflt_value}`;
      return def;
    }).join(', ');

    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs})`);
  }

  // Insert data
  for (const [tableName, rows] of Object.entries(data)) {
    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`);

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const values = columns.map(col => row[col] ?? null);
        insert.run(...values);
      }
    });

    insertMany(rows);
  }

  // Create indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_english_name ON categories(english_name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_sequence ON categories(sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_language_code ON categories(language_code)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_item_translations_category ON item_translations(category_id)');

  db.close();
}

// Generate per-language SQLite databases
function generateLanguageDbs(sourcePath, outputDir) {
  const srcDb = new Database(sourcePath, { readonly: true });

  // Get all languages
  const languages = srcDb.prepare('SELECT id, code, name, is_rtl FROM languages ORDER BY id').all();
  console.log(`\nFound ${languages.length} languages:`);
  for (const lang of languages) {
    console.log(`  ${lang.code} (${lang.name})`);
  }

  let totalFiles = 0;

  for (const lang of languages) {
    const outputFile = path.join(outputDir, `dna_${lang.code}.sqlite`);
    console.log(`\nGenerating dna_${lang.code}.sqlite (${lang.name})...`);

    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }

    const outDb = new Database(outputFile);

    // Create schema
    outDb.exec(`
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
          id INTEGER PRIMARY KEY,
          quran_id INTEGER NOT NULL,
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
          UNIQUE(quran_id, ayat_no)
      );

      CREATE TABLE IF NOT EXISTS quran_translations (
          id INTEGER PRIMARY KEY,
          quran_id INTEGER NOT NULL,
          language_code TEXT NOT NULL,
          translation TEXT,
          transliteration TEXT,
          is_visible INTEGER DEFAULT 1,
          UNIQUE(quran_id, language_code)
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
      CREATE INDEX IF NOT EXISTS idx_events_group ON events(event_group_id);
      CREATE INDEX IF NOT EXISTS idx_events_hijri ON events(hijri_date);
      CREATE INDEX IF NOT EXISTS idx_events_language ON events(language_code);
      CREATE INDEX IF NOT EXISTS idx_quran_sura ON quran(quran_id, ayat_no);
      CREATE INDEX IF NOT EXISTS idx_quran_translations_language ON quran_translations(language_code);
      CREATE INDEX IF NOT EXISTS idx_bookmark_new_item ON legacy_bookmark_map(new_item_id);
      CREATE INDEX IF NOT EXISTS idx_bookmark_new_cat ON legacy_bookmark_map(new_category_id);
    `);

    // Insert language
    outDb.prepare('INSERT INTO languages (id, code, name, is_rtl) VALUES (?, ?, ?, ?)').run(
      lang.id, lang.code, lang.name, lang.is_rtl
    );

    // Get categories for this language
    const langCatIds = new Set(
      srcDb.prepare('SELECT id FROM categories WHERE language_code = ?').all(lang.code).map(r => r.id)
    );

    if (langCatIds.size === 0) {
      console.log(`  No categories found for '${lang.code}', skipping.`);
      outDb.close();
      fs.unlinkSync(outputFile);
      continue;
    }

    // Include parent chain
    const allNeededIds = new Set(langCatIds);
    for (const catId of langCatIds) {
      let current = catId;
      while (current) {
        const row = srcDb.prepare('SELECT parent_id FROM categories WHERE id = ?').get(current);
        if (row && row.parent_id && !allNeededIds.has(row.parent_id)) {
          allNeededIds.add(row.parent_id);
          current = row.parent_id;
        } else {
          break;
        }
      }
    }

    // Copy categories
    const catIdsList = [...allNeededIds];
    const catPlaceholders = catIdsList.map(() => '?').join(',');
    const categories = srcDb.prepare(`
      SELECT id, parent_id, sequence, lang_name, english_name,
             audio_url, video_url, duas_url, local_audio_url, local_video_url,
             is_trans, related1, related2, notify_hijri_date, label1, label2,
             is_last_level, language_code, content_source_id
      FROM categories WHERE id IN (${catPlaceholders}) ORDER BY id
    `).all(...catIdsList);

    const insertCat = outDb.prepare(`
      INSERT INTO categories
        (id, parent_id, sequence, lang_name, english_name,
         audio_url, video_url, duas_url, local_audio_url, local_video_url,
         is_trans, related1, related2, notify_hijri_date, label1, label2,
         is_last_level, language_code, content_source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertCats = outDb.transaction((rows) => {
      for (const r of rows) {
        insertCat.run(
          r.id, r.parent_id, r.sequence, r.lang_name, r.english_name,
          r.audio_url, r.video_url, r.duas_url, r.local_audio_url, r.local_video_url,
          r.is_trans, r.related1, r.related2, r.notify_hijri_date, r.label1, r.label2,
          r.is_last_level, r.language_code, r.content_source_id
        );
      }
    });
    insertCats(categories);

    // Copy item_translations
    const itemPlaceholders = catIdsList.map(() => '?').join(',');
    const items = srcDb.prepare(`
      SELECT id, category_id, sequence, language_title,
             arabic, translation, transliteration, is_visible, english
      FROM item_translations WHERE category_id IN (${itemPlaceholders}) ORDER BY id
    `).all(...catIdsList);

    const insertItem = outDb.prepare(`
      INSERT INTO item_translations
        (id, category_id, sequence, language_title,
         arabic, translation, transliteration, is_visible, english)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertItems = outDb.transaction((rows) => {
      for (const r of rows) {
        insertItem.run(
          r.id, r.category_id, r.sequence, r.language_title,
          r.arabic, r.translation, r.transliteration, r.is_visible, r.english
        );
      }
    });
    insertItems(items);

    // Copy events for this language
    let eventCount = 0;
    try {
      const events = srcDb.prepare(`
        SELECT id, event_group_id, hijri_date, date_long, color, event_type,
               deeplink_id, deeplink_id_text, link_type, sequence,
               language_code, title, description, is_visible
        FROM events WHERE language_code = ? ORDER BY sequence
      `).all(lang.code);

      if (events.length > 0) {
        const insertEvent = outDb.prepare(`
          INSERT INTO events
            (id, event_group_id, hijri_date, date_long, color, event_type,
             deeplink_id, deeplink_id_text, link_type, sequence,
             language_code, title, description, is_visible)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertEvents = outDb.transaction((rows) => {
          for (const r of rows) {
            insertEvent.run(
              r.id, r.event_group_id, r.hijri_date, r.date_long, r.color,
              r.event_type, r.deeplink_id, r.deeplink_id_text, r.link_type,
              r.sequence, r.language_code, r.title, r.description, r.is_visible
            );
          }
        });
        insertEvents(events);
        eventCount = events.length;
      }
    } catch (e) {
      // events table may not exist in production yet
    }

    // Copy quran (Arabic + shared data, language-independent)
    let quranCount = 0;
    let transCount = 0;
    try {
      const ayat = srcDb.prepare('SELECT * FROM quran ORDER BY quran_id, ayat_no').all();
      if (ayat.length > 0) {
        const insertAyat = outDb.prepare(`
          INSERT INTO quran (id, quran_id, ayat_no, arabic, is_sajda, juz_no, ruku_no, page_no,
            sura_name_ar, sura_name_guj, sura_name_en, sura_name_ur, sura_name_ro, sura_name_fa, sura_name_fr,
            sura_type, total_ayat, audio_url, video_url, sequence, is_visible)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAyatBatch = outDb.transaction((rows) => {
          for (const r of rows) {
            insertAyat.run(r.id, r.quran_id, r.ayat_no, r.arabic, r.is_sajda, r.juz_no, r.ruku_no, r.page_no,
              r.sura_name_ar, r.sura_name_guj, r.sura_name_en, r.sura_name_ur, r.sura_name_ro, r.sura_name_fa, r.sura_name_fr,
              r.sura_type, r.total_ayat, r.audio_url, r.video_url, r.sequence, r.is_visible);
          }
        });
        insertAyatBatch(ayat);
        quranCount = ayat.length;
      }

      const translations = srcDb.prepare('SELECT * FROM quran_translations WHERE language_code = ? ORDER BY quran_id').all(lang.code);
      if (translations.length > 0) {
        const insertTrans = outDb.prepare(`
          INSERT INTO quran_translations (id, quran_id, language_code, translation, transliteration, is_visible)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertTransBatch = outDb.transaction((rows) => {
          for (const r of rows) {
            insertTrans.run(r.id, r.quran_id, r.language_code, r.translation, r.transliteration, r.is_visible);
          }
        });
        insertTransBatch(translations);
        transCount = translations.length;
      }
    } catch (e) {
      // quran tables may not exist yet
    }

    // Copy users
    const users = srcDb.prepare('SELECT id, email, password_hash, role, created_at, github_token FROM users').all();
    const insertUser = outDb.prepare(
      'INSERT INTO users (id, email, password_hash, role, created_at, github_token) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertUsers = outDb.transaction((rows) => {
      for (const r of rows) {
        insertUser.run(r.id, r.email, r.password_hash, r.role, r.created_at, r.github_token);
      }
    });
    insertUsers(users);

    // Copy legacy_bookmark_map if it exists
    try {
      const bookmarks = srcDb.prepare(
        'SELECT source_table, legacy_id, new_category_id, new_item_id, legacy_title FROM legacy_bookmark_map'
      ).all();
      if (bookmarks.length > 0) {
        const insertBookmark = outDb.prepare(
          'INSERT OR IGNORE INTO legacy_bookmark_map (source_table, legacy_id, new_category_id, new_item_id, legacy_title) VALUES (?, ?, ?, ?, ?)'
        );
        const insertBookmarks = outDb.transaction((rows) => {
          for (const r of rows) {
            insertBookmark.run(r.source_table, r.legacy_id, r.new_category_id, r.new_item_id, r.legacy_title);
          }
        });
        insertBookmarks(bookmarks);
      }
    } catch (e) {
      // legacy_bookmark_map may not exist in production
    }

    outDb.close();

    const fileSize = fs.statSync(outputFile).size;
    console.log(`  ${categories.length} categories, ${items.length} items, ${eventCount} events, ${quranCount} suras, ${transCount} quran ayat, ${(fileSize / 1024).toFixed(1)} KB`);
    totalFiles++;
  }

  srcDb.close();

  console.log(`\nDone! Generated ${totalFiles} language-specific databases.`);

  // List generated files
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('dna_') && f.endsWith('.sqlite'))
    .sort();
  console.log('\nFiles:');
  for (const f of files) {
    const size = fs.statSync(path.join(outputDir, f)).size;
    console.log(`  ${f} (${(size / 1024).toFixed(1)} KB)`);
  }
}

// Main
async function main() {
  try {
    // Step 1: Fetch from Turso
    const config = getTursoConfig();
    const client = createClient({ url: config.url, authToken: config.token });

    const { data, schemas } = await fetchAllData(client);

    // Step 2: Save full export
    const exportPath = path.join(OUTPUT_DIR, 'production_export.sqlite');
    console.log(`\nSaving full export to ${exportPath}...`);
    createLocalDb(data, schemas, exportPath);
    const exportSize = fs.statSync(exportPath).size;
    console.log(`  Export complete: ${(exportSize / 1024).toFixed(1)} KB`);

    // Step 3: Generate per-language databases
    generateLanguageDbs(exportPath, OUTPUT_DIR);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
