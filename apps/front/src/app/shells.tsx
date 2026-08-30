import { msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { ChevronDown, PortalContainerProvider } from '../ui';
import AccountMenu from './AccountMenu';
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
  const t = useT();
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

            {/*
              Only the games menu. The bar used to grow three quiz links the
              moment you signed in — the library, the playlists and the history —
              and then carry them into CoronaZ and Mafia, where they meant
              nothing. Each game's own menu is the front door now, so those live
              as tiles on the menus they belong to.
            */}
            <nav className="mainnav" aria-label={t(msg('site.nav.main'))}>
              <GamesMenu container={shell} />
            </nav>

            <div className="topbar-end">
              {user ? (
                <AccountMenu login={user.login} container={shell} onLogout={() => void logout()} />
              ) : (
                <NavLink to="/connexion" className="navlink">
                  {t(msg('site.nav.signIn'))}
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
function GamesMenu({ container }: { container: HTMLElement | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  /** Where the panel sits, in viewport coordinates. Null until it is measured. */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

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

    /**
     * The panel is portalled out of the header, so nothing anchors it any more.
     * Clamping is part of the job the old `right: 0` media query used to do: a
     * trigger near the right edge would otherwise push the panel off screen.
     */
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const width = panel.current?.offsetWidth ?? 320;
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      setAt({ top: rect.bottom + margin, left });
    }

    place();

    // Both refs, now that the panel is no longer a descendant of the trigger's box.
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target)) return;
      if (panel.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    // Capture: the scroll that moves the trigger is often an inner one.
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const onGamePage = GAMES.some((game) => location.pathname.startsWith(game.path));

  const menu = (
    <div
      className="gamesmenu-panel"
      role="menu"
      ref={panel}
      // Hidden rather than unmounted for the one frame before it is measured:
      // rendering it is what gives `place` a width to clamp against.
      style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}
    >
      {GAMES.map((game) => (
        <NavLink key={game.id} to={game.path} role="menuitem" className="gamesmenu-item">
          <span className="gamesmenu-emoji" aria-hidden="true">
            {game.emoji}
          </span>
          <span>
            <strong style={{ color: game.accent }}>{game.name}</strong>
            <span className="gamesmenu-tagline">{t(msg(game.tagline))}</span>
          </span>
        </NavLink>
      ))}

      <NavLink to="/rejoindre" role="menuitem" className="gamesmenu-item gamesmenu-join">
        <span className="gamesmenu-emoji" aria-hidden="true">
          🔑
        </span>
        <span>
          <strong>{t(msg('site.nav.join'))}</strong>
          <span className="gamesmenu-tagline">{t(msg('site.nav.joinHint'))}</span>
        </span>
      </NavLink>
    </div>
  );

  return (
    <div className="gamesmenu">
      <button
        type="button"
        ref={trigger}
        className={`navlink gamesmenu-trigger ${onGamePage ? 'on' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {t(msg('site.nav.games'))}
        <ChevronDown />
      </button>

      {open && (container ? createPortal(menu, container) : menu)}
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
