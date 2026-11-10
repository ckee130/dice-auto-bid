/**
 * Deciding what belongs in each field of an application form.
 *
 * Every field resolves to exactly one of four outcomes, and which one it is
 * matters more than the value itself:
 *
 *   fill     - the profile knows this, copy it
 *   attach   - a document goes here
 *   ask      - open-ended, the model may answer it
 *   blocked  - required, and nothing here may answer it
 *
 * The fourth exists for one reason. A form that asks whether you need visa
 * sponsorship, or whether you are a protected veteran, is asking a question
 * with a true answer that the applicant knows and a model does not. Guessing it
 * is not a wrong field value, it is a false statement on an application, so a
 * sensitive field the profile cannot answer stops the whole submission rather
 * than being filled with the model's best idea.
 *
 * Matching runs on the field's visible label first and its name or id second,
 * never on position, because position is the thing that changes between two
 * companies using the same board.
 */

import { desiredSalary } from "./salary.js";

const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
];

const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

/** The same table the other way round, for reading a code back as a name. */
const STATE_NAMES = Object.fromEntries(
  Object.entries(STATE_CODES).map(([name, code]) => [code, name.replace(/\b\w/g, (letter) => letter.toUpperCase())]),
);

/** "TX" for "Texas" or "tx"; whatever was given, otherwise. */
export const stateCode = (state) => {
  const given = String(state ?? "").trim();
  if (STATE_NAMES[given.toUpperCase()]) return given.toUpperCase();
  return STATE_CODES[normalise(given)] ?? given;
};

/** "Texas" for "TX" or "texas"; whatever was given, otherwise. */
const stateName = (state) => {
  const given = String(state ?? "").trim();
  if (STATE_NAMES[given.toUpperCase()]) return STATE_NAMES[given.toUpperCase()];
  const code = STATE_CODES[normalise(given)];
  return code ? STATE_NAMES[code] : given;
};

// Accents dropped, so Rippling's "Résumé" is a resume.
const normalise = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Label first, then the machine names, so a relabelled field still resolves.
 *
 * Underscores and hyphens become spaces because the machine names are where
 * the meaning often lives - Greenhouse labels both upload controls "Attach"
 * and distinguishes them only by the ids `resume` and `cover_letter`.
 */
function haystack(field) {
  return normalise([field.label, field.name, field.id].filter(Boolean).join(" | ").replace(/[_-]+/g, " "));
}

/**
 * The wordings an answer might appear under on a menu.
 *
 * The profile stores an intent - "decline", "no" - but no board offers those
 * words. Each one is expanded into the phrasings that mean it, in preference
 * order, and the page tries them in turn against whatever is actually on the
 * dropdown. Keeping this list here rather than in the page script is what
 * keeps the page script free of any opinion about what an answer means.
 */
/**
 * The option a number falls in, for a list known up front.
 *
 * The same reading of "0-1", "4-6", "7+", "Less than 1", "10+ years" and
 * Beginner..Expert as the page script's pickByNumber in fill.js, which
 * handles the menus that only exist once opened. Two copies because the
 * page script is injected as a self-contained file and cannot import.
 */
