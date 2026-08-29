import { Link } from 'react-router';

import { GAMES } from '../app/games';
import { useAuth } from '../hooks/useAuth';
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

  return (
    <div className="home">
      <section className="home-hero">
        <h1 className="home-title">Trois jeux, un salon, des téléphones.</h1>
        <p className="home-lede">
          Un quiz à faire deviner, un quartier à évacuer, une ville qui cherche ses tueurs. Chacun sur son téléphone,
          la partie sur la télé quand il y en a une.
        </p>
        <div className="page-actions">
          <Link to="/rejoindre">
            <Button variant="primary" size="lg">
              Rejoindre une partie
            </Button>
          </Link>
          {user ? (
            <Link to="/bibliotheque">
              <Button variant="secondary" size="lg">
                Bibliothèque
              </Button>
            </Link>
          ) : (
            <Link to="/connexion">
              <Button variant="secondary" size="lg">
                Se connecter
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
            <p>{game.tagline}</p>
            <span className="home-game-go">Ouvrir le menu →</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
