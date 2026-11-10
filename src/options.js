/**
 * The settings page: the links, the applicant, the career the resume is
 * written on, and how the run behaves.
 */

import { ACCENTS, checkWriter, defaultResumePrompt, FORMATS, monthLabel, writeResumePreview } from "./writer.js";
import { buildQueue } from "./links.js";
import { DEFAULT_PROFILE, experiencePeriods } from "./profile.js";
import { allLinks, clearLinks, readProfile, saveLinks, writeProfile } from "./store.js";

const $ = (id) => document.getElementById(id);

function show(element, message, kind) {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ""}`;
  element.hidden = false;
}

/* --------------------------------------------------------------- profile */

/**
 * Every setting is a form control named after its key, so the two stay in
 * step. The one exception is the list of jobs, which is as many rows as
 * there are jobs and is read and written by the functions under it.
 */
const FIELDS = Object.keys(DEFAULT_PROFILE).filter((key) => key !== "experience");

function fillChoices() {
  for (const accent of ACCENTS) {
    const option = document.createElement("option");
    option.value = accent.value;
    option.textContent = accent.label;
    $("accentColor").append(option);
  }
  const paintSwatch = () => {
    $("accent-swatch").style.background = `#${$("accentColor").value}`;
  };
  $("accentColor").addEventListener("change", paintSwatch);
  $("accentColor").addEventListener("fill", paintSwatch);

  for (const format of FORMATS) {
    const option = document.createElement("option");
    option.value = format.id;
    option.textContent = format.label;
    $("resumeFormat").append(option);
  }
  const describeFormat = () => {
    const format = FORMATS.find((candidate) => candidate.id === $("resumeFormat").value) ?? FORMATS[0];
    $("format-note").textContent = format.description;
  };
  $("resumeFormat").addEventListener("change", () => {
    describeFormat();
    const format = FORMATS.find((candidate) => candidate.id === $("resumeFormat").value);
    if (!format) return;
    $("fontFamily").value = "Calibri";
    $("accentColor").value = format.theme.accentColor;
    paintSwatch();
  });
  $("resumeFormat").addEventListener("fill", describeFormat);
}

function fillProfile(profile) {
  for (const key of FIELDS) {
    const element = $(key);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = Boolean(profile[key]);
    else element.value = profile[key] ?? "";
  }
  $("fontFamily").value = "Calibri";
  $("accentColor").dispatchEvent(new Event("fill"));
  $("resumeFormat").dispatchEvent(new Event("fill"));
  renderJobs(Array.isArray(profile.experience) ? profile.experience : DEFAULT_PROFILE.experience);
  if (!$("resumePrompt").value.trim()) $("resumePrompt").value = defaultResumePrompt(profile);
}

async function loadProfile() {
  fillProfile(await readProfile());
}

function readForm() {
  const profile = {};
  for (const key of FIELDS) {
    const element = $(key);
    if (!element) continue;
    if (element.type === "checkbox") profile[key] = element.checked;
    else if (element.type === "number") profile[key] = Number(element.value) || 0;
    else profile[key] = element.value.trim();
  }
  profile.experience = readJobs();
  return profile;
}

/* ------------------------------------------------------------------ jobs */

/** One row per job on the resume: its number, the company, the months it ran, and a way to drop it. */
function renderJobs(rows) {
  const list = $("experience-list");
  list.innerHTML = "";
  rows.forEach((row) => addJobRow(row));
  if (rows.length === 0) addJobRow();
  summariseJobs();
}

function addJobRow(row = { company: "", location: "", from: "", to: "" }) {
  const list = $("experience-list");
  const item = document.createElement("div");
  item.className = "job";

  const number = document.createElement("span");
  number.className = "n";

  const company = document.createElement("input");
  company.type = "text";
  company.className = "company";
  company.value = row.company ?? "";
  company.placeholder = "Company name, as it should print";
  company.title = "The employer, exactly as the resume should name it";

  const location = document.createElement("input");
  location.type = "text";
  location.className = "location";
  location.value = row.location ?? "";
  location.placeholder = "Company location";
  location.title = "The employer location, exactly as the resume should print it";

  const from = document.createElement("input");
  from.type = "month";
  from.className = "from";
  from.value = row.from ?? "";
  from.title = "The month the job started";

  const separator = document.createElement("span");
  separator.className = "sep";
  separator.textContent = "to";

  const to = document.createElement("input");
  to.type = "month";
  to.className = "to";
  to.value = row.to ?? "";
  to.title = "The month it ended - empty for a job still held";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost small";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    item.remove();
    summariseJobs();
  });

  for (const input of [company, location, from, to]) input.addEventListener("change", summariseJobs);

  item.append(number, company, location, from, separator, to, remove);
  list.append(item);
  summariseJobs();
}

