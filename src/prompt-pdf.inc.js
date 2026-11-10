
// Extension-owned renderer. Appended to the vendor bundle by build.mjs.
// It shares the PDF primitives but never the vendor's content/schema rules.
export async function buildPromptResumePdf(resume, theme = DEFAULT_THEME) {
  const document = await PDFDocument_default.create();
  document.setTitle(`${resume.name} - ${resume.targetTitle}`);
  document.setAuthor(resume.name);
  const fonts = await embedFonts(document, theme);
  const layout = new Layout(document, fonts);
  const canvas = { layout, accent: hex(theme.accentColor), body: theme.baseSize, gap: twips => pt(twips) * spacingScale(theme.density) };
  const { body, accent, gap } = canvas;
  const paragraph = (text, style = {}) => layout.paragraph([{ text, style: { size: body, color: NEUTRAL, ...style } }]);
  const heading = title => {
    layout.space(gap(190));
    keepWithNext(canvas);
    paragraph(title.toUpperCase(), { color: accent, bold: true, size: body + 0.5 });
    layout.space(gap(80));
  };
  paragraph(resume.name, { size: body + 15, color: accent, bold: true });
  layout.space(gap(45));
  paragraph(resume.targetTitle, { size: body + 0.5, bold: true });
  layout.space(gap(40));
  paragraph(contactParts(resume).join(" | "), { size: body - 0.5, color: MUTED });
  heading("Professional Summary");
  paragraph(resume.summary);
  heading("Work Experience");
  for (const [index, role] of resume.experience.entries()) {
    if (index) layout.space(gap(170));
    // Keep title, employer, context and the opening bullet together where possible.
    layout.ensure(body * LINE_RATIO * (6 + Math.ceil(role.scope.length / 95)));
    paragraph(role.role, { bold: true, color: HEADING_INK });
    layout.space(gap(30));
    paragraph([role.company, role.location, `${role.startDate} - ${role.endDate}`].filter(Boolean).join(" · "), { size: body - 0.5, color: accent });
    layout.space(gap(40));
    paragraph(role.scope, { size: body - 0.5, color: MUTED });
    layout.space(gap(45));
    bullets(canvas, role.bullets);
  }
  heading("Technical Skills");
  skillLines(canvas, resume);
  heading("Education");
  educationBlock(canvas, resume);
  heading("Core Competencies");
  skillLines(canvas, { coreSkills: resume.competencies });
  return document.save();
}
