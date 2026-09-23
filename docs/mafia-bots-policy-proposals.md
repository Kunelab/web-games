# Making the base bots better to play with

This is a proposal, not a description. It covers the deterministic brain described in [mafia-bots-gameplay.md](mafia-bots-gameplay.md) (`packages/mafia-core/src/sim` and `apps/back/src/mafia`) and asks one question of it: what does a human at the table notice, and what can a human do with it?

"Better" here is not win rate. The three goals are:

1. **Hard to exploit.** A pattern in how bots vote, claim, target or react should not let a player predict them or beat them.
2. **Good teammates.** A bot that has reason to believe someone is on its side should usually go along with them, and refuse only for a reason it can say out loud.
3. **Not frustrating.** Votes that match words, lies that hold together, nothing that looks random or suicidal.

Code references are to commit `67d86d5`. Line numbers drift; function names are the stable reference. Numbers quoted are the code's own. Where a proposal needs a new threshold, it says so and leaves the value to be set on the bench, rather than inventing one.

---

## What the bench measured

Everything below was measured on the headless bench, which now has a second scoreboard:

```
pnpm --filter mafia-core sim -- --games 300 --players 12,16,20 --report --talk
pnpm --filter mafia-core sim -- --games 300 --players 12,16,20 --talk --scenario famille
```

