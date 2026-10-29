# QuartuGo

Direct ordering and delivery for Quartu Mini Market, alongside the existing Deliveroo channel.
Stack: Next.js, Supabase (Postgres, Auth, Realtime) and Stripe Checkout.

This repo starts with milestone 1: **two riders accept the same delivery at the same instant,
and exactly one wins.** The storefront, admin and rider screens come next.

## How the claim works

`claim_job(job_id, rider_id)` in [db/migrations/0001_dispatch.sql](db/migrations/0001_dispatch.sql)
does two conditional updates in one transaction:

1. Mark the rider `busy`, only if they are `available` (stops one rider holding two jobs).
2. Mark the job `assigned`, only if it is still `open`.

When two claims arrive together, Postgres makes the second wait on the job row's lock. Once the
first commits, the second re-checks `status = 'open'`, finds it false, and updates nothing. The
loser's busy flag is rolled back and a `claim_lost` event is logged. It returns `won`,
`job_taken` or `rider_not_available`.

On Supabase, riders call `claim_my_job(job_id)` over RPC
([db/supabase/0002_rider_rpc.sql](db/supabase/0002_rider_rpc.sql)), which uses the logged-in
rider's id. Riders get no direct write access to the tables.

## Running the tests

Needs Node 22 and any Postgres 14+. The tests create and drop their own `quartugo_test` schema.

```sh
npm install
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test
```

What they check:

- 200 rounds of two riders claiming one job at once: always exactly one `won` and one
  `job_taken`, matching events, and only the winner left `busy`.
- One rider claiming two jobs at once gets only one.
- A late claim on a taken job changes nothing.
- Marking an order Ready twice cannot create two active jobs.
- A naive read-then-write claim double-assigns, to show why the conditional update matters.
