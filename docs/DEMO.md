# Demo script: 3 minutes, nine beats

**Pitch.** "I can build faster than ever. Why am I still repeating myself to my agents?"

**The line.** "Supabase holds the decisions and the execution record. Tracing shows what happened. Evaluators detect behavioral drift. Sodabase checks data quality."

**One moment to land.** A fresh model run follows an accepted decision without being told again. No new version of the decision was made in this chain, so do not say "the correction survived".

"Tracing" here means the run and evidence records on the board: model, attempts, checks. Do not name an outside tracing product.

## What the hosted records show

Read from hosted Supabase at 22:57 UTC on 2026-11-04. Re-check on screen. If the screen differs, the screen wins.

| Beat | Record | What it shows |
|---|---|---|
| 1 | `milo.gym_nyc_partner` v1 | Accepted by Zacc Romero. One of six accepted decisions, each with a source. |
| 2 | Gym run `70e040f6` | Gate completed on attempt 1. `bk` 704, `lex` 367, `mul` 439, `east3` unknown. Data as of 2026-10-05, age 30 days. The optional critic failed and is on record. Earlier runs `8d536a05` and `37b1ce48` failed. The critic is optional on all three Gym runs. It is required on Milo runs. |
| 3 | Milo run `eed0520a` | Gate completed. Before: "The founder's own gym: the first operations fee". After: "Gym NYC: a partner. Founder-reported operations fee remains conditional on dashboard completion and buyer acceptance." |
| 4 | Replay `7116a6d3`, reviewer `6bedd90b`, finding `a5eed242` | The old line, replayed. `model_generated: false`. The reviewer quotes it against `milo.gym_nyc_partner`. |
| 4 | Memory-off run `d7d43ddf` | A real model run. It did not repeat the claim, and reviewer `93f4172f` found nothing. It wrote "Start with gym operations. Focus on the day-to-day work." |
| 5 | Replay `7116a6d3` | Gate blocked. Forbidden-claim check and critic failed. Sourcing check uncertain. |
| 5 | Memory-off run `d7d43ddf` | Also gate blocked, for a different reason: its assertions had no sourced claims. |
| 6 | Finding `a5eed242` | Its correction links to the already accepted `milo.gym_nyc_partner` v1. No v2. Nothing to accept on stage. |
| 7 | Fresh run `d2c0c6ce` | A separate model run on `gpt-6.1-sol`, one attempt, no repair notes. Pinned the decision, wrote "Gym NYC: a partner", gate completed. Finding status: verified. |
| 8 | Sodabase receipt `docs/receipts/sodabase-2026-11-04T22-34-54Z.json` | 8 actionable, 7 expected by definition, 3 clean, 21 undetermined. |
| 9 | `cm.techniques` | Empty. No reel has run. |

`eed0520a` is the Milo revision to anchor on. It ran before the finding existed, so it cannot be the fresh run in beat 7. That is `d2c0c6ce`. The Milo card may show the newest run instead, so read the text on screen.

## Before you start

**Open the board.** Check it signed out first: `https://company-memory-zacc-r.vercel.app/app`. `/` is the product page and `/app` is the board. At 22:49 UTC signed-out visitors were redirected to a Vercel login.

**If the board is login-walled:** run the demo from Zacc's signed-in browser and say so: "This page is behind our Vercel login, so I am showing it from my own session." Do not tell judges they can open the link unless you have just checked it signed out.

**If the hosted board is down:** from `app/`, after `pnpm --ignore-workspace build`, run the command below and open `http://127.0.0.1:4971/app`. It reads the same hosted records. Accept and Approve on this local page write to the real record, so do not click them.

```bash
doppler run -p hackathon -c dev -- pnpm --ignore-workspace start
```

**Check on screen:**
1. The masthead says **Live, Supabase**. If a white band says **Local test database**, those are test rows. Do not present them as the product working.
2. The hero says **Did a fresh run follow the accepted decision? Yes.** If it says anything else, say what it says.
3. Read every age off the screen. Never quote one from memory.

**Waiting on Zacc. Do not assume any of these:**
- Is Gym NYC's name allowed in a public demo? Milo's own audit lists its permission for name, data and photographs as unresolved.
- Reel file, or cut beat 9.
- Public read-only board, yes or no.
- Stale data: the script below shows it honestly. A fresher pull needs his approval.

**Rule for every beat:** read what the screen shows. If a beat has not run, use its fallback line. Do not talk around a gap.

## The script

Timings are cumulative. Cut words rather than beats.

### 0:00 Beat 1: accepted decision with source
**Show:** "What did I decide?" and `milo.gym_nyc_partner`: its status, who accepted it, its source.

**Say:** "I can build faster than ever. Why am I still repeating myself to my agents? So decisions live here, not in a chat. This one says Gym NYC is a partner, not my gym. I accepted it, and it points at its source. An agent can propose a decision. Only I can accept one, and the database enforces that."

*If it has not run:* "No decision is accepted in this database yet."

### 0:25 Beat 2: Gym answer with data age
**Show:** "What is each agent doing?" and the Gym operator card: the answer, the definition, the data age.

