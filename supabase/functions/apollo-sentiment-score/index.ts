// GET /functions/v1/apollo-sentiment-score
// Read-only join of apollo.sentiment to the next hourly apollo.guesses line round.
// Optional ?coin=BTC|ETH|SOL. This response does not place, suggest or rank a bet.
import postgres from 'npm:postgres@3.4.5'
import { createScoreHandler, SCORE_BUCKET_SQL, SCORE_DETAIL_SQL, type Coin } from '../_shared/apollo-sentiment.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5 })

Deno.serve(createScoreHandler((coin: Coin | null) => sql.begin('read only', async (tx) => {
  await tx.unsafe(`set local statement_timeout = '5s'`)
  const detail = await tx.unsafe(SCORE_DETAIL_SQL, [coin])
  const buckets = await tx.unsafe(SCORE_BUCKET_SQL, [coin])
  return { detail: detail as unknown[], buckets: buckets as unknown[] }
})))
