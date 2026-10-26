# Screenshots Tool (Standalone)

Self-contained recreation of the docs-migration screenshot capture tool.
Instead of living inside the `nexudus-coworking-ecommerce` repo, this folder
pulls the tool's source from the **Nexudus code-search mirror**
(`https://llm.nexudus.com/mcp/`) at runtime — so it works on any machine
without a local checkout of the source repos.

## Supported targets

| Key | App | URL | Login account |
|---|---|---|---|
| `v3` | Admin Panel v3 | https://dashboard.nexudus.com | shared (`PLAYWRIGHT_TEST_*`) |
| `v5` | Admin Panel v5 | https://flow.nexudus.com | shared (`PLAYWRIGHT_TEST_*`) |
| `members` | Members Portal | https://kalkioflex.nexudus.site | shared (`PLAYWRIGHT_TEST_*`, Member) |
| `contact` | Members Portal | https://kalkioflex.nexudus.site | `CONTACT_*` (Contact) |

Each target in [`targets.json`](./targets.json) carries its own base URL and
login selectors (the three apps render different login forms — `name="Email"`
vs `#login-email` vs `name="email"`, "Sign in" vs "Login"). The `contact`
target uses the same portal as `members` but a different account with
different access, so it reads `CONTACT_USERNAME` / `CONTACT_PASSWORD`.

## How it works

`bootstrap.mjs`:

1. Loads credentials from `.env`
2. Fetches the tool's source files from the mirror into `_mirror/`
   (structure mirrors `KB Migration/migration/` in `nexudus-coworking-ecommerce`,
   which refreshes every 15 minutes)
3. Verifies the **Nexudus CLI** is logged in to the **Kalkio Flex** business
   (record-specific shots — a coworker's invoices, a member's help desk — are
   resolved through the CLI). If not, it prompts you to run `nexudus login`
   with the Kalkio Flex account and waits until the check passes
4. Installs dependencies (`playwright` + chromium) into `_mirror/screenshots-tool`
   — cached; reuses them on subsequent runs
5. Patches the freshly-fetched `capture-docs-screenshots.mjs` with the selected
   target's login selectors and a per-target output subfolder
6. Runs the capture, which logs into the dashboard fresh (session-cookie auth),
   dismisses promo flyouts, and walks the shot list capturing full-page
   screenshots into `_mirror/test-run/screenshots/<target>/`

Fetched source is verified line-by-line (sequential line numbers + declared
total) so truncated or corrupted files are never written. If the upstream tool
changes and the patch no longer applies, the bootstrap stops with a clear error
(rather than capturing against the wrong app).

## Setup

```bash
cp .env.example .env
# fill in NEXUDUS_LLM_KEY (optional if VS Code's mcp.json already has the
# nexudus-code-search key), PLAYWRIGHT_TEST_USERNAME/PASSWORD, and
# CONTACT_USERNAME/PASSWORD for the contact target
```

## Usage

```bash
node bootstrap.mjs --check                          # verify mirror access + parsing only
node bootstrap.mjs --target v3                       # full run, default shot list
node bootstrap.mjs --target v3 shots-dashboard.json  # specific shot list (from mirror)
node bootstrap.mjs --target members my-shots.json    # local shot list from ./shotlists/
node bootstrap.mjs --target contact contact-home.json
node bootstrap.mjs --reinstall --target v5           # force reinstall of deps first
```

Shot lists resolve in this order: a local file in `./shotlists/` (or the
current directory), then a fetched list from the mirror. The mirror provides:
`shots-dashboard.json`, `shots-analytics.json`, `shots-announcements.json`,
`shots-floor-plans.json`, `shots-inventory.json`, `shots-phase0.json`,
`shots-phase1.json`, `shots-products.json`, `shots-resource-rates.json`,
`shots-trends.json`, `shots-viewport-accounting.json`,
`shots-viewport-integrations.json`. Put custom shot lists (e.g. for the v5
admin or the portal) in `./shotlists/`.

Output lands in `_mirror/test-run/screenshots/<target>/` (gitignored).

## Notes

- Every full capture run first verifies the `nexudus` CLI is logged in to the
  **Kalkio Flex** business (`nexudus whoami`). If you're logged into a
  different account or business — or not logged in at all — it stops and
  prompts you to run `nexudus login` with the Kalkio Flex account, then
  re-checks. `--check` skips this (it only validates mirror access).
- On macOS behind a corporate TLS proxy, the bootstrap exports the system
  trust store and re-execs itself with `NODE_EXTRA_CA_CERTS` set (Node only
  reads that variable at startup). Harmless elsewhere.
- The mirror's secret scanner may redact values it considers sensitive; the
  bootstrap warns if any fetched file contains `[REDACTED` markers.
- **Members Portal routes need the business web-address prefix.** After login
  the app lives under `/<webAddress>/...` (for Kalkio Flex that's
  `/kalkioflex/...`). Navigating to an unprefixed route like `/user/help-desk`
  makes the API look up a business named "user" and returns a 500 error page.
  Use e.g. `/kalkioflex/user/help-desk` in shot lists.
- **v5 deep routes:** a fresh browser profile is bounced to the "Welcome to
  Nexudus" onboarding on any full-page load. Shot lists should land on `/`,
  dismiss onboarding ("Skip for now"), then use the `{spaGoto}` step to reach
  deep routes without a reload.
- Never commit `.env` or `_mirror/`.
