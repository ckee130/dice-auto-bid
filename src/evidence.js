/**
 * A picture of the confirmation.
 *
 * A row in a results list says an application was sent; a screenshot of the
 * board saying "thank you for applying", with the page's address and the job
 * link printed across the top, is something that can be shown to someone.
 *
 * Chrome's screenshot API captures the visible part of the active tab and
 * nothing else - not the address bar, not the rest of the page. So the page
 * is scrolled and photographed in strips that are stitched together, the
 * browser's own frame is drawn around it (see drawBrowserFrame), and the job
 * link and the rest are printed in small type underneath. JPEG rather than
 * PNG because the file is handed to the downloads API as a data: address,
 * and those have a size ceiling that a full-page PNG can exceed.
 */

const MAX_STRIPS = 8;
const BAND_LINE = 17;
/** The tab strip and the toolbar, in CSS pixels, as Chrome draws them. */
const TAB_STRIP = 40;
const TOOLBAR = 40;
const FRAME_HEIGHT = TAB_STRIP + TOOLBAR;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The browser around the page, drawn.
 *
 * What is wanted is a picture of the browser window as it stood - the tab,
 * the address bar with the confirmation's address in it, the page - and
 * that is the one thing an extension cannot photograph: the capture API
 * returns the page alone, and the APIs that can see the window all put up a
 * picker that someone has to click. So the window is reconstructed around
 * the page: the tab strip with this tab's icon and title, the toolbar with
 * the address the page was captured at. Same proportions and colours as
 * Chrome's own, so the result reads as the window it stands for.
 */
function drawBrowserFrame(context, { width, scale, url, title, favicon }) {
  const px = (n) => Math.round(n * scale);
  const rounded = (x, y, w, h, r) => {
    context.beginPath();
    context.roundRect(x, y, w, h, r);
    context.fill();
  };

  // Tab strip.
  context.fillStyle = "#dfe3e8";
  context.fillRect(0, 0, width, px(TAB_STRIP));

  // The active tab, a white rounded shape standing on the toolbar.
  const tabX = px(8);
  const tabY = px(8);
  const tabW = Math.min(px(260), width - px(140));
  context.fillStyle = "#ffffff";
  rounded(tabX, tabY, tabW, px(TAB_STRIP - 8) + px(2), [px(8), px(8), 0, 0]);

  // Its icon and title.
  const iconSize = px(16);
  const iconX = tabX + px(12);
  const iconY = tabY + px(8);
  if (favicon) {
    context.drawImage(favicon, iconX, iconY, iconSize, iconSize);
  } else {
    context.fillStyle = "#9aa0a6";
    context.beginPath();
    context.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#202124";
  context.font = `${px(12)}px sans-serif`;
  context.textBaseline = "middle";
  const titleX = iconX + iconSize + px(8);
  const titleMax = tabW - px(12) - iconSize - px(8) - px(28);
  context.fillText(ellipsize(context, title || url, titleMax), titleX, tabY + px(16));
  // The tab's close cross.
  context.fillStyle = "#5f6368";
  context.font = `${px(14)}px sans-serif`;
  context.fillText("×", tabX + tabW - px(22), tabY + px(16));
  // New tab, and the window controls at the far right.
  context.fillStyle = "#3c4043";
  context.font = `${px(18)}px sans-serif`;
  context.fillText("+", tabX + tabW + px(10), px(22));
  context.fillStyle = "#5f6368";
  context.font = `${px(13)}px sans-serif`;
  context.textAlign = "right";
  context.fillText("—      ▢      ×", width - px(14), px(18));
  context.textAlign = "left";

  // Toolbar.
  const barY = px(TAB_STRIP);
  context.fillStyle = "#ffffff";
  context.fillRect(0, barY, width, px(TOOLBAR));
  context.fillStyle = "#5f6368";
  context.font = `${px(16)}px sans-serif`;
  context.fillText("←", px(12), barY + px(TOOLBAR / 2));
  context.fillStyle = "#bdc1c6";
  context.fillText("→", px(40), barY + px(TOOLBAR / 2));
  context.fillStyle = "#5f6368";
  context.fillText("↻", px(68), barY + px(TOOLBAR / 2));

  // The address bar, with the address in it.
  const pillX = px(96);
  const pillW = width - pillX - px(120);
  const pillH = px(28);
  const pillY = barY + px((TOOLBAR - 28) / 2);
  context.fillStyle = "#f1f3f4";
  rounded(pillX, pillY, pillW, pillH, pillH / 2);
  // A small lock.
  const lockX = pillX + px(12);
  const lockY = pillY + px(9);
  context.fillStyle = "#5f6368";
  context.fillRect(lockX, lockY + px(4), px(9), px(7));
  context.lineWidth = Math.max(1, px(1.5));
  context.strokeStyle = "#5f6368";
  context.beginPath();
  context.arc(lockX + px(4.5), lockY + px(4), px(3), Math.PI, 0);
  context.stroke();
  context.fillStyle = "#202124";
  context.font = `${px(13)}px sans-serif`;
  context.fillText(ellipsize(context, url, pillW - px(40)), lockX + px(18), pillY + pillH / 2);
  // Bookmark star and the menu dots.
  context.fillStyle = "#5f6368";
  context.font = `${px(16)}px sans-serif`;
  context.fillText("☆", width - px(100), barY + px(TOOLBAR / 2));
  context.fillText("⋮", width - px(26), barY + px(TOOLBAR / 2));

  // The toolbar's bottom edge.
  context.fillStyle = "#dadce0";
  context.fillRect(0, barY + px(TOOLBAR) - Math.max(1, px(1)), width, Math.max(1, px(1)));
}

function ellipsize(context, text, maxWidth) {
  let shown = String(text ?? "");
  if (context.measureText(shown).width <= maxWidth) return shown;
  while (shown.length > 1 && context.measureText(`${shown}…`).width > maxWidth) shown = shown.slice(0, -1);
  return `${shown}…`;
}

/** The tab's icon, for the tab strip. Null when there is none to be had. */
async function faviconOf(tab) {
  if (!tab.favIconUrl || !/^https?:/.test(tab.favIconUrl)) return null;
  try {
    const response = await fetch(tab.favIconUrl);
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

/**
 * Hides the things floating over the page - cookie notices, toasts, alert
 * bars, chat bubbles - for the duration of the photograph, and puts them
 * back afterwards. They are pinned to the viewport, so they would otherwise
 * be stamped onto every strip, and a confirmation with "we use cookies"
 * printed across it three times is not the evidence anyone wanted.
 */
function tidy(restore) {
  const marked = "data-gh-evidence-hidden";
  if (restore) {
    for (const node of document.querySelectorAll(`[${marked}]`)) {
      node.style.visibility = node.getAttribute(marked);
      node.removeAttribute(marked);
    }
    return 0;
  }
  const floating = /cookie|consent|gdpr|banner|toast|snackbar|alert|notif|modal|popup|overlay|chat|intercom|drift|hubspot|widget/i;
  let hidden = 0;
  for (const node of document.querySelectorAll("body *")) {
    const style = getComputedStyle(node);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const role = node.getAttribute("role") ?? "";
    const name = `${node.id} ${node.className} ${node.getAttribute("aria-label") ?? ""}`;
    if (!/^(alert|alertdialog|dialog|status)$/.test(role) && !floating.test(String(name))) continue;
    node.setAttribute(marked, node.style.visibility);
    node.style.visibility = "hidden";
    hidden += 1;
  }
  return hidden;
}

function measure() {
  const doc = document.documentElement;
  return {
    viewport: window.innerHeight,
    full: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
    url: location.href,
    title: document.title,
  };
}

function scrollTo(y) {
  // "instant" overrides a page's scroll-behavior: smooth, which would still be
  // gliding when the picture is taken and report the position it left from.
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))));
}

