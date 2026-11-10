/** Resolve explicit prompt employment locks before considering profile job rows. */
export function employmentRules(prompt, slots) {
  const matches = [...prompt.matchAll(/^- company_\d+:\s*([^|\n]+)\|\s*([^|\n]+)\|\s*(\d+) bullets\s*\|\s*([^\n]+)/gm)];
  const fixed = [...new Map(matches.map(match => [match[0].match(/company_\d+/)[0], match])).values()];
  return fixed.length ? fixed.map(([, company, dates, count, status]) => {
    const [startDate, endDate] = dates.trim().split(/\s+-\s+/);
    return { company: company.trim(), startDate, endDate, bulletCount: Number(count), internship: /intern/i.test(status) };
  }) : slots;
}
