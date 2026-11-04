# Migration request from lane 5 (dashboard)

The owner asked for a claims and turn page so agents editing the same pages can wait in order and talk.

**Apply:** copy `app/sql/coord.sql` to `supabase/migrations/005_coord.sql` and apply it.

**Impact:** new `coord` schema and a `coord_writer` role, plus read access for `dashboard_reader`. It touches no `cm` table and nothing in `cm` reads it, so the gate and evaluations are unaffected.

**Until it is applied:** `/claims` says the table is not on this database, and the rest of the dashboard works as before. `app/src/lib/local-db.ts` loads the same file, so the local test database already has it.