const LEVELS = ["none", "beginner", "novice", "basic", "familiar", "intermediate", "proficient", "advanced", "expert"];
export function pickOption(options, target) {
  const labelled = (options ?? []).map((option) => ({ option, label: normalise(option.label || option.value) })).filter((entry) => entry.label);
  const ranges = labelled
    .map(({ option, label }) => {
      const numbers = (label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (numbers.length === 0) return null;
      if (/less than|under|fewer than|below|<\s*\d/.test(label)) return { option, low: 0, high: numbers[0] - 0.01 };
      if (/more than|over|greater than|above|\+|>\s*\d|or more/.test(label)) return { option, low: numbers[0], high: Infinity };
      if (numbers.length >= 2) return { option, low: Math.min(numbers[0], numbers[1]), high: Math.max(numbers[0], numbers[1]) };
      return { option, low: numbers[0], high: numbers[0] };
    })
    .filter(Boolean);

  if (ranges.length > 0) {
    const holding = ranges.find((range) => target >= range.low && target <= range.high);
    if (holding) return holding.option;
    const below = ranges.filter((range) => range.low <= target).sort((a, b) => b.low - a.low)[0];
    return below ? below.option : ranges.sort((a, b) => a.low - b.low)[0].option;
  }

  const rungs = labelled
    .map(({ option, label }) => ({ option, rank: LEVELS.findIndex((level) => label.includes(level)) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (rungs.length === 0) return null;
  return rungs[Math.min(rungs.length - 1, Math.max(0, Math.round((target / 10) * (rungs.length - 1))))].option;
}

/** The ways a "how did you hear about us" menu words the usual answers, in order of preference. */
// The company's own site before "job board": landing from a search is a
// visit to the careers page, and "Other job board" on an Ashby form opens
// a second question asking which.
const HOW_HEARD_WORDINGS = ["Google", "Search Engine", "Search engine (Google, Bing, etc.)", "Online search", "Internet search", "Company website", "Careers page", "Career site", "Job Board", "LinkedIn", "Indeed", "Glassdoor", "Other"];

export function expand(value) {
  const want = normalise(value);

  if (want === "decline") {
    return [
      "Decline to self-identify",
      "I don't wish to answer",
      "I do not wish to answer",
      "Prefer not to say",
      "I prefer not to answer",
      "Decline to answer",
      "I don't wish to disclose",
      "Decline",
    ];
  }
  if (want === "yes") return ["Yes", "I am", "I do", "I have", "True", "I agree", "I acknowledge", "I accept", "I confirm", "Acknowledge", "Confirm"];
  if (want === "no") return ["No", "I am not", "I do not", "I have not", "False"];
  if (want === "heterosexual") return ["Heterosexual or straight", "Heterosexual / straight", "Heterosexual", "Straight"];
  // The veteran and disability statements, as the boards each word them.
  // Workday's menus say "I am not a protected veteran" on most sites and
  // "I am not a veteran" on some; the disability form's "No" runs to a
  // sentence.
  if (/not a protected veteran|not a veteran/.test(want)) {
    // "I am not a veteran" ahead of the bare "not a protected veteran":
    // the latter is also inside "I identify as a veteran, just not a
    // protected veteran", which says the opposite.
    return ["I am not a protected veteran", "I am not a veteran", "Not a protected veteran", "I am not a protected veteran, and I am not a veteran", "No, I am not a protected veteran", "No"];
  }
  if (/^no\b.*disabilit/.test(want)) {
    return ["No, I do not have a disability", "No, I don't have a disability", "No, I do not have a disability and have not had one in the past", "No, I do not have a disability or a history/record of having a disability", String(value), "No"];
  }

  // A place, as "City, ST". Greenhouse's location box is a search over a
  // geocoder, and the geocoder spells places its own way: "Friendswood,
  // Texas, United States", never "Friendswood, TX". The state's full name is
  // offered second so the right state still wins where a city name is shared,
  // and the bare city last, because a geocoder returning one place for a
  // typed city is almost always returning the right one.
  const place = /^(.+?),\s*([A-Za-z .]+)$/.exec(String(value).trim());
  if (place) {
    const [, city, region] = place;
    const code = STATE_NAMES[region.toUpperCase()] ? region.toUpperCase() : STATE_CODES[normalise(region)];
    const name = code ? STATE_NAMES[code] : "";
    // The full name first: it is what a geocoder shows and what a text box
    // asking for "city and state" wants. The code second, the bare city last.
    return name ? [`${city}, ${name}`, `${city}, ${code}`, city] : [String(value), city];
  }

  return [String(value)];
}

/**
 * Picks the option that says what we mean.
 *
 * Exact text wins, then a contained match, then a small set of synonyms, since
 * boards phrase the same answer as "Yes", "Yes, I am", "I am authorized" and
 * "I do not wish to answer" versus "Decline to self-identify".
 */
export function chooseOption(options, desired) {
  if (!options || options.length === 0) return null;
  const want = normalise(desired);
  if (!want) return null;

  const usable = options.filter((option) => normalise(option.label) || normalise(option.value));
  const text = (option) => normalise(option.label) || normalise(option.value);

  // A placeholder is not an answer, however well it matches.
  const real = usable.filter((option) => !/^(select\.{0,3}|choose\.{0,3}|--.*--|please select)$/.test(text(option)));
  const pool = real.length > 0 ? real : usable;

  const exact = pool.find((option) => text(option) === want || normalise(option.value) === want);
  if (exact) return exact;

  const starts = pool.find((option) => text(option).startsWith(want) || want.startsWith(text(option)));
  if (starts) return starts;

  /**
   * Containment on word boundaries, never bare substrings.
   *
   * This matters more than it looks. Matching "no" loosely picks "Pending" out
   * of a sponsorship dropdown, because "pending" contains an n and an o in
   * order - and the result is an application that states the opposite of the
   * truth about the applicant's right to work.
   */
  const contains = (haystackText, needle) =>
    new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystackText);

  for (const phrase of expand(want).map(normalise)) {
    const hit = pool.find((option) => contains(text(option), phrase));
    if (hit) return hit;
  }

  const loose = pool.find((option) => contains(text(option), want));
  return loose ?? null;
}

/**
 * Answers "do you live in one of the following states: ..." by reading the list
 * out of the question itself.
 *
 * Boards use this to screen for states they cannot employ in, and the list
 * differs per company, so the only reliable source for it is the label.
 */
function statesListedIn(label) {
  const text = normalise(label);
  const listed = US_STATES.filter((state) => new RegExp(`\\b${state}\\b`).test(text));
  // Two or more named states is a list being asked about. One is a sentence
  // that happens to mention a state.
  return listed.length >= 2 ? listed : null;
}

/** Words that are part of a company's legal name rather than its identity. */
const COMPANY_NOISE = /\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|technology|labs|software|systems|solutions|the)\b/g;

const companyKey = (name) => normalise(name).replace(/[.,]/g, " ").replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();

/**
 * Whether this applicant has worked for the company being applied to.
 *
 * The answer differs per application, which is the whole point: it is a fact
 * about the pair, not about the applicant, so a single setting cannot express
 * it. It is resolved against the employers named in the master resume, with an
 * explicit list in the profile overriding that when the resume's wording and
 * the employer's legal name disagree.
 *
 * The cover letter is deliberately not consulted. It is written *to* this
 * company and says its name in every other sentence, so matching against it
 * would answer yes to every posting - a false statement on every application,
 * arrived at by looking in the one place guaranteed to mislead.
 */
function workedAt(company, profile) {
  const target = companyKey(company);
  if (!target) return false;

  const declared = String(profile.previousEmployers ?? "")
    .split(/[,\n;]/)
    .map(companyKey)
    .filter(Boolean);
  if (declared.length > 0 && declared.some((employer) => employer === target)) return true;

  // A bare "yes" in the profile means "assume I have worked everywhere", which
  // nobody means; it is kept only as a manual override for a single run.
  if (profile.previouslyEmployed === "yes") return true;
  if (declared.length > 0) return false;

  const resume = normalise(profile.masterResume);
  if (!resume) return false;

  // Word boundaries, so Discord is not found inside "discordant" and a
  // two-letter company name does not match half the document.
  if (target.length < 3) return false;
  return new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(resume);
}

const AUTHORIZATION_ANSWER = {
  "us-citizen": "I am a US citizen",
  "permanent-resident": "I am a lawful permanent resident",
  "visa-holder": "I hold a visa that permits me to work",
  "needs-sponsorship": "I will require sponsorship",
};

/**
 * The same four statuses as wordings a menu might use, most specific first.
 *
 * For a dropdown whose entries are only visible once it opens, so the page
 * has to be handed every phrasing in advance. Order is the safety: "Yes" is
 * last because its own expansions ("I am") sit inside every entry of a
 * status menu - "I am authorized ... due to my nationality" was picked for a
 * sponsorship case that way - and a status phrase wins before it is tried.
 */
const AUTHORIZATION_WORDINGS = {
  "us-citizen": ["US citizen", "citizen", "due to my nationality", "nationality", "do not need a company to sponsor", "without sponsorship", "Yes"],
  "permanent-resident": ["lawful permanent resident", "permanent resident", "green card", "do not need a company to sponsor", "without sponsorship", "Yes"],
  "visa-holder": ["do not need a company to sponsor", "valid work permit", "work permit", "visa", "Yes"],
  "needs-sponsorship": ["need visa support", "needs to be sponsored", "require sponsorship", "sponsorship", "not authorized", "No"],
};

/**
 * The field map.
 *
 * Order matters: the first rule whose pattern matches wins, so narrower
 * questions sit above the broad ones they would otherwise be swallowed by.
 * "sensitive" marks a rule the model is never allowed to stand in for.
 */
/** A field asking for a fact rather than an account: not a paragraph box, not a "why". */
const shortAnswer = (field) => field.type !== "textarea" && !/\bwhy\b|\bdescribe\b|\bexplain\b|\breason|\btell us\b/i.test(field.label ?? "");

/** The phone is a US number, so a country picker beside it is always the United States. */
const US_PHONE_COUNTRY = ["United States of America (+1)", "United States (+1)", "United States of America", "United States", "USA", "US", "+1"];

/** The other names a country goes by on a menu. */
const countryWordings = (country) => (/^(?:united states|usa|us|u\.s\.a?\.?)(?: of america)?$/i.test(String(country ?? "").trim()) ? ["United States of America", "USA", "US"] : []);

const RULES = [
  // Documents.
  { id: "resume", pattern: /\bresume\b|\bcv\b/, attach: "resume", when: (field) => field.type === "file" },
  { id: "cover-letter", pattern: /cover letter/, attach: "cover", when: (field) => field.type === "file" },
  // The same letter, typed, where the box is a paragraph rather than an upload (Workable).
  { id: "cover-letter-text", pattern: /cover letter/, when: (field) => field.type === "textarea", value: (_p, ctx) => ctx.letter ?? "" },
  // An account a board asks to create on the way - Rippling, Workable - gets
  // the one password every career-site account is made with.
  { id: "password", pattern: /\bpassword\b/, value: (p) => p.workdayPassword || "Vhkautmd1215!@#QWE123qwe" },

  // Identity.
  { id: "first-name", pattern: /\bfirst name\b|\bgiven name\b|^first$/, value: (p) => p.firstName },
  { id: "last-name", pattern: /\blast name\b|\bfamily name\b|\bsurname\b|^last$/, value: (p) => p.lastName },
  // Ashby asks the whole name in one box labelled "Name", id _systemfield_name.
  { id: "full-name", pattern: /\bfull name\b|^name(?:\s*\||$)|systemfield name/, value: (p) => `${p.firstName} ${p.lastName}`.trim() },
  { id: "email", pattern: /\be-?mail\b/, value: (p) => p.email },
  // Workday splits the phone across three boxes; only the number is the
  // number. The device type is a menu, and the extension is left blank.
  { id: "phone-type", pattern: /phone (?:device )?type|device type/, value: () => ["Mobile", "Cell", "Cellular", "Home", "Landline"] },
  // "Country Phone Code", "Country / Territory Phone Code", "Phone Code".
  { id: "country-code", pattern: /(?:country|territory)[^|]*?phone code|country code|phone (?:country )?code|dial(?:ing)? code|phone country/, value: () => US_PHONE_COUNTRY },
  { id: "phone-extension", pattern: /phone extension|\bextension\b|\bext\.?\b/, value: () => "" },
  // Consent to be texted, which Ashby files under the "Phone" label as a
  // pair of yes/no choices. Reachable is the point of giving the number.
  {
    id: "phone-consent",
    pattern: /\bphone\b|\bmobile\b|\bsms\b|\btext message/,
    when: (field) => (field.options ?? []).some((option) => /consent|agree|opt.?in/i.test(String(option.label ?? option.value ?? option))),
    value: () => ["Yes"],
  },
  // A phone box that offers choices is the country picker beside the
  // number; the number itself is always a US one, so the country is always
  // the United States.
  { id: "phone", pattern: /\bphone\b|\bmobile\b|\btelephone\b/, value: (p, _context, field) => (field?.options?.length > 0 ? US_PHONE_COUNTRY : p.phone) },
  // Name parts Workday asks for and the profile does not keep.
  { id: "middle-name", pattern: /middle (?:name|initial)/, value: () => "" },
  { id: "preferred-name", pattern: /preferred (?:first )?name|i have a preferred name/, value: () => "" },
  // The street, before the city rule sees the word "address".
  { id: "street", pattern: /address ?line ?1\b|addressline1|\bstreet(?: address)?\b|^address(?:\s*\||$)/, value: (p) => p.street },
  { id: "address-2", pattern: /address ?line ?[2-9]\b|addressline[2-9]|\bapt\b|\bsuite\b|\bunit\b/, value: () => "" },
  { id: "zip", pattern: /\bzip\b|\bpostal(?: code)?\b|\bpostcode\b/, value: (p) => p.zip },
  {
    id: "country",
    pattern: /\bcountry\b/,
    // The word turns up inside other questions - "your authorization to work
    // in the country where you live" was answered "United States" - so this
    // only takes a field whose label is the word, more or less.
    when: (field) => normalise(field.label).length <= 40,
    value: (p) => p.country,
  },
  // A state is asked for by a short label with no yes/no behind it. "Have you
  // been employed by a federal, state or local agency?" is not asking for one.
  {
    id: "state",
    pattern: /\bstate\b|\bprovince\b|\bregion\b/,
    when: (field) => String(field.label ?? "").length <= 60 && !(field.options ?? []).some((option) => /^(?:yes|no)\b/i.test(String(option.label ?? option.value ?? option))),
    value: (p) => p.state,
  },
  {
    id: "city",
    // "From where do you intend to work" went to the model, which answered
    // with the city of the resume's last employer. Where the applicant works
    // from is a fact about the applicant, and the profile holds it.
    pattern:
      /\bcity\b|\blocation\b|\baddress\b|\bwhere are you (?:located|based)\b|where (?:do|will|would) you (?:intend|plan|expect) to work|where (?:will|would|do) you (?:be )?work(?:ing)? from|^from where/,
    // A box labelled just "City" (Workday's address form, with the state in
    // its own box) gets the city alone; anything broader gets "City, State".
    // A "Location" whose small print asks for the country - Ashby's
    // "Country you're currently residing in", a list of countries - gets
    // the country; and a menu gets the country as a second wording, so a
    // list that has no cities still has an answer.
    value: (p, _ctx, field) => {
      if (/^\s*(?:city|town|city\s*\/\s*town)\s*\*?\s*$/i.test(field?.label ?? "")) return p.city;
      const place = `${p.city}, ${stateName(p.state)}`;
      if (/\bcountr(?:y|ies)\b/i.test(field?.hint ?? "")) return [p.country, ...countryWordings(p.country), ...expand(place)];
      return field?.combobox || (field?.options ?? []).length > 0 ? [...expand(place), p.country, ...countryWordings(p.country)] : place;
    },
  },

  // The current job, as the attached resume states it. These went to the
  // model, which answered "Current Title" with a sentence about the title.
  // The resume's first entry is the answer and is already in hand.
  // "Why are you leaving your current role?" names the current role and is
  // not asking for it; a box that wants a title is a short box.
  { id: "current-title", pattern: /current (?:job )?title|current (?:role|position)|^(?:job )?title$|most recent (?:job )?title|\bheadline\b/, when: shortAnswer, value: (_p, ctx) => ctx.currentRole ?? "" },
  // Between contracts: the last one has ended, so there is no current
  // employer. "Most recent" is a different question and gets the resume's.
  { id: "current-company", pattern: /current (?:company|employer|organi[sz]ation)|^(?:company|employer)(?: name)?$/, when: shortAnswer, value: () => "N/A" },
  { id: "recent-company", pattern: /most recent (?:company|employer)|last (?:company|employer)|previous (?:company|employer)/, when: shortAnswer, value: (_p, ctx) => ctx.currentCompany ?? "" },

  // Links. Twitter is deliberately absent: it is optional everywhere and
  // nothing in the profile answers it.
  // Given only where the form insists. An optional LinkedIn box is left
  // empty on every board: a profile is one more thing for a recruiter to
  // compare the resume against, and nothing is gained by volunteering it.
  { id: "linkedin", pattern: /\blinkedin\b/, onlyRequired: true, value: (p) => profileLink(p.linkedin, "www.linkedin.com") },
  { id: "github", pattern: /\bgithub\b|\bgit hub\b/, value: (p) => profileLink(p.github, "github.com") },
  { id: "website", pattern: /\bwebsite\b|\bportfolio\b|\bpersonal site\b|\bblog\b/, value: (p) => p.website },

  // Legal and screening. None of these may be guessed.
  // Willingness to move is a decision, not a fact to look up, so it comes from
  // its own setting rather than being inferred from the remote preference.
  { id: "relocation", pattern: /relocat|willing to move/, sensitive: true, value: (p) => (p.willingToRelocate === "yes" ? "Yes" : "No") },
  // "Able to travel as required?" - annually to a headquarters, to an on-site
  // interview, to clients. Its own setting, since agreeing to a trip and
  // agreeing to move are different promises. The percentage variant ("what
  // percent of travel are you comfortable with") is a different question and
  // is left to the model with the rest of the open ones.
  {
    id: "travel",
    pattern: /\b(?:able|willing|available|open|comfortable) to travel\b|\btravel (?:as required|as needed|when required|when needed|occasionally|for (?:this|the) role)\b|\btravel requirement\b/,
    sensitive: true,
    value: (p) => (p.willingToTravel === "no" ? "No" : "Yes"),
  },
  {
    id: "residence",
    pattern: /do you (?:currently )?(?:live|reside)|are you (?:a )?resident|are you (?:currently )?(?:located|based|living)/,
    sensitive: true,
    value: (p, _ctx, field) => {
      // Some ask about a named list of states, some about the country. Which
      // one it is can only be read off the question, because the list differs
      // per company and exists nowhere else.
      const listed = statesListedIn(field.label);
      const question = normalise(field.label);
      const inUs = /united states|usa|us\b/.test(normalise(p.country));

      // The yes or no, where the question can be settled from the profile.
      let yesNo = "";
      if (listed) yesNo = listed.includes(normalise(p.state)) ? "Yes" : "No";
      else if (/\b(?:the )?(?:us|usa|u\.s\.?|united states|america)\b/.test(question)) yesNo = inUs ? "Yes" : "No";

      // A menu may want the place rather than a yes: "are you based in any of
      // these countries?" over a list of countries. Which it is cannot be
      // known while the menu is closed, so both are offered, the yes or no
      // first, and the page takes whichever its entries match. "Do you reside
      // in the United States, Canada, or Mexico?" was being offered only the
      // country, against a menu of Yes and No.
      const choices = field.options.map((option) => normalise(option.label ?? option.value ?? ""));
      const yesNoMenu = choices.length > 0 && choices.every((choice) => /^(?:yes|no)\b/.test(choice));
      if ((field.combobox || choices.length > 0) && !yesNoMenu) {
        const places = [];
        if (/\bcountr(?:y|ies)\b/.test(question)) places.push(p.country);
        if (/\bstates?\b|\bprovinces?\b/.test(question)) places.push(stateName(p.state));
        const wordings = [yesNo, ...places].filter(Boolean);
        if (wordings.length > 0) return wordings;
      }
      // Without a place to name, a question about somewhere the profile
      // cannot settle stays unanswered.
      return yesNo;
    },
  },
  {
    id: "sponsorship",
    pattern: /sponsorship|sponsor(?:ed|ing)?\b|\bh-?1b\b/,
    sensitive: true,
    value: (p) => (p.requiresSponsorship === "yes" ? "Yes" : "No"),
  },
  {
    id: "authorization",
    // "Eligible to work" is AlphaSense's wording and far from rare; it was
    // missing, and a required text box the profile could have answered was
    // left blank instead, which skipped the job.
    pattern:
      /authoriz|authoris|legally (?:able|entitled|permitted)|right to work|work permit|eligib\w* (?:to|for) (?:work|employ)|(?:work|employment) eligib|permitted to work|able to work in/,
    sensitive: true,
    value: (p, _ctx, field) => {
      // Phrased as a yes/no far more often than as a status, and a status
      // answer offered to a yes/no field matches nothing.
      const authorised = p.workAuthorization !== "needs-sponsorship";
      if (!field.options || field.options.length === 0) {
        // A menu that lists nothing until opened gets every wording; a plain
        // box gets the first of them, which is the yes or no.
        const wordings = AUTHORIZATION_WORDINGS[p.workAuthorization];
        if (!field.combobox || !wordings) return authorised ? "Yes" : "No";
        // "Are you authorized...?" leads with the yes or no; "choose the
        // option that describes your authorization" leads with the status.
        const yesNo = /^(?:are|do|can|will|is|have|would)\b/.test(normalise(field.label));
        return yesNo ? [authorised ? "Yes" : "No", ...wordings] : wordings;
      }
      const status = chooseOption(field.options, AUTHORIZATION_ANSWER[p.workAuthorization] ?? "");
      return status ? status.label || status.value : authorised ? "Yes" : "No";
    },
  },
  { id: "over-18", pattern: /\b18 years\b|\bat least 18\b|\bover 18\b|\bage of 18\b/, sensitive: true, value: (p) => (p.over18 === "no" ? "No" : "Yes") },
  { id: "non-compete", pattern: /non-?compete|non-?solicit|restrictive covenant/, sensitive: true, value: (p) => (p.nonCompete === "yes" ? "Yes" : "No") },
  {
    id: "background-check",
    pattern: /background (?:check|screen)|drug (?:test|screen)|pre-?employment screening/,
    sensitive: true,
    value: (p) => (p.backgroundCheck === "no" ? "No" : "Yes"),
  },
  {
    id: "previous-employment",
    // "Previously worked in a remote environment?" is not this question; the
    // guard keeps it to working for this employer.
    pattern: /(?:previously|ever) (?:worked|been employed)|former employee|worked (?:here|for us|at this company)|current or former employee/,
    when: (field) => !/\b(?:remote|hybrid|environment|industry|startup|team|role of|as an?|with)\b/i.test(field.label ?? ""),
    sensitive: true,
    value: (p, ctx) => (workedAt(ctx.company, p) ? "Yes" : "No"),
  },

  // Demographic questions.
  // Before gender, because "gender identity: do you identify as transgender?"
  // contains the word gender and is a different question.
  { id: "transgender", pattern: /\btransgender\b|\btrans\b/, sensitive: true, value: (p) => (p.transgender === "yes" ? "Yes" : p.transgender === "no" ? "No" : "decline") },
  { id: "sexual-orientation", pattern: /sexual orientation|\borientation\b|\blgbtq?/, sensitive: true, value: (p) => p.sexualOrientation || "decline" },
  { id: "gender", pattern: /\bgender\b|\bsex\b/, sensitive: true, value: (p) => p.gender },
  // "Are you Hispanic/Latino?" is its own yes/no on most boards, asked
  // beside the race menu rather than as part of it. Answered on its own
  // before the race rule sees it, which answered "Asian" to a menu of yes,
  // no and decline.
  { id: "hispanic", pattern: /\bhispanic\b|\blatino\b|\blatinx\b/, sensitive: true, value: (p) => (p.hispanic === "yes" ? "Yes" : p.hispanic === "decline" ? "Decline" : "No") },
  { id: "race", pattern: /\brace\b|\bethnic/, sensitive: true, value: (p) => p.race },
  { id: "veteran", pattern: /\bveteran\b|\bmilitary\b|\bprotected vet/, sensitive: true, value: (p) => p.veteran },
  // A signature's date, beside the name on an EEOC disability form. Before
  // the disability rule: the box's own name is "eeoc_disability_date".
  { id: "date", pattern: /^(?:today'?s )?date\s*(?:\||$)|\bdate signed\b|signature date|date of signature|disability date\b/, value: () => new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) },
  { id: "disability", pattern: /\bdisabilit|\bdisabled\b/, sensitive: true, value: (p) => p.disability },
  // Ashby's own survey: "which communities do you belong to?" over a list
  // of disability, veteran, parent, refugee; and an age bracket.
  { id: "communities", pattern: /communities do you belong|underrepresented group|member of any of the following/, sensitive: true, value: () => ["None of the above", "I prefer not to answer", "Prefer not to say", "decline"] },
  { id: "age", pattern: /\byour (?:current )?age\b|\bage (?:range|bracket|group)\b/, sensitive: true, value: () => ["I prefer not to answer", "Prefer not to say", "decline"] },

  // "How many years with Vue.js?" "Rate your proficiency in SQL." Answered
  // with one number from the profile for every tool asked about, placed on
  // whatever scale the control offers: typed into a box, or the band it
  // falls in - "7-10", "8", "Advanced" - picked off a menu. Not a question
  // for the model, which answered 0-1 off a resume that happened not to name
  // the tool. Text areas are left out: "describe your experience with X"
  // wants prose.
  {
    id: "tech-experience",
    pattern: /how many years|years of (?:experience|hands-on|professional)|\byears\b.*\b(?:experience|using|with)\b|rate your|self-?rate|proficien|skill level|level of (?:experience|expertise|proficiency)|how (?:proficient|experienced|comfortable|familiar)|experience level/,
    when: (field) => field.tag !== "textarea",
    value: (p) => [String(p.techYears || 8), `${p.techYears || 8} years`, `${p.techYears || 8}+ years`],
    pick: (p) => Number(p.techYears) || 8,
  },

  // The education block: School, Degree, Discipline, and start/end month
  // and year, under ids like school--0 and start-year--0 (which arrive here
  // as "school 0", "start year 0"). Answered from the education on the
  // resume that was just written, so the dates agree with the degree on it.
  // A start date here answered "two weeks from now" sent one form back with
  // "End date must be after start date".
  { id: "education-school", pattern: /\bschool \d+$|\buniversity\b|\binstitution\b|school name/, value: (p, ctx) => schooling(ctx).school },
  {
    id: "education-degree",
    pattern: /\bdegree \d+$|\bdegree\b|highest (?:completed )?(?:level of )?education|education level|level of education/,
    value: (p, ctx) => schooling(ctx).degreeWordings,
  },
  { id: "education-discipline", pattern: /\bdiscipline \d+$|\bdiscipline\b|\bmajor\b|field of study|area of study/, value: (p, ctx) => schooling(ctx).majorWordings },
  { id: "education-start-month", pattern: /\bstart month \d+$/, value: () => ["September", "Sep", "August"] },
  { id: "education-start-year", pattern: /\bstart year \d+$/, value: (p, ctx) => schooling(ctx).startYear },
  { id: "education-end-month", pattern: /\bend month \d+$/, value: () => ["May", "June", "Jun"] },
  { id: "education-end-year", pattern: /\bend year \d+$/, value: (p, ctx) => schooling(ctx).endYear },

  // Logistics.
  { id: "salary", pattern: /salary|compensation|pay expectation|desired pay|expected (?:pay|comp)/, value: (p, ctx) => formatSalary(p, ctx) },
  // "availability" alone is also a word in questions about systems; a
  // paragraph box asking to describe something is never asking for a date.
  { id: "start-date", pattern: /start date|when (?:can|could) you start|\byour availability|availability (?:to start|date)|available to start|notice period|earliest/, when: shortAnswer, value: (p) => p.startDate },
  // The date beside a signature - Workday's self-identification form has
  // "Name", "Employee ID", "Date" - is today. The model guessed one.
  {
    id: "signed-today",
    pattern: /^(?:today'?s )?date\s*(?:\||$)|\bdate ?signed\b|\bsignature date\b|\bdate of (?:signature|application|submission)\b/,
    when: (field) => !/birth|\bdob\b|start|graduat|hire|employ/i.test(field.label ?? ""),
    value: () => {
      const now = new Date();
      return `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
    },
  },
  // A signature box wants the name, typed.
  { id: "signature", pattern: /\bsignature\b|\b(?:type|enter) your (?:full )?name\b|\bname \(?(?:as|for) (?:a |your )?signature/, when: (field) => field.type !== "file" && !/date/i.test(field.label ?? ""), value: (p) => `${p.firstName} ${p.lastName}`.trim() },
  {
    id: "how-heard",
    // "Where did you first hear about this role?" went to the model, which
    // rightly had nothing to say; the "first" is what the old pattern missed.
    pattern:
      /(?:how|where) did you (?:first |originally )?(?:hear|find|learn)|hear about (?:this|the|our) (?:role|job|position|opening|opportunity)|referr?al source|how were you referred|\bsource of (?:application|referral)\b|which (?:job )?board|(?:job )?board brought you|brought you to/,
    // The profile's answer, then the ways a menu might word it. Workday
    // tenants file sources under categories - "Search Engine" holding
    // "Google", "Job Board" holding "LinkedIn" - so the category comes
    // right after the thing itself.
    value: (p, _ctx, field) => (field.combobox || field.options?.length > 0 ? [p.howHeard, ...HOW_HEARD_WORDINGS.filter((w) => w !== p.howHeard)] : p.howHeard),
  },
  { id: "remote", pattern: /\bremote\b|\bhybrid\b|\bon-?site\b|work (?:location )?preference/, when: (field) => !/\bhave you\b|\bdid you\b|\bexperience\b/i.test(field.label ?? ""), value: (p) => p.remotePreference },
  // A box that only takes an address - "work samples", "anything else you
  // would like to share" - gets the best address there is.
  { id: "any-url", pattern: /./, when: (field) => field.type === "url", onlyRequired: true, value: (p) => p.website || p.github || p.linkedin },

  // Consent. Not a question with an answer so much as a box the form will not
  // send without, and refusing it is identical to not applying.
  {
    id: "acknowledgement",
    // The label is normalised before matching, so "double-check" arrives as
    // "double check".
    pattern: /acknowledge|i agree|consent|privacy (?:notice|policy|statement)|have read|double[\s-]?check|certify|confirm that|i understand|\bgdpr\b|data protection|personal data|terms (?:and|&) conditions|i (?:willingly )?accept/,
    // Such a menu often has one entry - "Acknowledge/Confirm", "I have
    // reviewed and confirmed..." - and that entry is the answer whatever it
    // says, since the alternative is not applying.
    sole: true,
    value: (p, _ctx, field) => {
      const affirmative = chooseOption(field.options ?? [], "yes") ?? chooseOption(field.options ?? [], "i acknowledge");
      return affirmative ? affirmative.label || affirmative.value : "Yes";
    },
  },
];

/**
 * The education on the resume, in the shapes forms ask for it.
 *
 * The resume holds one line - "Bachelor of Science in Computer Science",
 * the school, the graduation year. Forms want the degree as a menu entry
 * ("Bachelor's of Science (B.S)"), the major on its own, and a start year
 * the resume never states: four years before the end for a bachelor's,
 * two for a master's, five for a doctorate.
 */
function schooling(context) {
  const education = context?.education ?? {};
  const degree = String(education.degree ?? "").trim();
  const lower = degree.toLowerCase();
  const endYear = Number((String(education.year ?? "").match(/(?:19|20)\d\d/g) ?? []).pop()) || 0;

  let degreeWordings;
  let span;
  if (/\b(?:ph\.?d|doctor)/.test(lower)) {
    degreeWordings = ["Doctorate (PhD)", "Doctor of Philosophy (Ph.D)", "PhD", "Ph.D", "Doctorate", "Doctoral"];
    span = 5;
  } else if (/\b(?:master|m\.?s\.?\b|m\.?sc|mba|m\.?eng)/.test(lower)) {
    degreeWordings = ["Master's of Science (M.S)", "Master of Science (M.S)", "Master's Degree", "Master's", "Masters", "Master"];
    span = 2;
  } else if (/\b(?:associate|a\.?s\.?\b|a\.?a\.?\b)/.test(lower)) {
    degreeWordings = ["Associates of Science (A.S)", "Associate of Science (A.S)", "Associate's Degree", "Associates", "Associate"];
    span = 2;
  } else {
    degreeWordings = ["Bachelor's of Science (B.S)", "Bachelor of Science (B.S)", "Bachelor's Degree", "Bachelor's", "Bachelors", "Bachelor"];
    span = 4;
  }
  if (/\barts?\b|b\.?a\.?\b|m\.?a\.?\b/.test(lower) && !/science/.test(lower)) {
    degreeWordings = degreeWordings.map((wording) => wording.replace("Science (B.S)", "Arts (B.A)").replace("Science (M.S)", "Arts (M.A)").replace("Science (A.S)", "Arts (A.A)"));
  }

  // "Bachelor of Science in Computer Science": what follows "in", or
  // failing that "of" ("Bachelor of Computer Science").
  const major = (degree.match(/\bin\s+([A-Za-z&/ ,-]+?)(?:\s*[(,]|$)/)?.[1] ?? degree.match(/\bof\s+([A-Za-z&/ ,-]+?)(?:\s*[(,]|$)/)?.[1] ?? "").trim();
  const majorWordings = [...new Set([major, "Computer Science", "Computer Engineering", "Software Engineering", "Engineering", "Information Technology"].filter(Boolean))];

  return {
    school: String(education.school ?? "").trim(),
    degreeWordings,
    majorWordings,
    startYear: endYear ? String(endYear - span) : "",
    endYear: endYear ? String(endYear) : "",
  };
}

/**
 * A profile link in the one form every board accepts. Workday refuses
 * "linkedin.com/in/x" and "https://linkedin.com/in/x" alike; it wants the
 * scheme and the www host. A bare handle is taken as a path on that host.
 */
export function profileLink(value, host) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const bare = host.replace(/^www\./, "");
  const match = raw.match(new RegExp(`^(?:https?://)?(?:[a-z]{2,3}\\.)?(?:www\\.)?${bare.replace(/\./g, "\\.")}(/.*)?$`, "i"));
  if (match) {
    const path = (match[1] ?? "").replace(/\/+$/, "");
    return `https://${host}${path}`;
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.includes("/") && !raw.includes(".")) return `https://${host}/${bare.includes("linkedin") ? "in/" : ""}${raw.replace(/^@/, "")}`;
  return `https://${raw.replace(/^\/+/, "")}`;
}

function formatSalary(profile, context) {
  const { amount } = desiredSalary(context.jd ?? "", Number(profile.salaryFallback) || 120000);
  return String(amount);
}

/**
 * Resolves one field against the profile and the job.
 *
 * `field` is what the page reported: label, name, id, type, required, options.
 */
export function resolveField(field, profile, context) {
  if (field.type === "hidden" || field.type === "submit" || field.type === "button") {
    return { outcome: "ignore" };
  }

  const subject = haystack(field);
  const rule = RULES.find((entry) => entry.pattern.test(subject) && (!entry.when || entry.when(field)));

  if (rule && rule.attach) {
    return { outcome: "attach", document: rule.attach, rule: rule.id };
  }

  if (rule && rule.onlyRequired && !field.required) {
    // Already holding a value - Workday carries the candidate's profile
    // from one application to the next - it is emptied, since the point is
    // that it goes unanswered.
    const held = String(field.current ?? "").trim();
    if (held && (field.type === "text" || field.type === "url")) {
      return { outcome: "fill", rule: rule.id, value: "", candidates: [""], cleared: true };
    }
    return { outcome: "skip", rule: rule.id, reason: "optional, and left empty on purpose" };
  }

  if (rule) {
    // A rule answers with one wording, or with several in preference order
    // for a menu whose entries it cannot see.
    const answer = rule.value(profile, context, field);
    const wordings = Array.isArray(answer) ? answer.map((entry) => String(entry ?? "").trim()).filter(Boolean) : null;
    const wanted = wordings ? (wordings[0] ?? "") : String(answer ?? "").trim();

    if (!wanted) {
      // A sensitive question with no answer behind it is the one case that must
      // stop the run rather than be improvised or quietly left out.
      if (rule.sensitive && field.required) {
        return { outcome: "blocked", rule: rule.id, reason: `"${field.label}" needs an answer the profile does not hold` };
      }
      if (field.required) {
        return { outcome: "blocked", rule: rule.id, reason: `"${field.label}" is required and the profile is empty for it` };
      }
      return { outcome: "skip", rule: rule.id, reason: "nothing in the profile for an optional field" };
    }

    // Several wordings are used as given, not expanded: expanding "Yes" into
    // "I am" would let it match the first entry of any status menu.
    const candidates = wordings ? [...new Set(wordings)] : expand(wanted);

    // A plain `<select>` lists its options up front, so a mismatch is knowable
    // now and worth refusing over. A react-select does not - its menu exists
    // only while open - so the wordings go to the page and the verify pass
    // afterwards is what catches a miss.
    const pick = typeof rule.pick === "function" ? rule.pick(profile, context, field) : null;
    const picking = Number.isFinite(pick) ? { pick } : {};

    if (field.options && field.options.length > 0) {
      const option =
        (wordings ?? [wanted]).map((wording) => chooseOption(field.options, wording)).find(Boolean) ??
        (picking.pick !== undefined ? pickOption(field.options, picking.pick) : null);
      if (!option) {
        if (field.required) {
          return {
            outcome: "blocked",
            rule: rule.id,
            reason: `"${field.label}" offers no option matching "${wanted}"`,
          };
        }
        return { outcome: "skip", rule: rule.id, reason: `no option matching "${wanted}"` };
      }
      return { outcome: "fill", value: option.value, candidates: [option.label || option.value], rule: rule.id };
    }

    return { outcome: "fill", value: wanted, candidates, rule: rule.id, ...(rule.sole ? { sole: true } : {}), ...picking };
  }

  // Nothing matched. Whether the model may try depends on what is being asked.
  if (looksSensitive(subject)) {
    return field.required
      ? { outcome: "blocked", reason: `"${field.label}" reads as a legal or demographic question with no profile answer` }
      : { outcome: "skip", reason: "unmatched question that the model may not answer" };
  }

  if (field.type === "file") {
    return field.required
      ? { outcome: "blocked", reason: `"${field.label}" wants a document that is not the resume or the cover letter` }
      : { outcome: "skip", reason: "an optional upload with nothing to put in it" };
  }

  return { outcome: "ask", question: field.label || field.name || field.id, options: field.options ?? [] };
}

/**
 * A backstop for questions the rules did not name.
 *
 * The rule list is written against the forms that have been seen; this catches
 * the phrasings that have not been. It errs toward refusing, because the cost
 * of a model answering a demographic question wrongly is far higher than the
 * cost of skipping a job.
 */
function looksSensitive(subject) {
  return /\bveteran\b|\bdisabilit|\brace\b|\bethnic|\bgender\b|\bhispanic\b|sponsorship|authoriz|authoris|\bvisa\b|\bcitizen|\bfelony\b|\bconvict|background check|drug (?:test|screen)|\bsalary history\b|\bdate of birth\b|\bssn\b|social security/.test(
    subject,
  );
}

/**
 * Resolves a whole form, keeping the fields that need a model separate.
 *
 * Returns blocked separately from skipped because they mean opposite things to
 * the caller: skipped fields are fine to leave empty, one blocked field means
 * this application should not be sent at all.
 */
export function resolveForm(fields, profile, context) {
  const fills = [];
  const attachments = [];
  const questions = [];
  const skipped = [];
  const blocked = [];

  for (const field of fields) {
    const result = resolveField(field, profile, context);
    switch (result.outcome) {
      case "fill":
        fills.push({
          key: field.key,
          value: result.value,
          candidates: result.candidates ?? [result.value],
          rule: result.rule,
          ...(result.sole ? { sole: true } : {}),
          ...(Number.isFinite(result.pick) ? { pick: result.pick } : {}),
        });
        break;
      case "attach":
        attachments.push({ key: field.key, document: result.document });
        break;
      case "ask":
        questions.push({
          key: field.key,
          question: result.question,
          options: result.options,
          required: field.required,
          // A one-line input wants a phrase; a textarea wants prose. Told
          // apart here because the model cannot see the box it is filling.
          multiline: field.tag === "textarea",
        });
        break;
      case "blocked":
        blocked.push({ key: field.key, label: field.label, reason: result.reason, rule: result.rule });
        break;
      case "skip":
        skipped.push({ key: field.key, label: field.label, reason: result.reason });
        break;
      default:
        break;
    }
  }

  return { fills, attachments, questions, skipped, blocked };
}
