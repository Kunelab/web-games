import { msg } from 'i18n';
import { Link } from 'react-router';

import { GAMES } from '../app/games';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { Button } from '../ui';
import './home.css';

/**
 * The main menu.
 *
 * It used to be a landing page about blind tests, with a list of question types
 * as its centrepiece and no way to reach two of the three games — CoronaZ was a
 * card you could not click and Mafia was not mentioned at all. What a visitor
 * actually needs from the front page is the catalogue and the two doors: start
 * something, or join something somebody else started.
 *
 * The question types moved to the quiz's own guide, which is where you look them
 * up rather than where you land.
 */
export default function Home() {
  const { user } = useAuth();
  const t = useT();

  return (
    <div className="home">
      <section className="home-hero">
        <h1 className="home-title">{t(msg('site.home.title'))}</h1>
        <p className="home-lede">{t(msg('site.home.lede'))}</p>
        <div className="page-actions">
          <Link to="/rejoindre">
            <Button variant="primary" size="lg">
              {t(msg('site.home.join'))}
            </Button>
          </Link>
          {user ? (
            <Link to="/bibliotheque">
              <Button variant="secondary" size="lg">
                {t(msg('site.home.library'))}
              </Button>
            </Link>
          ) : (
            <Link to="/connexion">
              <Button variant="secondary" size="lg">
                {t(msg('site.home.signIn'))}
              </Button>
            </Link>
          )}
        </div>
      </section>

      <section className="home-games">
        {GAMES.map((game) => (
          <Link className="home-game" key={game.id} to={game.path} style={{ borderLeftColor: game.accent }}>
            <span className="home-game-emoji" aria-hidden="true">
              {game.emoji}
            </span>
            <h2 style={{ color: game.accent }}>{game.name}</h2>
            <p>{t(msg(game.tagline))}</p>
            <span className="home-game-go">{t(msg('site.home.open'))}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
