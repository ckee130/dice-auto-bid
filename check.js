/**
 * Checks the bot against the pages it will actually meet.
 *
 * The fixtures are not markup anyone wrote for a test. They are the rendered
 * posting and wizard steps captured out of Chrome from live Dice pages, with
 * the scripts and styles stripped, which matters because every mistake worth
 * catching here comes from assuming what that markup looks like.
 *
 * Run with: node dice-apply-bot/check.js
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser, parseHTML } from "linkedom";

import { buildQueue, canonicalUrl, diceJobId, extractLinks, postingUrl, wizardUrl } from "./src/links.js";
import { DEFAULT_PROFILE, experiencePeriods, missingFromProfile, withDefaults } from "./src/profile.js";
import { checkWriter, defaultResumePrompt, slotsFrom, themeFrom, withPinnedEmployers } from "./src/writer.js";
import { stateCode } from "./src/answers.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${passed || !detail ? "" : `  -> ${detail}`}`);
  if (!passed) failures += 1;
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------- the DOM */

/**
 * Runs the real dice.js over a fixture. The page functions are written for
 * Chrome; what linkedom lacks is shimmed with the dullest possible answer,
 * so the checks stand or fall on the markup rather than on the shim.
 */
async function onPage(fixture, href, action, args = {}, prepare = null) {
  const html = readFileSync(join(HERE, "fixtures", fixture), "utf8");
  const { window, document } = parseHTML(html);
  if (prepare) prepare(document);

  for (const element of document.querySelectorAll("*")) {
    element.getBoundingClientRect = () => ({ width: 100, height: 20 });
  }

  const context = createContext({
    window,
    document,
    location: { href },
    // linkedom's Node carries no position constants; the DOM's values.
    Node: { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
    Element: window.Element,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    MouseEvent: window.Event,
    KeyboardEvent: window.Event,
    InputEvent: window.Event,
    DOMParser,
    CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout,
    console,
    JSON,
    Object,
    String,
    RegExp,
    Array,
    Promise,
  });
  context.window = context;

  const source = readFileSync(join(HERE, "src/dice.js"), "utf8").replace(/^export async function dicePage/m, "async function dicePage");
  runInContext(`${source}\nglobalThis.__dicePage = dicePage;`, context);
  return runInContext(`__dicePage(${JSON.stringify(action)}, ${JSON.stringify(args)})`, context);
}

/* --------------------------------------------------------------- links */

section("Links");
{
  const id = "283b6967-55ec-4a1f-bbae-255573e24946";
  check("reads the id off a job-detail link", diceJobId(`https://www.dice.com/job-detail/${id}`) === id);
  check("reads the id off a link with tracking", diceJobId(`https://www.dice.com/job-detail/${id}?utm_source=x&searchlink=search%2F`) === id);
  check("reads the id off the wizard link", diceJobId(`https://www.dice.com/job-applications/${id}/wizard`) === id);
  check("reads the id off a slugged link", diceJobId(`https://www.dice.com/jobs/detail/Software-Engineer-Acme/${id}`) === id);
  check("refuses a link that is not Dice", diceJobId("https://jobs.lever.co/acme/" + id) === "");
  check("refuses a Dice link with no id", diceJobId("https://www.dice.com/jobs?q=engineer") === "");
  check("canonical form is the posting page", canonicalUrl(`https://dice.com/job-applications/${id}/wizard`) === postingUrl(id));
  check("the wizard address is the posting's button target", wizardUrl(id) === `https://www.dice.com/job-applications/${id}/wizard`);

  const pasted = `https://www.dice.com/job-detail/${id}\nhttps://www.dice.com/job-detail/${id}?x=1, https://www.dice.com/job-detail/a946de63-df82-4c43-b6b0-dcdda01b2951\nhttps://jobs.lever.co/acme/1`;
  check("finds links wherever they sit in the paste", extractLinks(pasted).length === 4);
  const { queue, rejected } = buildQueue([pasted]);
  check("repeats are one job", queue.length === 2, String(queue.length));
  check("keeps the order pasted", queue[0].id === id);
  check("a link off Dice is set aside with a reason", rejected.length === 1 && /not a Dice/.test(rejected[0].reason));
}

/* ------------------------------------------------------------- profile */

section("Profile");
{
  const rows = [
    { company: "Acme", from: "2022-01", to: "" },
    { company: "", from: "2020-01", to: "2021-12" },
    { company: "Globex", from: "2017-06", to: "2019-12" },
    { company: "Initech", from: "2016-01", to: "2015-01" },
  ];
  const periods = experiencePeriods({ experience: rows });
  check("a job needs a company to be on the resume", periods.length === 2 && periods.every((row) => row.company), JSON.stringify(periods));
  check("newest first", periods[0].company === "Acme");
  check("an end before the start is left out", !periods.some((row) => row.company === "Initech"));

  const gaps = missingFromProfile(withDefaults({ ...DEFAULT_PROFILE }));
  check("the default profile still needs company names before it runs", gaps.some((gap) => /company name/.test(gap)), gaps.join("; "));
  check("the default profile has no API key baked in", gaps.some((gap) => /API key/.test(gap)) && !withDefaults({}).apiKey, gaps.join("; "));
  const named = missingFromProfile(withDefaults({ ...DEFAULT_PROFILE, apiKey: "sk-ant-api03-test", experience: [{ company: "Acme", from: "2022-01", to: "" }] }));
  check("with a company named and a key entered the profile is complete", named.length === 0, named.join("; "));
  check("the writer refuses to run without a key", !checkWriter(withDefaults({})).ok && /no anthropic key/i.test(checkWriter(withDefaults({})).error), checkWriter(withDefaults({})).error);
  check("an entered Anthropic key is accepted", checkWriter(withDefaults({ apiKey: "sk-ant-api03-test" })).ok, checkWriter(withDefaults({ apiKey: "sk-ant-api03-test" })).error);
  check("the state is given to Dice as its code", stateCode("Texas") === "TX" && stateCode("tx") === "TX" && stateCode("TX") === "TX");
}

/* -------------------------------------------------------------- writer */

section("Writer");
{
  const profile = withDefaults({ experience: [{ company: "Acme Corp", location: "Austin, Texas", from: "2022-01", to: "" }, { company: "Globex", location: "Boston, Massachusetts", from: "2019-03", to: "2021-12" }] });
  const slots = slotsFrom(profile);
  check("each slot carries the employer from the profile", slots.map((slot) => slot.company).join("|") === "Acme Corp|Globex");
  check("and the months as the resume prints them", slots[0].startDate === "Jan 2022" && slots[0].endDate === "Present" && slots[1].endDate === "Dec 2021");
  check("each slot carries its entered company location", slots.map((slot) => slot.location).join("|") === "Austin, Texas|Boston, Massachusetts");
  const drafted = {
    experience: [
      { company: "ACME Corporation", startDate: "Jan 2022", endDate: "Present", role: "Engineer", bullets: [] },
      { company: "Globex Inc", startDate: "Mar 2019", endDate: "Dec 2021", role: "Engineer", bullets: [] },
    ],
  };
  const pinned = withPinnedEmployers(drafted, slots);
  check("the model's spelling of the employer is replaced with the profile's", pinned.experience.map((role) => role.company).join("|") === "Acme Corp|Globex");
  check("the model's location is replaced with the entered company location", pinned.experience[0].location === "Austin, Texas");
  check("the role and bullets are the model's", pinned.experience[0].role === "Engineer");
  check("the current embedded prompt is available for editing", /elite Principal Technical Recruiter/.test(defaultResumePrompt(profile)));
  check("resume documents always use Calibri", themeFrom({ ...profile, fontFamily: "Georgia" }).fontFamily === "Calibri");
}

/* ------------------------------------------------------------- posting */

section("The posting page");
{
  const posting = await onPage("posting.html", "https://www.dice.com/job-detail/a946de63-df82-4c43-b6b0-dcdda01b2951", "posting");
  check("the structured block is found", posting.ready && !posting.gone);
  check("the title", posting.title === "Senior Mobile Software Engineer", posting.title);
  check("the company", posting.company === "Apex Systems", posting.company);
  check("the description is read as text, not markup", posting.description.length > 2000 && !/<[a-z]+>/i.test(posting.description), String(posting.description.length));
  check("the button is Easy Apply, leading to the wizard", posting.apply.kind === "easy" && /\/job-applications\/a946de63-df82-4c43-b6b0-dcdda01b2951\/wizard/.test(posting.apply.href), JSON.stringify(posting.apply));
  check("the page is seen as signed in", posting.signedIn === true);
}

/* -------------------------------------------------------------- wizard */

section("The wizard");
{
  const first = await onPage("wizard-step1.html", "https://www.dice.com/job-applications/a946de63-df82-4c43-b6b0-dcdda01b2951/wizard", "state");
  check("step 1 is the resume step", first.step === "resume", `${first.step} / ${first.heading}`);
  check("with its step label", first.stepLabel === "Step 1 of 3", first.stepLabel);
  const uploadTargets = await onPage("wizard-step1.html", "https://www.dice.com/job-applications/a946de63-df82-4c43-b6b0-dcdda01b2951/wizard", "uploadTargets");
  check("the resume and cover-letter inputs are kept separate", /resume/i.test(uploadTargets.resume?.describedBy) && /cover/i.test(uploadTargets.cover?.describedBy), JSON.stringify(uploadTargets));
  const withSavedResume = await onPage(
    "wizard-step1.html",
    "https://www.dice.com/job-applications/a946de63-df82-4c43-b6b0-dcdda01b2951/wizard",
    "uploadTargets",
    {},
    (document) => document.querySelector('input[type=file][aria-describedby*="resume"]')?.remove(),
  );
  check("an existing saved resume does not make the cover-letter input look like the resume input", withSavedResume.resume === null && /cover/i.test(withSavedResume.cover?.describedBy), JSON.stringify(withSavedResume));

  const second = await onPage("wizard-step2.html", "https://www.dice.com/job-applications/a946de63-df82-4c43-b6b0-dcdda01b2951/wizard", "state");
  check("step 2 is the questions step", second.step === "questions", `${second.step} / ${second.heading}`);
  check("with no error showing", second.errors.length === 0, second.errors.join("; "));

  const fields = await onPage("wizard-step2.html", "https://www.dice.com/job-applications/a946de63-df82-4c43-b6b0-dcdda01b2951/wizard", "fields");
  const authorization = fields.find((field) => field.name === "workAuthorization");
  const location = fields.find((field) => field.name === "candidateLocation");
  check("the work authorization menu is read with its options", authorization?.type === "select" && authorization.options.some((option) => option.label === "Green Card Holder" && option.value === "GREEN_CARD_HOLDER"), JSON.stringify(authorization?.options));
  check("and labelled as the page labels it", /work authorization/i.test(authorization?.label ?? ""), authorization?.label);
  check("the city box is a combobox the run has to type into", location?.combobox === true && location.required === true, JSON.stringify(location));
  check("the city box is labelled by its question", /city of residence/i.test(location?.label ?? ""), location?.label);
  check("nothing from the page's header or footer is taken for a question", fields.every((field) => !/search|log ?out|career resources/i.test(field.label)), fields.map((field) => field.label).join(" | "));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
