import { api, type CzCareer } from '../api/client';
import { awardMeta } from '../app/awards';
import { badgeMeta } from '../app/badges';
import { czTrophyMeta } from '../app/czMeta';
import { useAsync } from '../hooks/useAsync';
import { EmptyState, Loading } from '../ui';
import './history.css';

/** French names of the speedrun-able scenarios, record-table order. */
const CZ_SCENARIOS: { id: string; label: string }[] = [
  { id: 'escape', label: 'Évasion' },
  { id: 'purge', label: 'Purge' },
  { id: 'survival', label: 'Survie' }
];

/**
 * What remains of the evenings: every finished game, newest first, and the careers
 * built out of them.
 *
 * Identity here is the nickname, because that is the identity the games were played
 * under: players join from phones with no account, and on a living-room instance
 * "Max" is the same Max every Saturday. The server aggregates on the same rule.
 */
export default function History() {
  const games = useAsync(() => api.results(50), []);
  const careers = useAsync(() => api.careers(), []);
  const czCareers = useAsync(() => api.czCareers(), []);

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Historique</h1>
          <p className="page-sub">Les parties jouées et ce que chacun en a tiré.</p>
        </div>
      </div>

      {(games.loading || careers.loading) && <Loading />}
      {games.error && <p className="field-error">{games.error}</p>}

      {!games.loading && (games.data ?? []).length === 0 && (
        <EmptyState title="Aucune partie enregistrée">
          <p>Les parties terminées apparaîtront ici, avec leur podium et leurs distinctions.</p>
        </EmptyState>
      )}

      {(careers.data ?? []).length > 0 && (
        <section className="stack-4">
          <h2 className="section-title">Palmarès</h2>
          <div className="career-scroll">
            <table className="career-table">
              <thead>
                <tr>
                  <th>Joueur</th>
                  <th className="num">Parties</th>
                  <th className="num">Victoires</th>
                  <th className="num">Points cumulés</th>
                  <th className="num">Meilleur score</th>
                  <th className="num">Distinctions</th>
                  <th>Succès</th>
                </tr>
              </thead>
              <tbody>
                {(careers.data ?? []).map((career) => (
                  <tr key={career.name}>
                    <td>
                      {career.name}
                      {career.title && <span className="career-title"> {badgeMeta(career.title).title}</span>}
                    </td>
                    <td className="num tabular">{career.games}</td>
                    <td className="num tabular">{career.wins}</td>
                    <td className="num tabular">{career.totalPoints.toLocaleString('fr-FR')}</td>
                    <td className="num tabular">{career.bestScore.toLocaleString('fr-FR')}</td>
                    <td className="num tabular">{career.awards}</td>
                    <td className="career-badges">
                      {career.badges.map((key) => {
                        const meta = badgeMeta(key);
                        return (
                          <span key={key} title={`${meta.title} · ${meta.hint}`}>
                            {meta.emoji}
                          </span>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(czCareers.data ?? []).length > 0 && (
        <section className="stack-4">
          <h2 className="section-title">CoronaZ · palmarès et records</h2>
          <CzRecords careers={czCareers.data ?? []} />
          <div className="career-scroll">
            <table className="career-table">
              <thead>
                <tr>
                  <th>Survivant</th>
                  <th className="num">Raids</th>
                  <th className="num">Victoires</th>
                  <th className="num">Victimes</th>
                  <th className="num">Boss</th>
                  <th>Trophées</th>
                </tr>
              </thead>
              <tbody>
                {(czCareers.data ?? []).map((career) => (
                  <tr key={career.name}>
                    <td>{career.name}</td>
                    <td className="num tabular">{career.stats.raids + career.stats.gmRaids}</td>
                    <td className="num tabular">{career.stats.wins + career.stats.gmWins}</td>
                    <td className="num tabular">{career.stats.kills}</td>
                    <td className="num tabular">{career.stats.bossKills}</td>
                    <td className="career-badges">
                      {career.trophies.map((key) => {
                        const meta = czTrophyMeta(key);
                        return (
                          <span key={key} title={`${meta.title} · ${meta.hint}`}>
                            {meta.emoji}
                          </span>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(games.data ?? []).length > 0 && (
        <section className="stack-4">
          <h2 className="section-title">Parties</h2>
          <ul className="history-list">
            {(games.data ?? []).map((game) => (
              <li className="history-card" key={game.id}>
                <div className="history-head">
                  <span className="history-playlist">{game.playlistName}</span>
                  <span className="history-date">{formatDate(game.finishedAt)}</span>
                </div>

                <ol className="history-standings">
                  {game.players.map((player) => (
                    <li key={player.name} className={player.rank === 1 ? 'winner' : undefined}>
                      <span className="rank tabular">{player.rank}</span>
                      <span className="history-player">{player.name}</span>
                      <span className="tabular">{player.score.toLocaleString('fr-FR')} pts</span>
                    </li>
                  ))}
                </ol>

                {game.awards.length > 0 && (
                  <ul className="history-awards">
                    {game.awards.map((award) => {
                      const meta = awardMeta(award.key);
                      return (
                        <li key={award.key} title={`${meta.title} : ${award.value}`}>
                          {meta.emoji} {meta.title} · {award.playerName}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <p className="history-meta">
                  {game.roundsTotal} manche{game.roundsTotal > 1 ? 's' : ''} · code {game.code}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The speedrun board: fastest winning raid per scenario, holder named. */
function CzRecords({ careers }: { careers: CzCareer[] }) {
  const records = CZ_SCENARIOS.map((scenario) => {
    let best: { name: string; turns: number } | null = null;
    for (const career of careers) {
      const turns = career.stats.fastestWinTurns[scenario.id];
      if (turns !== undefined && (best === null || turns < best.turns)) {
        best = { name: career.name, turns };
      }
    }
    return { ...scenario, best };
  }).filter((record) => record.best !== null);

  if (records.length === 0) return null;

  return (
    <ul className="history-awards">
      {records.map((record) => (
        <li key={record.id} title={`Raid gagné le plus vite · ${record.label}`}>
          ⏱️ {record.label} · {record.best?.turns} tours · {record.best?.name}
        </li>
      ))}
    </ul>
  );
}
