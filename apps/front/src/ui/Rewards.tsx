import { msg } from 'i18n';

import { useLocale } from '../i18n/locale-context';
import './rewards.css';

/**
 * The payoff screen: what the game just bought you.
 *
 * Ported from CoronaZ, where it answered "after three evenings there is nothing
 * left to chase", and now shared by all three games. The quiz had the same hole
 * and hid it better — tokens credited at the final whistle and shown nowhere — and
 * Mafia had the worst version of it, a running total in a footnote with no ladder
 * behind it at all. Progression nobody watches advancing is progression nobody
 * believes in.
 *
 * Three things, in the order a player wants them: what I earned, what fell
 * tonight, and what I am close to. The last one is the one that matters — a bar at
 * 17 of 25 is an argument for one more game in a way a balance is not.
 *
 * Everybody's rows are shown to everybody wherever the screen is shared,
 * deliberately: reading out who unlocked what is most of what this is for at a
 * table, and nothing in a badge is private.
 *
 * Structural on purpose. Each game owns its own ladder, its own badge faces and
 * its own currency, so the two things that differ are parameters and the shape
 * they have in common is this interface. `game-core`'s `GameReward` and
 * `mafia-core`'s `MafiaReward` both satisfy it without either package having to
 * learn about the other.
 */
export interface RewardRow {
  playerId: string;
  name: string;
  /** What this game paid. */
  gained: number;
  /** The balance afterwards, or null for a seat with no ledger, such as a bot. */
  total: number | null;
  newBadges: string[];
  newTitle: string | null;
  nextBadges: { key: string; current: number; target: number; unit: string; moved: boolean }[];
}

export function Rewards({
  rewards,
  meId,
  currency,
  meta
}: {
  rewards: RewardRow[];
  meId: string | null;
  /** The emoji this game pays in: 🎟️ for the quiz, 🩸 for Mafia, 🥫 for a raid. */
  currency: string;
  /** A badge key to its face. Each game owns its ladder, so each owns this. */
  meta: (key: string) => { emoji: string; titleKey: string };
}) {
  const { t } = useLocale();
  if (rewards.length === 0) return null;

  // Yours first: on a phone the fold is three rows down.
  const ordered = [...rewards].sort((a, b) => Number(b.playerId === meId) - Number(a.playerId === meId));

  return (
    <section className="rewards">
      <h2 className="rewards-title">{t(msg('play.rewards.career'))}</h2>

      {ordered.map((reward) => (
        <article key={reward.playerId} className={`reward ${reward.playerId === meId ? 'mine' : ''}`}>
          <header className="reward-head">
            <span className="reward-name">{reward.name}</span>
            <span className="reward-tokens tabular">
              +{reward.gained} {currency}
              {/* A seat with no ledger banked nothing, so it has no balance to
                  print. Saying "0 in all" at a bot would be a lie about a wallet
                  that does not exist. */}
              {reward.total !== null && (
                <span className="reward-total"> · {t(msg('play.rewards.inStock', { count: reward.total }))}</span>
              )}
            </span>
          </header>

          {/* What fell tonight. Loud, because it is rare and it is the good news. */}
          {reward.newBadges.length > 0 && (
            <ul className="reward-badges">
              {reward.newBadges.map((key) => {
                const face = meta(key);
                return (
                  <li key={key}>
                    <span aria-hidden="true">{face.emoji}</span> <strong>{t(msg(face.titleKey))}</strong>
                  </li>
                );
              })}
            </ul>
          )}

          {reward.newTitle && (
            <p className="reward-title-line">
              {t(msg('play.rewards.newTitle'))} · {meta(reward.newTitle).emoji}{' '}
              <strong>{t(msg(meta(reward.newTitle).titleKey))}</strong>
            </p>
          )}

          {/* The reason to play another. */}
          {reward.nextBadges.length > 0 && (
            <ul className="reward-next">
              {reward.nextBadges.map((next) => {
                const face = meta(next.key);
                const pct = next.target > 0 ? Math.min(100, (next.current / next.target) * 100) : 0;
                return (
                  <li key={next.key} className={next.moved ? 'moved' : ''}>
                    <span className="next-label">
                      <span aria-hidden="true">{face.emoji}</span> {t(msg(face.titleKey))}
                    </span>
                    <span className="next-bar" aria-hidden="true">
                      <span className="next-fill" style={{ width: `${pct.toFixed(1)}%` }} />
                    </span>
                    <span className="next-count tabular">
                      {next.current}/{next.target} {t(msg(next.unit))}
                      {next.moved && <span className="next-moved"> ↑</span>}
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
