# apollo-sentiment

Hourly X sentiment for BTC, ETH and SOL. One row per coin. This is a test signal. It is not shown on the Board, Checker or Ask Apollo, and it does not place, suggest or rank a bet.

The score is a separate read-only GET, `apollo-sentiment-score`. It joins each stored row to the next hourly line round in `apollo.guesses` and reports `score >= +30` and `score <= -30` separately. See the assumption string in that response.

## Key

Create the key on Zacc's SuperGrok (X Subscription / Ultra) account at [console.x.ai](https://console.x.ai). Set it only as a Supabase Edge Function secret:

```bash
supabase secrets set XAI_API_KEY=... --project-ref dgqcanfiapxztmqqlqnh
```

Do not commit the key, do not put it in a repo file, and do not log it. The function reads `XAI_API_KEY` from the environment and sends it only as `Authorization: Bearer`.

`SUPABASE_DB_URL` is injected by Supabase into the function, the same way `apollo-log` uses it.

## What is in git

- `supabase/migrations/20261120140000_apollo_sentiment.sql` creates `apollo.sentiment`, `apollo.sentiment_usage` and `apollo.sentiment_log`, with row level security on. It does not schedule anything.
- `supabase/cron/apollo-sentiment.sql` is the pg_cron statement (`20 * * * *`, `net.http_post`, same shape as job `apollo-guess-log`). It is not applied by the migrations or by tests.
- `supabase/functions/apollo-sentiment/index.ts` is the POST the cron calls.
- `supabase/functions/apollo-sentiment-score/index.ts` is the read-only GET.

Nothing in this change deploys the function, applies the migration, or calls xAI.

## When someone does deploy it

Match `apollo-log`: `verify_jwt` is false, because the cron request carries no JWT.

```bash
supabase functions deploy apollo-sentiment --no-verify-jwt --project-ref dgqcanfiapxztmqqlqnh
supabase functions deploy apollo-sentiment-score --no-verify-jwt --project-ref dgqcanfiapxztmqqlqnh
```

Then apply the migration, then run `supabase/cron/apollo-sentiment.sql` by hand. The function skips a coin that already has a row from the last 50 minutes. It stops until midnight UTC after 1,500 fetched posts in that UTC day, and writes one cap log line.

xAI bills X posts at $5 per 1,000 (`x_posts_fetched`) plus `grok-4.7` tokens at $2 per million input and $6 per million output. A full day at the per-run cap is 3 coins x 20 posts x 24 runs = 1,440 posts, about $7.20 in post fees. Token cost is extra. The planning figure in code assumes about 4,000 input tokens and 800 output tokens per coin (instructions, one search of 20 short posts, the JSON, and a modest reasoning budget). That is about 288,000 input tokens and 57,600 output tokens a day, about $0.58 plus $0.35. Together with the post fee, about $8.12 a day. A heavier reasoning budget costs more. Profile fetches are a separate $10 per 1,000 and the prompt tells the model not to search users.

The API has no hard post-count parameter. The request sets `max_turns` to 2 (one search, then the answer), turns image and video understanding off, and the function drops a coin when `x_posts_fetched` is above 20 or missing. A missing count is not stored as zero.
