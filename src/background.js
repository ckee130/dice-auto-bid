/**
 * The run loop.
 *
 * A list of Dice job links, nothing else: pasted into settings before the
 * run, in whatever order the applicant wants them sent. Each is opened on
 * Dice, read, and - where the posting takes Easy Apply - a resume and cover
 * letter are written for it and the three-step wizard is walked through and
 * submitted. A posting that sends the applicant to the company's own site
 * is listed on the day's table and left alone; this bot sends nothing off
 * Dice.
 *
 * The browser has to be signed into Dice as the applicant. The wizard is
 * behind the account, and the first link that lands on the sign-in page
 * ends the run with that said, rather than failing forty times.
 *
 * Generating comes after reading, not before: a link that turns out to be
 * closed, already applied to, or an external posting costs one page load
 * and no model call.
 *
 * What cannot be sent is handed to the applicant two ways at once. The tab
 * is left open as it stands - the files attached, the answers typed - so
 * it can be finished in a minute by the person who comes back to the
 * machine. And a Slack message goes to the channel in settings saying which
 * job, why, and where the files are.
 */

import { resolveField, stateCode } from "./answers.js";
import { answerQuestion, AiError } from "./ai.js";
import { checkWriter, educationFrom, WriterError, writeApplication } from "./writer.js";
import { describe as describeSpend, resetRun as resetSpend, runTotal } from "./spend.js";
import { dicePage } from "./dice.js";
import { captureEvidence } from "./evidence.js";
import { postingUrl, wizardUrl } from "./links.js";
import { mrkdwn, needsYouMessage, postSlack, runSummaryMessage, slackConfigured } from "./slack.js";
import { atFront, focus, openTab as openInFront } from "./tabs.js";
import { allLinks, allResults, readProfile, recordResult } from "./store.js";
import { missingFromProfile } from "./profile.js";
import { applicationFolder, dayRoot, historyPath, logText, MANUAL_ROOT, otherLinksCsv, otherLinksPath, resultsCsv, save, saveJson, stamp } from "./vault.js";

/** The profile's authorization setting, in words a model can use. */
const AUTHORIZATION_WORDS = {
  "us-citizen": "US citizen, authorized to work in the United States without sponsorship",
  "permanent-resident": "lawful permanent resident, authorized to work in the United States without sponsorship",
  "visa-holder": "visa holder, currently authorized to work in the United States",
  "needs-sponsorship": "will require visa sponsorship to work in the United States",
};

/**
 * The same setting as Dice's own work authorization menu words it, in the
 * order to try. Dice offers: US Citizen, Canadian Citizen, Have H1 Visa,
 * Need H1 Visa, Green Card Holder, TN Permit Holder, Employment Auth
 * Document, Prefer Not to Answer.
 */
const DICE_AUTHORIZATION = {
  "us-citizen": ["US Citizen"],
  "permanent-resident": ["Green Card Holder"],
  "visa-holder": ["Have H1 Visa", "Employment Auth Document"],
  "needs-sponsorship": ["Need H1 Visa"],
};

const state = {
  running: false,
  stopping: false,
  total: 0,
  done: 0,
  log: [],
};

/**
 * The tabs left for the applicant, with the job each holds. Never closed by
 * the run; a person closes them when the form is sent. The popup lists them.
 */
const openForYou = [];

/**
 * The log lives in session storage as well as in memory, because memory here
 * is the service worker's, and Chrome ends the worker thirty seconds after a
 * run finishes. Session storage is also how a worker that died mid-run gets
 * to say so.
 */
const remember = () =>
  chrome.storage.session
    .set({ runLog: state.log, runProgress: { running: state.running, total: state.total, done: state.done }, openForYou })
    .catch(() => {});

const restored = chrome.storage.session
  .get(["runLog", "runProgress", "openForYou"])
  .then((stored) => {
    if (Array.isArray(stored.runLog)) state.log = stored.runLog;
    if (Array.isArray(stored.openForYou)) openForYou.push(...stored.openForYou);
    if (stored.runProgress) {
      state.total = stored.runProgress.total ?? 0;
      state.done = stored.runProgress.done ?? 0;
      if (stored.runProgress.running) {
        state.log.push({
          at: Date.now(),
          level: "error",
          message: `The run was cut off after ${state.done} of ${state.total}: Chrome ended the extension's background worker. Already-sent applications are remembered; press Run to continue with the rest.`,
        });
        remember();
      }
    }
  })
  .catch(() => {});

