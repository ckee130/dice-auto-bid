/** Wait after one Submit click; a transient review page is not a failure. */
export async function waitForSubmission(read, { timeout = 15000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now();
  let last;
  while (now() - started < timeout) {
    const page = await read().catch(() => null);
    if (page) {
      last = page;
      if (page.errors?.length || ["done", "applied", "signin", "gone", "questions", "resume"].includes(page.step)) return page;
    }
    await sleep(500);
  }
  return last ?? { step: "unknown", errors: [], text: "" };
}
