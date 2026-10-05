# endpoint-finder

Headless bug-bounty endpoint finder. Renders targets in real Chromium and
extracts every endpoint a page leaks, the same way the classic `javascript:`
bookmarklets do: quoted `/paths` in HTML plus every loaded JS file, absolute
`.js` URLs, network-observed scripts, and inline bodies. Output is split into
`urls` + `js` files, plus auto-unpacked `.js.map` sources and a tight secrets
scan.

## Install

Requires Node.js 18+.

```bash
npm install -g endpoint-finder
npx playwright install chromium
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
`-o foo.txt` gives `foo.txt` + `foo-js.txt`. Paths ending in `.js` go to
the js file, everything else to urls. Found `.map` URLs are added to urls.

Extras, all on by default: multimedia/font/style/xml filtering (images,
video, audio, fonts, css, xml feeds dropped; `pdf` and PII formats like
`json csv xls txt sql bak env zip` kept), `.js.map` auto-unpack to
`endpoint-<target>-output/<js>/` (`--no-sourcemap`, `--max-maps 25`),
tight secrets scan to `<base>-secrets.txt` (fixed-format keys only:
AWS, Stripe, Slack, GitHub, Google, Twilio, private keys, JWTs; generic
`api_key`/`password` noise excluded; no hits means no file;
`--no-secrets`). Scope defaults to the target registrable domain
(`--scope host|all`).

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
--headless / --no-headless
--no-fallback            bare hosts: try https only (default tries https then http)
--fallback               explicit https URL failing also tries http variant
--strict                 exact bookmarklet quote handling (misses single-quoted paths)
--no-inline              skip inline <script> bodies
--exclude-static         (always on, kept for compat)
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
- Confirm target authorization yourself for engagement work.

## License

MIT
