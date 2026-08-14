import { Link } from 'react-router';

import { useAuth } from '../hooks/useAuth';
import { Button } from '../ui';
import './home.css';

const games = [
  {
    kind: 'blindtest',
    name: 'Blind test',
    text: 'Un extrait joue sur la télé, les joueurs nomment le titre et l’artiste depuis leur téléphone.'
  },
  {
    kind: 'quiz',
    name: 'Questions',
    text: 'Avec ou sans choix multiples. Répondre à l’aveugle, sans voir les propositions, rapporte davantage.'
  },
  {
    kind: 'estimation',
    name: 'Estimation',
    text: 'Une question chiffrée, chacun avance son nombre. La réponse la plus proche l’emporte.'
  },
  {
    kind: 'image-reveal',
    name: 'Image qui se révèle',
    text: 'Une image pixelisée devient nette peu à peu. Le premier à reconnaître marque le plus.'
  },
  {
    kind: 'image-memory',
    name: 'Le panel',
    text: 'Un panel à mémoriser, puis citez-en le plus possible. Chaque élément est une course à part.'
  },
  {
    kind: 'coronaz',
    name: 'CoronaZ',
    text: 'Survie coopérative contre la horde, façon jeu de plateau : la carte sur la télé, votre survivant en main.'
  }
];

export default function Home() {
  const { user } = useAuth();

  return (
    <div className="home">
      <section className="home-hero">
        <h1 className="home-title">Des jeux à faire deviner, entre amis.</h1>
        <p className="home-lede">
          Vous préparez une playlist, vous l’affichez sur la télé, vos amis rejoignent en scannant un QR code. Le score
          récompense celui qui répond le premier, pas celui qui a la meilleure connexion.
        </p>
        <div className="page-actions">
          {user ? (
            <>
              <Link to="/playlists">
                <Button variant="primary" size="lg">
                  Mes playlists
                </Button>
              </Link>
              <Link to="/bibliotheque">
                <Button variant="secondary" size="lg">
                  Bibliothèque
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link to="/connexion">
                <Button variant="primary" size="lg">
                  Se connecter
                </Button>
              </Link>
              <Link to="/rejoindre">
                <Button variant="secondary" size="lg">
                  Rejoindre une partie
                </Button>
              </Link>
            </>
          )}
        </div>
      </section>

      <section className="home-games">
        {games.map((game) => (
          <article className="home-game" key={game.kind} style={{ borderLeftColor: `var(--kind-${game.kind})` }}>
            <h2>{game.name}</h2>
            <p>{game.text}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
