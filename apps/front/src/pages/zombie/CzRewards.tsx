import { gmClassDef, heroDef, type CzRaidReward } from 'coronaz-core';

import { czPerkMeta, czTrophyMeta } from '../../app/czMeta';

/**
 * The payoff screen: what the raid just bought you.
 *
 * The rations were always banked and never shown. The end screen listed a verdict,
 * a scoreboard and a set of awards, then sent everybody back to the menu — so the
 * progression existed only in the database and only announced itself in the next
 * lobby, by which point the raid it belonged to was over. A career nobody can see
 * advancing is a career nobody believes in, which is most of why a third evening
 * feels like there is nothing left to chase.
 *
 * Three things, in the order a player wants them: what I earned, what fell
 * tonight, and what I am close to. The last one is the one that matters — a bar at
 * 72 of 100 is an argument for a fourth raid in a way that a number of rations is
 * not.
 *
 * Everybody's rows are shown to everybody, deliberately: reading out who unlocked
 * what is most of what this screen is *for* at a table, and nothing in a trophy is
 * private.
 */
export function CzRewards({ rewards, meId }: { rewards: CzRaidReward[]; meId: string | null }) {
  if (rewards.length === 0) return null;

  // Yours first: on a phone the fold is three rows down.
  const ordered = [...rewards].sort((a, b) => Number(b.playerId === meId) - Number(a.playerId === meId));

  return (
    <section className="cz-rewards">
      <h2 className="cz-rewards-title">Carrière</h2>
      {ordered.map((reward) => (
        <article key={reward.playerId} className={`cz-reward ${reward.playerId === meId ? 'mine' : ''}`}>
          <header className="cz-reward-head">
            <span className="cz-reward-name">{reward.name}</span>
            <span className="cz-reward-rations tabular">
              +{reward.rationsGained} 🥫<span className="cz-reward-total"> · {reward.rations} en réserve</span>
            </span>
          </header>

          {/* What fell tonight. Loud, because it is rare and it is the good news. */}
          {reward.newTrophies.length > 0 && (
            <ul className="cz-reward-trophies">
              {reward.newTrophies.map((key) => {
                const meta = czTrophyMeta(key);
                return (
                  <li key={key}>
                    <span aria-hidden="true">{meta.emoji}</span> <strong>{meta.title}</strong>
                  </li>
                );
              })}
            </ul>
          )}

          {reward.newPerks.length > 0 && (
            <ul className="cz-reward-perks">
              {reward.newPerks.map((perk) => {
                const meta = czPerkMeta(perk);
                return (
                  <li key={perk}>
                    <span aria-hidden="true">{meta.emoji}</span> {meta.label}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Newly within reach — not everything affordable, or the same list would
              reappear every raid until it was bought and stop being news. */}
          {reward.affordable.length > 0 && (
            <p className="cz-reward-unlock">
              🔓 Débloquable :{' '}
              {reward.affordable
                .map((entry) => {
                  // A hero id on the survivors' track, a horde class on the other:
                  // the row says which, so neither has to be guessed at.
                  const def = reward.gm ? gmClassDef(entry.id) : heroDef(entry.id);
                  return `${def.emoji} ${def.name}`;
                })
                .join(' · ')}
            </p>
          )}

          {/* The reason to come back. */}
          {reward.nextTrophies.length > 0 && (
            <ul className="cz-reward-next">
              {reward.nextTrophies.map((next) => {
                const meta = czTrophyMeta(next.key);
                const pct = next.target > 0 ? Math.min(100, (next.current / next.target) * 100) : 0;
                return (
                  <li key={next.key} className={next.moved ? 'moved' : ''}>
                    <span className="cz-next-label">
                      <span aria-hidden="true">{meta.emoji}</span> {meta.title}
                      {next.perk && <span className="cz-next-perk"> → {czPerkMeta(next.perk).label}</span>}
                    </span>
                    <span className="cz-next-bar" aria-hidden="true">
                      <span className="cz-next-fill" style={{ width: `${pct.toFixed(1)}%` }} />
                    </span>
                    <span className="cz-next-count tabular">
                      {next.current}/{next.target} {next.unit}
                      {next.moved && <span className="cz-next-moved"> ↑</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
