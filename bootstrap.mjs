#!/usr/bin/env node
/**
 * Bootstrap for the standalone docs screenshot tool.
 *
 * Recreates the screenshots-tool from the Nexudus code-search mirror
 * (https://llm.nexudus.com/mcp/) — no local checkout of the source repos is
 * required. It:
 *
 *   1. Loads credentials from .env
 *   2. Fetches the tool's source files from the mirror into ./_mirror/
 *      (structure mirrors KB Migration/migration/ in nexudus-coworking-ecommerce)
 *   3. Installs dependencies (playwright + chromium) into ./_mirror/screenshots-tool
 *   4. Patches the freshly-fetched capture script with the selected target's
 *      login selectors (from targets.json) and output subfolder
 *   5. Runs capture-docs-screenshots.mjs against the target dashboard
 *
 * Targets (see targets.json):
 *   v3       Admin Panel v3      https://dashboard.nexudus.com
 *   v5       Admin Panel v5      https://flow.nexudus.com
 *   members  Members Portal      https://kalkioflex.nexudus.site  (Member account)
 *   contact  Members Portal      https://kalkioflex.nexudus.site  (Contact account)
 *
 * Usage:
 *   node bootstrap.mjs --check                          # verify mirror access + parsing only
 *   node bootstrap.mjs --target v3                      # full run, default shot list
 *   node bootstrap.mjs --target v3 shots-dashboard.json # full run with a specific shot list
 *   node bootstrap.mjs --target members my-shots.json   # local shot list from ./shotlists/
 *   node bootstrap.mjs --reinstall --target v5          # force reinstall of deps first
 *
 * Shot lists resolve in this order: a local file in ./shotlists/ (or the
 * current directory), then a fetched list in the mirror.
 *
 * The mirror refreshes every 15 minutes; re-run bootstrap to pick up changes
 * made to the tool in the source repo.
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_DIR = path.join(__dirname, "_mirror");
const TOOL_DIR = path.join(MIRROR_DIR, "screenshots-tool");
const DEPS_MARKER = path.join(MIRROR_DIR, ".deps-installed");
const SHOTLISTS_DIR = path.join(__dirname, "shotlists");
const TARGETS_FILE = path.join(__dirname, "targets.json");
const SOURCE_REPO = "nexudus-coworking-ecommerce";
const SOURCE_PREFIX = "KB Migration/migration";

// Files to fetch: the capture scripts, package.json, and the default shot list.
const FILES_TO_FETCH = [
  "screenshots-tool/capture-docs-screenshots.mjs",
  "screenshots-tool/_capture.mjs",
  "screenshots-tool/_capture-viewport.mjs",
  "screenshots-tool/_capture-forms-flow.mjs",
  "screenshots-tool/embed-images.mjs",
  "screenshots-tool/package.json",
  "test-run/shots.json",
];
// Plus every shots-*.json discovered in the mirror (the real shot lists).
const SHOT_LIST_GLOB = "**/screenshots-tool/shots-*";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) {
    console.error("Missing .env — copy .env.example to .env and fill in the values.");
    process.exit(1);
  }
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

loadDotEnv();

const MCP_KEY =
  process.env.NEXUDUS_LLM_KEY || readKeyFromVsCodeMcpConfig() || "";

if (!MCP_KEY) {
  console.error(
    "Set NEXUDUS_LLM_KEY in .env (your Nexudus LLM key, sk-...). " +
      "It authenticates the code-search mirror."
  );
  process.exit(1);
}

