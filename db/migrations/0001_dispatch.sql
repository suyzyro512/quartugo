-- Rider dispatch core: riders, delivery jobs, job events and the atomic claim.
-- Plain Postgres, so it runs locally and in CI. Supabase-specific wrappers live in db/supabase/.

create table riders (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  is_active     boolean not null default true,
  availability  text not null default 'unavailable'
                check (availability in ('available', 'unavailable', 'busy')),
  created_at    timestamptz not null default now()
);

create table delivery_jobs (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null,
  status             text not null default 'open'
                     check (status in ('open', 'needs_manual', 'assigned', 'picked_up',
                                       'delivered', 'failed', 'returned')),
  assigned_rider_id  uuid references riders(id),
  fee_to_rider_cents integer not null default 0 check (fee_to_rider_cents >= 0),
  opened_at          timestamptz not null default now(),
  assigned_at        timestamptz,
  version            integer not null default 0,
  -- an assigned job always has a rider, an open one never does
  check ((status in ('open', 'needs_manual')) = (assigned_rider_id is null))
);

-- One active job per order: marking an order Ready twice cannot create two jobs.
create unique index one_active_job_per_order
  on delivery_jobs (order_id)
  where status not in ('failed', 'returned');

create table job_events (
  id        bigint generated always as identity primary key,
  job_id    uuid not null references delivery_jobs(id),
  rider_id  uuid references riders(id),
  kind      text not null
            check (kind in ('opened', 'claim_won', 'claim_lost', 'released',
                            'picked_up', 'delivered', 'failed')),
  detail    text,
  at        timestamptz not null default now()
);

create index job_events_job_id on job_events (job_id);

-- Atomic claim. Returns 'won', 'job_taken' or 'rider_not_available'.
--
-- Both updates are conditional. Postgres row locks serialise concurrent claims on the
-- same job: the second claim waits for the first to commit, re-checks status = 'open',
-- finds it false and updates nothing. The rider update stops one rider holding two jobs.
-- A loss rolls back to the block's savepoint (so the busy flag is undone) and is logged.
create function claim_job(p_job_id uuid, p_rider_id uuid)
returns text
language plpgsql
as $$
begin
  begin
    update riders
       set availability = 'busy'
     where id = p_rider_id and is_active and availability = 'available';
    if not found then
      raise exception 'rider_not_available';
    end if;

    update delivery_jobs
       set status = 'assigned',
           assigned_rider_id = p_rider_id,
           assigned_at = now(),
           version = version + 1
     where id = p_job_id and status = 'open';
    if not found then
      raise exception 'job_taken';
    end if;

    insert into job_events (job_id, rider_id, kind) values (p_job_id, p_rider_id, 'claim_won');
    return 'won';
  exception when raise_exception then
    insert into job_events (job_id, rider_id, kind, detail)
    values (p_job_id, p_rider_id, 'claim_lost', sqlerrm);
    return sqlerrm;
  end;
end;
$$;
