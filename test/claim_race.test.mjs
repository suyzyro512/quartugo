// Milestone 1: two riders accept the same job at the same instant, exactly one wins.
// Needs DATABASE_URL. Everything runs in its own schema, which is dropped and recreated.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const SCHEMA = 'quartugo_test';
const ROUNDS = Number(process.env.ROUNDS ?? 200);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${SCHEMA}`,
  max: 4,
});

async function sql(file) {
  return readFile(new URL(file, import.meta.url), 'utf8');
}

let riderA;
let riderB;

before(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, dir), 'utf8'));
  }
  await pool.query(await sql('./naive_claim.sql'));
  const { rows } = await pool.query(
    `insert into riders (display_name) values ('Rider A'), ('Rider B') returning id`,
  );
  [riderA, riderB] = rows.map((r) => r.id);
});

after(() => pool.end());

async function freshJob() {
  await pool.query(`update riders set availability = 'available'`);
  const { rows } = await pool.query(
    `insert into delivery_jobs (order_id) values ($1) returning id`,
    [randomUUID()],
  );
  return rows[0].id;
}

// Two connections already open, so the two calls hit the database together.
async function race(fn, calls) {
  const clients = await Promise.all(calls.map(() => pool.connect()));
  try {
    return await Promise.all(
      calls.map(([job, rider], i) =>
        clients[i].query(`select ${fn}($1, $2) as result`, [job, rider]).then((r) => r.rows[0].result),
      ),
    );
  } finally {
    clients.forEach((c) => c.release());
  }
}

test(`claim_job: exactly one winner in ${ROUNDS} simultaneous two-rider races`, async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const job = await freshJob();
    const results = await race('claim_job', [[job, riderA], [job, riderB]]);
    assert.deepEqual(results.toSorted(), ['job_taken', 'won'], `round ${i}`);

    const { rows: events } = await pool.query(
      `select kind, rider_id from job_events where job_id = $1 order by kind`,
      [job],
    );
    assert.deepEqual(events.map((e) => e.kind), ['claim_lost', 'claim_won'], `round ${i} events`);

    const { rows: [j] } = await pool.query(
      `select assigned_rider_id from delivery_jobs where id = $1`,
      [job],
    );
    const winner = events.find((e) => e.kind === 'claim_won').rider_id;
    assert.equal(j.assigned_rider_id, winner);

    // The loser's busy flag was rolled back; only the winner is busy.
    const { rows: busy } = await pool.query(`select id from riders where availability = 'busy'`);
    assert.deepEqual(busy.map((r) => r.id), [winner], `round ${i} busy riders`);
  }
});

test('claim_job: one rider accepting two jobs at once gets only one', async () => {
  for (let i = 0; i < 50; i++) {
    const job1 = await freshJob();
    const job2 = await freshJob();
    const results = await race('claim_job', [[job1, riderA], [job2, riderA]]);
    assert.deepEqual(results.toSorted(), ['rider_not_available', 'won'], `round ${i}`);
  }
});

test('claim_job: a claim on a taken job fails without touching it', async () => {
  const job = await freshJob();
  assert.equal((await race('claim_job', [[job, riderA]]))[0], 'won');
  assert.equal((await race('claim_job', [[job, riderB]]))[0], 'job_taken');
  const { rows: [j] } = await pool.query(`select assigned_rider_id, version from delivery_jobs where id = $1`, [job]);
  assert.equal(j.assigned_rider_id, riderA);
  assert.equal(j.version, 1);
});

test('one active job per order: a second Ready is refused', async () => {
  const order = randomUUID();
  await pool.query(`insert into delivery_jobs (order_id) values ($1)`, [order]);
  await assert.rejects(
    pool.query(`insert into delivery_jobs (order_id) values ($1)`, [order]),
    /one_active_job_per_order/,
  );
});

test('naive read-then-write claim lets two riders win (why claim_job exists)', async () => {
  let doubleWins = 0;
  for (let i = 0; i < 20; i++) {
    const job = await freshJob();
    const results = await race('naive_claim_job', [[job, riderA], [job, riderB]]);
    if (results.every((r) => r === 'won')) doubleWins++;
  }
  console.log(`naive claim: ${doubleWins}/20 rounds had two winners`);
  assert.ok(doubleWins > 0, 'expected the naive version to double-assign at least once');
});
