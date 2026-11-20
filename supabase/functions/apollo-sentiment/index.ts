// POST /functions/v1/apollo-sentiment
// Hourly X sentiment for BTC, ETH and SOL. One row per coin. Test signal only.
// pg_cron job apollo-sentiment calls this at minute 20. See supabase/cron/apollo-sentiment.sql.
// XAI_API_KEY is a Supabase secret from Zacc's SuperGrok account. It is never written to a row or a log.
import postgres from 'npm:postgres@3.4.5'
import { buildXaiRequest, createSentimentHandler, createStore, runSentiment, XAI_RESPONSES_URL } from '../_shared/apollo-sentiment.ts'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5 })

const db = {
  query: async <T>(text: string, params: unknown[]) => {
    const rows = await sql.unsafe(text, params as never[])
    return { rows: rows as unknown as T[] }
  },
}

async function callXai(coin: Parameters<typeof buildXaiRequest>[0], apiKey: string, now: Date): Promise<unknown> {
  const response = await fetch(XAI_RESPONSES_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildXaiRequest(coin, now)),
    signal: AbortSignal.timeout(40_000),
  })
  if (!response.ok) throw new Error(`xAI status ${response.status}`)
  return response.json()
}

Deno.serve(createSentimentHandler(() => runSentiment({
  now: () => new Date(),
  apiKey: Deno.env.get('XAI_API_KEY'),
  ...createStore(db),
  callXai,
})))
