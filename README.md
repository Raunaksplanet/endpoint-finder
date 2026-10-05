# endpoint-finder

Headless bug-bounty endpoint finder. Takes a list of subdomains (or a single
URL) and extracts every endpoint a page leaks — the same way the classic
`javascript:` bookmarklets do, but at scale, from the CLI, with zero browser
interaction.

It renders each target in real headless Chromium, runs **both** bookmarklet
mechanisms natively, and saves complete absolute URLs split into
`urls.txt` + `js.txt` output pairs — plus auto-unpacked `.js.map` sources.

## How it finds endpoints

Two bookmarklet techniques, ported 1:1 to run headlessly:

1. **Relative paths** — `/(?<=("|%27|`))\/[…]+(?=("|'|%60))/g` applied to
   `document.documentElement.outerHTML` plus the body of every loaded JS file
   (fetched like the bookmarklet's `fetch(src).then(t => t.text())`).
   Default mode also accepts single-quote/backtick quoting, which the raw
   bookmarklet misses (`'/api/x'`); `--strict` restores byte-identical
   behavior.
2. **Absolute JS files** — `/https?:\/\/[^\s"'`<>]+\.js(\?[^\s"'`<>]*)?/g`
   applied to HTML and JS bodies. Finds lazy chunks, dynamic imports and
   commented-out files the browser never loads. Discovered files get fetched
   in a second round and parsed for endpoints too.

On top of that, the tool adds what a bookmarklet can't:

- real rendering (SPA content, bot-sensor-injected DOM re-read after load)
- network-sniffed `.js` responses, inline `<script>` bodies
- same-domain-first fetching so caps never cut your target's files for trackers
- in-scope filtering, auto filenames, TCP preflight for dead hosts
- **multimedia/style/font/xml filtering (always on)** — no noise in output
- **`.js.map` auto-unpack (JS-only, no Python)** — the unwebpack goldmine built in
- **polite rate limiting + retries** — WAF/ban safe by default

## Install

Requires Node.js 18+.

```bash
npm install -g endpoint-finder
npx playwright install chromium
```

## Usage

```bash
endpoint-finder -i subs.txt
endpoint-finder -i https://example.com/page
endpoint-finder -u https://example.com/page
endpoint-finder https://example.com/page
cat subs.txt | endpoint-finder
```

Single-letter flags also work without the dash (`u <url>` == `-u <url>`,
same for `i`, `o`). A positional that matches a file on disk is read as a
target list, so `endpoint-finder subs.txt` just works.

### Output files

Every run writes **two** files — urls and js are never mixed — **never
overwriting** (explicit `-o` is the only overwriting case):

| Targets | Files |
|---|---|
| single target | `<domain>-urls.txt` + `<domain>-js.txt` (taken → `-urls2/-js2`, `-urls3/-js3` …) |
| several targets | `urls1.txt`+`js1.txt`, `urls2.txt`+`js2.txt`, … (first free pair, never overwrites) |
| explicit `-o foo.txt` | `foo.txt` (urls) + `foo-js.txt` (js) |

A path ending in `.js` (query ignored) goes to the js file, everything else
to the urls file. Both files are always written, even when empty.

Found `.map` URLs are added to the urls file.

### Noise filter (always on)

Multimedia, fonts, styles and feed noise are dropped from output —
`--exclude-static` is kept for compat but no longer needed:

- images: `png jpg jpeg gif webp bmp ico svg avif tif tiff heic heif psd ai eps cur`
- video: `mp4 avi mov wmv flv webm mkv m4v 3gp mpg mpeg ogv m3u8 mpd ts`
- audio: `mp3 wav ogg oga m4a aac flac wma opus mid midi`
- fonts: `woff woff2 ttf eot otf fon pfb sfnt`
- styles: `css scss sass less styl`
- xml/feed: `xml xsd xsl xslt dtd rss atom`

Always kept: `.pdf` + PII/sensitive (`json csv xls xlsx doc docx txt sql db
log bak env zip`) + real endpoints + `.js` + `.map`.

### Sourcemap auto-unpack (default: on)

JS-only port of `unwebpack_sourcemap.py` — no Python needed. For every
in-scope `.js` it tries `sourceMappingURL` first, then `<file.js>.map`,
and unpacks `sources` + `sourcesContent` with traversal-safe sanitization
(`webpack://` stripped, `../` → `parent_dir/`, `external` skipped).

One subdir per unpacked map inside a single root:

| Run | Unpack dir |
|---|---|
| single `dell.com` | `endpoint-dell.com-output/<host>__<js>/` |
| single taken | `endpoint-dell.com-output2/`, `…3` … (never overwrites) |
| multi `urls1` | `endpoint-scan1-output/` |
| explicit `-o foo.txt` | `endpoint-foo-output/` |

```bash
--no-sourcemap    # disable unpack
--max-maps <n>    # max .map per run (default 25, max 500)
```

Example (`connect.sulzer.com`): 11 js → 11 maps → 1233 files.

### Secrets scan (default: on, tight, JS-only)

21 fixed-format patterns only (AWS `AKIA`, Stripe `sk_live`, Slack `xox`,
GitHub `ghp_`, `AIza`, Twilio, private-key headers, `eyJ.eyJ.` JWTs…).
Generic `api_key`/`password`/UUID noise is deliberately excluded, plus a
placeholder reject — a finding is worth checking. Scans fetched JS bodies,
inline `<script>` bodies, and every unpacked source file.

One file, only non-empty sources, blocks separated by an `====` bar:

```
https://…/static/js/app.js
  aws_access_key -> AKIA…

================================================================================

endpoint-x-output/…/server/config.js  (from https://…/app.js)
  github_token -> ghp_…
```

No hits → no file written. `--no-secrets` disables.

### Robustness at scale (100+ targets)

- per-target isolation: one bad target never kills the run
- progress checkpointed to disk every 10 targets (`[*] Progress: X/Y`)
- outputs never overwrite (`-urls2`, `endpoint-…-output2`, …)
- LRU-capped fetch cache, pooled secrets scan, per-host polite throttling
  with `429/503` backoff; dead hosts fail fast (~4s TCP preflight)

Tune big lists with `--wait 1` and `--no-secrets`/`--no-sourcemap`
recon-only passes.

### Scope filter (default: `domain`)

Only URLs on the target's registrable domain are kept — third-party
trackers (`oracleinfinity.io`, `taboola`, `bing`, …) are dropped from the
output (shown only with `--verbose`).

```bash
--scope domain   # default: target's registrable domain (subdomains included)
--scope host     # exact hostname only (note: redirects away are then dropped)
--scope all      # keep everything, no filtering
```

### Options

```
-i, --input <file|url>   file with targets (one per line) or a single URL/host
-u, --url <url>          single target (repeatable; a file value is read as a list)
-o, --output <file>      names the urls file (js sibling added beside it)
--timeout <s>            per-page goto timeout (default: 30, min 1)
--js-timeout <s>         per-JS fetch timeout (default: 15, min 1)
--wait <s>               settle wait after load, mirrors bookmarklet setTimeout(3000) (default: 3, 0 ok)
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
--fast                   old aggressive timing (12-wide maps, 100ms gaps).
                         Default is polite (2-wide maps, 1.5s/host gap,
                         429/503 backoff) to avoid WAF bans
--scope <mode>           domain (default) | host | all
--user-agent <str>       browser + fetch User-Agent
--verbose                retry/timeout/scope-drop logs
-q, --quiet              clean output: only [FAIL] and [DONE] print
-h, --help               this help
```

### Output format

Aligned table, no borders (hidden with `-q`):

```
TARGET                                                         SCRIPTS   PATHS    URLS     NEW
https://www.dell.com/en-in                                         100     470     406    +406
nota-real-host-xyz12345.com                                     FAIL  TCP …unreachable (preflight)
```

Map lines during unpack:

```
[MAP] https://…/static/js/main.abc.js -> https://…/static/js/main.abc.js.map (847 files in dell.com__static_js_main_abc/)
[DONE] 1 targets in 46.8s -> 43 urls (…) + 11 js (…) + 11 maps/1233 files (endpoint-dell.com-output/)
```

## Speed / politeness

Polite by default — no thread flags. Parallel pages (up to 10) + a 12-wide JS
pool + a **2-wide map pool**, per-host rate limiting with jitter, TCP
preflight so dead hosts fail in ~4s instead of 30s, shared JS cache across
targets, `429/503` + timeout retries with backoff, and JS fetching overlapped
with the page settle wait.

- page gap 800ms/host, JS gap 400ms/host, map gap 1500ms/host, jitter 400ms
- `--fast` restores old aggressive timing (12-wide maps, 100ms gaps) for your
  own targets

Measured (30 Sep 2026, `--wait 3`):

| Run | Time | Result |
|---|---|---|
| 29-target mixed list (incl. dead hosts) | ~37s | ~1900 urls + ~250 js |
| dell.com (heavy, 100+ scripts) | ~17s | ~400 urls + js |
| connect.sulzer.com (12 scripts, polite) | ~47s | 43 urls + 11 js + 11 maps/1233 files |

Live bot-defended pages vary run to run (rotating bundle versions, session
beacons, captcha stubs on headless clients) — small count wobble between
runs is the site, not the tool.

## Notes / limitations

- Auth-walled pages redirect to login (e.g. B2C/OAuth) — scan the public
  surface, or ask for cookie-session support.
- Strictly scope-aware by default; sibling corp domains (`dellcdn.com` vs
  `dell.com`) are different registrable domains — use `--scope all` to keep them.
- One fetch depth past discovered files; relative `src="path/file.js"`
  without a leading slash matches bookmarklet behavior (not extracted).
- For engagement-scoped work, confirm target authorization yourself.

## License

MIT
