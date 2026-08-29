import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { GameEntry } from '../../app/games';
import { useAuth } from '../../hooks/useAuth';
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
  /** Two or three lines of what this game is, above the tiles. */
  lede: ReactNode;
  tiles: MenuTile[];
}

export default function GameMenu({ game, lede, tiles }: GameMenuProps) {
  const { user } = useAuth();

  return (
    <div className="menu" style={{ '--game-accent': game.accent } as React.CSSProperties}>
      <header className="menu-head">
        <span className="menu-emoji" aria-hidden="true">
          {game.emoji}
        </span>
        <div>
          <h1 className="menu-title">{game.name}</h1>
          <p className="menu-lede">{lede}</p>
        </div>
      </header>

      <nav className="menu-grid" aria-label={`Menu ${game.name}`}>
        {tiles.map((tile) => {
          const locked = Boolean(tile.requiresAccount) && !user;

          if (locked) {
            return (
              <Link key={tile.to} to="/connexion" className="menu-tile locked">
                <span className="menu-tile-emoji" aria-hidden="true">
                  {tile.emoji}
                </span>
                <strong>{tile.label}</strong>
                <span className="menu-tile-hint">Il faut un compte — se connecter</span>
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
              <strong>{tile.label}</strong>
              <span className="menu-tile-hint">{tile.hint}</span>
            </Link>
          );
        })}
      </nav>

      <Link to="/" className="menu-back">
        ← Retour au menu principal
      </Link>
    </div>
  );
}
