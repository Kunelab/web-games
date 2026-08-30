import { msg } from 'i18n';
import { Link } from 'react-router';

import type { GameEntry } from '../../app/games';
import { useAuth } from '../../hooks/useAuth';
import { useT } from '../../i18n/locale-context';
import './menu.css';

/**
 * The front door of a game.
 *
 * Every game used to open onto its setup form, which asked you to choose a
 * scenario before you had decided whether to play at all — and offered no way to
 * join someone else's table, read the rules, or spend what you had earned. This
 * is the screen that was missing: create, join, learn, spend, leave.
 *
 * The tiles are declared by each game's own page and rendered here, because the
 * three menus differ in their contents and in nothing else. A tile that needs an
 * account says so rather than disappearing: a visitor should be able to see that
 * making one gets them a library and a wardrobe.
 */

export interface MenuTile {
  to: string;
  /** Catalogue keys, resolved here: a tile list is data, not prose. */
  label: string;
  hint: string;
  emoji: string;
  /** Draws the eye: the one thing most visitors came to do. */
  primary?: boolean;
  /** Greys out and explains itself when signed out, rather than vanishing. */
  requiresAccount?: boolean;
  /** Opens in a new tab. For the television, and nothing else so far. */
  external?: boolean;
}

export interface GameMenuProps {
  game: GameEntry;
  /** Key for the two or three lines of what this game is, above the tiles. */
  lede: string;
  tiles: MenuTile[];
}

export default function GameMenu({ game, lede, tiles }: GameMenuProps) {
  const { user } = useAuth();
  const t = useT();

  return (
    <div className="menu" style={{ '--game-accent': game.accent } as React.CSSProperties}>
      <header className="menu-head">
        <span className="menu-emoji" aria-hidden="true">
          {game.emoji}
        </span>
        <div>
          <h1 className="menu-title">{game.name}</h1>
          <p className="menu-lede">{t(msg(lede))}</p>
        </div>
      </header>

      <nav className="menu-grid" aria-label={t(msg('site.menu.aria', { game: game.name }))}>
        {tiles.map((tile) => {
          const locked = Boolean(tile.requiresAccount) && !user;

          if (locked) {
            return (
              <Link key={tile.to} to="/connexion" className="menu-tile locked">
                <span className="menu-tile-emoji" aria-hidden="true">
                  {tile.emoji}
                </span>
                <strong>{t(msg(tile.label))}</strong>
                <span className="menu-tile-hint">{t(msg('site.menu.needsAccount'))}</span>
              </Link>
            );
          }

          return (
            <Link
              key={tile.to}
              to={tile.to}
              className={`menu-tile ${tile.primary ? 'primary' : ''}`}
              target={tile.external ? '_blank' : undefined}
              rel={tile.external ? 'noopener' : undefined}
            >
              <span className="menu-tile-emoji" aria-hidden="true">
                {tile.emoji}
              </span>
              <strong>{t(msg(tile.label))}</strong>
              <span className="menu-tile-hint">{t(msg(tile.hint))}</span>
            </Link>
          );
        })}
      </nav>

      <Link to="/" className="menu-back">
        {t(msg('site.menu.back'))}
      </Link>
    </div>
  );
}
