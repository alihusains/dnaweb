import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';

const VERSION = process.env.DB_VERSION;
const BRANCH = process.env.DB_BRANCH;
const PASSWORD = process.env.DB_PASSWORD;
const OUTPUT_DIR = 'release_files';

if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function main() {
  const turso = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN
  });

  console.log(`Generating v${VERSION} from ${BRANCH} branch`);

  console.log('\n--- Fetching data from Turso ---');
  const data = {};
  for (const table of ['languages', 'categories', 'item_translations']) {
    const result = await turso.execute(`SELECT * FROM ${table}`);
    data[table] = result.rows;
    console.log(`  ${table}: ${result.rows.length} rows`);
  }
  try {
    data.legacy_bookmark_map = (await turso.execute('SELECT * FROM legacy_bookmark_map')).rows;
    console.log(`  legacy_bookmark_map: ${data.legacy_bookmark_map.length} rows`);
  } catch { console.log('  legacy_bookmark_map: not found'); }

  // Full database
  console.log('\n--- Generating full database ---');
  createFullDb(`${OUTPUT_DIR}/database.sqlite`, data);
  encrypt(`${OUTPUT_DIR}/database.sqlite`);
  console.log(`  database.sqlite: ${(fs.statSync(`${OUTPUT_DIR}/database.sqlite`).size / 1024).toFixed(1)} KB`);

  // Per-language databases
  console.log(`\n--- Per-language databases (${data.languages.length}) ---`);
  for (const lang of data.languages) {
    const file = `${OUTPUT_DIR}/database_${lang.code}.sqlite`;
    createLanguageDb(file, lang.code, data);
    if (fs.existsSync(file)) {
      encrypt(file);
      console.log(`  database_${lang.code}.sqlite: ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
    }
  }

  console.log('\n--- Files ---');
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    console.log(`  ${f} (${(fs.statSync(`${OUTPUT_DIR}/${f}`).size / 1024).toFixed(1)} KB)`);
  }
}

function createFullDb(out, data) {
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  insertTable(db, 'languages', data.languages);
  insertTable(db, 'categories', data.categories);
  insertTable(db, 'item_translations', data.item_translations);
  if (data.legacy_bookmark_map) {
    db.exec(`CREATE TABLE IF NOT EXISTS legacy_bookmark_map (source_table TEXT NOT NULL, legacy_id INTEGER NOT NULL, new_category_id INTEGER, new_item_id INTEGER, legacy_title TEXT, PRIMARY KEY (source_table, legacy_id))`);
    insertTable(db, 'legacy_bookmark_map', data.legacy_bookmark_map);
  }
  db.close();
}

function createLanguageDb(out, langCode, data) {
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const lang = data.languages.find(l => l.code === langCode);
  if (lang) db.prepare('INSERT INTO languages VALUES (?,?,?,?)').run(lang.id, lang.code, lang.name, lang.is_rtl);

  const langCatIds = new Set(data.categories.filter(c => c.language_code === langCode).map(c => c.id));
  if (langCatIds.size === 0) { db.close(); fs.unlinkSync(out); return; }

  const catMap = new Map(data.categories.map(c => [c.id, c]));
  const allIds = new Set(langCatIds);
  for (const id of langCatIds) {
    let cur = id;
    while (cur) {
      const c = catMap.get(cur);
      if (c?.parent_id && !allIds.has(c.parent_id)) { allIds.add(c.parent_id); cur = c.parent_id; }
      else break;
    }
  }

  for (const cat of data.categories.filter(c => allIds.has(c.id))) {
    db.prepare('INSERT INTO categories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      cat.id, cat.parent_id, cat.sequence, cat.lang_name, cat.english_name,
      cat.audio_url, cat.video_url, cat.duas_url, cat.local_audio_url, cat.local_video_url,
      cat.is_trans, cat.related1, cat.related2, cat.notify_hijri_date, cat.label1, cat.label2,
      cat.is_last_level, cat.language_code, cat.content_source_id
    );
  }
  for (const item of data.item_translations.filter(i => allIds.has(i.category_id))) {
    db.prepare('INSERT INTO item_translations VALUES (?,?,?,?,?,?,?,?,?)').run(
      item.id, item.category_id, item.sequence, item.language_title,
      item.arabic, item.translation, item.transliteration, item.is_visible, item.english
    );
  }
  console.log(`    ${langCode}: ${data.categories.filter(c => allIds.has(c.id)).length} cats, ${data.item_translations.filter(i => allIds.has(i.category_id)).length} items`);
  db.close();
}

function insertTable(db, table, rows) {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const ph = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`);
  db.transaction(() => { for (const r of rows) stmt.run(cols.map(c => r[c] ?? null)); })();
}

function encrypt(filePath) {
  const tmp = `${filePath}.tmp`;
  fs.renameSync(filePath, tmp);
  execSync(`sqlcipher ${tmp} "ATTACH DATABASE '${filePath}' AS encrypted KEY '${PASSWORD}'; SELECT sqlcipher_export('encrypted'); DETACH DATABASE encrypted;"`);
  fs.unlinkSync(tmp);
  execSync(`sqlcipher ${filePath} "PRAGMA key = '${PASSWORD}'; SELECT count(*) FROM sqlite_master;"`, { stdio: 'pipe' });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS languages (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, is_rtl INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, parent_id INTEGER, sequence INTEGER DEFAULT 0, lang_name TEXT, english_name TEXT, audio_url TEXT, video_url TEXT, duas_url TEXT, local_audio_url TEXT, local_video_url TEXT, is_trans INTEGER DEFAULT 0, related1 INTEGER, related2 INTEGER, notify_hijri_date TEXT, label1 TEXT, label2 TEXT, is_last_level INTEGER DEFAULT 0, language_code TEXT DEFAULT 'gu', content_source_id INTEGER);
  CREATE TABLE IF NOT EXISTS item_translations (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, sequence INTEGER DEFAULT 0, language_title TEXT, arabic TEXT, translation TEXT, transliteration TEXT, is_visible INTEGER DEFAULT 1, english TEXT);
  CREATE INDEX IF NOT EXISTS idx_categories_english_name ON categories(english_name);
  CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
  CREATE INDEX IF NOT EXISTS idx_categories_sequence ON categories(sequence);
  CREATE INDEX IF NOT EXISTS idx_categories_language_code ON categories(language_code);
  CREATE INDEX IF NOT EXISTS idx_item_translations_category ON item_translations(category_id);
`;

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
