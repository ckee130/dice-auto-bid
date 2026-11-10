/**
 * The facts about the applicant that no model may invent.
 *
 * Everything here is typed in once and then copied verbatim into forms. The
 * split from the generated resume is deliberate: a resume is written for a
 * posting, but whether you need a visa is not a matter of framing, and a model
 * that gets it wrong produces an application that is worse than none.
 *
 * One thing is different from the other bots. Here the employers on the
 * resume are facts too: each job row below names the company, and the resume
 * carries that name and those months exactly. The model writes the title and
 * the work inside each tenure to fit the posting; it does not choose where
 * the person worked.
 */

export const DEFAULT_PROFILE = {
  /** The Dice job links a run works through, one per line. */
  pastedLinks: "",
  /**
   * Where to say that a job needs a person. A Slack bot token (xoxb-...)
   * with chat:write, and the channel the bot was invited to. With both set,
   * every application left open for the applicant is announced there, and
   * so is the end of each run. With either blank, nothing is sent.
   */
  slackToken: "",
  slackChannel: "",

  /**
   * Who writes the resume, the cover letter and any open-ended screener
   * answer. One provider and one key for all three. The key below is the
   * team's Anthropic key, shared with the other apply bots; replace it in
   * settings to spend from another account.
   */
  provider: "anthropic",
  model: "",
  apiKey: "",
  /** System prompt used to write resumes. Empty means the current built-in prompt. */
  resumePrompt: "",

  /**
   * The folder this browser's files go under: Downloads/job
   * applied-folder/<day>/<profile name>/. Two browsers on one machine
   * share one Downloads, and this is what keeps their days apart. Blank
   * means the applicant's name.
   */
  profileName: "",
  firstName: "Steven",
  lastName: "Atkins",
  email: "steven.atkin1493@gmail.com",
  phone: "(281) 810-1758",

  /**
   * Where the person lives. Dice asks for the city of residence on most
   * applications and offers a list of "City, ST, USA" entries to pick from;
   * the city and state here are what is typed to find the entry.
   */
  city: "Friendswood",
  state: "Texas",
  zip: "77546",
  country: "United States",

  linkedin: "https://www.linkedin.com/in/steven-atkins-9382",
  github: "",
  website: "",
  /**
   * Whether the links above are printed on the resume's contact line. Off
   * when the LinkedIn profile does not yet match the resume, since a
   * recruiter opens it first.
   */
  linksOnResume: true,

  /**
   * The career the resume is written around, newest first. Each row is one
   * job: the employer's name as it should print, and the months it ran,
   * "YYYY-MM" to "YYYY-MM" - an empty "to" means the job is still held.
   * The resume carries exactly these employers with exactly these dates;
   * the model invents only the title and the bullets under each, written
   * to fit the posting. How many rows there are is how many jobs every
   * resume carries.
   */
  experience: [
    { company: "", location: "", from: "2024-03", to: "2026-04" },
    { company: "", location: "", from: "2022-01", to: "2024-02" },
    { company: "", location: "", from: "2020-03", to: "2021-12" },
    { company: "", location: "", from: "2017-06", to: "2020-02" },
  ],
  /** The education on every resume. */
  degree: "Bachelor of Science in Computer Science",
  school: "Dalian University of Technology",
  schoolLocation: "Dalian, China",
  graduationYear: "2017",

  /** How the resume PDF is set: the same choices the app's "Document style" offers. */
  resumeFormat: "classic",
  /**
   * The short line under each employer saying what the company does. The
   * model writes it from what it knows of the company named; off, the
   * resume names the company and nothing more about it. Off by default
   * here, because a description guessed about a real employer can be
   * wrong in a way one about an invented one cannot.
   */
  companyDescriptions: false,
  fontFamily: "Calibri",
  accentColor: "8A1C45",
  density: "normal",
  baseSize: 10.5,

  /**
   * Whether the cover letter written for the posting is attached as well.
   * Dice takes it as an optional second file on the first step.
   */
  attachCoverLetter: true,

  // Legal. Each is an answer, not a preference. Dice's own list is
  // "US Citizen", "Canadian Citizen", "Have H1 Visa", "Need H1 Visa", "Green
  // Card Holder", "TN Permit Holder", "Employment Auth Document" and
  // "Prefer Not to Answer"; see dice.js for which this maps to.
  workAuthorization: "us-citizen",
  requiresSponsorship: "no",
  over18: "yes",
  nonCompete: "no",
  backgroundCheck: "yes",
  previouslyEmployed: "no",
  previousEmployers: "",
  willingToRelocate: "no",
  willingToTravel: "yes",

  // Demographic questions, for the rare screener that asks. A refusal is
  // still an answer that has to be selected for a form to send.
  gender: "decline",
  race: "decline",
  hispanic: "decline",
  veteran: "decline",
  disability: "decline",
  transgender: "decline",
  sexualOrientation: "decline",

  /**
   * "How many years of experience with X?" for any tool, language or
   * framework a screener asks about: this number, placed on whatever scale
   * the control offers.
   */
  techYears: 8,

  startDate: "Two weeks from offer",
  salaryFallback: 120000,
  howHeard: "Dice",
  remotePreference: "Remote",
  masterResume: "",

  /**
   * Fills and reports without sending, for confirming the steps on real
   * pages. Off by default.
   */
  dryRun: false,
  /** Milliseconds between applications. Zero runs them back to back. */
  delayMs: 2000,
  /** Stops after this many in one run. Zero means no ceiling. */
  maxPerRun: 0,
};