- `--report` prints what each role did with its power (used or not, on whom, with what result), the tells a watching player could read (each as a rule, with how much likelier it fires on a killer than on anybody else), and the faults a bot should never commit, per 100 games. See `sim/probe.ts` and `sim/report.ts`.
- `--talk` lets the three voting passes speak as well as vote. Without it, a seat only speaks at dawn, before any vote exists, so nothing a bot says because of a vote (defending, covering a brother, promising, a timely check) ever happened on the bench.
- `--scenario` forces a situation a person would create, and records how the bots handle it: `famille` (a teammate asks for a different house), `peche` (a fake claim fishes for a real holder), `barre` (a killer on the stand claims a juror's own role), `meneur` (a revealed Mayor calls a vote with no reason, plus a control seat nobody named), `promesse` (a killer promises on the stand and says anything the next day). See `sim/scenarios.ts`.

Each run below is 900 games (12, 16 and 20 seats, half the requested setup and half the census), same seeds before and after, with `--talk` unless noted.

**Faults, per 100 games**

| | before | after |
| --- | --- | --- |
| a killer names its victim's house when asked where it was | 40.7 | 0 |
| a night story that contradicts the role the seat claims | 21.8 | 0 |
| a family seat contests its own teammate's badge | 1.3 | 0 |
| a family seat vouches for a brother who is hanged that day | 12.6 | 0 |
| "we have to vote" followed by a vote to skip (share of urges) | 10.7% | 0% |
| an invented accusation on a cold board lands on the first seat (chance: 10%) | 97% | none invented |

**Tells: how much likelier the rule fires on a killer than on anybody else**

| rule a watcher applies | before | after |
| --- | --- | --- |
| says it visited the house that died last night | 4.59x | 0 (only town says it now) |
| asks to skip while a case stands | 4.75x | 0.51x |
| was accused by last night's victim | 1.64x | 1.38x |
| votes non-guilty on a trial with public evidence | 1.59x | 0.23x |
| votes guilty on a trial with no public evidence | 1.03x | 1.08x |
| joins a wagon with no public evidence | 0.97x | 0.95x |
| accuses with nothing checkable | 1.11x | 1.02x |

**Scenarios**

| | before | after |
| --- | --- | --- |
| a teammate's request is granted | 70% | 94%, every refusal gives its reason |
| the real holder rises to a fishing claim (unique role) | 97% | 7% |
| the real holder votes innocent on a stand claim of its own role | 82 of 661 | 3 of 643 |
| town votes follow a revealed Mayor's call (control seat: 0.5 to 2.5%) | 19% on a townsperson, 31% on a killer | 51% and 61% |
| a killer's promise, kept by naming anybody, is judged broken | 0% | 48% |

**What the bench refuted.** Several claims in the proposals below did not survive measurement, and they are corrected in place:

- Proposal 3 overstated the ballot tell. Town bots also vote guilty on 70% of trials with no public evidence, because the chorus alone carries a trial. The real tell was the family sparing its own brothers on proven cases (1.59x). The fix for that overshoots into a mild reverse tell (killers now spare a proven case 2% of the time, the town 9%), which marks a few seats as town and no seat as a killer.
- Proposal 5 was wrong: the prisoner's words only apply once the policy has already decided to execute, so silence does not cause executions. Nothing was changed there.
- Proposal 12 matters less than claimed: a killer claiming a juror's role on the stand is hanged about 90% of the time either way. The cheap part (the juror knows the claim is false) is done.
- Proposal 13 was wrong that "no bot moves": town bots did follow a revealed Mayor's unsupported call well above chance. The fix makes it the norm.
- Proposal 17 is not a problem: 82% of the Vigilante's shots on a seat acquitted that day hit a killer. Nothing was changed.
- Proposal 16 is real as an exploit for a person (98% of "I went to X" answers come from a power role) but the bots themselves do not use it, and fixing it changes how the town gives alibis. Not done.

**Balance.** The fixes cost the town about seven points of win rate in all-bot games, pooled over the six tables: 43.2% to 35.9% with `--talk`, 37.2% to 29.9% without. With two human-profile seats at the table the town is unchanged (42.2% before and after). Two causes were found and one was corrected:

- A temporary ablation (each fix switched back off in turn) showed that nearly the whole first drop came from families vouching for their brothers more often, and the reason was a hole on the town side: a clear with nothing behind it was worth a full voice while a bare accusation was worth a fifth. Clears are now weighed like accusations (`clearGrounding`), which closed that gap.
- The rest most likely comes from the framing rule (fix 9 below): dressing every fake accusation that corroborates a running case as a night's work makes fake checks more frequent, and the town's instruments act on them. The Vigilante's kills went from 38% to 48% townspeople, and the Jailor's executions on killers from 62% to 48%. This last attribution is inferred from the runs, not isolated.

The bots are harder to read, which is the point of goal 1, and a family that blends in wins more against bots that read the same public record. Whether to give that back by limiting framing further, or by rebalancing the role lists, is a design choice left open.

**What each role does**, from the `--report` table, before any fix: the Vigilante's kills were 38% townspeople and it ended with about two bullets unused per seat; the Veteran's porch kills were 43% townspeople; the Jailor's executions were 23% townspeople; the Escort blocked a town power 19% of the time. None of the proposals target these; the table is there to track them.

---

## Two principles used throughout

**The cover action.** In a hidden-role game the evil side is safe exactly when its behaviour cannot be told apart from the town's (a pooling equilibrium, in game-theory terms). Every public act whose odds differ by faction is a signal the room can read. So for each public act (a vote, a ballot, an accusation, an urge), an evil seat should first compute what a town seat holding its public view would do, and treat that as its default. It departs from that default only when the departure pays for the information it gives away: the vote is pivotal, a brother's life is at stake, a proven power role is in reach, or the family is close to winning. Different situations then produce different choices, with no dice needed.

**The value of a suggestion.** When someone suggests a target, a bot should weigh three things rather than roll a listen/ignore coin:

- how likely the suggester is to be an ally (certain for a family member or a Mason brother, near certain for a revealed Mayor, a matter of record for everyone else);
- the suggester's track record (the public `settledCredit`, the private `privateTrust`);
- what following costs or reveals (a friend of the family knifed, an exonerating check ignored, the bot's own role exposed).

Following is the default when the first two are high and the third is low. A refusal names the specific cost that caused it.

---

## Ranking

Ordered by how much the player's experience improves relative to how much work it is.

| # | Proposal | Goal | Gain | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A liar's night account contradicts its own mask, and a knife can name its victim | 3, 1 | High | Low | Done |
| 2 | A family bot can publicly deny its own teammate's badge | 2 | High | Low | Done |
| 3 | Evil seats play by different evidence rules from the town | 1 | Very high | Medium (simpler version: low) | Partly: brother ballots, the cover ballot, skip urges. The evidence floor was left alone (not a tell) |
| 4 | Family-room requests are granted by a roll, and refused without a reason | 2 | High | Low to medium | Done: merit judgement with a stated reason, repeats honoured. Daytime family-room reading not done |
| 5 | The cell executes silence and disputed badges by dice | 3 | Medium to high | Low | Not needed (the claim was wrong) |
| 6 | Covering a doomed brother, and a bus decided by a coin | 3, 1 | Medium to high | Low | Done, and a brother is now defended only behind a checker badge |
| 7 | "We have to vote", then a vote to skip | 3 | Medium | Low | Done |
| 8 | On a cold board, a fake accusation lands on the first seat at the table | 1 | Medium | Low | Done |
| 9 | Framed reports: re-rolled every turn, and more reports than nights | 3, 1 | Medium | Low | Done (one report a night, framing by situation); see the balance note |
| 10 | The knife goes first to whoever accused the family | 1 | High | Medium | Done, without the optional town mirror |
| 11 | Claiming a role fishes out its real holder | 1 | High | Medium | Done, plus the Jailor jails its impostor |
| 12 | A claim made on the stand cannot be contested before the verdict | 1 | Medium to high | Medium | Juror part done; bench counter-claim not done (little effect measured) |
| 13 | Bots never follow a likely ally in the square | 2 | High | Medium to high (simpler version: low) | Done |
| 14 | A promise is kept by saying anything the next day | 1 | Medium | Low to medium | Done |
| 15 | Claims forced at mechanical thresholds, and the wagon reply that swallows the best card | 1, 3 | Medium | Medium | Simpler version done (live table only) |
| 16 | "Where were you?" is a free scan for power roles | 1 | Medium | Medium | Not done |
| 17 | The Vigilante shoots a seat the room just acquitted on its defence | 3 | Low to medium | Low | Not needed (measured) |
| 18 | Coins that still decide public acts | 1, 3 | Low to medium | Low | Framing coin replaced; the rest not done |

---

## 1. A liar's night account contradicts its own mask, and a knife can name its victim

**Where.** `policies.ts`, `decideDay`, the "answering when asked" block. The seat answers honestly with probability `stance.answerHonestly`; honest, with a real visit and a badge that leaves home, it publishes `account: 'visited'` for `brain.wentTo`, otherwise `home`. A calm family seat answers honestly 0.55 of the time (`social.ts`, `stanceOf`). `brain.wentTo` is where the seat really went: set after the night in `sim/simulate.ts`, and by `BotMinds.wentTo` in `bot-mind.ts` on a live table. For a knife holder, that is the house it attacked.

**What a player sees.** Asked "where were you last night?", the Mafioso says "I went to Bob's", and Bob is the corpse on the square. Or a seat that has claimed Doctor answers "I stayed home", which no Doctor says. Either one is a free catch, and it reads as a bot that did not understand its own lie. The bots themselves do not punish the first case (the doorstep admission only feeds the public ranking in `visits.ts`, not `suspicionParts`), so this is a gift to humans specifically.

**Why.** A lie holds only if every public statement fits the mask. For an evil seat, "honest" means "tells its true night", which is exactly what it must not do when that night was a crime. The live driver already has the right material: `maskOf`, `inventedNight` and `fakeIntel` build one invented notebook that the stand and the will both quote.

**Change.** For a seat that is not town, the account comes from its mask, not from `wentTo`:

- a mask that stays home (`staysHome`): home, as today;
- a twin mask (`twinMasks`, for example a Consort wearing Escort) whose real visit did not land on a death: the real visit, which is both true and in character;
- any other visiting mask: that night's entry in the invented notebook (live: `inventedNight`; bench: a visit to a living house that did not die, the rule `fakeIntel` already follows);
- no mask yet: never a house that died last night.

`answerHonestly` then only decides, for an unmasked evil seat, whether it tells a harmless truth or says home.

**Effort.** Low. The notebook exists; the answer block needs to read it.

---

## 2. A family bot can publicly deny its own teammate's badge

**Where.** `policies.ts`, `decideDay`:

- the bystander counter-claim loop ("Three of you have said Escort") denies the living claimant of a unique role with the lowest `trustOf`, and has no teammate filter;
- the impostor block (another living seat claims the face this seat wears, acted on with probability 0.85) also has no teammate filter.

**What a player sees.** A human Mafioso claims Jailor to fight the real one, and a bot brother stands up and says "X cannot be the Jailor" about the human. Or a bot brother already wearing Jailor accuses its human teammate. For a human in the family this is the single most betraying thing a bot can do.

**Why.** In a contested claim the family wants the real holder to lose. A family voice on the wrong side of the contest is worse than silence, and it is also a tell: the room will note later who helped whom.

**Change.** Never deny or accuse a teammate or a bonded partner in either block. When a teammate is in a claim contest, the family seat weighs backing it: deny the rival when the rival is the weaker claimant (lower `trustOf`, later claim) and other seats have denied it too, so the family voice is not isolated. When two family faces collide, the seat that claimed second says nothing about the collision.

**Effort.** Low.

---

## 3. Evil seats play by different evidence rules from the town

This is the largest exploit in the brain.

**Where.** Five places, all in `policies.ts`:

- `pickVote`: the hearsay floor (`HEARSAY_FLOOR`, 2.2) applies only to the town. `unchecked` is zero for `isMafiaSeat` or any evil role, so a family seat votes on evidence of 0.55, while its score also carries plus 1.5 for a wagon a teammate is on and plus 2.4 times `wagonAlong` from day three.
- `decideBallot`: `if (familyOf(role) !== null) return 'guilty'` for any non-brother. Town jurors go through reasonable doubt, the abstain band and the logistic curve.
- `decideDay`, urge block: a family seat urges a skip when its top suspect is a brother (`coveringOne`), which only happens when the brother's case is strong enough to beat the ally discount.
- `decideDay`, family lies: accusations of the hottest seat with nothing behind them. A town seat's accusations come from findings or from `pickVote` passing the floor, so they almost always carry hard evidence.
- `steadyVote`: an evil seat never helps a skip while a wagon on a non-ally is at least halfway.

**What a player sees.** Open a thin wagon on a quiet bot, or push a trial with nothing hard in it, and watch. Town bots mostly stay off the wagon, and at the trial many vote innocent or abstain. Every family bot votes guilty. Ballots are public (`TrialRecord`), so after two such trials a human can list the family. Two smaller readings follow from the same rules: a bot that accuses without giving a reason is almost always evil, and a bot asking to skip on a day with a strong case is protecting someone.

**Why.** In a jury, one ballot is rarely pivotal, so the family's always-guilty rule buys little and pays the full information cost every time. It also forgoes what the trust meter pays: an innocent ballot on a townsperson who then hangs is worth plus 0.8 to the voter in `trustOf`.

**Change.** Apply the cover action from the principles section.

1. For each public act, compute the town answer from this seat's public view: call the same function with the seat treated as a town seat of its mask, allies emptied, family bonuses off, and private intel replaced by the mask's notebook (live) or dropped (bench).
2. Depart from it only when:
   - the act is pivotal: this vote opens or fails to open the trial, or this ballot passes or fails the rope. If the bot can see the ballots already cast, count them; otherwise project from the size of the wagon that opened the trial;
   - the stakes are high: a brother's life (the existing brother branches), a revealed Mayor, a proven power role, a rival killer (`rivalThreat`), or a losing clock near its floor;
   - the cover itself is harmful: for example it would put the seat on a brother's wagon when proposal 6 says no.
3. At a trial of a non-brother, a non-pivotal family seat casts the cover ballot, which on a thin case is often innocent and is later paid for by the trust meter. A pivotal one votes guilty.

Deceit and herd can shift how large a stake justifies departing from the cover, so two family seats in the same spot can still differ for reasons of temperament.

**Simpler alternative.**

- Remove the evil exemption from the hearsay floor in `pickVote`, keeping the family bonuses in the score.
- Let family seats fall through to the town ballot for non-brothers, overriding to guilty only when the projected tally is within one ballot or the town's parity pressure is at least 0.6.
- Let family lies ride only wagons that already carry a grounded accusation, where a town seat could also be standing.
- Let the urge block use the town rule for family seats too.

**Checking it.** The bench will move family win rates; that is not the measure. Check that the draw rate does not rise (a family that never commits can stall a table) and that trials still happen.

---

## 4. Family-room requests are granted by a roll, and refused without a reason

**Where.** `bots.ts`, `scripted`, night branch. A teammate's ask is granted if `willHeed` in `bot-mind.ts` passes a hashed roll: a base of 0.25 plus 0.2 times herd, doubled for a human, plus a small earned term from `privateTrust`. Family rooms never feed `privateTrust` (`hearPrivately` returns early for `mafia`, `triad` and `cult`), so for a family ask only the base counts, and a human is refused between one time in five and two times in five depending on the bot's herd (herd varies by 0.2 either side of 0.5; the bench measured 30% refused). A refusal (`familyLine`) explains why the bot likes its own pick (`whyKill(aim)`), not what is wrong with the asked house. `familyAsk` returns null outside the night, so a daytime request in the family room ("all on 7", "don't bus me") never reaches the day vote.

**What a player sees.** "Take 10." "I'd rather do 13, 13 is loud." Nothing about 10. Asking again gets the same answer, because the roll is stable. That is the stubborn teammate the brief warns against.

**Why.** Inside a family the engine has already told every member who the others are, so the chance the asker is an enemy in disguise is zero. What is left is a coordination game, and in a coordination game a teammate who refuses without a reason destroys more value than a slightly worse target costs. The human also often knows things the bot cannot parse from the square.

**Change.** Grant by default. Refuse only for a concrete defect of the asked house, and say that defect:

- it is a friend of the family (`friendlySeats`);
- the family's knife already bounced off it (`bounced`), or it is a proven Veteran's porch;
- the family's own captive or gagged seat (`unclashedTargets` already knows);
- last night's kill failed there and nothing suggests the protection has moved;
- the town will hang it tomorrow for free (heavy wagon with hard evidence);
- killing it would point at a brother (see proposal 10).

If the human repeats an ask after a refusal, grant it unless the defect is certain waste (armour, a Veteran, the family's own captive). Give family asks a track record: settle them at dawn like other confidences (did the knife land on a power role, bounce, hit a friend). During the day, read the family room for "vote X", "spare me" and "I'll claim Y", and feed them into the day policy: a teammate's named wagon gets the existing teammate-wagon bonus, the bus is off for the asker, and a teammate's announced mask is burned for everybody else in the family.

**Simpler alternative.** Replace the roll with the defect list and make the refusal cite it. Leave daytime reading for later.

**Effort.** Low for the defect list, medium for daytime reading.

---

## 5. The cell executes silence and disputed badges by dice

**Measured: this proposal was wrong.** The live overlay described below only applies once the policy has already decided to execute the prisoner (`slot !== null`), and both of its "execute" branches fall through to that same execution. So silence and a disputed badge do not cause executions; they only remove the chances of a reprieve. Nothing was changed. The text is kept as written, for the record.

**Where.** `bots.ts`, `scripted`, the `jail-execute` block. A prisoner whose claimed badge is disputed (another living claimant, a copy in the graveyard, or a proven holder) is executed with probability 0.9. A prisoner who said nothing is executed with probability 0.8. Both fire before and regardless of the prisoner's suspicion.

**What a player sees.** A human who is new, slow, or did not notice the cell is executed with no case against them. A human real Sheriff who is jailed after a bot Mafioso claimed Sheriff first is executed nine times in ten. Both feel like the game punishing the player for the bot's rule.

**Why.** Silence is strong evidence from a bot, which always answers, and weak evidence from a person, who may not have seen the cell. A disputed badge says one of two claimants is lying, not which one; executing whichever is in hand is a coin flip weighted by who happened to get jailed.

**Change.** Fold both into the weight the Jailor already compares against its bar (`suspicion` plus `cellProves`, against 2.3 minus courage), instead of rolling separately. For a disputed badge, compare the two claimants' standing (who claimed first, `settledCredit`, counter-claims, how long each claim has gone unchallenged) and add weight only when the prisoner is the weaker claimant. Count a human's silence for less than a bot's. The size of each addition is a tuning choice for the bench.

**Effort.** Low.

---

## 6. Covering a doomed brother, and a bus decided by a coin

**Where.** `policies.ts`:

- `decideDay`, "covering a brother": with a brother under two votes or on trial, if the sacrifice roll fails, the seat clears him with probability `fakeClaim` times 0.6, whatever the case against him. Once the brother flips evil, `provenLiar` marks the clearer for good (plus 2.5, hard) and its voice is discounted.
- `pickVote`, the bus: with a brother at the bar minus one vote, the seat boards with probability 0.2, or 0.7 if deceit is above 0.55, plus 0.3 times the sacrifice appetite. At the bar minus one, the boarding vote is the one that opens the trial.

**What a player sees.** A bot vouches for a Mafioso buried under evidence, and is hanged the next day for having vouched. Or a bot casts the deciding vote on its own brother one day, and in the same situation another day does not. The first looks suicidal, the second random.

**Why.** A clear is worth its risk only if it can change the outcome, and `decideBallot` already has the bands for that: `DOOMED_BROTHER` (2.2), `SAVABLE_BROTHER` (1.4) and `FAMILY_SWING` (0.18). The bus earns credit when the hanging happens anyway; being the vote that makes it happen is only sensible when the brother is lost in any case.

**Change.**

- Clear a brother only in the savable band, and only with enough family reach to matter. In the doomed band, say nothing.
- Replace the bus coin with a rule: board when the brother is in the doomed band and the wagon will complete without this seat, or when this seat's vote is the last one needed and the brother is doomed on hard evidence anyway. Never board a brother this seat defended in public earlier the same day, since that flip is the most visible move available. Deceit shifts where in the band the seat is willing to board, rather than being a probability.

**Effort.** Low.

---

## 7. "We have to vote", then a vote to skip

**Where.** `policies.ts`, `decideDay`, urge block: it urges a vote when its best suspect's `evidence` (which includes the chorus) reaches `NO_CASE_CEILING` (0.5). `steadyVote` votes to skip when the best `hard` is under the same ceiling, and a town seat's `pickVote` needs the hearsay floor. On a board where the only thing against anyone is talk, the same turn can urge a vote and cast a skip.

**What a player sees.** "We need to vote today", and the tally shows that seat voting to hang nobody.

**Why.** An urge is a commitment the room reads. It should come from the same read as the ballot.

**Change.** Urge a vote only if this seat's own proposal is non-null or its best hard evidence reaches the ceiling. Urge a skip only when `steadyVote` would skip. For family seats, see proposal 3.

**Effort.** Low.

---

## 8. On a cold board, a fake accusation lands on the first seat at the table

**Where.** `policies.ts`, `decideDay`, family lies. Candidates are sorted by heat (votes plus accusations) and the seat accuses `marks[0]` if its heat is above zero, or with probability 0.25 otherwise. When every heat is zero, the stable sort keeps table order, so the accusation always lands on the first living non-family seat. This is the same class of bug as the Arsonist's first-night petrol that the code already fixed.

**What a player sees.** In game after game, the lowest-numbered seat collects an accusation from nowhere early on, and the accuser turns out evil.

**Why.** Any fixed ordering becomes a signature once someone has seen a few games.

**Change.** On a cold board, do not invent an accusation at all. The code's own rule is that piling on is safe and inventing is how liars get caught, and a cold board is where an invented accusation stands out most. If a lie is wanted there, pick its target for a reason: the top of `likelyTargets`, a seat the family wants gone anyway.

**Effort.** Low.

---

## 9. Framed reports: re-rolled every turn, and more reports than nights

**Where.** `policies.ts`, `decideDay`. `framing = rng() < 0.5` is drawn on every call, and `dressedUp` stamps every accusation in that call with the mask's instrument. On a live table `decideDay` runs on every turn, so the coin changes during the afternoon. Nothing limits how many dressed reports a masked seat files against the number of nights its mask has worked, and no deduction in `deduce.ts` checks it.

**What a player sees.** A fake Sheriff who has had two nights reads out three checks. Or one seat alternates between "I checked 7" and "5 just feels off" in the same afternoon.

**Why.** A lie has to obey the arithmetic of the role it imitates: one check per night.

**Change.** Decide framing once per night of the mask and keep it on the brain. Allow at most one dressed report per night, name that night, and on a live table draw it from `fakeIntel` so the square, the stand and the will agree. Add a deduction, "more reports than nights", so that bots also catch a human who does it.

**Effort.** Low.

---

## 10. The knife goes first to whoever accused the family

**Where.** `policies.ts`, `decideNightTarget`, family branch. The first entry on the hit list (`provenSheriff`) is the first claim in the record in which a living seat accused a teammate. It counts any accusation: a bare hunch, days old, that nobody followed, ranks above a revealed Mayor. The slip is 0.25, falling to 0.05 as the push appetite rises.

**What a player sees.** Each morning, the victim's accusations list the family. A victim whose only accusation was a hunch on seat 7 all but names 7. A human learns this within a game or two.

**Why.** The kill is a public signal, and any targeting rule correlated with the family's identity leaks that identity. Killing the author of a weak accusation also turns it into strong evidence, because the room now reads it as vindicated. An accusation is worth killing over only when it is dangerous. Loud and trusted seats in general, lower on the list, reveal little, because every killer goes for them.

**Change.** Rank the accuser entry by how dangerous the accusation is, not by whether it exists: grounded or from a worked night (`grounded`, `worked`), from a credible voice (`claimerWeight`, `uncontestedBadge`), already drawing votes. A hunch nobody followed gets no priority and the accuser falls back into the ordinary tiers. Prefer accusers who have also accused several non-family seats, since their death points nowhere in particular. When the accused brother is already in the doomed band, the accusation no longer matters; kill elsewhere unless the accuser is a power role anyway.

**Optional mirror.** Let town bots read the same signal: a seat accused by last night's victim gets a hint-sized nudge. Its size would come from the existing `hint` weight and must be measured on the bench for false positives, since the fix above is meant to make the signal weaker.

**Effort.** Medium.

---

## 11. Claiming a role fishes out its real holder

**Where.** `policies.ts`, `decideDay`:

- the impostor block: when another living seat claims this seat's unique face, it claims and accuses with probability 0.85;
- the thief denial: a town seat whose real role is claimed says "X cannot be the Doctor" with probability 0.75, which reveals the denier as the Doctor;
- the private finding (`privateFindings`): a town seat claims and accuses without any roll whenever its own badge would make another claim impossible.

**What a player sees, as an evil human.** Claim Jailor (or Doctor, or anything the roster makes tight) in the square. The real holder stands up that afternoon, and the family kills it that night. It works almost every time, which makes it a reliable exploit rather than a gamble.

**Why.** This is a screening game: the fake claim is cheap talk whose purpose is to make the real holder reveal itself. Counter-claiming pays only when the impostor's claim is doing damage now. Otherwise it hands the family a target for nothing.

**Change.** Counter-claim when the stake exceeds the exposure.

- **Stake:** the impostor is on trial or under a wagon and leaning on the claim; the impostor has used the badge to accuse or clear someone; the claim is about to become uncontested and gain voice (`badgesOf` counts a badge from the day after it is worn); or the false claim would draw the Doctor's attention.
- **Exposure:** how much this role loses by being known. A Doctor or a Jailor loses a great deal, a Citizen nothing.

Without a stake, act quietly: note it in the will, whisper it to a revealed Mayor, vote the impostor when a wagon forms, and for a Jailor, jail the impostor. The private finding follows the same test.

**Simpler alternative.** Fire all three only when the impostor is endangered (two votes or on trial, the rule the investigator block already uses) or has used the badge in an accusation or a clear. Otherwise write it into the will.

**Effort.** Medium.

---

## 12. A claim made on the stand cannot be contested before the verdict

**Where.** `bots.ts`, `scripted`, `defense` task: a bystander gets at most one watch line and files no claim, and the impostor reflex lives in `decideDay`, which does not run during a trial. In `decideBallot`, a juror never uses its own card: `suspicionParts` weighs role claims only against other claims and the graveyard.

**What a player sees, as an evil human.** On the stand, claim a unique role nobody has claimed yet. The defence earns 0.4 (`defenceStrength`), and the real holder, sitting on the jury, cannot object before the vote and does not even vote guilty for it.

**Why.** The juror holding that role knows the claim is false as surely as it knows its own checks. Throwing that away is how a bot looks gullible.

**Change.**

- In `decideBallot`, a juror whose own unique role (or a role whose copies the roster exhausts once its own copy is counted) is claimed by the accused treats it as hard evidence of its own, priced like its own evil role result in `suspicionParts` (plus 4).
- Let a bystander's defence-stage turn file a counter-claim (the kind exists, valued 6 in `CLAIM_VALUE`) under the exposure test of proposal 11. The stake is high by definition here, since the claim is what is saving the accused.

**Effort.** Medium.

---

## 13. Bots never follow a likely ally in the square

**Where.** `policies.ts`, `suspicionParts` (`grounding`: an ungrounded accusation is a fifth of a voice and fades within two days) and `pickVote` (the hearsay floor). A human's "all on 7" is filed by the ear or the pattern reader as an ordinary accusation. `hearPrivately` in `bots.ts` files a whisper or a lodge line as an accusation scoped to that room, just as ungrounded. `willHeed` exists only for the family's knife.

**What a player sees.** A revealed Mayor, a proven Sheriff, or a Mason brother says "vote 7" with no reason, and too few bots move. (Measured: this was overstated. Town seats voted the named seat 19 to 31% of the time against 2.5% for a control seat nobody named, so the call did move votes, just not enough to feel followed.) A human Mason telling the lodge "7 is lying" is ignored by the brothers who know for certain that the human is town. That is the stubbornness of goal 2.

**Why.** Following a leader is worth the chance the leader is an ally, times the chance they are right, times the value of a coordinated vote, minus the cost if they are an enemy and minus what following reveals. For a revealed sash or a Mason brother the ally chance is certain, so only accuracy and cost are left. For a stranger the hearsay floor is the right answer, and it is what stops a human evil from steering the table.

**Change.** Add a leader weight. An explicit vote request from a seat this reader counts as an ally (`allyCredit` above zero: the sash for a town reader, a Mason brother, a lover) or as proven town (`provenRoles`) is treated as grounded for this reader, scaled by the suggester's `settledCredit` and, for private words, `privateWeight`. The reader follows unless it holds hard evidence to the contrary (its own clear check, a heal that exonerates, the target proven town or its own ally). In that case it says so in public, with `whyClear`, which already cites exactly those reasons. Strangers are unchanged.

The same weighing extends to night requests from likely allies ("doc, protect me", "check 7 tonight") once a reader for them exists. That reader can be a pattern reader in the style of `asks.ts`, applied to whispers and the lodge.

**Simpler alternative.** Treat accusations and clears from the revealed Mayor or Marshall, and from a Mason brother in the lodge, as grounded for readers who have them as allies. Leave everything else as it is.

**Effort.** Medium to high; the simpler version is low.

---

## 14. A promise is kept by saying anything the next day

**Where.** `deduce.ts`, broken promise: a promise counts as kept if the seat files any accusation, clear, sighting, hint, account or role claim on a later day. `defenceStrength` pays 0.8 for a night promise, the largest single defence credit. `decideDay` lets a role outside `PROVABLE` bluff one with probability half its false-accusation appetite.

**What a player sees, as an evil human.** On the stand: "spare me, I will prove it tonight." The next day: "7 is suspicious." The promise counts as kept, and the jury has paid the largest defence credit for nothing. It can be farmed.

**Why.** Cheap talk carries information only when breaking it costs something. Here breaking it costs nothing, so the jury pays for a signal that means nothing.

**Change.** Settle a promise against the role it implies. The delivery must be the kind of record that role produces, for the night promised: a check with `from: 'sheriff'` from a claimed Sheriff, a sighting with a doorstep from a claimed Lookout, the reveal for a Mayor. A promise from a seat with no claim must be followed by a claim plus that role's result. Roles whose proof can honestly come back empty (a Veteran nobody visited) settle as unproven rather than broken: no deduction, but no defence credit for a second promise. On the bot side, an evil seat bluffs a promise only when it projects being hanged otherwise, and delivers from its mask notebook.

**Effort.** Low to medium.

---

## 15. Claims forced at mechanical thresholds, and the wagon reply that swallows the best card

**Where.**

- `policies.ts`, `decideDay`: a Sheriff or Investigator under two votes or on trial claims and publishes every suspicious result.
- `bots.ts`, `defenceLine`: on a live stand, a town seat claims its real role in round one, always. On the bench, `bluffFor` does the same.
- `bots.ts`, `scripted`: on a live table, a seat with even one vote on it returns the push-back line from `answerWagon` with `claim: null`. Whatever `decideDay` wanted to say that turn is dropped, including a timely finding, a claim or a clear.

**What a player sees.** As an evil human: put two votes on a quiet bot (bench), or drag it to the stand (live), and a power role outs itself whether or not the case would have hanged it. As a town human: a bot Sheriff with one vote on it says only "why me?" while sitting on a check about the seat everyone is voting.

**Why.** Claiming is right when the chance of hanging without it, times what the town loses, beats the chance of being killed after it, times the same. That depends on the strength of the case and the value of the role, not on a vote count.

**Change.** On the stand, a power role estimates its own verdict from the evidence a town juror would see against it (its public `hard` and `evidence`) and claims in round one only if it is likely to hang. Otherwise it opens with its record (the account, then the will) and claims in a later round if the case holds. The live stand has three rounds, which is what makes this possible. A Citizen claims at once, since it costs nothing. Before a trial, the wagon reply should carry the seat's best card when it has one: a timely finding, a claim that defends it, a clear.

**Simpler alternative.** In `scripted`, let `answerWagon` give way to a role claim or a worked accusation already in `day.publishes`. Leave the stand as it is.

**Effort.** Medium; the simpler version is low.

---

## 16. "Where were you?" is a free scan for power roles

**Where.** `policies.ts`, `decideDay`, the answer block. A calm town seat answers honestly every time (`answerHonestly` is 1 minus 0.55 times desperation), and every bot asked today answers.

**What a player sees, as an evil human.** Ask each bot where it was. Every calm town bot with a visiting power names its visit; the rest say home. That sorts the table into power roles and the others in one afternoon, and the family knows whom to kill.

**Why.** An answer is a signal. For the town it is worth something only as corroboration later (`ownsUpTo`, the "volunteered" credit) or as a witness statement when the visited house died. For the evil side it identifies a role class. Bots cannot tell who is asking or why.

**Change.** Answer fully when the answer earns something: the visited house died or was saved, the seat is publishing a finding about it, the asker is a likely ally, or the seat is under a wagon, where volunteering protects it. Otherwise decline for now, and have every seat decline under the same conditions, not only power roles, so declining does not become the new tell. The rule depends on the asker and the stakes, not on the role. The stonewall path exists as a quirk; this makes it a reasoned choice. Check that a single declined question stays cheap on the board.

**Effort.** Medium.

---

## 17. The Vigilante shoots a seat the room just acquitted on its defence

**Where.** `policies.ts`, `decideNightTarget`, Vigilante: a seat tried and acquitted is shot if its suspicion reaches 1.8 minus half the courage. Suspicion does not include the defence that won the acquittal (`defenceStrength` is read only in the booth).

**What a player sees.** A human makes the defence of the evening, is acquitted, and is shot that night. It looks vindictive.

**Why.** The rule is right when the acquittal was carried by suspect ballots, and wrong when it was carried by the argument.

**Change.** Subtract the defence that was weighed at that trial, or fire only when the innocent ballots came mostly from low-trust seats (for example at or below the minus 2 at which `claimerWeight` halves a voice).

**Effort.** Low.

---

## 18. Coins that still decide public acts

Several public acts are still decided by a fixed probability, so the same situation gives different answers from one day to the next. Proposals 4, 6, 9 and 11 replace the worst of them. The remaining ones worth the same treatment:

- the Sheriff's timely claim (0.75 or more): claim when the wagon on the checked seat can actually reach a trial;
- the suspicion jitter in `suspicionParts` (up to 0.3 on every call): make it stable per reader, target and day, so re-reading an unchanged board gives the same number. Differences between bots should then come from temperament and private intel, which already differ.

Left as it is: the knife's slip. It is randomness, but it plays the mixed strategy the Doctor-against-killer game needs, and a pure ranking would be read exactly by a human Doctor. It can go once the known gap on reasoning about failed kills is closed.

---

## Looked at and left alone

- **The town never fake-claims.** Human town players rarely do either, and adding it would muddy the information human town players rely on more than it would protect the bots.
- **The human bonuses** (a small lift to a human's voice, 1.2 times on a human's defence, twice the heed in the family room). They correct for the parser losing half of what a person says, and none of them lets a human steer a stranger bot on nothing.
- **Styles for the Jester and the Survivor.** The scum Jester's innocent ballots on caught seats are a tell by design; that is how he gets hanged.

---

## Ideas that need an LLM

Noted only; each has a non-LLM stand-in for now.

- **Crediting the reasons a human gives in prose**, so that `backedUp` and `grounded` treat a person's argument like a bot's. Stand-in: a pattern reader that files a hint when a human line names the accused together with a night, a house or a role.
- **Real negotiation in the family room** ("why 13 and not 10?", compromises). Stand-in: the defect list of proposal 4, spoken as canned counter-arguments.
- **Reading a teammate's plan** ("I'll claim Doctor tomorrow, back me"). Stand-in: `selfClaim` from `asks.ts`, run on the family room, to register the human's intended mask.
- **Judging how convincing a defence was.** Stand-in: `defenceStrength`, plus the consistency checks of proposals 9 and 14.
- **Tone, hesitation, sarcasm, jokes.** Stand-in: nothing worth building beyond vote timing (`tempo.ts`).
- **Answers tailored to the exact accusation.** Stand-in: the existing `why`, `denyWhy` and `caseLine` phrasebook.
- **Recognising bait** (a fishing claim, a role-scan question). Stand-in: proposals 11 and 16, which make the bait unprofitable without having to detect intent.
- **Free-text night requests in the square** ("doc, protect me"). Stand-in: an `asks.ts`-style reader for a verb and a house, weighed as in proposal 13.
