/**
 * The model, used for the narrow slice of a form the profile cannot answer.
 *
 * That slice is the open-ended questions: why this company, describe your
 * experience with X, what interests you about the role. Everything factual
 * about the applicant has already been resolved from the profile before
 * anything here is called, and answers.js refuses to pass legal or demographic
 * questions through at all.
 *
 * Four sources ground an answer, in descending order of how much they know
 * about this particular job:
 *
 *   the cover letter - written for this exact application, so it already
 *     argues the fit in the applicant's voice
 *   the tailored resume - the bullets about to be attached, which say what
 *     this application is claiming
 *   the job description - what was actually asked for
 *   the master resume - the career behind all of them, used when there is no
 *     tailored resume to hand
 *
 * The tailored resume arrives as JSON alongside the PDF, so the bot reads the
 * same document the employer will. The master resume only matters for the
 * older path, where an application was generated earlier and all that was
 * saved beside it was a PDF nothing here can read.
 */

import { callModel, ProviderError } from "./vendor/generation.js";
import { record } from "./spend.js";
import { defaultModel, PROVIDERS } from "./writer.js";

/**
 * Keeps a bad key or a quota wall from looking like a hundred unanswerable forms.
 *
 * `fatal` separates the two things that used to be one. A rejected key or an
 * exhausted quota means the next job fails identically, so the run should end
 * rather than burn a page load per link proving it. A cut-off answer or a
 * provider hiccup is about this question, and ending a queue of forty over one
 * of them is its own kind of wrong.
 */
export class AiError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = "AiError";
    this.fatal = fatal;
  }
}

/**
 * Room to think, and then to answer.
 *
 * 600 was right when this called Gemini 2.0 Flash, which does not reason: a
 * paragraph fits easily. Reasoning models draw their thinking from the same
 * budget and spend it first, so a ceiling sized for the answer alone produces
 * no answer at all - the whole allowance goes on reasoning and the reply is
 * cut off mid-word. Sized for both now. Nothing is billed for headroom that
 * goes unused.
 */
const MAX_TOKENS = 4000;

/**
 * What is true of the candidate regardless of the job, stated outright.
 *
 * The resume is the model's main source, and its employers have cities. Asked
 * "where will you work from", a model with nothing else to go on answered
 * "San Francisco, where I've been based" - the city of the resume's last
 * employer - two fields below a location box that said Friendswood, Texas.
 * Inference from the resume is right for "describe your experience with X"
 * and wrong for anything about the person, so the facts about the person
 * come first and the model is told they win.
 */
