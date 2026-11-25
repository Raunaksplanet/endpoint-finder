# endpoint-finder

Headless bug-bounty endpoint finder. Renders targets in real Chromium and
extracts every endpoint a page leaks, the same way the classic `javascript:`
bookmarklets do: quoted `/paths` in HTML plus every loaded JS file, absolute
`.js` URLs, network-observed scripts, and inline bodies. Output is split into
`urls` + `js` files, plus auto-unpacked `.js.map` sources, a tight secrets
scan, and static-analysis siblings (parameters, GraphQL, RPC, files, emails).

It also crawls like a real spider: DOM link graph (`a/area/iframe/form/data-*`),
relative and escaped path resolution (`\/api\/x`, `\u002fapi`), LinkFinder
quoted-string extraction, `robots.txt` rules and `sitemap.xml` (indexes
recursed), plus opt-in depth crawling.

Every body that is already in memory — page HTML, inline scripts, fetched JS
and source-map-recovered sources — is also passed through a pure static
analyzer ported from JSHound. It classifies what is a request target, then
extracts parameters, GraphQL operations, RPC methods, files and emails with no
extra network requests.

## Webpack lazy chunks (on by default)

Every fetched JS body is checked for a webpack runtime
(`__webpack_require__.u`, old `jsonpScriptSrc`). When found, its chunk map is
evaluated by an inert parser (no `eval`, no `new Function`, no `vm`), so lazy
chunks the page never loads are added to the js output and fetched (80 per
target by default) and scanned for endpoints. Handles webpack 4/5, prefix
maps, template literals, function aliases, external maps, named chunks and
public/CDN paths. `--no-webpack` disables it; `--max-chunks <n>` tunes the
fetch budget (`0` = list chunks without fetching).

## Static analysis (JSHound port)

The analyzer runs on every body the collector already has — page HTML, inline
scripts, fetched JS and source-map sources:

- **Endpoint classification** — quoted literals are accepted only when they
  look like request targets. Bundler module tables, `require(...)`/`import`
  specifiers, JSON Patch `path` values, JSON-pointer prose, schema references
  and MIME constants are rejected. `fetch(...)`, `axios.post(...)`,
  `{ url: ... }` and route keywords vouch for their own arguments.
- **Parameters** — query keys, `URLSearchParams`/`FormData`, HTML `name=`,
  `JSON.stringify`/`axios.post` body keys (including ES6 shorthand), `:id`/
  `{id}` route parameters and GraphQL variables.
- **GraphQL** — `query`/`mutation`/`subscription` names, only when a selection
  set follows.
- **RPC** — Twirp/gRPC-Web paths (`/twirp/pkg.Service/Method`), Connect-ES
  descriptors, JSON-RPC 2.0 methods and service-like dotted names
  (`UserService.getUser`).
- **Files and emails** — non-URL candidates with a known extension; emails
  with placeholder, W3C-namespace and database-URI filters.

Analysis is on by default and costs no extra requests. Non-empty results are
written to sibling files: `<base>-params.txt`, `-graphql.txt`, `-rpc.txt`,
`-files.txt`, `-emails.txt`. Implementation: `lib/analyze/`; tests:
`node --test lib/analyze/*.test.mjs`.

## Source maps

Every in-scope JS file is checked for a map:

- `//# sourceMappingURL=…` and `/*# sourceMappingURL=… */` anywhere in the
  file, not just the last line;
- inline `data:` maps (base64 or URL-encoded);
- the conventional `<file>.js.map` sibling;
- indexed maps (`sections`) as well as flat `sources`/`sourcesContent`.

Recovered sources are written under `endpoint-<target>-output/` with
collision-safe, path-sanitized names. They are then analyzed for endpoints —
not just scanned for secrets — which is usually where the admin routes the
running app never loads are found. `.ts`/`.tsx` sources are kept.

## Output hygiene

Results are cleaned while crawling, so junk is never fetched:

- **No multimedia/style/font assets.** `jpg/png/gif/webp/avif/svg/ico/css/
  woff2…` are always dropped — including `srcset` blobs, `wThumbnails/`,
  image-optimizer URLs and trailing-slash variants.
- **No fragments.** `#anchor` and JSON-LD ids (`#org`, `#website`, …) are
  stripped; a fragment is not an endpoint.
- **One URL per pattern.** UUID, long-hex and whole numeric-id variants
  collapse to the first match; the host is never masked, date slugs stay
  distinct (`--no-collapse` keeps every variant).
- **No dead-weight JS.** Tag managers, analytics, consent widgets, service
  workers and a11y checkers (`gtm`, `gtag`, `fbevents`, `waiChecker`, …) are
  skipped before fetching. Chunks, `app`, `index`, `main`, `*.map`,
  `Retire.js`, `instrument.*.js` and custom bundles stay (`--no-js-filter`
  keeps everything).
- **Canonical URLs.** Duplicate query suffixes (`?dpl=X?dpl=X`), trailing
  slashes after a file extension and repeated `///` are normalised.

The `[DONE]` summary reports the drops: `filtered 530 media · 55 noise js ·
103 duplicate patterns`.

## Install

Requires Node.js 18+.

```bash
npm install -g endpoint-finder
npx playwright install chromium
```

Tests (no browser needed):

```bash
node --test lib/analyze/*.test.mjs webpack_chunks.test.mjs
```