function log(level, message, detail) {
  const entry = { at: Date.now(), level, message, detail };
  state.log.push(entry);
  if (state.log.length > 500) state.log.shift();
  remember();
  chrome.runtime.sendMessage({ type: "log", entry }).catch(() => {});
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (from, to = Date.now()) => `${((to - from) / 1000).toFixed(1)}s`;

/* ------------------------------------------------------------ identity */

const fold = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|gmbh|plc)\b\.?/g, " ")
    .replace(/\b(?:remote|hybrid|onsite|on-site|usa?|us-based|united states)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");

/**
 * What makes two postings the same job: the company and the title, folded.
 * The same role is often listed twice on Dice by two recruiters, and an
 * applicant sends it once.
 */
export function jobKey(company, title) {
  const c = fold(company);
  const t = fold(title);
  return c && t ? `${c}|${t}` : "";
}

/**
 * The company alone. One applicant sends one application to a company: a
 * second role at the same place, under the same name, reads as scattershot
 * and does the first no good. Staffing firms post for many clients under
 * their own name, which is the one place this rule costs something, so the
 * firms seen most are let through.
 */
export function companyKey(company) {
  const key = fold(company);
  if (/^(?:confidential|undisclosed|unknown|stealth|private)$/.test(key)) return "";
  return key;
}

/* ---------------------------------------------------------------- tabs */

const closeTab = (tabId) => chrome.tabs.remove(tabId).catch(() => {});

/** Runs one of dice.js's actions in the tab. */
async function inPage(tabId, action, args = {}) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: dicePage, args: [action, args] });
  return results?.[0]?.result ?? null;
}

/** The posting, once its structured block is on the page or it is known to be gone. */
async function readPosting(tabId, deadlineMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < deadlineMs) {
    last = await inPage(tabId, "posting").catch(() => null);
    if (last?.ready) return last;
    await wait(500);
  }
  return last;
}

/** The wizard's step, once it has settled on one. */
async function wizardState(tabId, deadlineMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < deadlineMs) {
    last = await inPage(tabId, "state").catch(() => null);
    if (last && last.step !== "unknown") return last;
    await wait(500);
  }
  return last ?? { step: "unknown", errors: [], text: "" };
}

function leftOpen(tabId, result) {
  openForYou.push({ tabId, company: result.company, title: result.title, applyUrl: result.applyUrl, reason: result.reason, at: Date.now() });
  remember();
}

async function tabsLeftOpen() {
  const alive = [];
  for (const entry of openForYou) {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (tab) alive.push(entry);
  }
  return alive;
}

/* ------------------------------------------------------------- writing */

class SignInNeeded extends Error {
  constructor(tabId) {
    super("Dice is not signed in. Sign in on the tab that was left open, then press Run again.");
    this.name = "SignInNeeded";
    this.tabId = tabId;
  }
}

function spent(generated) {
  const spend = generated?.spend;
  return spend ? ` (model: resume ${spend.resume}; letter ${spend.letter})` : "";
}

