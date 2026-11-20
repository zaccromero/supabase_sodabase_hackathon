-- NOT a migration. Nothing in supabase/migrations, the test suite, or this branch applies this file.
-- Do not run it until apollo-sentiment is deployed on purpose.
--
-- Same shape as the live pg_cron job 'apollo-guess-log' (*/5 * * * *), which runs:
--   select net.http_post(
--     url:='https://dgqcanfiapxztmqqlqnh.supabase.co/functions/v1/apollo-log',
--     headers:='{"Content-Type":"application/json"}'::jsonb,
--     body:='{}'::jsonb,
--     timeout_milliseconds:=45000)
--
-- This job runs at minute 20 of every hour. Three xAI calls need a longer timeout than the
-- 45 second guess log, so the post timeout is 150 seconds. The function still skips any
-- coin that already has a row from the last 50 minutes.

select cron.schedule(
  'apollo-sentiment',
  '20 * * * *',
  $job$
  select net.http_post(
    url := 'https://dgqcanfiapxztmqqlqnh.supabase.co/functions/v1/apollo-sentiment',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
