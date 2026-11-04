# Follow-ups

Deliberately not done before judging (2026-11-04).

## Security
- **Give the app its own database login.** The app, the runner and the `run-status` function connect as `postgres`, which has BYPASSRLS and CREATEROLE, so `SET LOCAL ROLE` is enforced only by our code. An app compromise would mean full database control. Replace it with a login that has no bypass and may only take the service roles each part needs. Put off because a broken connection during judging was the bigger risk.
- **Revoke the Sodabase read login after judging.** `soda_readonly_c68226d2fe1d` has BYPASSRLS and reads 7 `gym` and 3 `cm` tables. It expires on its own on 2026-11-11.

## Gym operator
- **No gym repair has ever succeeded live.** In run `9a040d49` the gate rejected `data_as_of` 2026-10-01 on attempts 1 and 3. Attempt 2 reported a count for east3, which has no latest complete projection.
- **Settle what "oldest" covers.** The prompt says "If locations differ, report the oldest". The model reads that as including east3's incomplete 2026-10-01 report, while the check compares against the locations with a count (2026-10-05). Decide which is right before changing either. Do not loosen the check to make a run pass.