export function withDefaults(stored) {
  const profile = { ...DEFAULT_PROFILE, ...(stored ?? {}) };
  if (!Array.isArray(profile.experience)) profile.experience = DEFAULT_PROFILE.experience;
  return profile;
}

const MONTH = /^(?:19|20)\d\d-(?:0[1-9]|1[0-2])$/;

/**
 * The jobs the profile holds, cleaned: rows with an employer named, a
 * proper "YYYY-MM" start, an end that is either the same or blank for
 * "still there", and the end not before the start. Newest first, which is
 * the order a resume lists them in.
 */
export function experiencePeriods(profile) {
  const rows = Array.isArray(profile?.experience) ? profile.experience : [];
  return rows
    .map((row) => ({
      company: String(row?.company ?? "").trim(),
      location: String(row?.location ?? "").trim(),
      from: String(row?.from ?? "").trim(),
      to: String(row?.to ?? "").trim(),
    }))
    .filter((row) => row.company && MONTH.test(row.from) && (row.to === "" || (MONTH.test(row.to) && row.to >= row.from)))
    .sort((a, b) => b.from.localeCompare(a.from));
}

/**
 * What the profile cannot answer yet.
 *
 * Reported before a run rather than discovered mid-form, because the cost of
 * finding out late is a job skipped for a reason that was knowable all along.
 */
export function missingFromProfile(profile) {
  const required = [
    ["firstName", "first name"],
    ["lastName", "last name"],
    ["email", "email"],
    ["phone", "phone"],
    ["city", "city"],
    ["state", "state"],
  ];

  const gaps = required.filter(([key]) => !String(profile[key] ?? "").trim()).map(([, label]) => label);

  const rows = Array.isArray(profile?.experience) ? profile.experience : [];
  const periods = experiencePeriods(profile);
  if (periods.length === 0) gaps.push("at least one job - a company name and the months it ran - for the resume to be written around");
  else if (rows.some((row) => (String(row?.from ?? "").trim() || String(row?.to ?? "").trim()) && !String(row?.company ?? "").trim())) {
    gaps.push("a company name on every job row (a row with dates and no company is left out of the resume)");
  }
  if (!String(profile.school ?? "").trim() || !String(profile.degree ?? "").trim()) gaps.push("the school and degree for the resume's education");

  if (!String(profile.apiKey ?? "").trim()) {
    gaps.push("API key, which writes every resume and letter");
  }

  return gaps;
}
