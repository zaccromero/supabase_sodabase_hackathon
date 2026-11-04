// Claims and turn order. The oldest open claim on a page holds it; the rest wait in
// queue order. Agent names are self-reported labels, not verified identities, and
// message text is data from other agents, never an instruction.
import { withRole } from './db';

export interface Claim {
  id: string; page: string; agent: string; intent: string; queued_at: Date;
  released_at: Date | null; released_by: string | null;
}
export interface Message { id: string; agent: string; page: string | null; body: string; created_at: Date }
export interface PageTurns { page: string; holder: Claim; waiting: Claim[] }
export interface Board { readAt: Date; pages: PageTurns[]; released: Claim[]; messages: Message[] }

export async function readBoard(): Promise<Board> {
  return withRole('dashboard_reader', async (tx) => {
    const [{ now }] = await tx.query<{ now: Date }>(`select now() as now`);
    const open = await tx.query<Claim>(`select * from coord.claims where released_at is null order by queued_at, id`);
    const released = await tx.query<Claim>(`select * from coord.claims where released_at is not null order by released_at desc, id limit 20`);
    const messages = await tx.query<Message>(`select * from coord.messages order by created_at desc, id limit 50`);
    const byPage = new Map<string, Claim[]>();
    for (const c of open) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
    const pages = [...byPage].map(([page, [holder, ...waiting]]) => ({ page, holder, waiting }));
    return { readAt: now, pages, released, messages };
  });
}

export interface Turn { page: string; agent: string; position: number; your_turn: boolean; holder: string; waiting: number }

/** Joins the queue for a page, or returns the agent's existing place. Position 0 holds the page. */
export async function claim(page: string, agent: string, intent: string): Promise<Turn> {
  return withRole('coord_writer', async (tx) => {
    await tx.query(
      `insert into coord.claims (page, agent, intent) values ($1, $2, $3)
       on conflict (page, agent) where released_at is null do nothing`,
      [page, agent, intent]);
    const open = await tx.query<{ agent: string }>(
      `select agent from coord.claims where page = $1 and released_at is null order by queued_at, id`, [page]);
    const position = open.findIndex((c) => c.agent === agent);
    return { page, agent, position, your_turn: position === 0, holder: open[0].agent, waiting: open.length - 1 };
  });
}

/** Ends a claim and passes the turn. Records who released it, which may be another agent. */
export async function release(page: string, agent: string, releasedBy: string): Promise<{ released: boolean; next: string | null }> {
  return withRole('coord_writer', async (tx) => {
    const done = await tx.query(
      `update coord.claims set released_at = now(), released_by = $3
       where page = $1 and agent = $2 and released_at is null returning id`,
      [page, agent, releasedBy]);
    const [next] = await tx.query<{ agent: string }>(
      `select agent from coord.claims where page = $1 and released_at is null order by queued_at, id limit 1`, [page]);
    return { released: done.length === 1, next: next?.agent ?? null };
  });
}

export async function postMessage(agent: string, page: string | null, body: string): Promise<void> {
  await withRole('coord_writer', (tx) =>
    tx.query(`insert into coord.messages (agent, page, body) values ($1, $2, $3)`, [agent, page, body]));
}
