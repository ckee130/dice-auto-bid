/**
 * The extension's main prompt governs resume generation and structural validation.
 * Shared provider/PDF primitives and cover-letter generation come from the vendor
 * bundle; the extension owns the resume schema adapter and reference layout.
 */

import {
  ACCENT_OPTIONS,
  buildPromptResumePdf as buildResumePdf,
  buildCoverLetterPdf,
  DEFAULT_CANDIDATE,
  DEFAULT_MODELS,
  DEFAULT_SLOTS,
  DEFAULT_THEME,
  EMPLOYER_SIZES,
  employerBand,
  RESUME_FORMATS,
  formatSpec,
  describeKeyProblem,
  FONT_OPTIONS,
  generateCoverLetter,
  PROVIDER_LABELS,
  ProviderError,
} from "./vendor/generation.js";
import { generatePromptResume as generateResume } from "./prompt-generation.js";
import { DEFAULT_RESUME_PROMPT } from "./resume-prompt.js";
import { profileLink } from "./answers.js";
import { experiencePeriods } from "./profile.js";
import { record } from "./spend.js";

export class WriterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WriterError";
    this.status = status;
  }
}

export const PROVIDERS = Object.keys(DEFAULT_MODELS);
export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? provider;
export const defaultModel = (provider) => DEFAULT_MODELS[provider] ?? "";
export const FONTS = FONT_OPTIONS;
export const ACCENTS = ACCENT_OPTIONS;
export const FORMATS = Object.values(RESUME_FORMATS);
export const SIZES = Object.values(EMPLOYER_SIZES);

/** The employer headcount band the profile asks for; mid-sized when unset or unknown. */
export function sizeFrom(profile) {
  return employerBand(profile?.companySize).id;
}

/** The resume shape the profile asks for; classic when unset or unknown. */
export function formatFrom(profile) {
  return formatSpec(profile?.resumeFormat).id;
}

/**
 * Whether the resume carries a line under each employer saying what the
 * company does. On unless the profile turns it off - a profile saved before
 * the setting existed has no key, and keeps the line it always had.
 */
export function describesCompanies(profile) {
  return profile?.companyDescriptions !== false;
}

/**
 * The same resume with each role's employer and dates set to the profile's
 * exactly - the spelling the person typed, the months they gave. The
 * validator already holds the model to these; this is the belt to its
 * braces, since the employer line is the one a reference check reads.
 */
export function withPinnedEmployers(resume, slots) {
  if (!Array.isArray(resume?.experience)) return resume;
  return {
    ...resume,
    experience: resume.experience.map((role, index) => {
      const slot = slots[index];
      if (!slot?.company) return role;
      return {
        ...role,
        company: slot.company,
        location: slot.location || role.location,
        startDate: slot.startDate,
        endDate: slot.endDate,
      };
    }),
  };
}

/** The same resume with the company description dropped from every role. */
export function withoutCompanyContext(resume) {
  if (!Array.isArray(resume?.experience)) return resume;
  return {
    ...resume,
    experience: resume.experience.map(({ companyContext, ...role }) => role),
  };
}

/**
 * The applicant, in the shape the generator expects.
 *
 * Taken from the profile rather than from the app's defaults, so the resume
 * carries the contact details that are about to be typed into the form. A
 * resume naming one email while the form carries another is the kind of
 * mismatch a recruiter notices and nobody intends.
 */
export function candidateFrom(profile) {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const location = [profile.city, profile.state].filter(Boolean).join(", ");

  return {
    name: name || DEFAULT_CANDIDATE.name,
    email: profile.email || DEFAULT_CANDIDATE.email,
    phone: profile.phone || DEFAULT_CANDIDATE.phone,
    location: location || DEFAULT_CANDIDATE.location,
    education: educationFrom(profile),
    // The links are only printed when the profile says so; the forms still
    // get them from the profile directly.
    links: profile.linksOnResume === false ? [] : linksFrom(profile),
  };
}

/**
 * The profile links the resume's contact line carries, LinkedIn first,
 * each in the short form a resume prints - "linkedin.com/in/steven", not
 * the scheme and www that the forms are given. Only the ones set.
 */
export function linksFrom(profile) {
  const short = (url) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const links = [
    { label: "LinkedIn", url: profileLink(profile.linkedin, "www.linkedin.com") },
    { label: "GitHub", url: profileLink(profile.github, "github.com") },
    { label: "Website", url: String(profile.website ?? "").trim() ? String(profile.website).trim().replace(/^(?!https?:\/\/)/i, "https://") : "" },
  ];
  return links.filter((link) => link.url).map((link) => ({ label: link.label, url: short(link.url) }));
}