## Usage

```bash
endpoint-finder -i subs.txt
endpoint-finder -u https://example.com/page
endpoint-finder https://example.com/page
cat subs.txt | endpoint-finder
```

Single-letter flags work without the dash (`u <url>` == `-u <url>`).

Outputs never overwrite (explicit `-o` is the only overwriting case):
single target gives `<domain>-urls.txt` + `<domain>-js.txt` (taken goes
`-urls2`, `-urls3`…), multi-target gives `urls1/js1`, `urls2/js2`…,
`-o foo.txt` gives `foo.txt` + `foo-js.txt`. Paths ending in
`.js`/`.mjs`/`.cjs` go to the js file, everything else to urls. Found `.map`
URLs are added to urls.

Analysis artifacts are written beside the base pair when non-empty:
`<base>-params.txt`, `<base>-graphql.txt`, `<base>-rpc.txt`,
`<base>-files.txt`, `<base>-emails.txt` and `<base>-secrets.txt`. Each is one
sorted value per line, and auto-named files never overwrite an earlier run.

Extras, all on by default: multimedia/font/style/xml filtering (images,
video, audio, fonts, css, xml feeds dropped; `pdf` and PII formats like
`json csv xls txt sql bak env zip` kept), `.js.map` auto-unpack to
`endpoint-<target>-output/<js>/` with recovered sources analyzed for endpoints
(`--no-sourcemap`, `--max-maps 25`), tight secrets scan to
`<base>-secrets.txt` (fixed-format keys only: AWS, Stripe, Slack, GitHub,
Google, Twilio, private keys, JWTs; generic `api_key`/`password` noise
excluded; no hits means no file; `--no-secrets`). Scope defaults to the
target registrable domain (`--scope host|all`).

Robust at scale: per-target isolation, disk checkpoints every 10 targets,
LRU-capped cache, polite per-host throttling with `429/503` backoff, dead
hosts fail fast (~4s TCP preflight). Tune big lists with `--wait 1` and
`--no-secrets`/`--no-sourcemap` recon passes. `--fast` restores aggressive
timing for your own infra.

## Options

```
-i, --input <file|url>   file with targets (one per line) or a single URL/host
-u, --url <url>          single target (repeatable; a file value is read as a list)
-o, --output <file>      names the urls file (js sibling added beside it)
--timeout <s>            per-page goto timeout (default: 30, min 1)
--js-timeout <s>         per-JS fetch timeout (default: 15, min 1)
--wait <s>               settle wait after load (default: 3, 0 ok)
--max-scripts <n>        max JS files per page (default: 100, max 1000)
--no-webpack             disable webpack lazy-chunk discovery (default: on)
--max-chunks <n>         max lazy chunks fetched per target (default: 80,
                         max 500; 0 = list chunks without fetching)
--depth <n>              crawl depth (default 1 = seed pages only; 2+ follows
                         in-scope a/area/iframe/frame links; 0 = unlimited)
--max-pages <n>          max extra pages crawled per target (default 25, max 500)
--no-robots              skip robots.txt harvesting
--no-sitemap             skip sitemap.xml harvesting (incl. indexes)
--no-collapse            keep every uuid/hex/numeric-id URL variant
--no-js-filter           keep noise JS (gtm, analytics, consent, waiChecker, sw)
--headless / --no-headless
--no-fallback            bare hosts: try https only (default tries https then http)
--fallback               explicit https URL failing also tries http variant
--strict                 exact bookmarklet quote handling (misses single-quoted paths)
--no-inline              skip inline <script> bodies
--exclude-static         (always on, kept for compat) media/css/font/xml
                         filtered, pdf + PII-safe endpoints kept
--allow-private          allow discovered URLs to private/link-local hosts
                         (default: blocked unless the host is a target)
--no-sourcemap           disable .js.map auto-unpack (default: enabled, JS-only)
--max-maps <n>           max .map files to try per run (default: 25, max 500)
--no-secrets             disable tight secrets scan (default: enabled, JS-only)
--fast                   aggressive timing (old defaults, ban-prone on others)
--scope <mode>           domain (default) | host | all
--user-agent <str>       browser + fetch User-Agent
--verbose                retry/timeout/scope-drop logs
-q, --quiet              clean output: only [FAIL] and [DONE] print
-h, --help               this help
```

## Notes

- Auth-walled pages redirect to login; scan the public surface.
- Sibling corp domains (`dellcdn.com` vs `dell.com`) are different
  registrable domains; use `--scope all` to keep them.
- One fetch depth past discovered files; relative `src="path/file.js"`
  without a leading slash matches bookmarklet behavior (not extracted).
- Webpack discovery is heuristic: chunk names computed by function calls, or
  runtimes split across files, are skipped rather than guessed. Vite,
  Turbopack, esbuild and Parcel use different manifests.
- Source-map recovery needs `sourcesContent`; maps that reference external
  sources without embedding them are detected but cannot be unpacked.
- Discovered URLs to private/link-local hosts are blocked by default (SSRF
  guard). The operator-supplied target host is always allowed; use
  `--allow-private` for lab/internal scans. Redirects are re-checked at the
  fetch layer; Chromium's own subresource requests are outside the guard.
- Exit code is `1` when every target fails, so CI can tell a dead run from a
  clean one.
- Confirm target authorization yourself for engagement work.

## License

MIT