async function writeWithPatience(profile, job) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await writeApplication(profile, job);
    } catch (error) {
      const status = error instanceof WriterError ? error.status : 0;
      if ((status === 429 || status >= 500) && attempt < 2) {
        log("warn", `${job.company || job.title} - the writer answered ${status}; trying again in ${20 * (attempt + 1)}s`);
        await wait(20000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

/** The fewest characters of description worth writing a resume from. */
const JD_MIN = 200;

/**
 * The first half of a job: the posting opened and read, the documents
 * written. Returns an application ready to send, or a skip with its reason.
 */
async function prepareLink(entry, profile, hints) {
  const openedAt = Date.now();
  const posting = await atFront(async () => {
    const tabId = await openInFront(postingUrl(entry.id));
    try {
      const read = await readPosting(tabId);
      if (!read) throw new Error("the posting page could not be read");
      if (!read.signedIn && (read.apply.kind === "signin" || read.apply.kind === "none")) {
        // Left open on the posting; its button leads to the sign-in page.
        await focus(tabId);
        throw new SignInNeeded(tabId);
      }
      await closeTab(tabId);
      return read;
    } catch (error) {
      if (!(error instanceof SignInNeeded)) await closeTab(tabId);
      throw error;
    }
  });

  const company = posting.company || "";
  const title = posting.title || "";
  const label = title ? `${company} - ${title}` : entry.link;

  if (posting.gone) return { skip: "no longer listed on Dice", elsewhere: true, company, title };
  if (posting.apply.kind === "applied") return { skip: "already applied to on Dice", applied: true, company, title };
  if (posting.apply.kind === "closed") return { skip: "the posting is no longer taking applications", elsewhere: true, company, title };
  if (posting.apply.kind !== "easy") {
    return { skip: `applies on the company's own site, not through Easy Apply (${posting.apply.href || posting.apply.label || "no apply button"})`, manual: true, applyUrl: posting.apply.href, company, title };
  }
  if (hints.applied.has(jobKey(company, title))) return { skip: `already applied to "${title}" at ${company}`, duplicate: true, company, title };
  if (hints.companies.has(companyKey(company))) return { skip: `already applied to ${company} for another role; one application per company`, duplicate: true, company, title };
  if (posting.description.length < JD_MIN) return { skip: `only ${posting.description.length} characters of description were found to write from`, company, title };

  log("info", `${label} - Easy Apply, read in ${since(openedAt)}. Writing resume and cover letter.`);
  const jd = [
    `Title: ${title}`,
    `Company: ${company}`,
    posting.location ? `Location: ${posting.location}` : "",
    posting.employmentType ? `Employment type: ${posting.employmentType}` : "",
    posting.salary ? `Pay: ${posting.salary}` : "",
    "",
    posting.description,
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");

  const writingAt = Date.now();
  const generated = await writeWithPatience(profile, { jd, url: entry.link, title, company });
  log("info", `${label} - written in ${since(writingAt)}${spent(generated)}`);
  if (generated.violations.length > 0) {
    log("warn", `${label} - the writer noted ${generated.violations.length} rule(s) it could not fully meet`, generated.violations.slice(0, 5));
  }

  return {
    application: {
      id: entry.id,
      company,
      title,
      applyUrl: wizardUrl(entry.id),
      sourceUrl: entry.link,
      jd,
      resume: generated.resumeBlob,
      resumeName: generated.resumeName,
      resumeText: generated.resumeText,
      letter: generated.letterBlob,
      letterName: generated.letterName,
      letterText: generated.letterText,
      currentRole: generated.resume?.experience?.[0]?.role ?? "",
      currentCompany: generated.resume?.experience?.[0]?.company ?? "",
      education: educationFrom(profile),
    },
  };
}

/* ------------------------------------------------------------- answers */

function answerContext(application, profile) {
  return {
    company: application.company,
    title: application.title,
    jd: application.jd,
    letter: application.letterText ?? "",
    resume: application.resumeText ?? "",
    masterResume: profile.masterResume,
    currentRole: application.currentRole ?? "",
    currentCompany: application.currentCompany ?? "",
    education: application.education ?? educationFrom(profile),
    location: [profile.city, profile.state].filter(Boolean).join(", "),
    remotePreference: profile.remotePreference,
    startDate: profile.startDate,
    workAuthorization: AUTHORIZATION_WORDS[profile.workAuthorization] ?? "",
    sponsorship: profile.requiresSponsorship === "yes" ? "will need sponsorship" : "does not need sponsorship, now or in the future",
    relocation: profile.willingToRelocate === "yes" ? "willing to relocate" : "not willing to relocate; works remotely",
    travel: profile.willingToTravel === "no" ? "not able to travel" : "able to travel when the role requires it",
    salary: profile.salaryFallback ? `about $${Number(profile.salaryFallback).toLocaleString("en-US")} a year, or the midpoint of the posted range` : "",
    phone: profile.phone,
    email: profile.email,
    extraFacts: [
      `Hands-on experience with every language, framework, database and tool named in the job description: about ${Number(profile.techYears) || 8} years each, used most recently in the latest role${application.currentRole ? ` (${application.currentRole}${application.currentCompany ? ` at ${application.currentCompany}` : ""})` : ""}.`,
      "Can work standard US business hours in any US time zone, keeps the camera on in meetings, and works from a quiet, distraction-free home office.",
    ],
  };
}

/**
 * What to put in one of the wizard's questions.
 *
 * Dice's own two - work authorization and city of residence - are answered
 * from the profile in Dice's words. Anything an employer added goes through
 * the same rules the other bots use, and what the rules cannot place goes
 * to the model with the facts about the person.
 */
async function answerFor(field, profile, context) {
  const subject = `${field.label} ${field.name ?? ""} ${field.hint ?? ""}`.toLowerCase();

  if (/work ?authorization|workauthorization/.test(subject) && (field.options.length > 0 || field.type === "select")) {
    const wanted = DICE_AUTHORIZATION[profile.workAuthorization] ?? ["Prefer Not to Answer"];
    return { value: wanted[0], candidates: [...wanted, "Prefer Not to Answer"], rule: "dice-authorization" };
  }
  if (/city of residence|current (?:city|location)|candidatelocation|\blocation\b|where (?:do you|are you) (?:live|located|based)/.test(subject) && (field.combobox || field.type === "text")) {
    const city = String(profile.city ?? "").trim();
    const code = stateCode(profile.state);
    return { value: `${city}, ${code}`, candidates: [`${city}, ${code}`, `${city}, ${code}, USA`, city, String(profile.zip ?? "").trim()].filter(Boolean), rule: "dice-location" };
  }

  const resolved = resolveField({ ...field, key: field.key }, profile, context);
  if (resolved.outcome === "fill") return { value: resolved.value, candidates: resolved.candidates ?? [resolved.value], rule: resolved.rule };
  if (resolved.outcome === "skip" || resolved.outcome === "ignore" || resolved.outcome === "attach") return { skip: resolved.reason ?? "nothing to put here" };
  if (resolved.outcome === "blocked" && !field.required) return { skip: resolved.reason };

  // Unmatched, or matched with nothing behind it: the model decides from
  // the facts, and must decide when the form will not go without it.
  const answer = await answerQuestion(
    { question: field.label, options: field.options, multiline: field.multiline },
    context,
    { provider: profile.provider, apiKey: profile.apiKey, model: profile.model },
    { must: Boolean(field.required) },
  );
  if (answer === null || answer === undefined || answer === "") return { skip: "the model had nothing to say for an optional question" };
  return { value: answer, candidates: [answer], rule: "model", judged: true };
}

/* ---------------------------------------------------------- the wizard */

/**
 * One application, from the wizard's first step to its last.
 *
 * A loop over what the page says it is, not a script of three steps in
 * order: the second step is missing on postings whose employer asked
 * nothing, and the review page is where a dry run stops.
 */
async function runOne(application, profile) {
  const startedAt = Date.now();
  const label = `${application.company} - ${application.title}`;
  const answers = [];
  const detail = { filled: 0, attachments: [], answers };
  const result = (status, reason, extra = {}) => ({
    id: application.id,
    company: application.company,
    title: application.title,
    applyUrl: application.applyUrl,
    sourceUrl: application.sourceUrl,
    status,
    reason,
    detail: { ...detail, ...extra },
    at: startedAt,
    took: Date.now() - startedAt,
  });

  return atFront(async () => {
    const tabId = await openInFront(application.applyUrl);
    const handOver = (status, reason, extra = {}) => {
      const outcome = result(status, reason, { ...extra, tabOpen: true });
      leftOpen(tabId, outcome);
      return outcome;
    };

    try {
      const seen = [];
      for (let turn = 0; turn < 8; turn += 1) {
        const page = await wizardState(tabId);
        seen.push(page.step);
        if (page.errors?.length > 0) log("info", `${label} - the page says: ${page.errors.join("; ")}`);

        switch (page.step) {
          case "signin":
            throw new SignInNeeded(tabId);

          case "applied":
            await closeTab(tabId);
            return result("skipped", "already applied to on Dice");

          case "gone":
            await closeTab(tabId);
            return result("skipped", "the posting is no longer taking applications");

          case "resume": {
            const resume = await inPage(tabId, "attach", { which: "resume", name: application.resumeName, type: "application/pdf", base64: await blobBase64(application.resume) });
            if (!resume?.ok) return handOver("failed", `the resume could not be attached: ${resume?.error ?? "no answer from the page"}`);
            detail.attachments.push(application.resumeName);
            log("info", `${label} - resume attached${resume.already ? " (was already there)" : ""}`);

            if (profile.attachCoverLetter !== false && application.letter) {
              const letter = await inPage(tabId, "attach", { which: "cover", name: application.letterName, type: "application/pdf", base64: await blobBase64(application.letter) });
              if (letter?.ok) {
                detail.attachments.push(application.letterName);
                log("info", `${label} - cover letter attached`);
              } else {
                log("warn", `${label} - the cover letter was not attached (${letter?.error ?? "no answer"}); it is optional, going on without it`);
              }
            }

            const next = await inPage(tabId, "press", { label: "Next" });
            if (!next?.ok) return handOver("failed", `Next did not move past the resume step${next?.errors?.length ? `: ${next.errors.join("; ")}` : next?.error ? `: ${next.error}` : ""}`);
            break;
          }

          case "questions": {
            const fields = (await inPage(tabId, "fields")) ?? [];
            log("info", `${label} - ${fields.length} question(s) on the additional information step`, fields.map((field) => `${field.label}${field.required ? " *" : ""}`));
            const context = answerContext(application, profile);
            const unanswered = [];
            for (const field of fields) {
              let answer;
              try {
                answer = await answerFor(field, profile, context);
              } catch (error) {
                if (error instanceof AiError && error.fatal) throw error;
                answer = { skip: `the model could not answer: ${error?.message ?? error}` };
              }
              if (answer.skip) {
                if (field.required && !field.current) unanswered.push(`"${field.label}" (${answer.skip})`);
                else log("info", `${label} - "${field.label}" left as is: ${answer.skip}`);
                continue;
              }
              const placed = await inPage(tabId, "fill", { key: field.key, value: answer.value, candidates: answer.candidates });
              if (placed?.ok) {
                detail.filled += 1;
                answers.push({ question: field.label, answer: placed.chosen ?? answer.value, rule: answer.rule });
                log(answer.judged ? "warn" : "info", `${label} - "${field.label}" -> ${placed.chosen ?? answer.value}${answer.judged ? " (the model's judgement)" : ""}`);
              } else {
                const message = `"${field.label}" could not be set to "${answer.value}": ${placed?.error ?? "no answer from the page"}`;
                if (field.required && !field.current) unanswered.push(message);
                else log("warn", `${label} - ${message}`);
              }
            }
            if (unanswered.length > 0) return handOver("failed", `required question(s) left unanswered: ${unanswered.join("; ")}`);

            const next = await inPage(tabId, "press", { label: "Next" });
            if (!next?.ok) return handOver("failed", `Next did not move past the questions${next?.errors?.length ? `: ${next.errors.join("; ")}` : next?.error ? `: ${next.error}` : ""}`);
            break;
          }

          case "review": {
            const review = await inPage(tabId, "review");
            detail.review = review?.text?.slice(0, 600);
            if (profile.dryRun) return handOver("dry-run", "dry run: filled through to the review step and left open, nothing sent");
            if (!review?.hasSubmit) return handOver("failed", "the review step has no Submit button");

            const submitted = await inPage(tabId, "press", { label: "Submit" });
            if (!submitted?.ok) return handOver("failed", `Submit did not go through${submitted?.errors?.length ? `: ${submitted.errors.join("; ")}` : submitted?.error ? `: ${submitted.error}` : ""}`);
            const after = await wizardState(tabId, 15000);
            detail.boardSaid = after.text?.slice(0, 300);
            if (after.step === "done") {
              log("ok", `${label} - submitted`);
              return { ...result("submitted", ""), tabId };
            }
            if (after.step === "review" || after.step === "questions" || after.step === "resume") {
              return handOver("failed", `after Submit the page went back to the ${after.step} step${after.errors?.length ? `: ${after.errors.join("; ")}` : ""}`);
            }
            // The page moved somewhere this bot does not recognise. The
            // application very likely went. Record that uncertainty, but
            // close the completed wizard just like a recognised confirmation.
            return {
              ...result("unconfirmed", `Submit was pressed and the page moved on, but no confirmation was recognised (it says: ${after.heading || after.text?.slice(0, 120)})`),
              tabId,
            };
          }

          case "done":
            log("ok", `${label} - submitted`);
            return { ...result("submitted", ""), tabId };

          default:
            if (seen.length >= 3 && seen.slice(-3).every((step) => step === "unknown")) {
              return handOver("failed", `the wizard page could not be read (it says: ${page.heading || page.text?.slice(0, 120)})`);
            }
            await wait(1500);
        }
      }
      return handOver("failed", "the wizard did not reach a confirmation after eight steps");
    } catch (error) {
      if (error instanceof SignInNeeded) throw error;
      // Whatever broke, the tab stays as it stands for the person to finish.
      const outcome = result("failed", error?.message ?? String(error), { tabOpen: true });
      leftOpen(tabId, outcome);
      return outcome;
    }
  });
}

async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
}

/* -------------------------------------------------------------- record */

async function archive(application, profile, result, confirmedTabId, { root = "applied" } = {}) {
  const folder = applicationFolder(application, root, new Date(), profile);
  const files = [];

  if (application.resume) {
    await save(`${folder}/${application.resumeName}`, application.resume, { type: "application/pdf" });
    files.push(application.resumeName);
  }
  if (application.letter) {
    await save(`${folder}/${application.letterName}`, application.letter, { type: "application/pdf" });
    files.push(application.letterName);
  }
  if (application.letterText) {
    await save(`${folder}/Cover letter.txt`, application.letterText, { type: "text/plain" });
    files.push("Cover letter.txt");
  }
  if (result.detail?.answers?.length > 0) {
    const lines = [
      `${application.company}${application.title ? ` - ${application.title}` : ""}`,
      `Job: ${application.sourceUrl}`,
      "",
      ...result.detail.answers.flatMap((entry) => [`Q: ${entry.question}`, `A: ${entry.answer}`, ""]),
    ];
    await save(`${folder}/Answers.txt`, lines.join("\n"), { type: "text/plain" });
    files.push("Answers.txt");
  }
  if (root === MANUAL_ROOT) {
    const note = [
      `${application.company}${application.title ? ` - ${application.title}` : ""}`,
      `Apply here: ${application.applyUrl}`,
      `Posting: ${application.sourceUrl}`,
      `Why by hand: ${result.reason || result.status}.`,
      `Written: ${new Date().toLocaleString()}`,
    ];
    await save(`${folder}/Job link.txt`, note.join("\n"), { type: "text/plain" });
    files.push("Job link.txt");
  }

  let confirmationUrl = "";
  if (confirmedTabId) {
    const tab = await chrome.tabs.get(confirmedTabId).catch(() => null);
    confirmationUrl = tab?.url ?? "";
    const lines = [
      `Application submitted - ${application.company}${application.title ? ` - ${application.title}` : ""}`,
      `Confirmation page: ${confirmationUrl}`,
      `Job: ${application.sourceUrl}`,
      `Applicant: ${profile.email}   Captured: ${new Date().toLocaleString()}`,
    ];
    if (result.detail?.boardSaid) lines.push(`Dice said: "${result.detail.boardSaid.slice(0, 160)}"`);
    try {
      const picture = await captureEvidence(confirmedTabId, { lines });
      const shot = `Screenshot from ${stamp()}.png`;
      await save(`${folder}/${shot}`, picture, { type: "image/png" });
      files.push(shot);
    } catch (error) {
      log("warn", `${application.company} - the confirmation could not be photographed: ${error?.message ?? error}`);
    }
  }

  await saveJson(`${folder}/application.json`, {
    company: application.company,
    title: application.title,
    status: result.status,
    reason: result.reason || undefined,
    jobUrl: application.sourceUrl,
    applyUrl: application.applyUrl,
    confirmationUrl: confirmationUrl || undefined,
    applicant: { name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.email },
    startedAt: new Date(result.at).toISOString(),
    finishedAt: new Date().toISOString(),
    secondsTaken: Math.round((Date.now() - result.at) / 1000),
    questionsAnswered: result.detail?.filled,
    attachments: result.detail?.attachments,
    review: result.detail?.review || undefined,
    files,
  }, { overwrite: true });
  return folder;
}

function appliedJobsText(rows) {
  const sent = rows.filter((row) => row.status === "submitted" || row.status === "unconfirmed").sort((a, b) => a.at - b.at);
  return sent.map((row) => `${new Date(row.at).toISOString().slice(0, 10)}  ${row.company}${row.title ? ` - ${row.title}` : ""}  ${row.sourceUrl || row.applyUrl}`).join("\n");
}

async function keep(path, content, options) {
  try {
    await save(path, content, options);
  } catch (error) {
    log("warn", `Could not write ${path}: ${error?.message ?? error}`);
  }
}

async function keepOtherLinks(profile, manual, at = Date.now()) {
  const rows = manual.filter((entry) => new Date(entry.at).toDateString() === new Date(at).toDateString());
  if (rows.length === 0) return;
  await keep(otherLinksPath(new Date(at), profile), otherLinksCsv(rows), { overwrite: true, type: "text/csv" });
}

/* ----------------------------------------------------------- the queue */

const stopsTheRun = (error) =>
  error instanceof SignInNeeded ||
  (error instanceof AiError && error.fatal) ||
  (error instanceof WriterError && [401, 402, 403].includes(error.status));

/** Skipped and failed postings are left alone for this long before being tried again. */
const PASS_DAYS = 7;

/** How many postings are read and written ahead of the one being sent. */
const AHEAD = 2;

let runAgain = false;
async function run() {
  if (state.running) {
    if (state.stopping) runAgain = true;
    return;
  }
  state.log = [];
  log("info", `Dice apply bot ${chrome.runtime.getManifest().version}.`);
  resetSpend();

  const profile = await readProfile();
  const gaps = missingFromProfile(profile);
  if (gaps.length > 0) {
    log("error", `The profile is incomplete: ${gaps.join("; ")}. Fill it in on the options page first.`);
    return;
  }

  const loaded = (await allLinks()).links;
  if (loaded.length === 0) {
    log("error", "No jobs to run: paste some Dice links in settings and press Load links.");
    return;
  }
  const writer = checkWriter(profile);
  if (!writer.ok) {
    log("error", writer.error);
    return;
  }
  log("info", `Writing each resume with ${writer.provider} ${writer.model}; the employers on it are the ${profile.experience.filter((row) => String(row?.company ?? "").trim()).length} from the profile.`);
  if (slackConfigured(profile)) log("info", `Slack: a message to ${profile.slackChannel} for each job that needs you, and one when the run ends.`);

  const stored = await chrome.storage.local.get(["submitted", "elsewhere", "passed", "manual"]);
  const sent = new Set(stored.submitted ?? []);
  let manual = Array.isArray(stored.manual) ? [...stored.manual] : [];
  const recorded = await allResults();
  const elsewhere = new Set(stored.elsewhere ?? []);
  const passed = stored.passed && typeof stored.passed === "object" ? { ...stored.passed } : {};

  // Versions before 1.0.1 could mistake the cover-letter input for the
  // resume input when Dice already showed a profile resume. Those jobs were
  // marked manual even though the generated resume was never put in the
  // Resume card. Release them automatically so the corrected uploader can
  // retry them instead of treating them as already handled.
  const uploadBug = new Set(
    recorded
      .filter((row) => row.status === "manual" && /resume box did not show/i.test(String(row.reason ?? "")))
      .map((row) => row.id)
      .filter(Boolean),
  );
  if (uploadBug.size > 0) {
    for (const id of uploadBug) {
      elsewhere.delete(id);
      delete passed[id];
    }
    manual = manual.filter((row) => !uploadBug.has(row.id));
    await chrome.storage.local.set({ elsewhere: [...elsewhere], passed, manual });
    log("info", `Retrying ${uploadBug.size} application${uploadBug.size === 1 ? "" : "s"} held by the previous resume-upload bug.`);
  }

  const counted = recorded.filter(
    (row) => row.status === "submitted" || row.status === "unconfirmed" || (row.status === "manual" && !uploadBug.has(row.id)),
  );
  const applied = new Set(counted.map((row) => jobKey(row.company, row.title)).filter(Boolean));
  const companies = new Set(counted.map((row) => companyKey(row.company)).filter(Boolean));
  if (applied.size > 0) await keep(historyPath(profile, "applied-jobs.txt"), appliedJobsText(recorded), { overwrite: true });
  const resting = (id) => passed[id] && Date.now() - passed[id] < PASS_DAYS * 86400000;

  // Chrome ends a worker that goes thirty seconds without an extension API
  // call, and writing a resume takes longer than that.
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);

  state.running = true;
  state.stopping = false;
  state.total = 0;
  state.done = 0;
  remember();

  log("info", profile.dryRun ? "Dry run - every application is filled through to the review step and left open; nothing is sent." : "Live - applications will be submitted on Dice; what cannot be sent is left open in its tab for you.");

  const runStamp = stamp();
  const seenThisRun = new Set();
  const tally = { sent: 0, failed: 0, skipped: 0, waiting: [] };

  const tell = async (result, kind = "finish") => {
    tally.waiting.push({ company: result.company, title: result.title, applyUrl: result.applyUrl, kind });
    if (!slackConfigured(profile)) return;
    const message = needsYouMessage({
      kind,
      company: result.company,
      title: result.title,
      reason: result.reason,
      applyUrl: result.applyUrl,
      sourceUrl: result.sourceUrl,
      folder: result.detail?.folder ?? "",
      tabOpen: Boolean(result.detail?.tabOpen),
      applicant: `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim(),
    });
    const posted = await postSlack(profile, message);
    if (posted.ok) log("info", `${result.company || result.applyUrl} - told in Slack`);
    else log("warn", `${result.company || result.applyUrl} - could not tell Slack: ${posted.error}`);
  };

  const fresh = loaded.filter((entry) => !(sent.has(entry.id) || elsewhere.has(entry.id) || resting(entry.id)));
  log("info", `${loaded.length} link(s) loaded in settings; ${fresh.length} new to work through.`);
  await keep(
    `${dayRoot(profile)}/links/${stamp()} loaded.txt`,
    [
      `${loaded.length} Dice link(s) loaded, ${fresh.length} to work through`,
      "",
      ...loaded.map((entry) => `${fresh.includes(entry) ? "TODO " : sent.has(entry.id) ? "SENT " : elsewhere.has(entry.id) ? "ELSEWHERE " : "RESTING "}${entry.link}`),
    ].join("\n"),
  );

  const passOver = async (id) => {
    if (!elsewhere.has(id)) {
      passed[id] = Date.now();
      await chrome.storage.local.set({ passed });
    }
  };

  const prepare = async (entry) => {
    seenThisRun.add(entry.id);
    log("info", `Opening ${entry.link}`);
    const started = Date.now();
    try {
      const prepared = await prepareLink(entry, profile, { applied, companies });
      if (prepared.skip) {
        if (prepared.manual) {
          elsewhere.add(entry.id);
          await chrome.storage.local.set({ elsewhere: [...elsewhere] });
          manual.push({ id: entry.id, company: prepared.company, title: prepared.title, applyUrl: prepared.applyUrl || entry.link, sourceUrl: entry.link, folder: "", reason: prepared.skip, at: started });
          await chrome.storage.local.set({ manual });
          await keepOtherLinks(profile, manual, started);
        } else if (prepared.elsewhere || prepared.applied) {
          elsewhere.add(entry.id);
          await chrome.storage.local.set({ elsewhere: [...elsewhere] });
        }
        return { application: null, result: { id: entry.id, company: prepared.company ?? "", title: prepared.title ?? "", applyUrl: entry.link, sourceUrl: entry.link, status: "skipped", reason: prepared.skip, detail: null, at: started, took: Date.now() - started } };
      }
      return { application: prepared.application, result: null, started };
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      return { application: null, result: { id: entry.id, company: "", title: "", applyUrl: entry.link, sourceUrl: entry.link, status: "failed", reason: error?.message ?? String(error), detail: null, at: started, took: Date.now() - started } };
    }
  };

  const workOne = async (entry, prepared) => {
    const application = prepared.application;
    let result = prepared.result;

    if (!result && (applied.has(jobKey(application.company, application.title)) || companies.has(companyKey(application.company)))) {
      const started = prepared.started ?? Date.now();
      result = { id: entry.id, company: application.company, title: application.title, applyUrl: application.applyUrl, sourceUrl: entry.link, status: "skipped", reason: "already applied to, reached earlier by another link", detail: null, at: started, took: Date.now() - started };
    }

    if (!result) {
      result = await runOne(application, profile);
      if (result.status === "submitted" || result.status === "unconfirmed") {
        try {
          result.detail.folder = await archive(application, profile, result, result.tabId);
        } catch (error) {
          log("warn", `${application.company} - could not write the application folder: ${error?.message ?? error}`);
        }
        if (result.tabId) await closeTab(result.tabId);
        delete result.tabId;
      } else if (result.status === "dry-run") {
        try {
          result.detail.folder = await archive(application, profile, result, null, { root: MANUAL_ROOT });
        } catch (error) {
          log("warn", `${application.company} - could not write the folder: ${error?.message ?? error}`);
        }
      } else if (result.status === "failed") {
        // Written and filled but not sent: saved for sending by hand, the
        // tab left open where it stopped.
        const why = result.reason;
        const handed = { ...result, status: "manual", reason: `could not be sent (${why}); left open and saved for you to send by hand`, detail: { ...(result.detail ?? {}), handoff: true, failed: why } };
        try {
          handed.detail.folder = await archive(application, profile, handed, null, { root: MANUAL_ROOT });
          log("warn", `${application.company} - could not be sent: ${why}. Saved to Downloads/job applied-folder/${handed.detail.folder} for you to send by hand.`);
        } catch (error) {
          log("warn", `${application.company} - could not write the manual application folder: ${error?.message ?? error}`);
        }
        result = handed;
      }
    }
    await recordResult(result);
    state.done += 1;

    const level = result.status === "failed" ? "error" : result.status === "skipped" || result.status === "unconfirmed" || result.status === "dry-run" || result.detail?.failed ? "warn" : "ok";
    const label = result.company || result.applyUrl;
    log(level, `${label}: ${result.status}${result.reason ? ` - ${result.reason}` : ""}${result.detail?.tabOpen ? " (the tab is left open for you)" : ""}`);

    if (result.status === "manual") {
      const named = jobKey(result.company, result.title);
      if (named) applied.add(named);
      const place = companyKey(result.company);
      if (place) companies.add(place);
      if (result.detail?.handoff && !manual.some((row) => row.id === entry.id)) {
        elsewhere.add(entry.id);
        await chrome.storage.local.set({ elsewhere: [...elsewhere] });
        manual.push({ id: entry.id, company: result.company, title: result.title, applyUrl: result.applyUrl, sourceUrl: result.sourceUrl, folder: result.detail.folder ?? "", reason: result.reason, at: result.at });
        await chrome.storage.local.set({ manual });
        await keepOtherLinks(profile, manual, result.at);
      }
      await tell(result);
    } else if (result.status === "submitted") tally.sent += 1;
    else if (result.status === "unconfirmed") {
      tally.sent += 1;
      if (result.detail?.tabOpen) await tell(result, "check");
    } else if (result.status === "failed") tally.failed += 1;
    else if (result.status === "skipped") tally.skipped += 1;

    if (result.status === "submitted" || result.status === "unconfirmed") {
      sent.add(result.id);
      const named = jobKey(result.company, result.title);
      if (named) applied.add(named);
      const place = companyKey(result.company);
      if (place) companies.add(place);
      await chrome.storage.local.set({ submitted: [...sent] });
      await keep(historyPath(profile, "applied-links.txt"), [...sent].map(postingUrl).join("\n"), { overwrite: true });
      await keep(historyPath(profile, "applied-jobs.txt"), appliedJobsText(await allResults()), { overwrite: true });
    } else if (result.status === "skipped" || result.status === "failed" || result.status === "dry-run") {
      await passOver(entry.id);
    }

    await keep(historyPath(profile, "applications.csv"), resultsCsv(await allResults()), { overwrite: true, type: "text/csv" });
    await keep(historyPath(profile, `runs/${runStamp}.txt`), logText(state.log), { overwrite: true });

    if (profile.maxPerRun > 0 && state.done >= profile.maxPerRun) {
      log("info", `Stopping after ${state.done}, the ceiling set in settings.`);
      return false;
    }
    if (profile.delayMs > 0) await wait(profile.delayMs);
    return true;
  };

  try {
    if (fresh.length > 0) {
      state.total += fresh.length;
      remember();

      // A pipeline: the next postings are read and written while this one
      // is being sent. Sending stays one at a time and in order.
      const queue = [...fresh];
      const inFlight = [];
      const topUp = () => {
        while (inFlight.length < AHEAD && queue.length > 0 && !state.stopping) {
          const next = queue.shift();
          const promise = prepare(next);
          promise.catch(() => {});
          inFlight.push({ entry: next, promise });
        }
      };
      topUp();
      while (inFlight.length > 0 && !state.stopping) {
        topUp();
        const first = inFlight[0];
        inFlight.shift();
        const prepared = await first.promise;
        if (state.stopping) break;
        const going = await workOne(first.entry, prepared);
        if (!going) break;
      }
    } else {
      log("info", "Nothing new on the list: everything on it was sent, listed or passed over before.");
    }
    if (state.stopping) log("info", "Stopped.");
  } catch (error) {
    if (error instanceof SignInNeeded) {
      log("error", error.message);
      leftOpen(error.tabId, { company: "Dice", title: "sign in", applyUrl: "https://www.dice.com/dashboard/login", reason: "sign in to Dice here, then press Run again" });
    } else log("error", `Stopping: ${error?.message ?? error}`);
  } finally {
    clearInterval(heartbeat);
    state.running = false;
    const total = runTotal();
    log("info", `Finished ${state.done} of ${state.total}.${total.calls > 0 ? ` Model spend this run: ${describeSpend(null, total)}.` : ""}`);
    if (tally.waiting.length > 0) log("info", `${tally.waiting.length} job(s) waiting for you: ${tally.waiting.map((job) => job.company || job.applyUrl).join(", ")}.`);
    remember();
    await keep(historyPath(profile, `runs/${runStamp}.txt`), logText(state.log), { overwrite: true });
    if (slackConfigured(profile) && state.done > 0) {
      const summary = await postSlack(profile, runSummaryMessage({ ...tally, applicant: `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim(), stopped: state.stopping }));
      if (!summary.ok) log("warn", `Could not send the run summary to Slack: ${summary.error}`);
    }
    if (runAgain) {
      runAgain = false;
      setTimeout(run, 0);
    }
  }
}