/** The degree on every resume, as typed on the options page. */
export function educationFrom(profile) {
  const fallback = DEFAULT_CANDIDATE.education;
  return {
    degree: String(profile.degree ?? "").trim() || fallback.degree,
    school: String(profile.school ?? "").trim() || fallback.school,
    location: String(profile.schoolLocation ?? "").trim() || fallback.location,
    year: String(profile.graduationYear ?? "").trim() || fallback.year,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-03" as the resume prints it: "Mar 2024". */
export const monthLabel = (value) => {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})$/);
  return match ? `${MONTHS[Number(match[2]) - 1]} ${match[1]}` : String(value ?? "");
};

/**
 * The tenures the resume is written onto, from the job rows on the
 * options page. The model is handed these as fixed slots - employer and
 * dates - and invents the title and the work inside each; the employer
 * and the dates it may not touch. The
 * newest role carries the most bullets and the oldest the fewest, as the
 * reference resumes do, and an employer has to have been founded a couple
 * of years before a tenure starts to be plausible for it.
 */
export function slotsFrom(profile) {
  const periods = experiencePeriods(profile);
  if (periods.length === 0) return DEFAULT_SLOTS;
  return periods.map((period, index) => ({
    company: period.company,
    location: period.location,
    startDate: monthLabel(period.from),
    endDate: period.to ? monthLabel(period.to) : "Present",
    bulletCount: index === 0 ? 5 : index === periods.length - 1 && periods.length > 1 ? 3 : 4,
    maxFoundedYear: Number(period.from.slice(0, 4)) - 2,
  }));
}

