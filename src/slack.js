/**
 * Slack: one message to a channel when a job needs a person.
 *
 * The bot runs on a machine nobody is watching. When a form is filled but
 * cannot be sent - a captcha puzzle on Submit, a code that never came, a
 * Workday page wanting an ID - the tab is left open as it stands and the
 * applicant finishes it by hand. This is how they hear about it: a message
 * in the channel from settings, with the job, the reason, the link and the
 * folder on disk. Sent with a bot token through chat.postMessage; the token
 * needs the chat:write scope and the bot has to be in the channel.
 *
 * Never a reason to stop a run. A message that cannot be sent is logged and
 * the run goes on; the job is still on the day's table and in its folder.
 */

const POST_MESSAGE = "https://slack.com/api/chat.postMessage";

/** Whether the settings carry enough to send anything. */
export function slackConfigured(profile) {
  return Boolean(String(profile?.slackToken ?? "").trim() && String(profile?.slackChannel ?? "").trim());
}

/**
 * A channel as typed: "#jobs", "jobs" or a channel ID. Slack takes the ID
 * or the name with its "#", so a bare name gets the "#" back.
 */
export function slackChannelOf(value) {
  const channel = String(value ?? "").trim();
  if (!channel) return "";
  if (/^[CGD][A-Z0-9]{8,}$/.test(channel)) return channel;
  return channel.startsWith("#") || channel.startsWith("@") ? channel : `#${channel}`;
}

/** Slack's mrkdwn escapes: the three characters it reads as markup. */
export function mrkdwn(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Posts one message. Resolves to { ok, error }; never throws, because the
 * caller is in the middle of a run and a notification is not worth ending it.
 */
export async function postSlack(profile, text, { fetchImpl = fetch } = {}) {
  if (!slackConfigured(profile)) return { ok: false, error: "Slack is not set up: a bot token and a channel are needed" };
  const channel = slackChannelOf(profile.slackChannel);
  try {
    const response = await fetchImpl(POST_MESSAGE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(profile.slackToken).trim()}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return { ok: false, error: describeSlackError(payload.error, response.status) };
    return { ok: true, ts: payload.ts, channel: payload.channel };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Slack's error codes, in words that say what to do about them. */
export function describeSlackError(code, status) {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "account_inactive":
      return "Slack rejected the token; paste the bot token (starts with xoxb-) from the app's OAuth page";
    case "channel_not_found":
      return "Slack cannot find that channel; use its name as it appears in Slack, or its ID, and invite the bot to it";
    case "not_in_channel":
      return "the bot is not in that channel; open the channel in Slack and type /invite @<the bot>";
    case "missing_scope":
      return "the token lacks the chat:write scope; add it under OAuth & Permissions and reinstall the app";
    case "ratelimited":
      return "Slack is rate limiting the bot; the message was not sent";
    case undefined:
    case "":
      return `Slack answered ${status ?? "with an error"}`;
    default:
      return `Slack said "${code}"`;
  }
}

/**
 * The message for a job that needs the applicant. Short, scannable on a
 * phone: what, why, where the form is, where the files are.
 *
 * Two kinds. "finish": the form is filled and was not sent, and the
 * applicant sends it. "check": Submit was pressed and the page said nothing
 * either way; the applicant looks, and does not press it again unless the
 * page plainly still holds the form.
 */
export function needsYouMessage({ kind = "finish", company, title, reason, applyUrl, sourceUrl, folder, tabOpen, applicant }) {
  const who = applicant ? ` (${applicant})` : "";
  const heading = kind === "check" ? `:eyes: *Check this one${who}:*` : `:raised_hand: *Needs you${who}:*`;
  const lines = [`${heading} ${mrkdwn(company || "")}${title ? ` - ${mrkdwn(title)}` : ""}`, `*Why:* ${mrkdwn(reason || "")}`];
  const open = kind === "check" ? "  (the tab is open in the browser; see whether it went before pressing anything)" : "  (the tab is open in the browser, filled as far as it got)";
  if (applyUrl) lines.push(`*Form:* <${applyUrl}>${tabOpen ? open : ""}`);
  if (sourceUrl && sourceUrl !== applyUrl) lines.push(`*Found via:* <${sourceUrl}>`);
  if (folder) lines.push(`*Files:* Downloads/job applied-folder/${mrkdwn(folder)}`);
  return lines.join("\n");
}

/** The message at the end of a run: what went, what is waiting. */
export function runSummaryMessage({ applicant, sent, waiting, failed, skipped, stopped }) {
  const who = applicant ? ` (${applicant})` : "";
  const lines = [`:checkered_flag: *Run ${stopped ? "stopped" : "finished"}${who}:* ${sent} sent, ${waiting.length} waiting for you, ${failed} failed, ${skipped} skipped.`];
  for (const job of waiting.slice(0, 20)) {
    lines.push(`• ${mrkdwn(job.company || "")}${job.title ? ` - ${mrkdwn(job.title)}` : ""}${job.applyUrl ? ` <${job.applyUrl}|form>` : ""}`);
  }
  if (waiting.length > 20) lines.push(`• and ${waiting.length - 20} more on the day's other links table`);
  return lines.join("\n");
}
