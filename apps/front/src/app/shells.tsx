import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';

import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { Button, PortalContainerProvider } from '../ui';
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

            {user && (
              <nav className="mainnav" aria-label="Navigation principale">
                <NavLink to="/bibliotheque" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                  Bibliothèque
                </NavLink>
                <NavLink to="/playlists" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                  Playlists
                </NavLink>
                <NavLink to="/coronaz" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                  CoronaZ
                </NavLink>
                <NavLink to="/historique" className={({ isActive }) => `navlink ${isActive ? 'on' : ''}`}>
                  Historique
                </NavLink>
              </nav>
            )}

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