/** The rows as they stand, in the order shown; blank rows are dropped. */
function readJobs() {
  return [...$("experience-list").querySelectorAll(".job")]
    .map((item) => ({
      company: item.querySelector(".company").value.trim(),
      location: item.querySelector(".location").value.trim(),
      from: item.querySelector(".from").value.trim(),
      to: item.querySelector(".to").value.trim(),
    }))
    .filter((row) => row.company || row.from || row.to);
}

/** Numbers the rows and says what the resume will carry: which employers, over which years. */
function summariseJobs() {
  const items = [...$("experience-list").querySelectorAll(".job")];
  items.forEach((item, index) => {
    item.querySelector(".n").textContent = `${index + 1}.`;
  });
  const rows = readJobs();
  const periods = experiencePeriods({ experience: rows });
  const summary = $("experience-summary");
  if (periods.length === 0) {
    summary.textContent = "No job yet - the resume needs at least one, with its company named.";
    return;
  }
  const oldest = periods[periods.length - 1];
  const newest = periods[0];
  const problems = rows.length - periods.length;
  summary.textContent = `${periods.length} job${periods.length === 1 ? "" : "s"} on the resume - ${periods.map((row) => row.company).join(", ")} - ${monthLabel(oldest.from)} to ${newest.to ? monthLabel(newest.to) : "present"}${problems > 0 ? `; ${problems} row${problems === 1 ? "" : "s"} incomplete (no company or bad months) and will be left out` : ""}.`;
}

async function saveProfile() {
  const profile = readForm();
  await writeProfile(profile);
  show($("status"), profile.dryRun ? "Saved. Dry run is on, so nothing will be sent." : "Saved. Submissions are live.", "ok");
}