function readKeyFromVsCodeMcpConfig() {
  // Fallback: reuse the key configured for the nexudus-code-search MCP server.
  const candidate = path.join(
    os.homedir(),
    "Library/Application Support/Code/User/mcp.json"
  );
  try {
    const cfg = JSON.parse(fs.readFileSync(candidate, "utf8"));
    return cfg?.servers?.["nexudus-code-search"]?.headers?.Authorization || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal MCP streamable-HTTP client (JSON-RPC over POST + SSE)
// ---------------------------------------------------------------------------
const MCP_URL = "https://llm.nexudus.com/mcp/";
let sessionId = null;

async function mcpPost(body, id) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: MCP_KEY,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...body, ...(id ? { id } : {}) }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  return lines.length ? JSON.parse(lines[lines.length - 1].slice(5)) : null;
}

async function mcpCall(tool, args) {
  const r = await mcpPost(
    { method: "tools/call", params: { name: tool, arguments: args } },
    Date.now()
  );
  if (r?.error) throw new Error(`MCP error: ${JSON.stringify(r.error)}`);
  const text = r?.result?.content?.[0]?.text ?? "";
  if (text.startsWith("Error:")) throw new Error(text);
  return text;
}

/**
 * The mirror prefixes every line with "<n>| ". Strip that, verifying each
 * prefix number runs sequentially from 1, and confirm the returned line count
 * equals the declared total so we never silently write truncated source.
 */
function stripLinePrefix(raw, filePath) {
  const headerEnd = raw.indexOf("\n");
  const header = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 1);

  const totalMatch = header.match(/\((\d+)-(\d+) of (\d+)\)/);
  const declaredTotal = totalMatch ? parseInt(totalMatch[3], 10) : null;

  let lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(\d+)\| (.*)$/) || line.match(/^\s*(\d+)\|$/);
    if (!m) {
      throw new Error(`Unparseable line ${i + 1} in ${filePath}: ${line.slice(0, 60)}`);
    }
    if (parseInt(m[1], 10) !== i + 1) {
      throw new Error(
        `${filePath}: mirror line numbering broken at line ${i + 1} ` +
          `(expected ${i + 1}, got ${m[1]}) — refusing to write corrupted source.`
      );
    }
    out.push(m[2] ?? "");
  }

  if (declaredTotal !== null && out.length !== declaredTotal) {
    throw new Error(
      `${filePath}: expected ${declaredTotal} lines from mirror, parsed ${out.length}. ` +
        "The file may be too large for a single read — fetch it in ranges."
    );
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Mirror fetch
// ---------------------------------------------------------------------------
async function fetchAllFiles() {
  await mcpPost(
    {
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "screenshots-bootstrap", version: "1.0" },
      },
    },
    1
  );
  await mcpPost({ method: "notifications/initialized" });

  const listing = await mcpCall("code_search-list_files", {
    repo: SOURCE_REPO,
    glob: SHOT_LIST_GLOB,
    max_results: 100,
  });
  const shotLists = [
    ...listing.matchAll(
      /^KB Migration\/migration\/screenshots-tool\/(shots-[\w.-]+\.json)\s*$/gm
    ),
  ].map((m) => `screenshots-tool/${m[1]}`);

  const files = [...new Set([...FILES_TO_FETCH, ...shotLists])];
  console.log(`Fetching ${files.length} files from mirror (${SOURCE_REPO})...\n`);

  const redacted = [];
  for (const rel of files) {
    const dest = path.join(MIRROR_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const raw = await mcpCall("code_search-read_file", {
      repo: SOURCE_REPO,
      path: `${SOURCE_PREFIX}/${rel}`,
    });
    const content = stripLinePrefix(raw, rel);
    if (content.includes("[REDACTED")) redacted.push(rel);
    fs.writeFileSync(dest, content);
    console.log(`  ok   ${rel} (${content.length} bytes)`);
  }

  if (redacted.length) {
    console.error(
      `\nWARNING: mirror secret-scanner redacted content in: ${redacted.join(", ")}. ` +
        "The fetched source may not run. Check the source repo for those files."
    );
  }
  return redacted.length === 0;
}