/* ------------------------------------------------------------- messages */

/** The wizard or posting under the active tab, read the way the run reads it. */
async function probeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  if (!/dice\.com/i.test(tab.url ?? "")) throw new Error("the active tab is not on dice.com");
  if (/\/job-applications\//i.test(tab.url ?? "")) {
    const page = await inPage(tab.id, "state");
    const fields = page.step === "questions" ? await inPage(tab.id, "fields") : [];
    return { kind: "wizard", page, fields };
  }
  const posting = await inPage(tab.id, "posting");
  return { kind: "posting", posting: { ...posting, description: `${posting.description.slice(0, 400)}... (${posting.description.length} characters)` } };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "run") {
    run();
    respond({ started: true });
    return false;
  }
  if (message?.type === "stop") {
    state.stopping = true;
    respond({ stopping: true });
    return false;
  }
  if (message?.type === "state") {
    restored.then(async () => respond({ running: state.running, total: state.total, done: state.done, log: state.log, openForYou: await tabsLeftOpen() }));
    return true;
  }
  if (message?.type === "slackTest") {
    readProfile()
      .then((profile) => {
        const applicant = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim();
        return postSlack(profile, `:white_check_mark: Dice Apply Bot can reach this channel${applicant ? ` for ${mrkdwn(applicant)}` : ""}. Jobs that need you will be posted here.`);
      })
      .then((result) => respond(result), (error) => respond({ ok: false, error: error?.message ?? String(error) }));
    return true;
  }
  if (message?.type === "focusTab") {
    focus(message.tabId).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (message?.type === "probe") {
    probeActiveTab().then(
      (report) => respond({ ok: true, report }),
      (error) => respond({ ok: false, error: error?.message ?? String(error) }),
    );
    return true;
  }
  return false;
});
