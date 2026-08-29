import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';

import { useAuth } from '../hooks/useAuth';
import { Loading } from '../ui';
import { AtelierShell, JeuShell } from './shells';

const Home = lazy(() => import('../pages/Home'));
const Login = lazy(() => import('../pages/Login'));
const Register = lazy(() => import('../pages/Register'));
const Library = lazy(() => import('../pages/Library'));
const MediaEditor = lazy(() => import('../pages/MediaEditor'));
const Playlists = lazy(() => import('../pages/Playlists'));
const PlaylistEditor = lazy(() => import('../pages/PlaylistEditor'));
const Launch = lazy(() => import('../pages/Launch'));
const History = lazy(() => import('../pages/History'));
const CoronaZSetup = lazy(() => import('../pages/zombie/CoronaZSetup'));
const CoronaZTv = lazy(() => import('../pages/zombie/CoronaZTv'));
const CoronaZPlayer = lazy(() => import('../pages/zombie/CoronaZPlayer'));
const CoronaZGm = lazy(() => import('../pages/zombie/CoronaZGm'));
const MafiaSetup = lazy(() => import('../pages/mafia/MafiaSetup'));
const MafiaPlayer = lazy(() => import('../pages/mafia/MafiaPlayer'));
const MafiaTv = lazy(() => import('../pages/mafia/MafiaTv'));
const QuizMenu = lazy(() => import('../pages/menu/QuizMenu'));
const QuizGuide = lazy(() => import('../pages/menu/QuizGuide'));
const QuizCreate = lazy(() => import('../pages/menu/QuizCreate'));
const CzMenu = lazy(() => import('../pages/menu/CzMenu'));
const CzGuide = lazy(() => import('../pages/menu/CzGuide'));
const MafiaMenu = lazy(() => import('../pages/menu/MafiaMenu'));
const MafiaGuide = lazy(() => import('../pages/menu/MafiaGuide'));
const Locker = lazy(() => import('../pages/menu/Locker'));
const Quickplay = lazy(() => import('../pages/Quickplay'));
const Host = lazy(() => import('../pages/Host'));
const Join = lazy(() => import('../pages/Join'));
const Player = lazy(() => import('../pages/Player'));

/**
 * Sends anonymous visitors to the login page, remembering where they were going.
 *
 * Waits for the session probe before deciding, so a logged-in user reloading a deep
 * link is not bounced to the login screen for a frame.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loaded } = useAuth();
  const location = useLocation();

  if (!loaded) {
    return <Loading />;
  }

  if (!user) {
    return <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

/**
 * One address per state.
 *
 * Every screen that used to be a piece of component state — editing a media item,
 * importing a playlist, running a game — is a route here. That is the whole fix for
 * the navigation: the back button, a shared link and a refresh all work because the
 * URL is the source of truth rather than a `useState` inside a list page.
 *
 * Built once at module scope; building it inside the component threw away the
 * router's state on every render.
 */