/**
 * Photographs the tab. Returns the picture as a JPEG blob, or throws.
 *
 * `lines` are printed on the band, first line largest. The tab is brought to
 * the front for the duration, since only the active tab can be captured, and
 * whatever was in front is put back afterwards.
 */
export async function captureEvidence(tabId, { lines }) {
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (previous?.id !== tabId) await chrome.tabs.update(tabId, { active: true });

  let tidied = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: tidy, args: [false] }).catch(() => {});
    tidied = true;
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: measure });
    const strips = [];
    const count = Math.min(MAX_STRIPS, Math.max(1, Math.ceil(page.full / page.viewport)));

    for (let i = 0; i < count; i++) {
      const [{ result: y }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrollTo, args: [i * page.viewport] });
      await wait(i === 0 ? 300 : 400);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      strips.push({ y, bitmap });
      // The API allows two captures a second.
      if (i < count - 1) await wait(550);
    }
    await chrome.scripting.executeScript({ target: { tabId }, func: scrollTo, args: [0] }).catch(() => {});

    const scale = strips[0].bitmap.height / page.viewport;
    const width = strips[0].bitmap.width;
    const body = Math.round(Math.min(page.full, strips[strips.length - 1].y + page.viewport) * scale);
    const frame = Math.round(FRAME_HEIGHT * scale);
    const footer = Math.round((lines.length * BAND_LINE + 12) * scale);

    const canvas = new OffscreenCanvas(width, frame + body + footer);
    const context = canvas.getContext("2d");
    const favicon = await faviconOf(tab);
    drawBrowserFrame(context, { width, scale, url: page.url, title: tab.title || page.title, favicon });
    for (const strip of strips) context.drawImage(strip.bitmap, 0, frame + Math.round(strip.y * scale));

    // The job link, where it was found and when, in small type under the
    // page. Below rather than above, so the top of the picture is the
    // browser as it stood.
    const top = frame + body;
    context.fillStyle = "#ffffff";
    context.fillRect(0, top, width, footer);
    context.fillStyle = "#e5e7eb";
    context.fillRect(0, top, width, Math.max(1, Math.round(scale)));
    context.textBaseline = "top";
    lines.forEach((line, index) => {
      context.fillStyle = index === 0 ? "#111827" : "#4b5563";
      context.font = `${index === 0 ? "bold " : ""}${Math.round((index === 0 ? 12 : 11) * scale)}px sans-serif`;
      context.fillText(line, Math.round(10 * scale), top + Math.round((7 + index * BAND_LINE) * scale));
    });

    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    if (tidied) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: tidy, args: [true] }).catch(() => {});
    if (previous?.id && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}
