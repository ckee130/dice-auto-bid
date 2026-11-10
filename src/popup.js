/**
 * The run window.
 *
 * A popup dies the moment it loses focus, so it owns none of the run - it asks
 * the service worker for the state it missed on open, then follows along. The
 * run continues whether this is on screen or not.
 */

import { allLinks, allResults, readProfile } from "./store.js";
import { resultsCsv } from "./vault.js";

const $ = (id) => document.getElementById(id);

function line(entry) {
  const node = document.createElement("div");
  node.className = entry.level;
  node.textContent = new Date(entry.at).toLocaleTimeString() + "  " + entry.message;
  if (entry.detail) node.title = JSON.stringify(entry.detail, null, 2);
  $("log").append(node);
  $("log").scrollTop = $("log").scrollHeight;
}

function setRunning(running, done, total) {
  $("run").disabled = running;
  $("stop").disabled = !running;
  $("run").textContent = running ? (total > 0 ? `Running - ${done} of ${total} so far` : "Running") : "Run";
  $("progress").hidden = !running && done === 0;
  $("progress").firstElementChild.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

async function renderBidStatus() {
  const results = await allResults();
  const counts = {
    submitted: 0,
    unconfirmed: 0,
    manual: 0,
    skipped: 0,
    failed: 0,
    "dry-run": 0,
  };
  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
  }

  const cards = [
    ["Submitted", counts.submitted, "good"],
    ["Unconfirmed", counts.unconfirmed, "warn"],
    ["Needs you", counts.manual, "warn"],
    ["Skipped", counts.skipped, ""],
    ["Failed", counts.failed, "bad"],
    ["Dry runs", counts["dry-run"], ""],
  ];
  const box = $("bid-status");
  box.innerHTML = "";
  for (const [label, count, kind] of cards) {
    const card = document.createElement("div");
    card.className = `status-card${kind ? ` ${kind}` : ""}`;
    const number = document.createElement("strong");
    number.textContent = String(count);
    const name = document.createElement("span");
    name.textContent = label;
    card.append(number, name);
    box.append(card);
  }

  const latest = [...results].sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))[0];
  $("last-result").textContent = latest
    ? `${results.length} recorded so far. Latest: ${latest.company || latest.title || latest.applyUrl || "job"} - ${latest.status}${latest.reason ? ` (${latest.reason})` : ""}.`
    : "No applications have been recorded yet.";
}

async function refresh() {
  const [profile, state] = await Promise.all([readProfile(), chrome.runtime.sendMessage({ type: "state" })]);

  const sent = new Set((await chrome.storage.local.get("submitted")).submitted ?? []);

  // The list loaded on the options page, not the sheet. Opening the popup
  // makes no network request, and the number shown is the number that will
  // actually be worked through.
  const { links } = await allLinks();
  const waiting = links.filter((entry) => !sent.has(entry.id)).length;

  const parts = [];
  if (waiting > 0) parts.push(`${waiting} loaded link${waiting === 1 ? "" : "s"} to work through`);
  if (sent.size > 0) parts.push(`${sent.size} already submitted`);
  if (!(String(profile.slackToken ?? "").trim() && String(profile.slackChannel ?? "").trim())) parts.push("Slack is not set up, so jobs that need you are only in the log");

  $("ready").textContent =
    parts.length === 0
      ? "Nothing to run. Open settings, paste some Dice links and press Load links."
      : `${parts.join("; ")}.`;

  renderOpenTabs(state?.openForYou ?? []);

  $("mode").hidden = false;
  if (profile.dryRun) {
    $("mode").className = "status";
    $("mode").textContent = "Dry run: forms are filled and checked, nothing is sent.";
  } else {
    $("mode").className = "status error";
    $("mode").textContent = "Live: applications will be submitted and cannot be withdrawn.";
  }

  $("run").disabled = waiting === 0;
  $("log").innerHTML = "";
  for (const entry of state?.log ?? []) line(entry);
  setRunning(state?.running ?? false, state?.done ?? 0, state?.total ?? 0);
  await renderBidStatus();
  if (state?.running) poll();
}