function facts(context) {
  const lines = [
    context.location && `Lives in ${context.location}. This is where they are based and would work from.`,
    context.remotePreference && `Preferred working arrangement: ${context.remotePreference}.`,
    context.startDate && `Can start: ${context.startDate}.`,
    context.workAuthorization && `Work authorization: ${context.workAuthorization}.`,
    context.sponsorship && `Visa sponsorship: ${context.sponsorship}.`,
    context.relocation && `Relocation: ${context.relocation}.`,
    context.travel && `Travel: ${context.travel}.`,
    context.salary && `Salary expectation: ${context.salary}.`,
    `Employment status: between contracts. The most recent contract${context.currentCompany ? ` (${context.currentCompany})` : ""} has ended; not employed at the moment, and looking. Current company or employer: N/A.`,
    context.phone && `Phone: ${context.phone}.`,
    context.email && `Email: ${context.email}.`,
    ...(context.extraFacts ?? []),
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * The rule for a field the form will not send without.
 *
 * INSUFFICIENT is the right reply for an optional box, where blank is an
 * answer. For a required one it is a skipped application, and the applicant
 * has said they would rather send the honest, conservative answer than none:
 * the facts for anything about the person, the neutral option where the form
 * offers one, "N/A" where nothing applies.
 */
const MUST = `- This field is REQUIRED: the form cannot be sent without it, so INSUFFICIENT is not an acceptable reply. Answer it.
- For anything about the candidate's circumstances (location, authorization, availability, willingness, identity), answer from FACTS ABOUT THE CANDIDATE.
- Asked whether the candidate can meet a working expectation - hours, meetings, cameras, equipment, environment, policies, codes of conduct, training - answer yes, unless the facts say otherwise.
- Asked for a number of years or a rating with a technology, answer from the facts' figure for hands-on experience. Where the facts are silent on something else, give the conservative, truthful answer, "N/A" or "None" where nothing applies.
- Where options are offered and none clearly fits, choose the neutral one - "Prefer not to say", "Decline", "Not applicable", "Other", "None" - and otherwise the single most defensible one.
- Never leave the answer blank and never explain; reply with the answer only.`;

/** Everything the model may draw on, in descending order of how much it knows about this job. */
function sources(context) {
  return [
    facts(context) && `FACTS ABOUT THE CANDIDATE (these override anything the resume implies):\n${facts(context)}`,
    context.letter && `COVER LETTER FOR THIS JOB:\n${context.letter.slice(0, 6000)}`,
    context.resume && `RESUME SUBMITTED WITH THIS APPLICATION:\n${context.resume.slice(0, 8000)}`,
    context.jd && `JOB DESCRIPTION:\n${context.jd.slice(0, 8000)}`,
    // Skipped when a tailored resume is present: the two describe the same
    // career, and the tailored one describes it as this application does.
    !context.resume && context.masterResume && `CANDIDATE RESUME:\n${context.masterResume.slice(0, 8000)}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

const PROSE = "Answer in first person, plain prose, no greeting and no sign-off. Keep it to roughly 80-150 words, in two or three short paragraphs separated by a blank line: the direct answer first, the specifics from the candidate's experience next, and one closing sentence on what it means for this role. No headings, no bullet points.";
const ONE_LINE = "This is a one-line box. Answer with a short phrase or a single short sentence - a title, a name, a number, a place - not a paragraph.";

/** How one question wants its answer shaped: an option off its list, prose, or a phrase. */
function shapeOf(question) {
  if (question.options && question.options.length > 0) {
    return `Answer with exactly one of these options, copied verbatim - the option text alone, with no reasoning before or after it:\n${question.options.map((option) => `- ${option.label || option.value}`).join("\n")}`;
  }
  return question.multiline ? PROSE : ONE_LINE;
}

function prompt(question, context, must) {
  const choices = `\n\n${shapeOf(question)}`;

  return `You are filling in one field of ${context.company || "a company"}'s application form for the ${
    context.title || "role"
  }, on behalf of the candidate described below. Write as the candidate.

${sources(context)}

---

FORM QUESTION: ${question.question}${choices}

Rules:
- Use only what the sources above support. Do not invent employers, dates, numbers or credentials.
- Where the candidate lives, works from, or can start comes only from FACTS ABOUT THE CANDIDATE, never from the cities of past employers on the resume.
${must ? MUST : "- No placeholders of any kind. If the sources cannot support an answer, reply with exactly: INSUFFICIENT"}
- Return only the answer text itself.`;
}

const labelsOf = (options) => (options ?? []).map((option) => option.label || option.value || String(option)).filter(Boolean);

/** The neutral choice on a list, when there is one. */
function neutralOption(options) {
  return labelsOf(options).find((label) => /prefer not|decline|rather not|not applicable|^n\/a$|^none$|^other$/i.test(label)) ?? null;
}

/**
 * The option a reply names, when the reply is not simply the option.
 *
 * Asked to copy one entry verbatim, a reasoning model will sometimes think
 * aloud first and name its choice at the end - "...so the most reasonable
 * selection is: January". The choice is in there; this finds it. Exact
 * first, then the longest option the reply contains, then an option that
 * contains the whole reply. Null when the reply names nothing on the list.
 */
export function snapToOption(answer, options) {
  const labels = labelsOf(options);
  if (labels.length === 0) return null;
  const fold = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const reply = fold(answer);
  if (!reply) return null;

  const exact = labels.find((label) => fold(label) === reply);
  if (exact) return exact;

  const within = labels
    .filter((label) => fold(label).length >= 2 && reply.includes(fold(label)))
    .sort((a, b) => b.length - a.length)[0];
  if (within) return within;

  return labels.find((label) => fold(label).includes(reply)) ?? null;
}

/**
 * Answers one question, or returns null when it should be left alone.
 *
 * Null is a real outcome rather than a failure: a model that has nothing to go
 * on writes something plausible and false, and the caller can decide to skip an
 * optional field or abandon the job over a required one. A thrown AiError means
 * the service itself is unusable, which is a different problem and stops the
 * run instead of poisoning every remaining application.
 */
export async function answerQuestion(question, context, settings, { must = false } = {}) {
  if (!settings.apiKey) throw new AiError("no API key is set in the options page");

  const provider = PROVIDERS.includes(settings.provider) ? settings.provider : "openai";

  // The same provider, key and model that wrote the resume. One account to set
  // up, and the answers come from whatever the applicant chose to trust.
  let reply;
  // A rate limit is a pause, not a verdict: the provider wants a moment,
  // and a bot that runs for days with resumes being written beside it will
  // meet one. Waited out twice before it counts as a failed answer.
  for (let attempt = 0; ; attempt += 1) {
    try {
      reply = await callModel({
        provider,
        model: settings.model || defaultModel(provider),
        apiKey: settings.apiKey,
        temperature: 0.4,
        maxTokens: MAX_TOKENS,
        format: "text",
        system: "You fill in one field of a job application form, writing as the candidate.",
        messages: [{ role: "user", content: prompt(question, context, must) }],
      });
      break;
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.status === 401 || error.status === 403) {
          throw new AiError("the API key was rejected", { fatal: true });
        }
        if ((error.status === 429 || error.status >= 500) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 15000 * (attempt + 1)));
          continue;
        }
        if (error.status === 429) throw new AiError("the API rate limit was reached");
        throw new AiError(error.message);
      }
      throw new AiError(error?.message ?? String(error));
    }
  }

  record(settings.model || defaultModel(provider), reply);
  return settle(String(reply?.text ?? ""), question, must);
}

/**
 * A reply as it goes into the box: nothing for INSUFFICIENT on an optional
 * field, the neutral choice or N/A for one that must be answered, an entry
 * off the list for a list question, paragraphs for a long box.
 */
function settle(raw, question, must) {
  const answer = String(raw ?? "").trim();
  if (!answer || /^INSUFFICIENT\b/i.test(answer)) {
    // Told it must and still declined: the neutral option if the list has
    // one, N/A otherwise. A required box is never left to skip the job.
    return must ? (neutralOption(question.options) ?? "N/A") : null;
  }

  // Models like to wrap prose in quotes when told to return only the text.
  const cleaned = answer.replace(/^["'`]+|["'`]+$/g, "").trim();

  // A list question is answered with an entry on the list, or not at all.
  if (question.options && question.options.length > 0) {
    const snapped = snapToOption(cleaned, question.options);
    if (snapped) return snapped;
    return must ? (neutralOption(question.options) ?? labelsOf(question.options)[0]) : null;
  }
  return question.multiline ? paragraphed(cleaned) : cleaned;
}

/**
 * The whole page's questions in one call.
 *
 * The sources - the letter, the resume, the posting - are most of every
 * prompt, and asking seven questions one at a time sent them seven times.
 * Sent once with the questions numbered, the reply is an object keyed by
 * number, each value the answer under that question's own rules. A question
 * the sources cannot support is INSUFFICIENT, unless it is marked as one the
 * form will not send without.
 */
function batchPrompt(questions, context, must) {
  const asked = questions
    .map((question, index) => {
      const required = must.has(index);
      return `[${index + 1}]${required ? " (REQUIRED - the form cannot be sent without it; INSUFFICIENT is not acceptable here)" : ""} ${question.question}\n${shapeOf(question)}`;
    })
    .join("\n\n");

  return `You are filling in ${questions.length} fields of ${context.company || "a company"}'s application form for the ${
    context.title || "role"
  }, on behalf of the candidate described below. Write as the candidate.

${sources(context)}

---

FORM QUESTIONS:

${asked}

Rules:
- Use only what the sources above support. Do not invent employers, dates, numbers or credentials.
- Where the candidate lives, works from, or can start comes only from FACTS ABOUT THE CANDIDATE, never from the cities of past employers on the resume.
- For a question not marked REQUIRED: no placeholders of any kind; if the sources cannot support an answer, its value is exactly "INSUFFICIENT".
${must.size > 0 ? MUST.replace(/^- This field is REQUIRED[^\n]*\n/, "- For a question marked REQUIRED, answer it:\n") : ""}
- Reply with a JSON object only, no commentary: the keys are the question numbers as strings ("1", "2", ...), every question present, each value the answer text for that question alone.`;
}

/** The object in a reply that was asked for one, however it was wrapped. */
export function parseAnswers(text) {
  const raw = String(text ?? "").trim();
  const candidates = [raw, raw.replace(/^```(?:json)?\s*|\s*```$/g, ""), raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // The next shape may parse.
    }
  }
  return null;
}

/**
 * One call for a list of questions; null when the reply could not be read
 * as answers, in which case the caller falls back to asking one at a time.
 */
async function answerBatch(questions, context, settings, must) {
  if (!settings.apiKey) throw new AiError("no API key is set in the options page");
  const provider = PROVIDERS.includes(settings.provider) ? settings.provider : "openai";
  const model = settings.model || defaultModel(provider);

  let reply;
  for (let attempt = 0; ; attempt += 1) {
    try {
      reply = await callModel({
        provider,
        model,
        apiKey: settings.apiKey,
        temperature: 0.4,
        // Room for the thinking a reasoning model does first, then a page of answers.
        maxTokens: Math.min(16000, MAX_TOKENS + 1200 * questions.length),
        system: "You fill in the fields of a job application form, writing as the candidate, and reply with a JSON object.",
        messages: [{ role: "user", content: batchPrompt(questions, context, must) }],
      });
      break;
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.status === 401 || error.status === 403) throw new AiError("the API key was rejected", { fatal: true });
        if ((error.status === 429 || error.status >= 500) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 15000 * (attempt + 1)));
          continue;
        }
        if (error.status === 429) throw new AiError("the API rate limit was reached");
        throw new AiError(error.message);
      }
      throw new AiError(error?.message ?? String(error));
    }
  }
  record(model, reply);

  const parsed = parseAnswers(reply?.text);
  if (!parsed) return null;
  return questions.map((question, index) => {
    const value = parsed[String(index + 1)] ?? parsed[index + 1];
    if (value === undefined || value === null) return undefined;
    return settle(typeof value === "string" ? value : JSON.stringify(value), question, must.has(index));
  });
}

