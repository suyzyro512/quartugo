// Applies db/migrations/*.sql in name order to DATABASE_URL.
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const dir = new URL('../db/migrations/', import.meta.url);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  await client.query(await readFile(new URL(name, dir), 'utf8'));
  console.log(`applied ${name}`);
}
await client.end();
