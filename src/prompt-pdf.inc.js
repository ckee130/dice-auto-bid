
// Extension-owned reference layout, appended to the vendor bundle by build.mjs.
// Font and accent remain theme settings; the DOCX supplies layout only.
export async function buildPromptResumePdf(resume, theme = DEFAULT_THEME) {
  const document = await PDFDocument_default.create();
  document.setTitle(`${resume.name} - ${resume.targetTitle}`);
  document.setAuthor(resume.name);
  const fonts = await embedFonts(document, theme);
  const layout = new Layout(document, fonts);
  const body = theme.baseSize;
  const accent = hex(theme.accentColor);
  const ink = hex("1C1C1C"), muted = hex("5C5C5C");
  const left = 36, width = 540;
  const gap = twips => pt(twips) * spacingScale(theme.density);
  const leading = body * 1.38;
  const span = (text, style = {}) => ({ text, style: { size: body, color: ink, ...style } });
  const draw = (spans, options = {}) => layout.paragraph(spans, { x: left, width, lineHeight: leading, ...options });
  const paragraph = (text, style = {}, options = {}) => draw([span(text, style)], options);
  const height = (spans, contentWidth = width, lineHeight = leading) => layout.wrap(spans, contentWidth).length * lineHeight;
  const heading = (title, first = false) => {
    layout.ensure(gap(first ? 100 : 180) + leading * 4);
    layout.space(gap(first ? 100 : 180));
    paragraph(title, { color: accent, bold: true, size: body + 2 }, { lineHeight: body * 1.5 });
    layout.space(gap(40));
    layout.page.drawLine({ start: { x: left, y: layout.y }, end: { x: left + width, y: layout.y }, thickness: 1.25, color: accent });
    layout.space(gap(90));
  };
  const groups = rows => rows.forEach((group, index) => {
    if (index) layout.space(gap(60));
    draw([span(`${group.category}: `, { bold: true }), span(group.skills.join("; "))]);
    layout.space(gap(30));
  });

  layout.space(gap(20));
  paragraph(resume.name, { size: body + 12, color: accent, bold: true }, { align: "center", lineHeight: body + 14 });
  layout.space(gap(40));
  paragraph(resume.targetTitle, { size: body - 0.5, color: muted, italic: true }, { align: "center", lineHeight: body * 1.3 });
  layout.space(gap(50));
  const contact = [resume.contact.location, resume.contact.phone, resume.contact.email, ...(resume.contact.links ?? []).map(link => link.url)].filter(Boolean);
  paragraph(contact.join(" | "), { size: body - 1.5 }, { align: "center", lineHeight: body * 1.2 });
  layout.space(gap(140));

  heading("Professional Summary", true);
  paragraph(resume.summary, {}, { lineHeight: body * 1.43 });
  layout.space(gap(70));
  heading("Work Experience");
  for (const [index, role] of resume.experience.entries()) {
    const title = [span(role.role, { bold: true, size: body + 0.5 })];
    const metadata = [
      span(role.company, { bold: true, size: body - 1.5 }),
      span(`  ·  ${[role.location, `${role.startDate} - ${role.endDate}`].filter(Boolean).join("  ·  ")}`, { size: body - 1.5, color: muted }),
    ];
    const scope = [span(role.scope ?? "")];
    const opening = [span(role.bullets[0] ?? "")];
    // Keep each role header, description and first bullet together. Keep each
    // later bullet intact as well, avoiding a continuation line on a new page.
    layout.ensure(height(title) + height(metadata) + height(scope) + height(opening, width - 14.4) + gap(index ? 320 : 200));
    layout.space(gap(index ? 150 : 30));
    draw(title);
    layout.space(gap(30));
    draw(metadata);
    layout.space(gap(80));
    draw(scope);
    layout.space(gap(40));
    for (const bullet of role.bullets) {
      const spans = [span(bullet)];
      layout.ensure(height(spans, width - 14.4));
      draw(spans, { x: left + 14.4, width: width - 14.4, marker: { span: span("•"), x: left + 3.6 } });
      layout.space(gap(36));
    }
  }
  heading("Technical Skills");
  groups(resume.coreSkills);
  heading("Education");
  const school = resume.education;
  draw([
    span(school.degree, { bold: true }),
    span(`  —  ${[school.school, school.location, school.year].filter(Boolean).join("  ·  ")}`),
  ]);
  layout.space(gap(60));
  if (school.detail) paragraph(school.detail, { color: muted, size: body - 0.5 });
  heading("Core Competencies");
  groups(resume.competencies);
  return document.save();
}