**Say, if the newest Gym run completed:** "The Gym agent counts active members the way I defined them, and passed the gate. It says how old the data is: [read the age]. One location shows unknown, because its latest sync failed. Unknown, never zero. Two earlier runs failed this gate and stay on the record, and an advisory critic disagrees with how this run treats that location. That is recorded too."

**Say, if the newest Gym run failed:** "The Gym agent did not pass. [Read the reason.] So the gate did not complete it, and I am not going to claim an answer."

**Do not** add up the locations. With one unknown there is no chain total.

### 0:50 Beat 3: Milo slide revision
**Show:** the Milo pitch card, the struck-through before text, and its **historical** label.

**Say:** "This is a real line from an old draft of my deck: 'The founder's own gym: the first operations fee.' I have since corrected that claim. It is labeled historical. I asked Milo to revise it, and here is what it wrote." Read the revised text from the screen.

**Do not:**
- Read `suggested_revision` from `data/curated/milo-slide-text.json` as if a model wrote it. It is an authored candidate.
- Show the deck or the memo. They are not for distribution: one slide's text only, no financial figures.

*If it has not run:* "This run has not happened. The excerpt is historical input."

### 1:10 Beat 4: reviewer conflict
**Show:** "Where did it drift?" and step 2 of the chain: the quoted excerpt, the decision, the **historical replay** label.

**Say:** "This is that old line, replayed through the normal checks. No model wrote it tonight, and the board says so. The real agent with memory off did not repeat this claim. An independent reviewer reads the replay against what I decided. It must quote the exact words and name the decision. It cannot fix or accept anything."

**Do not say** an agent drifted, or that the replay came from the memory-off run.

### 1:30 Beat 5: completion rejected
**Show:** step 3 of the chain, **Rejected**, each check and why it stopped.

**Say:** "An agent does not get to say it is done. Completion goes through a gate in the database, and it rejected this line. Every verdict is recorded. The memory-off run was blocked too, for a different reason: it made claims with no source."

*If it has not run:* "The chain shows no rejection for this output, so I cannot claim one."

### 1:50 Beat 6: the correction
**Show:** step 4: the reviewer's proposed repair, and "accepted before this check, no new version".

**Say:** "The reviewer proposes a repair and cannot apply it. The correction it points to is one I had already accepted, version one. There is no new version and nothing for me to click. It is already company memory, instead of something I say again tomorrow."

**Do not** click anything or describe a new version. If step 4 ever shows a new version still proposed, say that instead: "It waits for me."

### 2:10 Beat 7: a fresh run follows it
**Show:** step 5 and the hero. **This is the moment. Stop and let them read it.**

**Say:** "This is a separate model run: [read the model off the screen]. It was handed that old line to revise. Nobody told it what was wrong, and it got no repair notes. It pinned my decision, wrote 'Gym NYC: a partner', and passed the gate. I did not have to repeat myself."

Say "Yes" only if the hero says **Yes**.

*If it has not run:* "It says 'Not yet', because no fresh run has followed this decision. The screen does not get to claim it."

### 2:30 Beat 8: Sodabase, separately
**Show:** the Sodabase section. Read one real row: table, count, problem. Good choices: `gym.members`, joined after their churn date, or missing a membership number.

**Say:** "This is a different question, so it does not feed the gate. Tracing shows what happened. Evaluators detect behavioral drift. Sodabase checks data quality, and it found real problems, including [read the row]. It flagged our own decisions too: my approval time is earlier than the import time."

**Do not** present a row as a defect if the page groups it as expected by definition, such as the `finance_snapshots` `all` rollup.

*If it has not run:* "Sodabase has not reported on this database, and an empty table is not a passing score."

### 2:50 Beat 9: reel. ONLY IF THE REEL RUNS
**Show:** the "Reel, same process" card and the proposed technique.

**Say:** "New ideas come in the same way. A reel I liked becomes a proposed technique with its source attached. It cannot change anything I accepted."

**If no reel has run, cut this beat.** `cm.techniques` is empty until Zacc supplies a file. Do not mention a reel as working. If asked, say: "That path is built, but no reel has gone through it yet."

### 3:00 Close
**Say:** "I can build faster than ever. Now I only have to say it once."

## Recovery on stage

| What you see | What to do |
|---|---|
| Vercel login page | Switch to Zacc's signed-in browser and say the page is behind a login. |
| "Records could not be read" | Say the database did not answer. Nothing is shown, because nothing was read. Restart with the command above. |
| Hero does not say "Yes" | Say what it says. A demo that refuses to claim a pass is the product working. Walk the chain as far as it goes. |
| Newest Gym run is not `70e040f6` | Read the newest run on screen and use the matching beat 2 line. |
| A run lands during the demo | The page re-reads every 5 seconds. Point at the new row and its age. |
| Local test database band | Name it out loud. Those rows are test rows, not company records. |
| A judge asks why the data is 30 days old | "Our dev sync is off by my own ruling, and production is off limits for this project. So we show the real age instead of hiding it." |
