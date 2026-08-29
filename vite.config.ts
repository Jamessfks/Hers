import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the website into `dist/web`, which is what the Node server serves.
 *
 * There is no dev server here on purpose. the local server owns the WebSocket, the
 * static routes and the origin check, and running Vite's server alongside it
 * would mean a second origin that the WebSocket handshake has to be taught to
 * trust — which is exactly the check that stops a hostile page reaching in. So
 * `npm run dev` runs `vite build --watch` and lets the real server serve it.
 * The cost is a page reload instead of hot module replacement, on a page that
 * takes eight milliseconds to build.
 */
export default defineConfig({
  root: 'src/web',
  base: './',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    /*
     * Never inline an asset as a `data:` URL.
     *
     * Not a size preference — a correctness one. The only asset here is the
     * AudioWorklet, and at 1.6kB it fell under the default 4kB inline limit and
     * was emitted as `data:text/javascript,…`. `AudioWorklet.addModule` fetches
     * with same-origin semantics and a data URL has an opaque origin, so the
     * microphone silently failed to start in exactly the build that ships.
     * Emitting it as a real file makes it same-origin and unambiguous.
     */
    assetsInlineLimit: 0,
  },
});
