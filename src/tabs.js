/**
 * Tabs: the ones the user keeps open for the run, and how a page is waited for.
 *
 * Gmail in the first tab, signed in as the applicant: the one page the run
 * reads that it does not open itself, for the security codes boards mail
 * out. The mailbox reader asks here for that tab; when none is open it
 * falls back to opening one. Everything else the run opens, and closes
 * when done - except the forms it fills but cannot send, which stay open
 * for the applicant (see background.js).
 *
 * Every tab the run opens is brought to the front. Chrome throttles a tab
 * that is not on screen - timers, rendering, on Windows the network too -
 * and on a VPS whose Remote Desktop session is disconnected there is no
 * screen at all, so a background tab can take a minute to do what a front
 * one does in three seconds. The run has nothing else to show, so the front
 * is where its tabs go.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loading longer than this is given up on - unless the document is already usable. */
const LOAD_TIMEOUT_MS = 90000;

/**
 * How long a parsed page is given to go from interactive to complete before
 * it is used as it is. Past this what is still loading is an analytics
 * beacon or an image, not the form.
 */
const INTERACTIVE_GRACE_MS = 3000;

/**
 * The first open tab whose address matches, by window then by position, so
 * the one the user put at the front of the window wins when there are two.
 */
export async function findTab(patterns, accept = () => true) {
  const tabs = await chrome.tabs.query({ url: patterns }).catch(() => []);
  const usable = tabs.filter((tab) => tab.id && accept(tab));
  usable.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  return usable[0] ?? null;
}

/** Brings a tab, and its window, to the front. */
export async function focus(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab;
}

/* ----------------------------------------------------------- the front */

/**
 * Only one tab can be in front, so page work takes turns at it.
 *
 * Three postings being opened at once meant three tabs loading at once, of
 * which only the active one loaded at speed; the others sat throttled until
 * their turn came, if it came before the deadline. So every stretch of work
 * that needs a tab on screen - loading a posting, following its apply
 * button, reading a mailbox - goes through `atFront`, which runs them one
 * after another. Writing a resume needs no tab and is not in the queue.
 *
 * The form being filled is the resident: it stays in front between turns,
 * and gets the front back the moment a turn ends.
 */
let line = Promise.resolve();
let residentId = null;

/** The tab that should be in front whenever nothing else needs it. */
export function resident(tabId) {
  residentId = tabId ?? null;
}

export async function atFront(work) {
  const turn = line.then(work, work);
  line = turn.then(
    () => {},
    () => {},
  );
  try {
    return await turn;
  } finally {
    if (residentId !== null) await focus(residentId);
  }
}

/** Runs inside the page. Where the document is in its loading. */
function readiness() {
  return { state: document.readyState, href: location.href };
}

/**
 * Resolves once the page in the tab is usable.
 *
 * Chrome's own "complete" for a tab waits on every last resource, and a
 * page that is otherwise ready can sit on a slow tracker or font for most
 * of a minute, which is how jobs were being lost to the load timeout. So
 * the document is asked directly: parsed and fully loaded is done, parsed
 * and still fetching is done after a short grace, and only a page that has
 * not even parsed by the deadline is given up on.
 */
export async function settled(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  const started = Date.now();
  let interactiveSince = 0;
  // A reload or navigation takes a moment to register as "loading".
  await wait(300);

  for (;;) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error("the tab closed before the page loaded");
    if (current.status === "complete" && !current.pendingUrl) return tabId;

    // The document is only worth asking once the tab is on its page: before
    // that the answer is about:blank's, which is always "complete".
    let page = null;
    if (!current.pendingUrl && /^https?:/.test(current.url ?? "")) {
      page = await chrome.scripting
        .executeScript({ target: { tabId }, func: readiness })
        .then((results) => results[0]?.result)
        .catch(() => null);
      if (page && !/^https?:/.test(page.href ?? "")) page = null;
    }

    if (page?.state === "complete") return tabId;
    if (page?.state === "interactive") {
      interactiveSince ||= Date.now();
      if (Date.now() - interactiveSince >= INTERACTIVE_GRACE_MS) return tabId;
    } else {
      interactiveSince = 0;
    }

    if (Date.now() - started > timeoutMs) {
      if (page?.state) return tabId;
      throw new Error(`the page did not finish loading within ${Math.round(timeoutMs / 1000)} seconds`);
    }
    await wait(250);
  }
}

/** Opens an address in a new tab at the front and waits for the page. */
export async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return settled(tab.id);
}

/** Moves an open tab to an address and waits for the page. */
export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await focus(tabId);
  return settled(tabId);
}

/** Reloads an open tab and waits for the page. A discarded tab comes back the same way. */
export async function reload(tabId) {
  await focus(tabId);
  await chrome.tabs.reload(tabId);
  return settled(tabId);
}
