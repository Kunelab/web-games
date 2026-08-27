import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppRouter } from './app/router';
import { AuthProvider } from './hooks/AuthProvider';
import { LocaleProvider } from './i18n/LocaleProvider';
import './styles/base.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    {/* Outermost: everything the server says arrives as a key, so nothing below
        this can render game narrative without it. */}
    <LocaleProvider>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </LocaleProvider>
  </StrictMode>
);
