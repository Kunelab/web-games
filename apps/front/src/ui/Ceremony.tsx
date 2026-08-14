import type { FinalAward, PlayerView } from 'game-core';

import { awardMeta } from '../app/awards';
import { badgeMeta } from '../app/badges';

/**
 * The final ceremony: a podium, the distinctions, then everyone else.
 *
 * The podium places second on the left and third on the right because that is what
 * a podium looks like, and the blocks rise in reverse order so the winner lands
 * last. Ties share a rank upstream, so two players can stand on the same step.
 */
export function Ceremony({ players, awards }: { players: PlayerView[]; awards: FinalAward[] }) {
  // Already sorted by rank; the visual order is 2nd, 1st, 3rd.
  const [first, second, third] = players;
  const steps = [second, first, third].filter((player) => player !== undefined);
  const rest = players.slice(3);

  return (
    <div className="ceremony">
      <div className="podium">
        {steps.map((player) => {
          const rank = Math.min(player.rank, 3);
          return (
            <div key={player.id} className={`podium-step podium-rank-${rank}`}>
              <span className="podium-name">{player.name}</span>
              {player.title && <span className="podium-title">{badgeMeta(player.title).title}</span>}
              <span className="podium-score tabular">{player.score} pts</span>
              <div className="podium-block">
                <span className="podium-rank tabular">{player.rank}</span>
              </div>
            </div>
          );
        })}
      </div>

      {awards.length > 0 && (
        <ul className="awards">
          {awards.map((award) => {
            const meta = awardMeta(award.key);
            return (
              <li key={award.key}>
                <span className="award-emoji" aria-hidden="true">
                  {meta.emoji}
                </span>
                <span className="award-title">{meta.title}</span>
                <span className="award-holder">{award.playerName}</span>
                <span className="award-value">{award.value}</span>
              </li>
            );
          })}
        </ul>
      )}

      {rest.length > 0 && (
        <ol className="final-standings">
          {rest.map((player) => (
            <li key={player.id}>
              <span className="rank tabular">{player.rank}</span>
              <span className="score-name">{player.name}</span>
              <span className="score-value tabular">{player.score}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
