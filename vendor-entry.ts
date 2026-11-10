/**
 * What the extension needs out of the app, gathered in one place.
 *
 * The bot writes its own resumes now - it calls no API and the app does not
 * have to be running. But "writes its own" must not mean "writes them
 * differently": the rules about what may be claimed, the repair passes, the
 * voice checks and the PDF layout took a long time to get right, and a second
 * implementation of them would be wrong in ways nobody would notice until an
 * application had already been sent.
 *
 * So this is not a copy. `build.mjs` compiles the app's own modules through
 * this file into src/vendor/generation.js, which means a fix to the prompt or
 * the layout reaches the bot by rebuilding rather than by being retyped.
 */

export { generateResume } from "../src/lib/generate";
export { generateCoverLetter } from "../src/lib/coverLetter";
export { buildResumePdf, buildCoverLetterPdf } from "../src/lib/pdf";
export { callModel, describeKeyProblem, ProviderError } from "../src/lib/providers";
export { DEFAULT_CANDIDATE, DEFAULT_MODELS, DEFAULT_SLOTS, PROVIDER_LABELS } from "../src/lib/defaults";
export { ACCENT_OPTIONS, DEFAULT_THEME, FONT_OPTIONS } from "../src/lib/theme";
export { DEFAULT_FORMAT, RESUME_FORMATS, formatSpec } from "../src/lib/formats";
export { DEFAULT_EMPLOYER_SIZE, EMPLOYER_SIZES, employerBand } from "../src/lib/companies";
export { analyzeJd, mentions } from "../src/lib/jd";
