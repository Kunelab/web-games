import { msg, type Msg } from 'i18n';
import { Link } from 'react-router';

import { api, type CzCareer } from '../api/client';
import { awardMeta } from '../app/awards';
import { badgeMeta } from '../app/badges';
import { czTrophyMeta } from '../app/czMeta';
import { useAsync } from '../hooks/useAsync';
import { useLocale } from '../i18n/locale-context';
import { EmptyState, Loading } from '../ui';
import './history.css';

/** The speedrun-able scenarios, in record-table order. Named by the catalogue. */
const CZ_SCENARIOS = ['escape', 'purge', 'survival'];

/**
 * What remains of the evenings: every finished game, newest first, and the careers
 * built out of them.
 *
 * Identity here is the nickname, because that is the identity the games were played
 * under: players join from phones with no account, and on a living-room instance
 * "Max" is the same Max every Saturday. The server aggregates on the same rule.
 */
export default function History() {
  const { t, locale } = useLocale();
  const games = useAsync(() => api.results(50), []);
  const careers = useAsync(() => api.careers(), []);
  const czCareers = useAsync(() => api.czCareers(), []);

  // The reader's own calendar: "samedi 12 avril" or "Saturday 12 April".
  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

  return (
    <>
      <Link to="/" className="backlink">
        {t(msg('nav.backHome'))}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{t(msg('hist.title'))}</h1>
          <p className="page-sub">{t(msg('hist.lede'))}</p>
        </div>
      </div>

      {(games.loading || careers.loading) && <Loading />}
      {games.error && <p className="field-error">{games.error}</p>}

      {!games.loading && (games.data ?? []).length === 0 && (
        <EmptyState title={t(msg('hist.none'))}>
          <p>{t(msg('hist.noneNote'))}</p>
        </EmptyState>
      )}

      {(careers.data ?? []).length > 0 && (
        <section className="stack-4">
          <h2 className="section-title">{t(msg('hist.honours'))}</h2>
          <div className="career-scroll">
            <table className="career-table">
              <thead>
                <tr>
                  <th>{t(msg('hist.player'))}</th>
                  <th className="num">{t(msg('hist.games'))}</th>
                  <th className="num">{t(msg('hist.wins'))}</th>
                  <th className="num">{t(msg('hist.totalPoints'))}</th>
                  <th className="num">{t(msg('hist.bestScore'))}</th>
                  <th className="num">{t(msg('hist.awards'))}</th>
                  <th>{t(msg('hist.badges'))}</th>
                </tr>
              </thead>
              <tbody>
                {(careers.data ?? []).map((career) => (
                  <tr key={career.name}>
                    <td>
                      {career.name}
                      {career.title && (
                        <span className="career-title"> {t(msg(badgeMeta(career.title).titleKey))}</span>
                      )}
                    </td>
                    <td className="num tabular">{career.games}</td>
                    <td className="num tabular">{career.wins}</td>
                    <td className="num tabular">{career.totalPoints.toLocaleString(locale)}</td>
                    <td className="num tabular">{career.bestScore.toLocaleString(locale)}</td>
                    <td className="num tabular">{career.awards}</td>
                    <td className="career-badges">
                      {career.badges.map((key) => {
                        const meta = badgeMeta(key);
                        return (
                          <span key={key} title={`${t(msg(meta.titleKey))} · ${t(msg(meta.hintKey))}`}>
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
          <h2 className="section-title">{t(msg('hist.cz'))}</h2>
          <CzRecords careers={czCareers.data ?? []} />
          <div className="career-scroll">
            <table className="career-table">
              <thead>
                <tr>
                  <th>{t(msg('hist.survivor'))}</th>
                  <th className="num">{t(msg('hist.raids'))}</th>
                  <th className="num">{t(msg('hist.wins'))}</th>
                  <th className="num">{t(msg('hist.kills'))}</th>
                  <th className="num">{t(msg('hist.bosses'))}</th>
                  <th>{t(msg('hist.trophies'))}</th>
                </tr>
              </thead>
              <tbody>
                {(czCareers.data ?? []).map((career) => (
                  <tr key={career.name}>
                    {/* An "@" key is a Kune account, not a nickname typed on a phone. */}
                    <td>
                      {career.name.startsWith('@') ? (
                        <>
                          <span className="career-account" title={t(msg('hist.kuneAccount'))}>
                            🔗
                          </span>{' '}
                          {career.name.slice(1)}
                        </>
                      ) : (
                        career.name
                      )}
                    </td>
                    <td className="num tabular">{career.stats.raids + career.stats.gmRaids}</td>
                    <td className="num tabular">{career.stats.wins + career.stats.gmWins}</td>
                    <td className="num tabular">{career.stats.kills}</td>
                    <td className="num tabular">{career.stats.bossKills}</td>
                    <td className="career-badges">
                      {career.trophies.map((key) => {
                        const meta = czTrophyMeta(key);
                        return (
                          <span key={key} title={`${t(msg(meta.titleKey))} · ${t(msg(meta.hintKey))}`}>
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
          <h2 className="section-title">{t(msg('hist.gamesSection'))}</h2>
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
                      <span className="tabular">
                        {t(msg('hist.pts', { points: player.score.toLocaleString(locale) }))}
                      </span>
                    </li>
                  ))}
                </ol>

                {game.awards.length > 0 && (
                  <ul className="history-awards">
                    {game.awards.map((award) => {
                      const meta = awardMeta(award.key);
                      const title = t(msg(meta.titleKey));
                      return (
                        <li key={award.key} title={`${title} : ${award.value}`}>
                          {meta.emoji} {title} · {award.playerName}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <p className="history-meta">
                  {t(msg('hist.rounds', { count: game.roundsTotal, code: game.code }))}
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
  const t = useLocale().t;
  const records = CZ_SCENARIOS.map((id) => {
    let best: { name: string; turns: number } | null = null;
    for (const career of careers) {
      const turns = career.stats.fastestWinTurns[id];
      if (turns !== undefined && (best === null || turns < best.turns)) {
        best = { name: career.name, turns };
      }
    }
    return { id, best };
  }).filter((record) => record.best !== null);

  if (records.length === 0) return null;

  return (
    <ul className="history-awards">
      {records.map((record) => {
        const scenario: Msg = msg(`coronaz.scenario.${record.id}.name`);
        return (
          <li key={record.id} title={t(msg('hist.fastestWin', { scenario }))}>
            ⏱️ {t(scenario)} · {t(msg('hist.turns', { count: record.best?.turns ?? 0 }))} · {record.best?.name}
          </li>
        );
      })}
    </ul>
  );
}
