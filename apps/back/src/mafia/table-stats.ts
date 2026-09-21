/**
 * The bench's numbers, read off a flight recorder instead of a simulator.
 *
 * `mafia-core`'s headless bench answers "is this role balanced" across a
 * thousand games of the deterministic brain. It cannot answer the same question
 * about a table that actually ran — an LLM run, or a Saturday night with people
 * at it — because those games happen inside the manager and leave a trace file
 * rather than a `SimResult`.
 *
 * The trace already holds everything the bench prints: `deal` has the roster,
 * `night` has every swing and what stopped it (with the roles as they were when
 * the knife moved), `death` has the graveyard, `announce` has the verdicts.
 * So the same table can be built from it, and the same questions asked of five
 * LLM games as of a thousand scripted ones.
 *
 * Low samples are the point rather than a caveat. Nobody is going to play two
 * thousand games against a local model, and the numbers worth having from five
 * are not win rates — they are "did the gun ever fire", "when it fired did it
 * hit its own side", and "did the model get a turn at all". Counts are printed
 * beside every rate so a 100% built on one swing reads as what it is.
 */
import { ROLES, type RoleId } from 'mafia-core';

export interface TraceLine {
  t: number;
  ev: string;
  [key: string]: unknown;
}


export interface TableStats {
  games: number;
  days: number;
  winners: string[];
  seats: number;
  /** Ropes, and what the graveyard said about them afterwards. */
  lynches: number;
  evilLynches: number;
  townLynches: number;
  nightDeaths: number;
  swings: Map<RoleId, { swings: number; landed: number; allyLanded: number }>;
  /** The model's share of the turns it could have taken, and how it behaved. */
  drafts: number;
  llmCalls: number;
  llmOk: number;
  llmMs: number;
  benched: number;
  noBrain: number;
}

/**
 * Are these two playing for the same result?
 *
 * The same question `sameCause` answers for the bench, and the same answer:
 * town is a side, each family is a side, and `neutral` is a filing cabinet
 * rather than a side — an Arsonist burning a Serial Killer is not friendly
 * fire, whatever the roster calls them both.
 */
function sameCause(one: RoleId, other: RoleId): boolean {
  const left = ROLES[one]?.faction;
  const right = ROLES[other]?.faction;
  if (!left || !right || left !== right) return false;
  return left !== 'neutral';
}

export function emptyStats(): TableStats {
  return {
    games: 0,
    days: 0,
    winners: [],
    seats: 0,
    lynches: 0,
    evilLynches: 0,
    townLynches: 0,
    nightDeaths: 0,
    swings: new Map(),
    drafts: 0,
    llmCalls: 0,
    llmOk: 0,
    llmMs: 0,
    benched: 0,
    noBrain: 0
  };
}

/** Fold one game's trace into an accumulator. Call it once per file. */
export function foldTrace(lines: TraceLine[], into: TableStats = emptyStats()): TableStats {
  const deal = lines.find((line) => line.ev === 'deal');
  const seats = (deal?.seats ?? []) as { slot: number; role: RoleId }[];
  if (seats.length === 0) return into;

  into.games += 1;
  into.seats += seats.length;

  const closed = lines.find((line) => line.ev === 'close');
  if (typeof closed?.day === 'number') into.days += closed.day;
  for (const win of (closed?.winners ?? []) as { kind?: string }[]) {
    if (win.kind && !into.winners.includes(win.kind)) into.winners.push(win.kind);
  }

  for (const line of lines) {
    if (line.ev === 'death') {
      const role = line.role as RoleId | undefined;
      if (!role || !ROLES[role]) continue;
      if (line.phase === 'day') {
        into.lynches += 1;
        // A hanged Jester or Survivor settles nothing either way; the bench
        // counts the two camps and leaves the rest out of the ratio.
        if (ROLES[role].faction === 'town') into.townLynches += 1;
        else if (ROLES[role].faction !== 'neutral') into.evilLynches += 1;
      } else {
        into.nightDeaths += 1;
      }
    }

    if (line.ev === 'night') {
      const attacks = (line.attacks ?? []) as {
        attackerSlot: number | null;
        targetSlot: number;
        outcome: string;
        attackerRole?: RoleId;
        targetRole?: RoleId;
      }[];
      for (const attack of attacks) {
        const by = attack.attackerRole;
        const on = attack.targetRole;
        if (!by || !on || !ROLES[by] || !ROLES[on]) continue;
        // Poison outlives its poisoner and then bills the corpse for its own
        // death. A seat is not its own killer. See the bench's note on this.
        if (attack.attackerSlot === null || attack.attackerSlot === attack.targetSlot) continue;
        const row = into.swings.get(by) ?? { swings: 0, landed: 0, allyLanded: 0 };
        row.swings += 1;
        if (attack.outcome === 'killed') {
          row.landed += 1;
          if (sameCause(by, on)) row.allyLanded += 1;
        }
        into.swings.set(by, row);
      }
    }

    if (line.ev === 'draft') {
      into.drafts += 1;
      if (line.why === 'no brain up') into.noBrain += 1;
    }
    if (line.ev === 'llm') {
      into.llmCalls += 1;
      if (line.ok) {
        into.llmOk += 1;
        into.llmMs += Number(line.ms ?? 0);
      }
    }
    if (line.ev === 'chain' && line.benched === true) into.benched += 1;
  }

  return into;
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? '   n/a' : `${((100 * part) / whole).toFixed(1)}%`;

/** The bench's layout, so the two reports can be read side by side. */
export function renderStats(stats: TableStats): string {
  const out: string[] = [];
  const g = Math.max(1, stats.games);

  out.push(
    `parties ${stats.games} · ${(stats.seats / g).toFixed(0)} sièges · ${(stats.days / g).toFixed(1)} jours` +
      ` · vainqueurs ${stats.winners.join(', ') || '?'}`
  );
  out.push(
    `pendaisons ${stats.lynches} (${(stats.lynches / g).toFixed(1)}/partie) · justes ${pct(
      stats.evilLynches,
      stats.evilLynches + stats.townLynches
    )} · morts de nuit ${stats.nightDeaths}`
  );

  const share = pct(stats.llmCalls, stats.drafts);
  const avg = stats.llmOk === 0 ? 0 : Math.round(stats.llmMs / stats.llmOk);
  out.push(
    `modèle ${stats.llmOk}/${stats.llmCalls} réussis · ${share} des tours · ${avg}ms · ` +
      `mis au banc ${stats.benched} · sans cerveau ${stats.noBrain}`
  );

  if (stats.swings.size > 0) {
    out.push('');
    out.push('rôle             | coups | réussis | sur les siens');
    const rows = [...stats.swings].sort((left, right) => right[1].landed - left[1].landed);
    for (const [role, row] of rows) {
      out.push(
        [
          role.padEnd(16),
          String(row.swings).padStart(5),
          pct(row.landed, row.swings).padStart(7),
          `${pct(row.allyLanded, row.landed)} (${row.allyLanded}/${row.landed})`.padStart(13)
        ].join(' | ')
      );
    }
  }
  return out.join('\n');
}
