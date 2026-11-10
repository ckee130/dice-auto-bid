/**
 * The record on disk: a folder of plain files, kept by the bot itself.
 *
 * Everything a run learns or produces is written under
 * Downloads/job applied-folder/, so the history survives the extension being
 * removed, can be read without it, and can be copied anywhere:
 *
 *   job applied-folder/
 *     <day>/<profile>/                       the day first, then whose: two
 *                                            browsers on one machine share
 *                                            one Downloads, and a day's work
 *                                            is read per person
 *       applied/<company> - <role>/          one folder per application sent
 *         resume.pdf
 *         cover-letter.pdf
 *         Cover letter.txt
 *         Screenshot from <when>.png          the board's thank-you, with the
 *                                            addresses printed across the top
 *         application.json                   links, status, times, what was
 *                                            filled
 *       manual application/<company> - <role>/
 *                                            the same, for a job sent by hand
 *       other links.csv                      the day's jobs left to be sent by hand
 *       links/<when>.txt                     every list a run worked through
 *       history/                             the running record as it stood at
 *                                            the end of that day; the newest
 *                                            day's is the current one
 *         applications.csv                   every result, one row each
 *         applied-links.txt                  the links already sent
 *         elsewhere-links.txt                the links that apply off Dice
 *         runs/<when>.txt                    the log of each run
 *
 * An extension can write files only through the downloads API, which creates
 * a file and never appends to one. So the folder is kept as a database is:
 * the per-application files are written once, and the index files are
 * rewritten whole each time they change. Each write is small enough that
 * this costs nothing noticeable.
 */

import { toBase64 } from "./store.js";

export const ROOT = "job applied-folder";

/** A file name every filesystem will take, Windows being the strictest. */
export const safeName = (name) =>
  String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 80);

/** 2026-10-31 18-14-36: sorts as time does, and is legal in a file name. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** The day's folder, "11-2" for the 2nd of November: month and day, as written by hand. */
export const dayFolder = (date = new Date()) => `${date.getMonth() + 1}-${date.getDate()}`;

/**
 * Whose folder: the profile name from settings, or the applicant's name
 * when none is set. Two browsers running this on one machine write into
 * one Downloads, and this is what keeps their days apart.
 */
export const profileFolder = (profile) =>
  safeName(profile?.profileName) || safeName(`${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`) || "profile";

/** The day's folder for one profile: "11-2/Steven". Everything a day produces sits under it. */
export const dayRoot = (profile, date = new Date()) => `${dayFolder(date)}/${profileFolder(profile)}`;

/**
 * The folder one application's files go in: under the day it was made and
 * whose it is, then "applied" or "manual application", then the company
 * and the role, nothing else. The time is on the screenshot inside it, and
 * a job is applied to once, so the name needs no stamp to stay unique.
 */
export const applicationFolder = (application, root = "applied", date = new Date(), profile = null) =>
  `${dayRoot(profile, date)}/${root}/${safeName(application.company) || "application"}${application.title ? ` - ${safeName(application.title)}` : ""}`;

/** Where the day's table of jobs left to be sent by hand goes: "11-2/Steven/other links.csv". */
export const otherLinksPath = (date = new Date(), profile = null) => `${dayRoot(profile, date)}/other links.csv`;

/** Where a profile's running record goes: "11-2/Steven/history/...". */
export const historyPath = (profile, file, date = new Date()) => `${dayRoot(profile, date)}/history/${file}`;

const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** Where the documents for jobs the applicant sends by hand go. */
export const MANUAL_ROOT = "manual application";

/**
 * The board a job applies through, for a column a spreadsheet can filter
 * on: Dice for its own links, "company site" for a posting that sends the
 * applicant elsewhere.
 */
export function boardLabel(url) {
  const link = String(url ?? "").trim();
  if (/^mailto:/i.test(link)) return "email";
  return /(^|\.)dice\.com$/i.test((() => { try { return new URL(link).hostname; } catch { return ""; } })()) ? "Dice" : "company site";
}

/**
 * "<day>/<profile>/other links.csv": every job this bot wrote up but did not send that
 * day, oldest first - one row per job, with the board it applies through, the link the
 * job was found at, the link to apply at, the folder holding its resume and
 * letter, and why it was left to be sent by hand. Written with a byte-order
 * mark and CRLF line ends so Excel opens it as-is.
 */
export function otherLinksCsv(rows) {
  const header = ["date", "company", "role", "board", "job link", "application link", "folder", "why"];
  const lines = [...rows]
    .sort((a, b) => a.at - b.at)
    .map((row) =>
      [
        new Date(row.at).toISOString().slice(0, 10),
        row.company || "",
        row.title || "",
        boardLabel(row.applyUrl),
        row.sourceUrl || row.applyUrl || "",
        row.applyUrl || "",
        row.folder || "",
        row.reason || "",
      ]
        .map(cell)
        .join(","),
    );
  return `\ufeff${[header.map(cell).join(","), ...lines].join("\r\n")}\r\n`;
}

async function asDataUrl(content, type) {
  if (content instanceof Blob) return `data:${content.type || type};base64,${await toBase64(content)}`;
  // Text goes through the same base64 route: a data: URL with raw text in it
  // is subject to percent-decoding, which mangles anything with a % in it.
  const bytes = new TextEncoder().encode(String(content));
  return `data:${type};base64,${await toBase64(new Blob([bytes]))}`;
}

/**
 * Writes one file. `overwrite` is for the index files, which are rewritten
 * whole; everything else is written once and never collides, but is
 * uniquified rather than overwritten should it.
 */
export async function save(path, content, { overwrite = false, type = "text/plain" } = {}) {
  const filename = `${ROOT}/${path}`;
  const url = await asDataUrl(content, type);
  // One write to a file at a time. Two overwrites of the run log started in
  // the same instant - one after the last job, one as the run ended - and
  // Chrome, finding the file already being written, put up a "Save as"
  // dialog for the second. Each write waits for the previous write to the
  // same file to finish.
  const previous = writing.get(filename) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => chrome.downloads.download({ url, filename, conflictAction: overwrite ? "overwrite" : "uniquify", saveAs: false }))
    .then(untilDone);
  writing.set(filename, current);
  await current;
  if (writing.get(filename) === current) writing.delete(filename);
  return filename;
}

const writing = new Map();

/** Resolves once a download has left the in-progress state, or after a few seconds regardless. */
async function untilDone(downloadId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    if (!item || item.state !== "in_progress") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const saveJson = (path, value, options) => save(path, JSON.stringify(value, null, 2), { ...options, type: "application/json" });

/** The whole results table, as a CSV any spreadsheet opens. */
export function resultsCsv(results) {
  const header = ["when", "company", "role", "status", "reason", "seconds", "apply url", "found via", "folder"];
  const rows = [...results]
    .sort((a, b) => a.at - b.at)
    .map((result) =>
      [
        new Date(result.at).toISOString(),
        result.company,
        result.title,
        result.status,
        result.reason,
        Math.round((result.took ?? 0) / 1000),
        result.applyUrl,
        result.sourceUrl ?? "",
        result.detail?.folder ?? "",
      ]
        .map(cell)
        .join(","),
    );
  return [header.map(cell).join(","), ...rows].join("\n");
}

/** The log of a run, as it was shown in the popup. */
export function logText(entries) {
  return entries
    .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.level.padEnd(5)} ${entry.message}${entry.detail ? `  ${JSON.stringify(entry.detail)}` : ""}`)
    .join("\n");
}
