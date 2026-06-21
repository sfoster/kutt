#!/usr/bin/env node
"use strict";

/**
 * Rewrite Apps Script inventory link targets to the static github.io pages.
 *
 * Finds every Kutt link whose target is a Google Apps Script web-app URL of the
 * form:
 *
 *   https://script.google.com/.../exec?id=<N>
 *
 * and rewrites the target to:
 *
 *   https://eugenemakerspace.github.io/inventory-pages/items/<N>.html
 *
 * The short address (e.g. euglink.org/abc123) is left untouched — only the
 * redirect target changes. Works entirely over the Kutt HTTP API.
 *
 * Usage:
 *   # 1. Preview only (default — makes NO changes):
 *   KUTT_API_KEY=<admin-api-key> node scripts/update-inventory-targets.js
 *
 *   # 2. Apply the changes:
 *   KUTT_API_KEY=<admin-api-key> node scripts/update-inventory-targets.js --apply
 *
 * Options / env:
 *   --apply              Actually PATCH the links. Without it, this is a dry run.
 *   --out <file.csv>     Also write the preview as CSV (address,id,old,new).
 *   --limit <N>          Only act on the first N matching links (for a test run).
 *   KUTT_BASE_URL        Base URL of the instance. Default: https://euglink.org
 *   KUTT_API_KEY         API key of an ADMIN user. Required.
 *
 * Notes:
 *   - The API key MUST belong to an admin. Non-admin edits are scoped to the
 *     key owner's own links, so they'd silently fail to find links owned by
 *     other (or anonymous) accounts.
 *   - The script is idempotent: links already pointing at the computed target
 *     are reported as "unchanged" and skipped.
 */

const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Config / args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}
function option(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const BASE_URL = (process.env.KUTT_BASE_URL || "https://euglink.org").replace(/\/+$/, "");
const API_KEY = process.env.KUTT_API_KEY;
const APPLY = flag("--apply");
const OUT_FILE = option("--out");
const MAX = option("--limit") ? parseInt(option("--limit"), 10) : Infinity;
const PAGE_SIZE = 50; // API caps `limit` at 50

if (!API_KEY) {
  console.error("ERROR: set KUTT_API_KEY to an admin user's API key.");
  process.exit(1);
}

const NEW_TARGET_BASE = "https://eugenemakerspace.github.io/inventory-pages/items";

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

/**
 * If `target` is an Apps Script `.../exec?id=<N>` URL, return the computed new
 * target. Otherwise return null. `id` must be a positive integer.
 */
function computeNewTarget(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  if (url.hostname !== "script.google.com") return null;
  if (!url.pathname.endsWith("/exec")) return null;

  const id = url.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) return null;

  return `${NEW_TARGET_BASE}/${id}.html`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(`${init.method || "GET"} ${path} -> ${msg}`);
  }
  return body;
}

async function fetchAllLinks() {
  const all = [];
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const page = await api(`/api/v2/links?limit=${PAGE_SIZE}&skip=${skip}`);
    total = page.total;
    if (!page.data || page.data.length === 0) break;
    all.push(...page.data);
    skip += page.data.length;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log(`Instance : ${BASE_URL}`);
  console.log(`Mode     : ${APPLY ? "APPLY (will modify links)" : "dry run (no changes)"}`);
  console.log("Fetching links...");

  const links = await fetchAllLinks();
  console.log(`Fetched ${links.length} link(s) total.\n`);

  const matches = [];
  for (const link of links) {
    const newTarget = computeNewTarget(link.target);
    if (!newTarget) continue;
    matches.push({
      id: link.id, // uuid, used for PATCH
      address: link.link || link.address,
      oldTarget: link.target,
      newTarget,
      unchanged: link.target === newTarget,
    });
  }

  const changes = matches.filter(m => !m.unchanged).slice(0, MAX);
  const alreadyDone = matches.filter(m => m.unchanged);

  if (matches.length === 0) {
    console.log("No Apps Script inventory links found. Nothing to do.");
    return;
  }

  console.log(`Matched ${matches.length} inventory link(s): ` +
    `${changes.length} to update, ${alreadyDone.length} already correct.\n`);

  for (const m of changes) {
    console.log(`  ${m.address}`);
    console.log(`    old: ${m.oldTarget}`);
    console.log(`    new: ${m.newTarget}`);
  }

  if (OUT_FILE) {
    const csv = ["address,id,old_target,new_target"]
      .concat(changes.map(m =>
        [m.address, m.id, m.oldTarget, m.newTarget]
          .map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
      ))
      .join("\n");
    fs.writeFileSync(OUT_FILE, csv + "\n");
    console.log(`\nWrote preview to ${OUT_FILE}`);
  }

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to update ${changes.length} link(s).`);
    return;
  }

  console.log(`\nApplying ${changes.length} update(s)...`);
  let ok = 0;
  const failures = [];
  for (const m of changes) {
    try {
      await api(`/api/v2/links/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ target: m.newTarget }),
      });
      ok++;
      console.log(`  ✓ ${m.address} -> ${m.newTarget}`);
    } catch (err) {
      failures.push({ ...m, error: err.message });
      console.error(`  ✗ ${m.address}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${ok} updated, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
})().catch(err => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
