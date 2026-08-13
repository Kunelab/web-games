import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src')
    }
  },
  build: {
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.code === 'SOURCEMAP_ERROR') {
          return;
        }
        defaultHandler(warning);
      }
    }
  },
  server: {
    // Bind every interface so the box is reachable as kune.local, as its LAN IP,
    // and as localhost. The `dev` script passes --host for the same reason;
    // setting it here keeps a bare `vite` behaving identically.
    host: true,
    /**
     * Vite blocks Host headers it does not recognise, to stop DNS rebinding.
     * A leading dot covers the domain and all its subdomains, so this accepts
     * both `kune.local` and `www.kune.local`. Must be an array; a bare string is
     * not a valid value.
     */
    allowedHosts: ['.kune.local', 'localhost', 'kune.local', 'www.kune.local']
  }
});