/** The forms left open for the applicant, each a click away. */
function renderOpenTabs(entries) {
  const box = $("open-for-you");
  box.innerHTML = "";
  box.hidden = entries.length === 0;
  if (entries.length === 0) return;
  const heading = document.createElement("p");
  heading.className = "note";
  heading.textContent = `${entries.length} form${entries.length === 1 ? "" : "s"} left open for you to finish:`;
  box.append(heading);
  for (const entry of entries) {
    const row = document.createElement("a");
    row.href = "#";
    row.className = "open-tab";
    row.textContent = `${entry.company || entry.applyUrl}${entry.title ? ` - ${entry.title}` : ""}`;
    row.title = entry.reason ?? "";
    row.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: "focusTab", tabId: entry.tabId }).catch(() => {});
    });
    box.append(row);
  }
}

let polling = null;
function poll() {
  if (polling) return;
  polling = setInterval(async () => {
    const state = await chrome.runtime.sendMessage({ type: "state" }).catch(() => null);
    if (!state) return;
    setRunning(state.running, state.done, state.total);
    renderOpenTabs(state.openForYou ?? []);
    await renderBidStatus();
    if (!state.running) {
      clearInterval(polling);
      polling = null;
      refresh();
    }
  }, 1000);
}

/* ---------------------------------------------------------------- actions */

$("run").addEventListener("click", async () => {
  const profile = await readProfile();
  if (!profile.dryRun) {
    const ok = confirm("Dry run is off. Every Easy Apply posting on the list will be submitted on Dice, and a submitted application cannot be withdrawn.\n\nGo ahead?");
    if (!ok) return;
  }
  $("log").innerHTML = "";
  await chrome.runtime.sendMessage({ type: "run" });
  setRunning(true, 0, 0);
  poll();
});

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  $("stop").disabled = true;
  line({ at: Date.now(), level: "warn", message: "Stopping after the current application." });
});

/**
 * Dumps the form on whatever is open, which is how the field map gets written
 * against pages that exist rather than pages as remembered.
 */
$("probe").addEventListener("click", async () => {
  $("log").innerHTML = "";
  line({ at: Date.now(), level: "info", message: "Reading this tab the way a run would..." });

  const response = await chrome.runtime.sendMessage({ type: "probe" });
  if (!response?.ok) {
    line({ at: Date.now(), level: "error", message: response?.error ?? "could not read the tab" });
    return;
  }
  const report = response.report;
  if (report.kind === "posting") {
    const posting = report.posting;
    line({ at: Date.now(), level: "ok", message: `Posting: ${posting.company} - ${posting.title} (${posting.location || "no location"})`, detail: posting });
    line({ at: Date.now(), level: posting.apply.kind === "easy" ? "ok" : "warn", message: `Apply button: ${posting.apply.kind} - "${posting.apply.label}"${posting.apply.href ? ` -> ${posting.apply.href}` : ""}` });
    line({ at: Date.now(), level: posting.signedIn ? "ok" : "error", message: posting.signedIn ? "Signed in to Dice." : "Not signed in to Dice - the wizard needs the account." });
  } else {
    const page = report.page;
    line({ at: Date.now(), level: "ok", message: `Wizard step: ${page.step}${page.stepLabel ? ` (${page.stepLabel})` : ""} - ${page.heading}`, detail: page });
    for (const field of report.fields ?? []) {
      line({
        at: Date.now(),
        level: "info",
        message: `  [${field.type}${field.required ? " *" : ""}] ${field.label}${field.options?.length > 0 ? ` -> ${field.options.map((option) => option.label).join(" | ")}` : ""}${field.current ? ` (now: ${field.current})` : ""}`,
        detail: field,
      });
    }
  }
  const copied = await navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => true, () => false);
  line({ at: Date.now(), level: copied ? "ok" : "warn", message: copied ? "The full report is on the clipboard." : "The clipboard was refused; the details are above." });
});

$("export").addEventListener("click", async () => {
  const results = await allResults();
  if (results.length === 0) {
    line({ at: Date.now(), level: "warn", message: "No run has been recorded yet." });
    return;
  }

  // The same table the run keeps at job applied-folder/<day>/<profile>/history/applications.csv.
  const csv = resultsCsv(results);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));

  // An anchor rather than chrome.downloads, which would mean asking for a
  // permission solely to write one file the browser can already write.
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dice-run-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  line({ at: Date.now(), level: "ok", message: `Exported ${results.length} result(s).` });
});

$("settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "log") {
    line(message.entry);
    renderBidStatus();
  }
});

refresh();