/**
 * Prose for a text box, in paragraphs.
 *
 * A long answer that arrives as one block is hard to read in a form's box,
 * and the model does not always break it up when asked. Anything already in
 * paragraphs is left as it is; a single block of four or more sentences is
 * split at sentence ends into two or three paragraphs of roughly even size.
 */
export function paragraphed(text) {
  const clean = String(text ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.includes("\n")) return clean;
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length < 4) return clean;
  const parts = sentences.length >= 6 ? 3 : 2;
  const paragraphs = [];
  let from = 0;
  for (let i = 0; i < parts; i++) {
    const to = i === parts - 1 ? sentences.length : Math.round(((i + 1) * sentences.length) / parts);
    paragraphs.push(sentences.slice(from, to).join(" "));
    from = to;
  }
  return paragraphs.filter(Boolean).join("\n\n");
}

/**
 * Answers a form's worth of questions in one call, two at most.
 *
 * One call for the page, whatever it asks: the sources that ground every
 * answer are sent once instead of once per question, which on a seven
 * question form is a sixth of the tokens. A required question the model
 * declined, or a reply that could not be read as answers, gets a second
 * call - those questions only, with the rule that they must be answered.
 * Anything still unreadable after that is asked one at a time, the way it
 * used to be. `unanswered` only ever holds optional fields, which are fine
 * to leave blank. Results are kept in the questions' order.
 */
