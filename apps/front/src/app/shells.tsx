import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { Button, ChevronDown, PortalContainerProvider } from '../ui';
import { GAMES } from './games';
import './shells.css';

/**
 * Two shells, because the app has two jobs.
 *
 * The atelier keeps navigation visible: you are preparing, you move between the
 * library and playlists, and you need to know where you are. The game shell has no
 * navigation at all — during a round there is nothing to click by mistake, and the
 * only way out is deliberate.
 *
 * The `shell-*` class is also what selects the palette, so switching shells
 * re-skins every component below it without any of them knowing.
 */

export function AtelierShell() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  /**
   * Published so selects and dialogs can render inside the shell rather than on the
   * body. The palette is declared here, and a portal to the body escapes it: that is
   * what left an open dropdown with no background at all.
   */
  const [shell, setShell] = useState<HTMLElement | null>(null);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      void navigate('/connexion');
    }
  }

  return (
    <PortalContainerProvider container={shell}>
      <div className="shell shell-atelier" ref={setShell}>
        <header className="topbar">
          <div className="topbar-inner">
            <NavLink to="/" className="brand">
              Kune
            </NavLink>

            <nav className="mainnav" aria-label="Navigation principale">
              <GamesMenu />
              {user && (
                <>
                  <NavLink to="/bibliotheque" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                    Bibliothèque
                  </NavLink>
                  <NavLink to="/playlists" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                    Mes quiz
                  </NavLink>
                  <NavLink to="/historique" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                    Historique
                  </NavLink>
                </>
              )}
            </nav>

            <div className="topbar-end">
              {user ? (
                <>
                  <span className="whoami">{user.login}</span>
                  <Button variant="ghost" size="sm" onClick={() => void logout()}>
                    Déconnexion
                  </Button>
                </>
              ) : (
                <NavLink to="/connexion" className="navlink">
                  Connexion
                </NavLink>
              )}
            </div>
          </div>
        </header>

        <main className="atelier-main">
          <Outlet />
        </main>
      </div>
    </PortalContainerProvider>
  );
}

/**
 * One door for three games.
 *
 * The header used to carry a link per game, which stopped scaling at two and was
 * already lying at three: Mafia had no link at all and was reachable only by
 * typing the URL. A dropdown states the whole catalogue in one place, and every
 * entry lands on that game's own menu rather than dropping you straight into a
 * setup form — deciding to play CoronaZ and deciding what kind of CoronaZ are
 * two different decisions.
 *
 * It is deliberately visible signed out. The games are the reason to be here.
 */
function GamesMenu() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const wrapper = useRef<HTMLDivElement | null>(null);

  /**
   * Navigating is an answer to the menu, so the menu should not still be open on
   * the page it opened. Adjusted during render rather than in an effect: this is
   * state derived from a prop changing, and doing it in an effect renders the new
   * page once with the menu still hanging over it.
   */
  const [seenPath, setSeenPath] = useState(location.pathname);
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const onGamePage = GAMES.some((game) => location.pathname.startsWith(game.path));

  return (
    <div className="gamesmenu" ref={wrapper}>
      <button
        type="button"
        className={`navlink gamesmenu-trigger ${onGamePage ? 'on' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        Jeux
        <ChevronDown />
      </button>

      {open && (
        <div className="gamesmenu-panel" role="menu">
          {GAMES.map((game) => (
            <NavLink key={game.id} to={game.path} role="menuitem" className="gamesmenu-item">
              <span className="gamesmenu-emoji" aria-hidden="true">
                {game.emoji}
              </span>
              <span>
                <strong style={{ color: game.accent }}>{game.name}</strong>
                <span className="gamesmenu-tagline">{game.tagline}</span>
              </span>
            </NavLink>
          ))}

          <NavLink to="/rejoindre" role="menuitem" className="gamesmenu-item gamesmenu-join">
            <span className="gamesmenu-emoji" aria-hidden="true">
              🔑
            </span>
            <span>
              <strong>Rejoindre une partie</strong>
              <span className="gamesmenu-tagline">Un code, ou la liste des salons ouverts.</span>
            </span>
          </NavLink>
        </div>
      )}
    </div>
  );
}

/** No navigation, no chrome: the round owns the screen. */
export function JeuShell() {
  const [shell, setShell] = useState<HTMLElement | null>(null);

  return (
    <PortalContainerProvider container={shell}>
      <div className="shell shell-jeu" ref={setShell}>
        <Outlet />
      </div>
    </PortalContainerProvider>
  );
}
