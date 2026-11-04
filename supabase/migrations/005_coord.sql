-- Agent coordination: who holds a page, who waits, what they said to each other.
-- A separate schema on purpose. Nothing in cm reads it, so it cannot touch the
-- completion gate, decisions or evaluations.
create schema if not exists coord;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'coord_writer') then create role coord_writer nologin; end if;
end $$;
grant coord_writer to postgres;

create table coord.claims (
  id uuid primary key default gen_random_uuid(),
  page text not null check (length(page) between 1 and 200),
  agent text not null check (length(agent) between 1 and 80),
  intent text not null default '' check (length(intent) <= 500),
  queued_at timestamptz not null default now(),
  released_at timestamptz,
  released_by text check (length(released_by) <= 80)
);
-- Turn order is queue order: the oldest open claim on a page holds it, the rest wait.
create index claims_open on coord.claims (page, queued_at, id) where released_at is null;
create unique index claims_one_open_per_agent on coord.claims (page, agent) where released_at is null;

create table coord.messages (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (length(agent) between 1 and 80),
  page text check (length(page) <= 200),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

grant usage on schema coord to coord_writer, dashboard_reader;
grant select on coord.claims, coord.messages to coord_writer, dashboard_reader;
grant insert on coord.claims, coord.messages to coord_writer;
grant update (released_at, released_by) on coord.claims to coord_writer;
