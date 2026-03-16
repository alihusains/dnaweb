import { createClient } from '@libsql/client';
import fs from 'fs';

const configContent = fs.readFileSync('config.js', 'utf8');
const urlMatch = configContent.match(/url:\s*'([^']+)'/);
const tokenMatch = configContent.match(/token:\s*'([^']+)'/);

if (!urlMatch || !tokenMatch) {
  console.error('Could not find URL or Token in config.js');
  process.exit(1);
}

const client = createClient({
  url: urlMatch[1],
  authToken: tokenMatch[1]
});

async function main() {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('Tables in Turso:');
  result.rows.forEach(row => console.log(`- ${row.name}`));
}

main().catch(console.error);
