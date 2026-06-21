#!/usr/bin/env node
"use strict";

/**
 * Apply the inventory link changes tracked in scripts/inventory.csv to Kutt,
 * over the HTTP API. The CSV's "Action" column drives what happens to each row:
 *
 *   update  -> repoint the Kutt link from its Appscript URL to the Static URL
 *   remove  -> delete the Kutt link
 *   (blank / anything else) -> skip
 *
 * Each row is matched to its Kutt link by the link's CURRENT target:
 *   - if a link currently targets the row's "Appscript URL", that's the link.
 *   - if a link already targets the row's "Static URL", the update is treated
 *     as already done (idempotent); a remove on it is flagged for review.
 *   - if neither is found, the row is reported as not-found (e.g. already
 *     removed) and skipped.
 *
 * Usage:
 *   # Preview only (default — makes NO changes):
 *   KUTT_API_KEY=<admin-api-key> node scripts/apply-inventory-changes.js
 *
 *   # Apply the changes:
 *   KUTT_API_KEY=<admin-api-key> node scripts/apply-inventory-changes.js --apply
 *
 * Options / env:
 *   --csv <file>   CSV to read. Default: scripts/inventory.csv
 *   --apply        Actually perform updates/deletes. Without it, this is a dry run.
 *   KUTT_BASE_URL  Base URL of the instance. Default: https://euglink.org
 *   KUTT_API_KEY   API key of an ADMIN user. Required.
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Config / args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

const BASE_URL = (process.env.KUTT_BASE_URL || "https://euglink.org").replace(/\/+$/, "");
const API_KEY = process.env.KUTT_API_KEY;
const APPLY = flag("--apply");
const CSV_FILE = option("--csv") || path.join("scripts", "inventory.csv");

if (!API_KEY) {
  console.error("ERROR: set KUTT_API_KEY to an admin user's API key.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CSV parsing (simple: no embedded commas/quotes in this data)
// ---------------------------------------------------------------------------
function readCsv(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) throw new Error(`CSV is empty: ${file}`);

  const header = lines[0].split(",");
  const idx = name => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV is missing a "${name}" column.`);
    return i;
  };
  const iId = idx("ID");
  const iApps = idx("Appscript URL");
  const iStatic = idx("Static URL");
  const iAction = idx("Action");

  return lines.slice(1).map(line => {
    const f = line.split(",");
    return {
      id: (f[iId] || "").trim(),
      appscript: (f[iApps] || "").trim(),
      static: (f[iStatic] || "").trim(),
      action: (f[iAction] || "").trim().toLowerCase(),
    };
  });
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
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
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
    const page = await api(`/api/v2/links?limit=50&skip=${skip}`);
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
  console.log(`CSV      : ${CSV_FILE}`);
  console.log(`Mode     : ${APPLY ? "APPLY (will modify links)" : "dry run (no changes)"}`);

  const rows = readCsv(CSV_FILE);
  console.log("Fetching links...");
  const links = await fetchAllLinks();
  const byTarget = new Map(links.map(l => [l.target, l]));
  console.log(`Fetched ${links.length} link(s); ${rows.length} CSV row(s).\n`);

  // Plan: classify each row into an action against a concrete link.
  const plan = { update: [], remove: [], done: [], notfound: [], skip: [], review: [] };

  for (const row of rows) {
    const linkByApps = byTarget.get(row.appscript);
    const linkByStatic = row.static ? byTarget.get(row.static) : undefined;

    if (row.action === "update") {
      if (!row.static) { plan.review.push({ row, why: "no Static URL to update to" }); continue; }
      if (linkByStatic) { plan.done.push({ row, link: linkByStatic }); continue; }
      if (linkByApps) { plan.update.push({ row, link: linkByApps }); continue; }
      plan.notfound.push({ row, why: "no link targets the Appscript or Static URL" });
    } else if (row.action === "remove") {
      if (linkByApps) { plan.remove.push({ row, link: linkByApps }); continue; }
      if (linkByStatic) { plan.review.push({ row, link: linkByStatic, why: "marked remove but link already points at Static URL" }); continue; }
      plan.notfound.push({ row, why: "no matching link (already removed?)" });
    } else {
      plan.skip.push({ row });
    }
  }

  // Preview
  const short = l => l ? (l.link || l.address || l.id) : "?";
  if (plan.update.length) {
    console.log(`UPDATE (${plan.update.length}):`);
    for (const { row, link } of plan.update)
      console.log(`  #${row.id}  ${short(link)}\n      ${row.appscript}\n   -> ${row.static}`);
    console.log();
  }
  if (plan.remove.length) {
    console.log(`REMOVE (${plan.remove.length}):`);
    for (const { row, link } of plan.remove)
      console.log(`  #${row.id}  ${short(link)}  (${row.appscript})`);
    console.log();
  }
  if (plan.done.length)
    console.log(`Already up to date: ${plan.done.length}`);
  if (plan.skip.length)
    console.log(`Skipped (no/blank action): ${plan.skip.length}`);
  if (plan.notfound.length) {
    console.log(`Not found (${plan.notfound.length}):`);
    for (const { row, why } of plan.notfound) console.log(`  #${row.id}  ${why}`);
  }
  if (plan.review.length) {
    console.log(`NEEDS REVIEW (${plan.review.length}):`);
    for (const { row, why } of plan.review) console.log(`  #${row.id}  ${why}`);
  }

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to perform ` +
      `${plan.update.length} update(s) and ${plan.remove.length} removal(s).`);
    return;
  }

  // Apply
  console.log(`\nApplying ${plan.update.length} update(s) and ${plan.remove.length} removal(s)...`);
  let ok = 0;
  const failures = [];

  for (const { row, link } of plan.update) {
    try {
      await api(`/api/v2/links/${link.id}`, {
        method: "PATCH",
        body: JSON.stringify({ target: row.static }),
      });
      ok++;
      console.log(`  ✓ update #${row.id} ${short(link)} -> ${row.static}`);
    } catch (err) {
      failures.push({ id: row.id, op: "update", error: err.message });
      console.error(`  ✗ update #${row.id}: ${err.message}`);
    }
  }

  for (const { row, link } of plan.remove) {
    try {
      await api(`/api/v2/links/${link.id}`, { method: "DELETE" });
      ok++;
      console.log(`  ✓ remove #${row.id} ${short(link)}`);
    } catch (err) {
      failures.push({ id: row.id, op: "remove", error: err.message });
      console.error(`  ✗ remove #${row.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${ok} action(s) succeeded, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
})().catch(err => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