export async function answerAll(questions, context, settings) {
  const results = new Array(questions.length);
  if (questions.length === 0) return { answers: [], unanswered: [], forced: [] };

  const BATCH = 10;
  for (let from = 0; from < questions.length; from += BATCH) {
    const slice = questions.slice(from, from + BATCH);
    const must = new Set(slice.map((question, index) => (question.must ? index : -1)).filter((index) => index >= 0));
    const first = await answerBatch(slice, context, settings, must);

    // The required ones that came back declined, and anything unreadable.
    const again = [];
    slice.forEach((question, index) => {
      const answer = first ? first[index] : undefined;
      if (answer === undefined || (answer === null && question.required)) again.push(index);
      else results[from + index] = { question, answer, wasForced: false };
    });

    if (again.length > 0) {
      const retry = again.map((index) => slice[index]);
      const second = await answerBatch(retry, context, settings, new Set(retry.map((question, index) => (question.required || question.must ? index : -1)).filter((index) => index >= 0)));
      for (let position = 0; position < again.length; position += 1) {
        const index = again[position];
        const question = slice[index];
        let answer = second ? second[position] : undefined;
        if (answer === undefined) {
          // Twice unreadable as a batch: this one on its own.
          answer = await answerQuestion(question, context, settings, { must: Boolean(question.required || question.must) });
        }
        results[from + index] = { question, answer, wasForced: Boolean(question.required && !question.must && answer !== null) };
      }
    }
  }

  const answers = [];
  const unanswered = [];
  const forced = [];
  for (const { question, answer, wasForced } of results) {
    if (wasForced) forced.push({ key: question.key, question: question.question, answer });
    if (answer === null) {
      unanswered.push({ key: question.key, question: question.question, required: question.required });
      continue;
    }
    answers.push({ key: question.key, value: answer, rule: "ai" });
  }

  return { answers, unanswered, forced };
}