function settingsFileName(profile) {
  const person = String(profile.profileName || `${profile.firstName ?? ""} ${profile.lastName ?? ""}` || "dice")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${person || "dice"}_settings.json`;
}

async function exportSettings() {
  const profile = readForm();
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), profile }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  try {
    await chrome.downloads.download({ url, filename: settingsFileName(profile), saveAs: true });
    show($("settings-file-status"), "Settings JSON created. Keep it private because it contains your API and Slack keys.", "ok");
  } catch (error) {
    show($("settings-file-status"), `Could not save the settings: ${error?.message ?? String(error)}`, "error");
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function importSettings(file) {
  const status = $("settings-file-status");
  try {
    const parsed = JSON.parse(await file.text());
    const imported = parsed?.profile ?? parsed;
    if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
      throw new Error("The JSON does not contain a settings object.");
    }
    const profile = { ...DEFAULT_PROFILE, ...imported, fontFamily: "Calibri" };
    if (!Array.isArray(profile.experience)) throw new Error('The "experience" setting must be a list of jobs.');
    fillProfile(profile);
    const saved = readForm();
    await writeProfile(saved);
    show(status, `Loaded and saved settings from ${file.name}.`, "ok");
  } catch (error) {
    show(status, `Could not load the settings: ${error?.message ?? String(error)}`, "error");
  } finally {
    $("settings-file").value = "";
  }
}

async function testApp() {
  const status = $("app-status");
  const result = checkWriter({ ...DEFAULT_PROFILE, ...readForm() });
  show(status, result.ok ? `Looks right. Resumes will be written with ${result.provider} ${result.model}.` : result.error, result.ok ? "ok" : "error");
}

async function previewResume() {
  const button = $("preview-resume");
  const status = $("preview-status");
  const jd = String($("previewJd").value ?? "").trim();
  if (jd.length < 100) {
    show(status, "Paste a complete job description (at least 100 characters) first.", "error");
    return;
  }

  button.disabled = true;
  show(status, "Generating the resume preview...", "");
  try {
    const title = String($("previewTitle").value ?? "").trim();
    const company = String($("previewCompany").value ?? "").trim();
    const preview = await writeResumePreview(
      { ...DEFAULT_PROFILE, ...readForm() },
      {
        jd: [[title && `Title: ${title}`, company && `Company: ${company}`].filter(Boolean).join("\n"), jd].filter(Boolean).join("\n\n"),
        title,
        company,
      },
    );
    const url = URL.createObjectURL(preview.resumeBlob);
    await chrome.tabs.create({ url, active: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const warnings = preview.violations?.length ? ` ${preview.violations.length} validation note(s) were returned.` : "";
    show(status, `Preview opened in a new tab. Model usage: ${preview.spend}.${warnings}`, preview.violations?.some((item) => item.severity === "error") ? "error" : "ok");
  } catch (error) {
    show(status, `Could not generate the preview: ${error?.message ?? String(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function testSlack() {
  const status = $("slack-status");
  const token = String($("slackToken").value ?? "").trim();
  const channel = String($("slackChannel").value ?? "").trim();
  if (!token || !channel) {
    show(status, "A bot token and a channel are both needed.", "error");
    return;
  }
  show(status, "Sending...", "");
  await writeProfile(readForm());
  const result = await chrome.runtime.sendMessage({ type: "slackTest" }).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  show(status, result?.ok ? `Sent to ${channel}. Look for it in Slack.` : result?.error ?? "Slack did not answer.", result?.ok ? "ok" : "error");
}

/* ----------------------------------------------------------------- links */

async function loadLinks() {
  const status = $("links-status");
  const pasted = String($("pastedLinks").value ?? "").trim();
  // The paste box is saved with the rest, so the list survives a reload.
  await writeProfile({ pastedLinks: pasted });

  const { queue, rejected } = buildQueue([pasted]);
  if (queue.length === 0) {
    return show(status, rejected.length > 0 ? `No Dice links found; ${rejected.length} link(s) were not Dice job pages.` : "No links found. Paste some Dice job links above.", "error");
  }

  await saveLinks(queue);
  await renderLinks(queue, Date.now(), rejected);
  show(status, `${queue.length} Dice link${queue.length === 1 ? "" : "s"} loaded. They are what a run will work through.${rejected.length > 0 ? ` ${rejected.length} other link(s) were dropped.` : ""}`, "ok");
}

async function renderLinks(links, at, rejected = []) {
  const sent = new Set((await chrome.storage.local.get("submitted")).submitted ?? []);
  const waiting = links.filter((entry) => !sent.has(entry.id));

  $("link-counts").innerHTML = "";
  const pill = (label, kind) => {
    const node = document.createElement("span");
    node.className = `pill${kind ? ` ${kind}` : ""}`;
    node.textContent = label;
    $("link-counts").append(node);
  };
  pill(`${waiting.length} to work through`, waiting.length > 0 ? "good" : "");
  const done = links.length - waiting.length;
  if (done > 0) pill(`${done} already submitted`, "warn");
  if (rejected.length > 0) pill(`${rejected.length} not Dice links`, "warn");
  if (at) pill(`loaded ${new Date(at).toLocaleString()}`);

  $("link-list").innerHTML = "";
  for (const entry of links.slice(0, 80)) {
    const item = document.createElement("li");
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = entry.link;
    item.append(what);
    if (sent.has(entry.id)) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = " - already submitted, will be left alone";
      item.append(why);
    }
    $("link-list").append(item);
  }
  if (links.length > 80) {
    const item = document.createElement("li");
    item.className = "why";
    item.textContent = `...and ${links.length - 80} more.`;
    $("link-list").append(item);
  }
  for (const { link, reason } of rejected.slice(0, 20)) {
    const item = document.createElement("li");
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = link;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = ` - ${reason}, dropped`;
    item.append(what, why);
    $("link-list").append(item);
  }
}

async function clearLoadedLinks() {
  await clearLinks();
  $("link-counts").innerHTML = "";
  $("link-list").innerHTML = "";
  show($("links-status"), "Cleared. Nothing will run until links are loaded again.", "ok");
}

async function restoreLinks() {
  const { links, at } = await allLinks();
  if (links.length === 0) return;
  await renderLinks(links, at);
  show($("links-status"), `${links.length} link(s) loaded earlier and still waiting.`, "ok");
}

/* ----------------------------------------------------------------- wiring */

$("save").addEventListener("click", saveProfile);
$("add-job").addEventListener("click", () => addJobRow());
$("reset-resume-prompt").addEventListener("click", () => {
  $("resumePrompt").value = defaultResumePrompt({ ...DEFAULT_PROFILE, ...readForm() });
});
$("test-app").addEventListener("click", testApp);
$("preview-resume").addEventListener("click", previewResume);
$("test-slack").addEventListener("click", testSlack);
$("load-links").addEventListener("click", loadLinks);
$("clear-links").addEventListener("click", clearLoadedLinks);
$("export-settings").addEventListener("click", exportSettings);
$("import-settings").addEventListener("click", () => $("settings-file").click());
$("settings-file").addEventListener("change", (event) => {
  const [file] = event.target.files ?? [];
  if (file) importSettings(file);
});

fillChoices();
loadProfile();
restoreLinks();
