/**
 * The Dice pages, as seen from inside them.
 *
 * Everything in this file runs in the page, not in the extension: `dicePage`
 * is handed to chrome.scripting.executeScript whole, so it has to carry its
 * own helpers and may not reach for anything defined outside it. The
 * background script calls it with an action name and arguments and gets
 * back plain data.
 *
 * Two pages matter. The posting, dice.com/job-detail/<id>, carries a
 * schema.org JobPosting block with the title, company and full description,
 * and an apply button that is "Easy Apply" (the wizard), "Apply Now" (an
 * external site) or already used. The wizard,
 * dice.com/job-applications/<id>/wizard, is a React Aria form in three
 * steps: Resume & Cover Letter (two file boxes), Additional Information
 * (which a posting may not have: a work authorization menu, a city
 * picker, and whatever screener questions the employer added), and Review
 * with a Submit button. The whole thing was read off the live pages;
 * nothing here is assumed from documentation.
 */

export async function dicePage(action, args = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || element instanceof HTMLInputElement;
  };
  const chrome_ = (element) => Boolean(element.closest("header, nav, footer"));
  const buttons = () => [...document.querySelectorAll("button, a[role=button], input[type=submit]")].filter((node) => !chrome_(node));
  const buttonNamed = (pattern) => buttons().find((node) => pattern.test(text(node.textContent || node.value)) && visible(node));
  const pageText = () => {
    const root = document.querySelector("main") ?? document.body;
    return text(root.innerText ?? root.textContent);
  };

  /** A full pointer interaction; React Aria listens for the sequence, not a bare click. */
  const press = (element) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, buttons: 1, button: 0, pointerType: "mouse" }));
    }
  };

  const setNative = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /** Typed one character at a time: the city picker searches as the person types. */
  const typeInto = async (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    element.focus();
    setter.call(element, "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(80);
    for (const character of String(value)) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      setter.call(element, element.value + character);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
      await wait(25);
    }
  };

  /* ------------------------------------------------------------ posting */

  const jsonLd = () => {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent ?? "");
        const list = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ? parsed["@graph"] : [parsed];
        const posting = list.find((entry) => /JobPosting/i.test(String(entry?.["@type"] ?? "")));
        if (posting) return posting;
      } catch {
        // Not every block is JSON; the next one may be the posting.
      }
    }
    return null;
  };

  const htmlToText = (html) => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    for (const node of doc.querySelectorAll("script, style, noscript")) node.remove();
    for (const node of doc.querySelectorAll("br")) node.replaceWith("\n");
    for (const node of doc.querySelectorAll("li")) node.prepend("- ");
    for (const node of doc.querySelectorAll("p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, section, article")) {
      node.prepend("\n");
      node.append("\n");
    }
    const root = doc.body ?? doc.documentElement ?? doc;
    const plain = String(root?.textContent ?? "").trim() || String(html).replace(/<[^>]+>/g, " ");
    return plain
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  };

  const firstText = (value) => {
    if (Array.isArray(value)) return firstText(value[0]);
    if (value && typeof value === "object") return firstText(value.name ?? value["@value"] ?? value.value);
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  };

  const placeOf = (posting) => {
    if (String(posting.jobLocationType ?? "").toUpperCase() === "TELECOMMUTE") return "Remote";
    const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
    for (const place of places) {
      const address = place?.address;
      if (!address) continue;
      if (typeof address === "string") return address.trim();
      const parts = [address.addressLocality, address.addressRegion, address.addressCountry].map(firstText).filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
    }
    return "";
  };

  const salaryOf = (posting) => {
    const base = posting.baseSalary;
    const value = base?.value ?? base;
    if (!value || typeof value !== "object") return "";
    const unit = firstText(value.unitText ?? base?.unitText);
    const currency = firstText(base?.currency ?? value.currency) || "USD";
    const range = [value.minValue, value.maxValue].map(firstText).filter(Boolean);
    const single = firstText(value.value);
    const figures = range.length === 2 ? `${range[0]} - ${range[1]}` : single;
    return figures ? `${currency} ${figures}${unit ? ` per ${unit.toLowerCase()}` : ""}` : "";
  };

  /** The apply control on a posting and what it leads to. */
  const applyButton = () => {
    const node = document.querySelector("[data-testid=apply-button]") ?? buttons().find((candidate) => /\bapply\b|\bapplied\b/i.test(text(candidate.textContent)));
    if (!node) return { kind: "none", label: "", href: "" };
    const label = text(node.textContent);
    const href = node instanceof HTMLAnchorElement ? node.href : node.getAttribute("href") ?? "";
    if (/\bapplied\b/i.test(label) && !/apply/i.test(label.replace(/applied/i, ""))) return { kind: "applied", label, href };
    if (/\/dashboard\/login/i.test(href)) return { kind: "signin", label, href };
    if (/\/job-applications\/[0-9a-f-]+\/wizard/i.test(href) || /easy apply/i.test(label)) return { kind: "easy", label, href };
    if (node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true") return { kind: "closed", label, href };
    return { kind: "external", label, href };
  };

  const signedIn = () => Boolean([...document.querySelectorAll("button, a")].find((node) => /^log ?out$/i.test(text(node.textContent))));

  if (action === "posting") {
    const posting = jsonLd();
    const body = pageText();
    const gone = /no longer (?:available|accepting|listed)|this job (?:has )?(?:expired|been removed|closed)|job not found|position (?:has been )?filled/i.test(body.slice(0, 2000));
    return {
      url: location.href,
      ready: Boolean(posting) || gone,
      gone,
      signedIn: signedIn(),
      apply: applyButton(),
      title: text(posting?.title) || text(document.querySelector("h1")?.textContent),
      company: firstText(posting?.hiringOrganization) || text(document.querySelector('[data-testid="job-company"], a[href*="/company-profile/"]')?.textContent),
      location: posting ? placeOf(posting) : "",
      employmentType: firstText(posting?.employmentType),
      salary: posting ? salaryOf(posting) : "",
      datePosted: firstText(posting?.datePosted),
      description: posting?.description ? htmlToText(posting.description) : "",
    };
  }

  /* ------------------------------------------------------------- wizard */

  const headingText = () => text([...document.querySelectorAll("main h1, main h2, main h3, h1, h2, h3")].filter((node) => !chrome_(node)).map((node) => text(node.textContent)).join(" | "));
  const stepLabel = () => pageText().match(/\bStep \d+ of \d+\b/i)?.[0] ?? "";
  const errorsShown = () =>
    [...document.querySelectorAll("[role=alert], [aria-live], [class*='error' i], [id*='error' i], [data-rac][slot='errorMessage']")]
      .filter((node) => !chrome_(node) && visible(node))
      .map((node) => text(node.textContent))
      .filter((line) => line && line.length < 300)
      .filter((line, index, all) => all.indexOf(line) === index)
      .slice(0, 6);

  const stepOf = () => {
    const body = pageText();
    const heading = headingText();
    if (/\/dashboard\/login/i.test(location.href) || buttonNamed(/^continue with (?:email|google|apple)$/i)) return "signin";
    if (/already applied|you(?:'ve| have) applied|application (?:was )?already (?:submitted|sent)/i.test(body.slice(0, 3000))) return "applied";
    if (/application (?:has been |was )?(?:submitted|sent|received|complete)|successfully (?:applied|submitted)|thank you for applying|thanks for applying|you(?:'ve| have) (?:successfully )?applied/i.test(body.slice(0, 3000))) return "done";
    if (/review your application/i.test(heading) || (buttonNamed(/^submit$/i) && !buttonNamed(/^next$/i))) return "review";
    if (/resume\s*&\s*cover letter/i.test(heading) || [...document.querySelectorAll("input[type=file]")].some(visible) || /upload your resume/i.test(body)) return "resume";
    if (/additional information|questions?/i.test(heading) || buttonNamed(/^next$/i)) return "questions";
    if (/no longer (?:available|accepting)|this job (?:has )?(?:expired|been removed|closed)|job not found/i.test(body.slice(0, 2000))) return "gone";
    return "unknown";
  };

  if (action === "state") {
    return { url: location.href, step: stepOf(), stepLabel: stepLabel(), heading: headingText().slice(0, 200), errors: errorsShown(), text: pageText().slice(0, 1500), signedIn: signedIn() };
  }

  /* ------------------------------------------------- step 1: the files */

  /**
   * The caption of the "Resume" or "Cover letter" box: a leaf, or a span
   * whose only child is the required-field asterisk.
   */
  const captions = (which) => {
    const pattern = which === "resume" ? /^resume\s*\*?$/i : /^cover letter\s*\*?$/i;
    return [...document.querySelectorAll("label, span, p, div, h3, h4, legend")].filter(
      (node) => node.childElementCount <= 1 && pattern.test(text(node.textContent)) && !node.querySelector("input, button, svg") && !chrome_(node),
    );
  };

  /** The upload block for "Resume" or "Cover letter": the labelled box and the file input inside it. */
  const uploadBlock = (which) => {
    const labels = captions(which);
    const inputs = [...document.querySelectorAll("input[type=file]")];
    const describes = (input) =>
      text(
        [
          input.getAttribute("aria-describedby"),
          input.getAttribute("aria-label"),
          input.getAttribute("name"),
          input.id,
        ].filter(Boolean).join(" "),
      );
    const isFor = (input) => {
      const description = describes(input);
      return which === "resume" ? /\bresume\b/i.test(description) && !/\bcover\b/i.test(description) : /\bcover\s*letter\b|\bcoverletter\b/i.test(description);
    };

    // Dice names the hidden inputs through aria-describedby ("resume-description"
    // and "cover letter-description"). Prefer that identity over DOM proximity.
    // When a profile resume is already selected, its input disappears while the
    // cover-letter input remains; climbing from the Resume caption would otherwise
    // reach the form and incorrectly treat that sole cover input as the resume.
    const named = inputs.filter(isFor);
    if (named.length === 1) {
      return { block: named[0].closest("section, fieldset, div") ?? named[0].parentElement, input: named[0], label: labels[0] ?? null };
    }

    // Older Dice markup did not name the inputs. It did keep one caption and
    // one input per card, in the same order, so only use positional matching
    // when the sets are complete. A missing input means a saved file occupies
    // that card and must go through Replace instead.
    const allLabels = [...captions("resume"), ...captions("cover")].sort((a, b) =>
      a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    if (inputs.length > 0 && inputs.length === allLabels.length) {
      const label = labels[0];
      const index = allLabels.indexOf(label);
      if (index >= 0) return { block: inputs[index].parentElement, input: inputs[index], label };
    }
    return null;
  };

  if (action === "uploadTargets") {
    const target = (which) => {
      const found = uploadBlock(which);
      return found ? { describedBy: found.input.getAttribute("aria-describedby") ?? "", name: found.input.getAttribute("name") ?? "", id: found.input.id ?? "" } : null;
    };
    return { resume: target("resume"), cover: target("cover") };
  }

  /** What a labelled upload box currently says - the file name once one is in. */
  const uploadShows = (which) => {
    const label = captions(which)[0];
    if (!label) return "";
    let block = label;
    for (let up = 0; up < 4 && block.parentElement && block.parentElement !== document.body; up += 1) {
      block = block.parentElement;
      if (text(block.textContent).length > 40) break;
    }
    return text(block.textContent).slice(0, 300);
  };

  /**
   * The "File options" menu button of a box that already holds a file. Dice
   * keeps uploads from an earlier, unfinished attempt at the same job, and
   * shows the file's name with this menu instead of an upload box.
   */
  const fileOptionsButton = (which) => {
    const label = captions(which)[0];
    if (!label) return null;
    let block = label;
    while (block.parentElement && block.parentElement !== document.body && !block.querySelector("button[aria-label='File options']")) block = block.parentElement;
    const buttons = [...block.querySelectorAll("button[aria-label='File options']")];
    if (buttons.length === 1) return buttons[0];
    // Both cards in one block: the menu that follows this label is this card's.
    return buttons.find((button) => label.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
  };

  /** Open the file's menu and choose Replace, which brings the upload box back. */
  const replaceFile = async (which) => {
    const menuButton = fileOptionsButton(which);
    if (!menuButton) return false;
    press(menuButton);
    let replace = null;
    for (let tick = 0; tick < 20 && !replace; tick += 1) {
      await wait(100);
      // The item's text may carry a second, visually hidden "Replace".
      replace = [...document.querySelectorAll("[role=menuitem]")].find((item) => /^(?:replace\s*)+$/i.test(text(item.textContent)) && visible(item)) ?? null;
    }
    if (!replace) return false;
    press(replace);
    for (let tick = 0; tick < 20; tick += 1) {
      await wait(100);
      if (uploadBlock(which)) return true;
    }
    return false;
  };

  if (action === "attach") {
    const { which, name, type, base64 } = args;
    let replaced = false;
    let found = null;

    // A visible file card means Dice intends to submit that saved/profile
    // document. Always use its Replace command first, even if React has left
    // a hidden file input elsewhere in the form. The generated document must
    // be the file attached to this application; the Dice profile resume is
    // never an acceptable fallback.
    if (fileOptionsButton(which)) {
      replaced = await replaceFile(which);
      found = replaced ? uploadBlock(which) : null;
      if (!replaced) {
        return { ok: false, error: `the existing ${which === "resume" ? "resume" : "cover letter"} could not be opened for replacement`, shown: uploadShows(which) };
      }
    } else {
      found = uploadBlock(which);
    }

    if (!found) {
      if (uploadShows(which).includes(name)) return { ok: true, shown: uploadShows(which), already: true };
      return { ok: false, error: `no upload box labelled "${which === "resume" ? "Resume" : "Cover letter"}" on this step` };
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], name, { type });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    found.input.files = transfer.files;
    found.input.dispatchEvent(new Event("input", { bubbles: true }));
    found.input.dispatchEvent(new Event("change", { bubbles: true }));
    // The box re-renders with the file's name once the form has taken it.
    for (let tick = 0; tick < 40; tick += 1) {
      await wait(250);
      const shown = uploadShows(which);
      if (shown.includes(name)) return { ok: true, shown, replaced };
      const errors = errorsShown();
      if (errors.length > 0) return { ok: false, error: errors.join("; "), shown };
    }
    return { ok: false, error: `the ${which} box did not show "${name}" after the upload`, shown: uploadShows(which) };
  }

  /* --------------------------------------------- step 2: the questions */

  const FORM_CONTROL = "input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]), select, textarea, [role=combobox], [role=radiogroup], [role=group][aria-labelledby]";

  const labelFor = (element) => {
    const byAria = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => text(node.textContent))
      .join(" ");
    if (byAria) return byAria;
    const ariaLabel = text(element.getAttribute("aria-label"));
    if (ariaLabel && !/show suggestions/i.test(ariaLabel)) return ariaLabel;
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return text(label.textContent);
    }
    const wrapping = element.closest("label");
    if (wrapping) {
      // The label's own words, not the control's: a hidden <select> sits
      // inside its label and would otherwise be labelled with its options.
      const own = [...wrapping.childNodes].filter((node) => node.nodeType === 3 || (node.nodeType === 1 && !node.contains(element) && !node.querySelector("input, select, textarea"))).map((node) => text(node.textContent)).join(" ");
      if (text(own)) return text(own);
    }
    // The question above the control inside its block: a label or legend
    // first, else the first short line of text that comes before it.
    let block = element.parentElement;
    for (let up = 0; up < 6 && block && block !== document.body; up += 1, block = block.parentElement) {
      const precedes = (node) => !node.contains(element) && Boolean(node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      const short = (node) => text(node.textContent).length > 1 && text(node.textContent).length < 200;
      const labelled = [...block.querySelectorAll("label, legend, h3, h4, [slot='label'], [class*='label' i]")].filter((node) => precedes(node) && short(node) && !node.querySelector("input, select, textarea, button"));
      if (labelled[0]) return text(labelled[0].textContent);
      const leaves = [...block.querySelectorAll("p, span, div")].filter((node) => node.childElementCount === 0 && precedes(node) && short(node));
      if (leaves[0]) return text(leaves[0].textContent);
    }
    return text(element.getAttribute("placeholder")) || element.name || element.id;
  };

  const requiredOf = (element, label) =>
    element.required || element.getAttribute("aria-required") === "true" || /\*\s*$/.test(label) || Boolean(element.closest("[data-required=true], .required"));

  const hintFor = (element) => {
    const block = element.closest("fieldset, section, [class*='field'], [class*='question']") ?? element.parentElement?.parentElement;
    if (!block) return "";
    const notes = [...block.querySelectorAll("[class*='description' i], [class*='help' i], [class*='hint' i], small, [slot='description']")]
      .filter((node) => !node.contains(element) && !node.querySelector("input, select, textarea"))
      .map((node) => text(node.textContent))
      .filter(Boolean);
    return text([...new Set(notes)].join(" ")).slice(0, 240);
  };

  /** Every answerable control on the step, each tagged so a later call can find it again. */
  const readFields = () => {
    const root = document.querySelector("main form") ?? document.querySelector("form") ?? document.querySelector("main") ?? document.body;
    const fields = [];
    const seenRadio = new Set();
    let key = 0;
    for (const element of root.querySelectorAll(FORM_CONTROL)) {
      if (chrome_(element)) continue;
      const tag = element.tagName.toLowerCase();
      const type = element instanceof HTMLInputElement ? element.type : tag === "select" ? "select" : tag === "textarea" ? "textarea" : element.getAttribute("role") ?? tag;
      if (type === "checkbox" && /^(?:consent|agree|terms)/i.test(element.name)) continue;

      if (type === "radio") {
        const group = element.name || element.closest("[role=radiogroup]")?.getAttribute("aria-labelledby") || "";
        if (seenRadio.has(group)) continue;
        seenRadio.add(group);
        const members = element.name ? [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(element.name)}"]`)] : [element];
        const groupNode = element.closest("[role=radiogroup], fieldset") ?? element.parentElement;
        const label = (groupNode && (groupNode.querySelector("legend") ? text(groupNode.querySelector("legend").textContent) : labelFor(groupNode))) || labelFor(element);
        members.forEach((member) => member.setAttribute("data-dice-key", String(key)));
        fields.push({
          key: String(key++),
          label,
          hint: hintFor(element),
          type: "radio",
          required: members.some((member) => requiredOf(member, label)),
          options: members.map((member) => ({ value: member.value, label: text(member.closest("label")?.textContent || document.querySelector(`label[for="${CSS.escape(member.id)}"]`)?.textContent || member.value) })),
          current: members.find((member) => member.checked)?.value ?? "",
        });
        continue;
      }

      if (type === "radiogroup" || type === "group") {
        // A React Aria radio group renders native radios inside; those are
        // picked up above. Skip the wrapper.
        continue;
      }

      // A native select React Aria hides behind its own button still takes a
      // value: it is the control, the button is the picture of it.
      const label = labelFor(element);
      if (!label && type !== "select") continue;
      element.setAttribute("data-dice-key", String(key));
      const options = tag === "select" ? [...element.options].map((option) => ({ value: option.value, label: text(option.textContent) })).filter((option) => option.value || option.label) : [];
      fields.push({
        key: String(key++),
        label: tag === "select" && (!label || label === element.name) ? labelFor(element.closest("div")?.parentElement ?? element) || label : label,
        hint: hintFor(element),
        type,
        name: element.name ?? "",
        required: requiredOf(element, label),
        options,
        combobox: element.getAttribute("role") === "combobox" || element.getAttribute("aria-autocomplete") === "list",
        multiline: tag === "textarea",
        current: tag === "select" ? text([...element.options].find((option) => option.selected)?.textContent) : element instanceof HTMLInputElement && element.type === "checkbox" ? String(element.checked) : String(element.value ?? ""),
        placeholder: text(element.getAttribute("placeholder")),
      });
    }
    return fields;
  };

  if (action === "fields") return readFields();

  const byKey = (key) => [...document.querySelectorAll(`[data-dice-key="${CSS.escape(String(key))}"]`)];
  const fold = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const matchOption = (options, candidates, labelOf) => {
    const wanted = candidates.map(fold).filter(Boolean);
    for (const want of wanted) {
      const exact = options.find((option) => fold(labelOf(option)) === want);
      if (exact) return exact;
    }
    for (const want of wanted) {
      const starts = options.find((option) => fold(labelOf(option)).startsWith(want));
      if (starts) return starts;
    }
    for (const want of wanted) {
      const contains = options.find((option) => fold(labelOf(option)).includes(want) || want.includes(fold(labelOf(option))));
      if (contains && fold(labelOf(contains)).length > 1) return contains;
    }
    return null;
  };

  const optionsOpen = () => [...document.querySelectorAll("[role=option]")].filter(visible);

  /** The city picker and any other typeahead: type, open the list, pick the entry wanted. */
  const setCombobox = async (element, candidates) => {
    const queries = [...new Set(candidates.map((candidate) => text(candidate)).filter(Boolean))].slice(0, 4);
    for (const query of queries) {
      await typeInto(element, query);
      await wait(400);
      // The list opens on the arrow key, not on typing alone.
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
      let options = [];
      for (let tick = 0; tick < 24 && options.length === 0; tick += 1) {
        await wait(250);
        options = optionsOpen();
      }
      if (options.length === 0) continue;
      const labelOf = (node) => text(node.textContent).slice(0, Math.ceil(text(node.textContent).length / 2) + 1);
      // Each entry prints its text twice (a visible and an assistive copy),
      // so the first half of the text is the entry.
      const match = matchOption(options, candidates, (node) => text(node.textContent)) ?? matchOption(options, candidates, labelOf) ?? (fold(text(options[0].textContent)).startsWith(fold(query)) ? options[0] : null);
      if (!match) continue;
      press(match);
      await wait(600);
      if (text(element.value)) return { ok: true, chosen: text(element.value) };
    }
    return { ok: false, error: `no entry in the list matched ${candidates.slice(0, 3).map((candidate) => `"${candidate}"`).join(", ")}` };
  };

  if (action === "fill") {
    const { key, value, candidates = [value] } = args;
    const elements = byKey(key);
    if (elements.length === 0) return { ok: false, error: "the control is no longer on the page" };
    const element = elements[0];
    const tag = element.tagName.toLowerCase();

    if (element instanceof HTMLInputElement && element.type === "radio") {
      const match = matchOption(elements, candidates, (node) => text(node.closest("label")?.textContent || document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent || node.value)) ?? matchOption(elements, candidates, (node) => node.value);
      if (!match) return { ok: false, error: `no choice matched "${candidates[0]}"` };
      press(match);
      if (!match.checked) match.click();
      await wait(200);
      return { ok: match.checked, chosen: text(match.closest("label")?.textContent || match.value) };
    }
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      const want = /^(?:yes|true|on|1)$/i.test(text(value));
      if (element.checked !== want) press(element);
      if (element.checked !== want) element.click();
      await wait(100);
      return { ok: element.checked === want };
    }
    if (tag === "select") {
      const options = [...element.options];
      const match = matchOption(options, candidates, (option) => text(option.textContent)) ?? matchOption(options, candidates, (option) => option.value);
      if (!match) return { ok: false, error: `no option matched "${candidates[0]}"` };
      setNative(element, match.value);
      await wait(300);
      return { ok: element.value === match.value, chosen: text(match.textContent) };
    }
    if (element.getAttribute("role") === "combobox" || element.getAttribute("aria-autocomplete") === "list") {
      return setCombobox(element, candidates);
    }
    setNative(element, String(value ?? ""));
    await wait(100);
    return { ok: text(element.value) === text(value), chosen: text(element.value) };
  }

  /* --------------------------------------------------------- the buttons */

  if (action === "press") {
    const pattern = new RegExp(`^${args.label}$`, "i");
    const button = buttonNamed(pattern);
    if (!button) return { ok: false, error: `no "${args.label}" button on this step` };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { ok: false, error: `the "${args.label}" button is disabled` };
    const before = { step: stepOf(), label: stepLabel(), heading: headingText() };
    press(button);
    if (button instanceof HTMLButtonElement && button.type === "submit") {
      // A submit button React Aria did not take the pointer sequence for
      // still submits on a plain click.
      await wait(50);
    }
    // Wait for the step to change or an error to show.
    for (let tick = 0; tick < 60; tick += 1) {
      await wait(250);
      const now = { step: stepOf(), label: stepLabel(), heading: headingText() };
      if (now.step !== before.step || now.label !== before.label || now.heading !== before.heading) {
        return { ok: true, moved: true, from: before.step, to: now.step, errors: errorsShown() };
      }
      const errors = errorsShown();
      if (errors.length > 0 && tick > 4) return { ok: false, moved: false, from: before.step, to: now.step, errors };
    }
    return { ok: false, moved: false, from: before.step, to: stepOf(), errors: errorsShown(), error: "the page did not move on" };
  }

  if (action === "review") {
    // What the review step says it is about to send, for the record.
    return { text: pageText().slice(0, 1200), hasSubmit: Boolean(buttonNamed(/^submit$/i)) };
  }

  return { error: `unknown action ${action}` };
}
