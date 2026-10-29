-- Supabase only (needs auth.uid()). Apply after db/migrations/0001_dispatch.sql.
-- Riders call claim_my_job() over RPC; they never get write access to the tables.

create function claim_my_job(p_job_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select claim_job(p_job_id, auth.uid());
$$;

revoke execute on function claim_job(uuid, uuid) from public, anon, authenticated;
revoke execute on function claim_my_job(uuid) from public, anon;
grant execute on function claim_my_job(uuid) to authenticated;

alter table riders enable row level security;
alter table delivery_jobs enable row level security;
alter table job_events enable row level security;

-- A rider sees their own profile.
create policy rider_reads_self on riders
  for select to authenticated using (id = auth.uid());

-- A rider sees open jobs (to be offered) and jobs assigned to them.
-- Realtime checks this policy against the new row, so losing riders do NOT receive the
-- UPDATE when a job is assigned. The claim endpoint must send a 'job_closed' broadcast
-- on a Realtime channel, and rider screens re-fetch open jobs when they get it.
-- Customer address and phone live on orders, which riders can only read through a
-- function that checks assignment (added with the order tables).
create policy rider_reads_jobs on delivery_jobs
  for select to authenticated
  using (status = 'open' or assigned_rider_id = auth.uid());

create policy rider_reads_own_events on job_events
  for select to authenticated using (rider_id = auth.uid());
