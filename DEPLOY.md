# Deploying Compy to compy.jyotiprakash.org

The site is a static Vite build (`packages/ide/dist`). CI (`.github/workflows/deploy.yml`)
runs the unit, differential, and end-to-end suites, checks the bundle budget, and publishes
to GitHub Pages on every push to `main`.

## One-time setup

1. Push this repository to GitHub and, under **Settings → Pages**, set **Source** to
   **GitHub Actions**.
2. Add the custom domain `compy.jyotiprakash.org` on that page (the `CNAME` file is already
   shipped in `packages/ide/public/`, so the setting survives deploys). Tick **Enforce HTTPS**
   once the certificate is issued.
3. DNS at the registrar for `jyotiprakash.org`: a `CNAME` record for `compy` pointing at
   `<github-user>.github.io`.

## Cross-origin isolation

GitHub Pages cannot send response headers. The service worker (`public/sw.js`) adds
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
to every same-origin document/script/style it serves and the page reloads once after the
worker first takes control. That is what lets the optional in-browser AI model use WebGPU
and multithreaded WASM. Everything else in Compy (the compiler, the three execution engines,
the panels) needs no isolation and works on the very first load.

If you ever move to a host that can set headers (Cloudflare Pages, Netlify, nginx), set the
two headers above on the server instead; the service worker logic is harmless alongside.

## Local check of the production build

```sh
npm run build && npm run preview   # http://127.0.0.1:4173
```
