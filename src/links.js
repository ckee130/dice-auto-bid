/**
 * Turning a pasted list of Dice links into a queue.
 *
 * The input is whatever the applicant collected while browsing Dice: job
 * pages copied from the address bar, one per line or several to a line, with
 * whatever tracking the page added. Each becomes the posting's own id, and
 * from the id both pages the run needs are known - the posting and the
 * application wizard.
 *
 * Nothing here touches the DOM, the network or chrome.*, so the parsing is
 * testable off a browser.
 */

const JOB_ID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** The posting's id out of any Dice address that carries one, or "". */
export function diceJobId(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return "";
  }
  if (!/(^|\.)dice\.com$/i.test(parsed.hostname)) return "";
  // /job-detail/<id>, /jobs/detail/<slug>/<id>, /job-applications/<id>/wizard
  // all carry the id in the path; a search result carries it in the query.
  const inPath = parsed.pathname.match(JOB_ID)?.[1];
  if (inPath) return inPath.toLowerCase();
  for (const value of parsed.searchParams.values()) {
    const inQuery = value.match(JOB_ID)?.[1];
    if (inQuery) return inQuery.toLowerCase();
  }
  return "";
}

/** The posting page for an id. */
export const postingUrl = (id) => `https://www.dice.com/job-detail/${id}`;

/** The Easy Apply wizard for an id, the page the posting's button opens. */
export const wizardUrl = (id) => `https://www.dice.com/job-applications/${id}/wizard`;

/**
 * One link, in the form every record keeps it: the posting page by id, so
 * the same job pasted twice with different tracking is one job.
 */
export function canonicalUrl(url) {
  const id = diceJobId(url);
  if (id) return postingUrl(id);
  try {
    const parsed = new URL(String(url ?? "").trim());
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return String(url ?? "").trim().replace(/\/+$/, "");
  }
}

/**
 * Every link in a block of text, in the order they appear.
 *
 * Deliberately indifferent to how they were pasted: one per line, several to
 * a line, wrapped in a spreadsheet's quotes, or trailed by a comma. Trailing
 * punctuation is stripped because a link at the end of a sentence collects it.
 */
export function extractLinks(text) {
  const matches = String(text ?? "").match(/https?:\/\/[^\s",<>)]+/gi) ?? [];
  return matches.map((link) => link.replace(/[.,;:]+$/, ""));
}

/**
 * The queue, in order, with repeats removed and anything that is not a Dice
 * posting set aside with the reason.
 *
 * Order is kept because the applicant's own ordering is usually priority.
 */
export function buildQueue(sources) {
  const seen = new Set();
  const queue = [];
  const rejected = [];

  for (const source of sources) {
    for (const link of extractLinks(source)) {
      const id = diceJobId(link);
      if (!id) {
        rejected.push({ link, reason: "not a Dice job link" });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push({ id, link: postingUrl(id), pasted: link });
    }
  }
  return { queue, rejected };
}
