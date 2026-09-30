# endpoint-finder

Headless bug-bounty endpoint finder. Takes a list of subdomains (or a single
URL) and extracts every endpoint a page leaks — the same way the classic
`javascript:` bookmarklets do, but at scale, from the CLI, with zero browser
interaction.

It renders each target in real headless Chromium, runs **both** bookmarklet
mechanisms natively, and saves complete absolute URLs split into
`urls.txt` + `js.txt` output pairs.

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

## Install

Requires Node.js 18+.

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node endpoint_finder.js -i subs.txt
node endpoint_finder.js -i https://example.com/page
node endpoint_finder.js -u https://example.com/page
node endpoint_finder.js https://example.com/page
cat subs.txt | node endpoint_finder.js
```

Single-letter flags also work without the dash (`u <url>` == `-u <url>`,
same for `i`, `o`). A positional that matches a file on disk is read as a
target list, so `node endpoint_finder.js subs.txt` just works.

### Output files

Every run writes **two** files — urls and js are never mixed:

| Targets | Files |
|---|---|
| single target | `<domain>-urls.txt` + `<domain>-js.txt` |
| several targets | `urls1.txt`+`js1.txt`, `urls2.txt`+`js2.txt`, … (first free pair, never overwrites) |
| explicit `-o foo.txt` | `foo.txt` (urls) + `foo-js.txt` (js) |

A path ending in `.js` (query ignored) goes to the js file, everything else
to the urls file. Both files are always written, even when empty.

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
--fallback               explicit https URL failing also tries the http variant
--strict                 exact bookmarklet quote handling (misses single-quoted paths)
--no-inline              skip inline <script> bodies
--exclude-static         drop png/jpg/woff/mp4/… assets
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

## Speed

Fully automatic — no thread flags. Parallel pages (up to 10) + a 12-wide JS
pool, per-host rate limiting with jitter (polite, IP-ban safe), TCP
preflight so dead hosts fail in ~4s instead of 30s, shared JS cache across
targets, and JS fetching overlapped with the page settle wait.

Measured (30 Sep 2026, `--wait 3`):

| Run | Time | Result |
|---|---|---|
| 29-target mixed list (incl. dead hosts) | ~37s | ~1900 urls + ~250 js |
| dell.com (heavy, 100+ scripts) | ~17s | ~400 urls + js |
| 2 light sites | ~4s | 49 urls |

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
