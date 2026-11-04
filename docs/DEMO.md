# Demo script: 3 minutes, nine beats

**Pitch.** "I can build faster than ever. Why am I still repeating myself to my agents?"

**The line.** "Supabase holds the decisions and execution record. Sodabase checks the underlying data quality. Our evaluators check whether the agent actually followed the decisions."

**One moment to land.** A fresh run follows the accepted decision. Show the approved source and version, run `eed0520a`, its corrected output, its three checks and the completion gate.

**The words.** Tracing shows what happened. Evaluators detect behavioral drift. Sodabase checks data quality. Say Langfuse only if you can show a real trace ID or URL. Skill and MCP improvement is a next extension: propose a diff, approve, apply within scope, verify a fresh run. Never say it improves itself.

## Before you start

Run the dashboard on the real records, from `app/`, after `pnpm --ignore-workspace build`:

```bash
doppler run -p hackathon -c dev -- pnpm --ignore-workspace start
```

Open https://company-memory-zacc-r.vercel.app in the browser used for the demo. `/` is the product page and `/app` is the board. Port 4971 is development only.

`SUPABASE_DB_URL` is the only switch: set means live, unset means the local test database. Accept and Approve on this local page write to the real record, so click them only when you mean it.

Check these three things on screen:

1. The masthead says **Live, Supabase**. If a white band says **Local test database**, those are test rows. Say so out loud, or do not show them as the product working.
2. The hero's answer matches what actually happened. If it says "Not yet", the demo says "not yet".
3. The timestamps are from today's runs. Read the real age off the screen and never quote one from memory.

**Rule for every beat:** read what the screen shows. The wording and numbers below describe where to look. If a beat has not run, use its "If it has not run" line. Do not fill the gap by talking around it.

## The script

Timings are cumulative. Twenty seconds a beat leaves no spare time, so cut words rather than beats.

### 0:00 Open and beat 1: accepted decision with source
**Show:** "What did I decide?" Point at `milo.gym_nyc_partner`, its status, who accepted it, and the source under it.

**Say:** "I can build faster than ever. Why am I still repeating myself to my agents? So decisions live here, not in a chat. This one is accepted, by me, and it points at where it came from. An agent can propose a decision. Only I can accept one, and the database enforces that."

*If it has not run:* "No decision is accepted in this database yet. Here is the empty state."

### 0:25 Beat 2: Gym question with data age
**Show:** "What is each agent doing?", the Gym operator card: the question, the answer, the definition, and the data age figure.

**Say:** "The Gym agent answers with the accepted definition of an active member, and it tells you how old the data is. That is [read the age off the screen]. A missing count shows as unknown, never as zero."

*If it has not run:* "The Gym agent has not answered on this database. The card says so."

### 0:45 Beat 3: Milo slide revision
**Show:** the Milo pitch card, then the struck-through before text and its **historical** label.

**Say:** "This is a real line from an old draft of my own deck: 'The founder's own gym: the first operations fee.' It is labeled historical. It is an excerpt from October 30 with a claim I have since corrected, not a new incident. I asked Milo to revise it, and here is what it wrote." Read the revised text from the screen.

**Do not:**
- Read `suggested_revision` from `data/curated/milo-slide-text.json` as if a model wrote it. It is an authored candidate.
- Show the deck or the memo. They are not for distribution: one slide's text only, no financial figures.

*If it has not run:* "This run has not happened. The excerpt is historical input and nothing has revised it yet."

### 1:05 Beat 4: reviewer conflict
**Show:** "Where did it drift?" and step 2 of the chain: the quoted excerpt, the decision it conflicts with, and the **historical replay** label.

**Say:** "This is that old line, replayed through the normal checks. It is labeled a replay because no model wrote it tonight. An independent reviewer reads it against what I decided. It has to quote the exact words, and it names the decision they conflict with. It cannot fix or accept anything."

**Do not say** an agent drifted just now, or that this was the memory-off agent. The board says "not model-generated", so match it.

*If the output did not drift:* say that. "This run did not drift, so there is no finding to show, and I am not going to stage one." Then go to beat 8.

### 1:25 Beat 5: completion rejected
**Show:** step 3 of the chain, **Rejected**, with each check and why it stopped the run. Point to the evidence list for the failed evaluation.

**Say:** "The agent does not get to say it is done. Completion goes through a gate in the database. It reads the latest attempt, its evaluations and its evidence, and it rejected this one. Every verdict is recorded."

*If it has not run:* "The chain shows no rejection for this output, so I cannot claim one."

### 1:45 Beat 6: repair and correction
**Show:** step 4, the reviewer's proposed repair and the decision it points to.

**Say, if step 4 says "accepted before this check, no new version":** "The reviewer proposes the repair and cannot apply it. My correction was already accepted as a decision, so it did not have to change. It is company memory instead of something I have to say again tomorrow."

**Say, if step 4 shows a new version still proposed:** "It waits for me." Click **Accept this correction**. That button is only on the local dashboard, because the hosted page is read-only.

**If step 4 shows a repair attempt, add:** "A repair is a new attempt, so every earlier pass stops counting." A replay or a memory-off baseline gets no repairs, and step 4 says so.

*If it has not run:* "No repair or correction is recorded yet."

### 2:05 Beat 7: a fresh run follows it
**Show:** step 5 and the headline, then "Fresh accepted-memory run" for run `eed0520a`: approved source and version, corrected output, three checks, completion gate. **This is the moment. Stop and let them read it.**

**Say:** "This is a real model run with a fresh start: [read the model off the screen]. It got no repair notes. It pinned my decision, it revised that same line, it passed the gate, and I did not have to repeat myself."

Say "Yes" only if the hero says **Yes**. The hero says it only when the finding is verified, the verifying run is a different run, it completed, and it pinned the decision. If the hero asks "Did a fresh run follow the accepted decision?", use those words, not "the correction survived": no new decision version was made in this chain.

*If it has not run:* "It says 'Not yet', because no fresh run has followed this correction. The screen does not get to claim it."

### 2:25 Beat 8: Sodabase findings, separately
**Show:** scroll to the separate Sodabase section. Read one real row: table, verdict, age.

**Say:** "This is a different question. Sodabase looks at the data underneath, not at the agent's behavior. So it has its own section, and it does not feed the gate. Supabase holds the decisions and execution record. Sodabase checks the underlying data quality. Our evaluators check whether the agent actually followed the decisions."

*If it has not run:* "Sodabase has not reported on this database, and an empty table is not a passing score." Still say the line.

### 2:45 Beat 9: reel through the same process
**Show:** the "Reel, same process" card, the proposed decision or technique from the reel, and its gate status.

**Say:** "New ideas come in the same way. A reel I liked becomes a proposed technique with its source attached. It runs against the same decisions and through the same gate, and it does not override anything I accepted."

*If it has not run:* `data/curated/reel-input-status.json` needs an owner-supplied file. Until one has run, say: "No reel has gone through yet. When one does, it takes this same path."

### 3:00 Close
**Say:** "I can build faster than ever. Now I only have to say it once."

## Recovery on stage

| What you see | What to do |
|---|---|
| "Records could not be read" | Say the database did not answer. Nothing is shown, because nothing was read. Restart with the Doppler command above. |
| "Not yet" in the hero | Say it. A demo that refuses to claim a pass is the product working. Walk the chain as far as it goes. |
| A run lands during the demo | The page re-reads every 5 seconds. Point at the new row and its age. |
| Local test database band | Name it out loud. Those rows came through the real gate and grants, but they are test rows, not company records. |