/** The PDF's styling, from the options page, with anything unrecognised falling back to the app's default. */
export function themeFrom(profile) {
  const accent = String(profile.accentColor ?? "").replace(/^#/, "").toUpperCase();
  const size = Number(profile.baseSize);
  return {
    fontFamily: FONT_OPTIONS.includes(profile.fontFamily) ? profile.fontFamily : DEFAULT_THEME.fontFamily,
    accentColor: /^[0-9A-F]{6}$/.test(accent) ? accent : DEFAULT_THEME.accentColor,
    density: ["compact", "normal", "roomy"].includes(profile.density) ? profile.density : DEFAULT_THEME.density,
    baseSize: Number.isFinite(size) && size >= 9 && size <= 12 ? size : DEFAULT_THEME.baseSize,
  };
}

function settingsFrom(profile) {
  const provider = PROVIDERS.includes(profile.provider) ? profile.provider : "openai";
  const apiKey = String(profile.apiKey ?? "").trim();
  if (!apiKey) {
    throw new WriterError(`No ${providerLabel(provider)} key set. Add one on the options page.`, 401);
  }

  const problem = describeKeyProblem(provider, apiKey);
  if (problem) throw new WriterError(problem, 401);

  return {
    provider,
    apiKey,
    model: String(profile.model ?? "").trim() || defaultModel(provider),
    temperature: 0.6,
    candidate: candidateFrom(profile),
    slots: slotsFrom(profile),
    theme: themeFrom(profile),
    format: formatFrom(profile),
    companySize: sizeFrom(profile),
  };
}

/** The current embedded resume prompt, evaluated with the applicant and job rows on screen. */
export function defaultResumePrompt() {
  return DEFAULT_RESUME_PROMPT;
}

/** Use the main prompt verbatim; adapt fields after generation, never in the model instructions. */
function generationPrompt(profile) {
  return String(profile.resumePrompt ?? "").trim() || defaultResumePrompt();
}

/**
 * The name an uploaded document carries, matching the app: the candidate's
 * name and the document in letters, digits and underscores only -
 * "Steven_Atkins_Resume.pdf". Resume scanners mark spaces and punctuation in
 * a file name down, because some tracking systems mangle them on upload.
 */
function documentFileName(candidateName, document, extension) {
  const person = safeName(candidateName, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${person ? `${person}_` : ""}${document}${extension}`;
}

/** Characters a file name cannot carry, matching what the app writes to disk. */
function safeName(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

/**
 * The generated resume as prose, for grounding the form's open questions.
 *
 * The PDF is what the employer gets and is unreadable once rendered. The
 * object it was rendered from is the same document before layout, so
 * flattening it gives the bot the tailored bullets it is about to attach -
 * written for this exact posting, which is a better answer to "describe your
 * experience with X" than any general resume could be.
 */
export function resumeToText(resume) {
  if (!resume) return "";

  const lines = [`${resume.name ?? ""} - ${resume.targetTitle ?? ""}`.trim(), resume.summary ?? ""];
  for (const line of resume.highlights ?? []) lines.push(`- ${line}`);

  for (const bucket of resume.coreSkills ?? []) {
    lines.push(`${bucket.category}: ${(bucket.skills ?? []).join(", ")}`);
  }

  for (const job of resume.experience ?? []) {
    lines.push("", `${job.role} at ${job.company} (${job.startDate} - ${job.endDate}, ${job.location})`);
    if (job.scope) lines.push(job.scope);
    for (const bullet of job.bullets ?? []) lines.push(`- ${bullet}`);
    if (job.environment?.length) lines.push(`Environment: ${job.environment.join(", ")}`);
  }

  for (const group of resume.competencies ?? []) lines.push(`${group.category}: ${group.skills.join(", ")}`);

  const school = resume.education;
  if (school?.degree) lines.push("", `${school.degree}, ${school.school} (${school.year})`);

  return lines.filter((line) => line !== undefined && line !== null).join("\n").trim();
}

/**
 * Generates only a resume and opens no application. Used by the settings
 * page to preview the exact PDF a real run would attach, without paying for
 * a cover letter or touching Dice.
 */
export async function writeResumePreview(profile, job, signal) {
  const settings = settingsFrom(profile);
  try {
    const spec = formatSpec(settings.format);
    const generated = await generateResume(
      job.jd,
      {
        ...settings,
        systemPrompt: generationPrompt(profile),
        pinnedCompanies: settings.slots.map((slot) => slot.company),
        useCuratedCompanies: false,
        includeScopeLine: true,
        includeEnvironmentLine: spec.environmentLine,
        variant: spec.variant,
      },
      signal,
    );
    const resume = generated.resume;
    const pdf = await buildResumePdf(resume, settings.theme, settings.format);
    const name = resume.name || settings.candidate.name;
    return {
      resume,
      resumeText: resumeToText(resume),
      resumeBlob: new Blob([pdf.slice()], { type: "application/pdf" }),
      resumeName: documentFileName(name, "Resume_Preview", ".pdf"),
      violations: generated.violations,
      spend: record(settings.model, generated.usage ?? {}),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw new WriterError(error.message, error.status);
    throw error;
  }
}

/**
 * A resume and cover letter written for this posting, and the PDF to attach.
 *
 * Called only after the posting has been confirmed to take Easy Apply, so
 * a posting this bot cannot submit never costs a model call.
 *
 * Explicit employment locks in the main prompt take precedence. Otherwise,
 * the profile job rows define the employers and dates. Generated content is
 * adapted to PDF fields without rewriting its employment history.
 */
export async function writeApplication(profile, job, signal) {
  const settings = settingsFrom(profile);

  try {
    const spec = formatSpec(settings.format);
    const generated = await generateResume(
      job.jd,
      {
        ...settings,
        systemPrompt: generationPrompt(profile),
        pinnedCompanies: settings.slots.map((slot) => slot.company),
        useCuratedCompanies: false,
        includeScopeLine: true,
        includeEnvironmentLine: spec.environmentLine,
        variant: spec.variant,
      },
      signal,
    );

    // Use the generated draft without a prompt-compliance gate. Do not repin dates,
    // employers or counts from settings over its explicit employment locks.
    const resume = generated.resume;
    const role = job.title?.trim() || resume.targetTitle || "the role";
    const company = job.company?.trim() || resume.tailoring?.jdCompany || "";
    const spend = { resume: record(settings.model, generated.usage ?? {}) };

    // Sequential, not parallel: the letter is written against the resume that
    // was just generated, so it cites the same career the resume claims.
    const letter = await generateCoverLetter(job.jd, { ...settings, role, company, resume }, signal);
    spend.letter = record(settings.model, letter.usage ?? {});

    const pdf = await buildResumePdf(resume, settings.theme, settings.format);
    const name = resume.name || settings.candidate.name;
    // The letter goes as a PDF too: Rippling and Workable take only
    // documents, and a .txt put into their upload box is dropped without a
    // word. The text itself is kept beside it for the folder and the forms
    // that ask for the letter in a box.
    const letterPdf = await buildCoverLetterPdf(letter.text, { name, contact: resume.contact, role, company }, settings.theme);

    return {
      resume,
      resumeText: resumeToText(resume),
      letterText: letter.text,
      // sliced() so the Blob takes the bytes rather than the pool they came from.
      resumeBlob: new Blob([pdf.slice()], { type: "application/pdf" }),
      letterBlob: new Blob([letterPdf.slice()], { type: "application/pdf" }),
      resumeName: documentFileName(name, "Resume", ".pdf"),
      letterName: documentFileName(name, "Cover_Letter", ".pdf"),
      role,
      company,
      violations: [...generated.violations, ...letter.violations],
      // What the two cost, in words for the log.
      spend,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw new WriterError(error.message, error.status);
    throw error;
  }
}

/**
 * Confirms the key before a run rather than on the first job.
 *
 * Checked by shape, not by spending a call: a key with the wrong prefix for
 * its provider is the common mistake, and finding it out for free is better
 * than finding it out after a page load.
 */
export function checkWriter(profile) {
  try {
    const settings = settingsFrom(profile);
    return { ok: true, provider: providerLabel(settings.provider), model: settings.model };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}
