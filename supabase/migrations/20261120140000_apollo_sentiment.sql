-- Hourly X sentiment for BTC, ETH and SOL. Test signal only.
-- This file touches the apollo schema and nothing else. It does not alter cm, gym, coord,
-- apollo.guesses, or any paper-trading table. It does not schedule cron.
-- Apply on the database only when a person chooses to. Tests load it locally.

create schema if not exists apollo;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'apollo_sentiment') then
    create role apollo_sentiment nologin;
  end if;
end $$;

create table apollo.sentiment (
  id bigint generated always as identity primary key,
  coin text not null check (coin in ('BTC', 'ETH', 'SOL')),
  captured_at timestamptz not null,
  posts_read integer not null check (posts_read between 0 and 20),
  posts_fetched integer not null check (posts_fetched between 0 and 20),
  bullish integer not null check (bullish >= 0),
  bearish integer not null check (bearish >= 0),
  neutral integer not null check (neutral >= 0),
  score numeric(6, 2) not null check (score between -100 and 100),
  top_themes jsonb not null check (jsonb_typeof(top_themes) = 'array'),
  notable_handles jsonb not null check (jsonb_typeof(notable_handles) = 'array'),
  summary text not null check (char_length(summary) between 1 and 500),
  model text not null check (model = 'grok-4.7'),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  check (bullish + bearish + neutral = posts_read),
  check (posts_read <= posts_fetched)
);

comment on table apollo.sentiment is
  'Hourly X sentiment test signal for BTC, ETH and SOL. Not a bet. Not an input to the Board, Checker or Ask Apollo.';

create unique index sentiment_coin_utc_hour
  on apollo.sentiment (coin, date_trunc('hour', captured_at at time zone 'utc'));

create index sentiment_coin_captured on apollo.sentiment (coin, captured_at desc);

-- One row per UTC day. posts_fetched is the xAI x_posts_fetched total, including calls
-- whose JSON was rejected. A missing API count is not written as zero.
create table apollo.sentiment_usage (
  day date primary key,
  posts_fetched integer not null check (posts_fetched >= 0),
  updated_at timestamptz not null default now()
);

comment on table apollo.sentiment_usage is
  'UTC-day count of X posts fetched for the sentiment test. The job stops at 1500 until the next UTC day.';

create table apollo.sentiment_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  coin text check (coin is null or coin in ('BTC', 'ETH', 'SOL')),
  level text not null check (level in ('info', 'skip', 'error', 'cap')),
  message text not null check (char_length(message) between 1 and 300)
);

comment on table apollo.sentiment_log is
  'Why a sentiment coin was skipped, rejected or stopped. The daily cap writes one cap row per UTC day.';

create index sentiment_log_cap_at on apollo.sentiment_log (at) where level = 'cap';

alter table apollo.sentiment enable row level security;
alter table apollo.sentiment_usage enable row level security;
alter table apollo.sentiment_log enable row level security;

revoke all on schema apollo from public;
revoke all on all tables in schema apollo from public;

do $$ declare r text; begin
  foreach r in array array[
    'anon', 'authenticated',
    'agent_worker', 'evaluator_service', 'gate_service', 'founder_approver', 'dashboard_reader',
    'coord_writer', 'soda_readonly_c68226d2fe1d'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema apollo from %I', r);
      execute format('revoke all on all tables in schema apollo from %I', r);
    end if;
  end loop;
end $$;

grant usage on schema apollo to apollo_sentiment;
grant select, insert on apollo.sentiment to apollo_sentiment;
grant select, insert on apollo.sentiment_log to apollo_sentiment;
grant select, insert, update on apollo.sentiment_usage to apollo_sentiment;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant apollo_sentiment to postgres;
  end if;
end $$;