// ---------------------------------------------------------------------------
// Setup + run
// ---------------------------------------------------------------------------
function ensureCaCerts() {
  // Corporate TLS proxies need the system trust store exported for Node.
  // NODE_EXTRA_CA_CERTS is only read at startup, so if it is not already set
  // and we can build a PEM bundle, re-exec this script once with it set.
  if (process.platform !== "darwin" || process.env.NODE_EXTRA_CA_CERTS) return;
  try {
    const pem = "/tmp/nexudus-mirror-ca.pem";
    execSync(
      'security find-certificate -a -p /Library/Keychains/System.keychain > ' +
        `${pem} 2>/dev/null; ` +
        `security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db" >> ${pem} 2>/dev/null; ` +
        `true`,
      { stdio: "ignore", shell: "/bin/bash" }
    );
    if (fs.existsSync(pem) && fs.statSync(pem).size > 0) {
      const r = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: pem } }
      );
      process.exit(r.status ?? 1);
    }
  } catch {
    // Restricted keychain — proceed without.
  }
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  return r.status ?? 1;
}

function installDeps(force) {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
  const pwInstalled = fs.existsSync(path.join(TOOL_DIR, "node_modules/playwright/index.mjs"));

  if (force || !pwInstalled) {
    console.log("\nInstalling dependencies (playwright)...\n");
    if (run(npmBin, ["install", "--no-fund", "--no-audit"], { cwd: TOOL_DIR }) !== 0) {
      console.error("npm install failed.");
      process.exit(1);
    }
  } else {
    console.log("\nDependencies present — skipping npm install (use --reinstall to force).");
  }

  if (force || !fs.existsSync(DEPS_MARKER)) {
    console.log("\nInstalling chromium browser...\n");
    if (run(npxBin, ["playwright", "install", "chromium"], { cwd: TOOL_DIR }) !== 0) {
      console.error("playwright install chromium failed.");
      process.exit(1);
    }
    fs.writeFileSync(DEPS_MARKER, new Date().toISOString());
  } else {
    console.log("Chromium browser present — skipping install (use --reinstall to force).");
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
function loadTargets() {
  if (!fs.existsSync(TARGETS_FILE)) {
    console.error("Missing targets.json — cannot determine which app to capture.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TARGETS_FILE, "utf8"));
}

/**
 * Resolve the username/password for a target. A target may specify its own
 * credential env vars (e.g. the Contact account); otherwise it falls back to
 * the shared PLAYWRIGHT_TEST_USERNAME / PLAYWRIGHT_TEST_PASSWORD.
 */
function resolveCredentials(target) {
  const userVar = target.usernameEnv || "PLAYWRIGHT_TEST_USERNAME";
  const passVar = target.passwordEnv || "PLAYWRIGHT_TEST_PASSWORD";
  const username = process.env[userVar];
  const password = process.env[passVar];
  if (!username || !password) {
    console.error(
      `Target "${targetKey}" needs ${userVar} and ${passVar} set in .env.`
    );
    process.exit(1);
  }
  return { username, password };
}

// ---------------------------------------------------------------------------
// Nexudus CLI login pre-flight
// ---------------------------------------------------------------------------
// Screenshots of record-specific pages (a coworker's invoices, a member's
// help desk, ...) are resolved through the Nexudus CLI, which must be logged
// in to the Kalkio Flex business. Every capture run verifies this first and
// prompts the user to log in if it isn't.
const EXPECTED_CLI_BUSINESS = "Kalkio Flex";

function cliWhoami() {
  try {
    const out = spawnSync("nexudus", ["whoami", "--agent"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (out.status !== 0) return null;
    const d = JSON.parse(out.stdout);
    return d?.ok ? d.data : null;
  } catch {
    return null;
  }
}

async function ensureCliLogin() {
  console.log(
    `\nNexudus CLI check — screenshots resolve records via the CLI and ` +
      `require the ${EXPECTED_CLI_BUSINESS} account.`
  );
  for (;;) {
    const me = cliWhoami();
    if (me && me.defaultBusinessName === EXPECTED_CLI_BUSINESS) {
      console.log(
        `  ✓ CLI logged in as ${me.email} — business "${me.defaultBusinessName}".`
      );
      return;
    }
    const reason = !me
      ? "the CLI is not logged in"
      : `the CLI is logged in as ${me.email ?? "unknown"} — business "${me.defaultBusinessName}" (expected "${EXPECTED_CLI_BUSINESS}")`;
    console.error(`\n✗ ${reason}.`);
    console.error(`Please log in to the ${EXPECTED_CLI_BUSINESS} account:`);
    console.error(`    nexudus login`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (
      await rl.question(
        `Once you have logged in to ${EXPECTED_CLI_BUSINESS}, press Enter to continue (or type "q" to quit): `
      )
    ).trim().toLowerCase();
    rl.close();
    if (ans === "q" || ans === "quit") process.exit(1);
  }
}

/**
 * Patch the freshly-fetched capture script so it logs in with the selected
 * target's selectors and writes screenshots into a per-target subfolder.
 * The mirror source is re-fetched every run, so this patch is always applied
 * to a clean copy.
 */
function patchCaptureScript(target) {
  const scriptPath = path.join(TOOL_DIR, "capture-docs-screenshots.mjs");
  let src = fs.readFileSync(scriptPath, "utf8");

  // Output subfolder per target so runs don't clobber each other.
  const outLine = 'const OUT_DIR = path.join(MIGRATION, "screenshots");';
  const outReplaced = `const OUT_DIR = path.join(MIGRATION, "screenshots", ${JSON.stringify(targetKey)});`;
  assertPatch(src, outLine, outReplaced, "OUT_DIR");
  src = src.replace(outLine, outReplaced);

  // doLogin(): generic selectors + button label from the target.
  const oldLogin = `async function doLogin() {
  await page.goto(\`\${BASE_URL}/login\`, { waitUntil: "domcontentloaded" });
  // Form is client-rendered; wait for the inputs to exist before filling.
  const email = page.locator('input[name="Email"]');
  await email.waitFor({ state: "visible", timeout: 15_000 });
  await email.fill(USERNAME);
  await page.locator('input[name="Password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).first().click();`;
  const newLogin = `async function doLogin() {
  await page.goto(\`\${BASE_URL}${target.loginRoute}\`, { waitUntil: "domcontentloaded" });
  // Form is client-rendered; wait for the inputs to exist before filling.
  const email = page.locator(${JSON.stringify(target.emailSelector)});
  await email.waitFor({ state: "visible", timeout: 15_000 });
  await email.fill(USERNAME);
  await page.locator(${JSON.stringify(target.passwordSelector)}).fill(PASSWORD);
  await page.getByRole("button", { name: /${target.submitButton}/i }).first().click();`;
  assertPatch(src, oldLogin, newLogin, "doLogin");
  src = src.replace(oldLogin, newLogin);

  // Add a { spaGoto } step: client-side SPA navigation (pushState + popstate),
  // so React Router navigates WITHOUT a full page reload. Needed for v5, whose
  // onboarding redirect guard is in-memory and resets on every reload.
  const spaAnchor = `        if (step.goto) {
          await page.goto(\`\${BASE_URL}\${step.goto}\`, { waitUntil: "load" });
          await page.waitForTimeout(1500);
        }`;
  const spaAdded = `${spaAnchor}
        if (step.spaGoto) {
          await page.evaluate((to) => {
            window.history.pushState({}, "", to);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, step.spaGoto);
          await page.waitForTimeout(2000);
        }`;
  assertPatch(src, spaAnchor, spaAdded, "spaGoto");
  src = src.replace(spaAnchor, spaAdded);

  fs.writeFileSync(scriptPath, src);
}

function assertPatch(src, expected, replacement, label) {
  if (!src.includes(expected)) {
    console.error(
      `\nFailed to patch ${label}: the fetched capture script does not contain the ` +
        "expected original text. The tool likely changed in the source repo — " +
        "update bootstrap.mjs to match.\n"
    );
    process.exit(3);
  }
}

/**
 * Resolve a shot-list argument to an absolute path. Local files in ./shotlists/
 * (or the current directory) win; otherwise fall back to a fetched list in the
 * mirror. With no argument, use the default ../test-run/shots.json.
 */
function resolveShotList(shotListArg) {
  if (!shotListArg) {
    return path.join(TOOL_DIR, "..", "test-run", "shots.json");
  }
  const localCandidates = [
    path.join(SHOTLISTS_DIR, shotListArg),
    path.join(process.cwd(), shotListArg),
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c)) return c;
  }
  const mirrored = path.join(TOOL_DIR, shotListArg);
  if (fs.existsSync(mirrored)) return mirrored;
  console.error(
    `Shot list "${shotListArg}" not found locally (./shotlists/) or in the mirror.`
  );
  process.exit(1);
}

function runCapture(target, shotListArg) {
  const { username, password } = resolveCredentials(target);
  patchCaptureScript(target);

  const env = { ...process.env };
  delete env.NEXUDUS_LLM_KEY; // not needed by the capture script
  env.PLAYWRIGHT_TEST_BASE_URL =
    process.env.PLAYWRIGHT_TEST_BASE_URL || target.baseUrl;
  env.PLAYWRIGHT_TEST_USERNAME = username;
  env.PLAYWRIGHT_TEST_PASSWORD = password;

  const args = [
    path.join(TOOL_DIR, "capture-docs-screenshots.mjs"),
    resolveShotList(shotListArg),
  ];
  const baseUrl = env.PLAYWRIGHT_TEST_BASE_URL;
  console.log(`\nRunning capture: ${target.label}\n  -> ${baseUrl}\n`);
  const status = run(process.execPath, args, { cwd: TOOL_DIR, env });
  process.exit(status);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const forceReinstall = argv.includes("--reinstall");
const dryRun = argv.includes("--dry-run");

// Parse --target <key>; everything else that isn't a flag or a flag's value is
// the shot list.
let targetKey = "v3";
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") {
    targetKey = argv[++i];
  } else if (a.startsWith("--")) {
    // other flags take no value
  } else {
    positional.push(a);
  }
}
const shotListArg = positional[0];

ensureCaCerts();

const targets = loadTargets();
const target = targets[targetKey];
if (!target) {
  console.error(
    `Unknown target "${targetKey}". Available: ${Object.keys(targets).join(", ")}`
  );
  process.exit(1);
}

try {
  const clean = await fetchAllFiles();
  if (!clean) process.exit(2);
} catch (err) {
  console.error(`Mirror fetch failed: ${err.message}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`\nCheck complete — mirror access and file parsing OK. Target: ${target.label}`);
  process.exit(0);
}

if (dryRun) {
  // Apply the patch and show the resulting login code + resolved shot list,
  // without installing deps or capturing anything.
  patchCaptureScript(target);
  const src = fs.readFileSync(path.join(TOOL_DIR, "capture-docs-screenshots.mjs"), "utf8");
  const loginStart = src.indexOf("async function doLogin()");
  const loginEnd = src.indexOf("// --- Capture loop");
  console.log(`\nDry run — target: ${target.label}\n  base URL: ${process.env.PLAYWRIGHT_TEST_BASE_URL || target.baseUrl}`);
  console.log(`  shot list: ${path.relative(__dirname, resolveShotList(shotListArg))}\n`);
  console.log("--- Patched doLogin() ---");
  console.log(src.slice(loginStart, loginEnd === -1 ? undefined : loginEnd));
  console.log("--- End ---");
  process.exit(0);
}

await ensureCliLogin();
installDeps(forceReinstall);
runCapture(target, shotListArg);
