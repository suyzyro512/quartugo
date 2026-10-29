-- Deliberately wrong claim, used only by the race test to show why claim_job is built
-- the way it is. It reads, pauses (like a slow network or server), then writes without
-- re-checking, so two riders can both "win".
create or replace function naive_claim_job(p_job_id uuid, p_rider_id uuid)
returns text
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from delivery_jobs where id = p_job_id;
  if v_status <> 'open' then
    return 'job_taken';
  end if;
  perform pg_sleep(0.02);
  update delivery_jobs
     set status = 'assigned', assigned_rider_id = p_rider_id, assigned_at = now()
   where id = p_job_id;
  insert into job_events (job_id, rider_id, kind) values (p_job_id, p_rider_id, 'claim_won');
  return 'won';
end;
$$;