const router = createBrowserRouter([
  {
    element: <AtelierShell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/connexion', element: <Login /> },
      { path: '/inscription', element: <Register /> },
      {
        path: '/bibliotheque',
        element: (
          <RequireAuth>
            <Library />
          </RequireAuth>
        )
      },
      {
        path: '/bibliotheque/nouveau',
        element: (
          <RequireAuth>
            <MediaEditor />
          </RequireAuth>
        )
      },
      {
        path: '/bibliotheque/:id',
        element: (
          <RequireAuth>
            <MediaEditor />
          </RequireAuth>
        )
      },
      {
        path: '/playlists',
        element: (
          <RequireAuth>
            <Playlists />
          </RequireAuth>
        )
      },
      {
        path: '/playlists/:id',
        element: (
          <RequireAuth>
            <PlaylistEditor />
          </RequireAuth>
        )
      },
      {
        path: '/playlists/:id/lancer',
        element: (
          <RequireAuth>
            <Launch />
          </RequireAuth>
        )
      },
      {
        path: '/historique',
        element: (
          <RequireAuth>
            <History />
          </RequireAuth>
        )
      },
      /**
       * One menu per game, and the setup form a click inside it.
       *
       * `/coronaz` used to *be* the setup form, which meant deciding to play and
       * deciding what to play were the same click, and there was no page at all
       * from which to join someone else's raid or read what a screamer does.
       * Every static segment here outranks the `:code` routes below it, and no
       * join code can spell "nouveau" — the alphabet excludes most of it.
       */
      { path: '/quiz', element: <QuizMenu /> },
      { path: '/quiz/regles', element: <QuizGuide /> },
      {
        path: '/quiz/creer',
        element: (
          <RequireAuth>
            <QuizCreate />
          </RequireAuth>
        )
      },
      { path: '/quiz/boutique', element: <RequireAuth><Locker game="quiz" mode="shop" /></RequireAuth> },
      { path: '/quiz/equipement', element: <RequireAuth><Locker game="quiz" mode="locker" /></RequireAuth> },

      { path: '/coronaz', element: <CzMenu /> },
      { path: '/coronaz/guide', element: <CzGuide /> },
      {
        path: '/coronaz/nouveau',
        element: (
          <RequireAuth>
            <CoronaZSetup />
          </RequireAuth>
        )
      },
      { path: '/coronaz/boutique', element: <RequireAuth><Locker game="coronaz" mode="shop" /></RequireAuth> },
      { path: '/coronaz/equipement', element: <RequireAuth><Locker game="coronaz" mode="locker" /></RequireAuth> },

      { path: '/mafia', element: <MafiaMenu /> },
      { path: '/mafia/guide', element: <MafiaGuide /> },
      {
        path: '/mafia/nouveau',
        element: (
          <RequireAuth>
            <MafiaSetup />
          </RequireAuth>
        )
      },
      { path: '/mafia/boutique', element: <RequireAuth><Locker game="mafia" mode="shop" /></RequireAuth> },
      { path: '/mafia/equipement', element: <RequireAuth><Locker game="mafia" mode="locker" /></RequireAuth> },
      { path: '*', element: <NotFound /> }
    ]
  },
  {
    // The game shell: no navigation, and the player routes need no account.
    element: <JeuShell />,
    children: [
      {
        path: '/partie/:code',
        element: (
          <RequireAuth>
            <Host />
          </RequireAuth>
        )
      },
      { path: '/rejoindre', element: <Join /> },
      /**
       * The hostless room, one screen for all three games. No account: a quick
       * match is the mode for a phone that was handed a link, and asking it to
       * sign in first would defeat the point.
       */
      { path: '/partie-rapide/:game', element: <Quickplay /> },
      { path: '/rejoindre/:code', element: <Player /> },
      {
        path: '/coronaz/:code',
        element: (
          <RequireAuth>
            <CoronaZTv />
          </RequireAuth>
        )
      },
      // Phones need no account, the game master's link carries its own secret.
      { path: '/coronaz/rejoindre/:code', element: <CoronaZPlayer /> },
      { path: '/coronaz/mj/:code', element: <CoronaZGm /> },
      // Mafia seats need no account either; the host proves itself by token.
      { path: '/mafia/rejoindre/:code', element: <MafiaPlayer /> },
      /**
       * The optional television. No account and no token: it holds no seat and
       * receives only what the town square already knows, so the code is enough.
       * Most tables are played apart and never open this at all.
       */
      { path: '/mafia/tv/:code', element: <MafiaTv /> }
    ]
  }
]);

function NotFound() {
  return (
    <div className="stack-4">
      <h1 className="page-title">Page introuvable</h1>
      <p className="page-sub">Ce lien ne mène à rien. Le menu en haut ramène en terrain connu.</p>
    </div>
  );
}

export function AppRouter() {
  return (
    <Suspense fallback={<Loading />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
