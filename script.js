// ---------------------------------------------------------------
// Alegerea temelor de proiect - frontend
// Reads settings.json (backend URL, team size, list of themes),
// loads registrations from the Google Apps Script web app and
// lets a team claim one free theme.
// ---------------------------------------------------------------

const CACHE_KEY = "registrationsCache";
const REQUEST_TIMEOUT_MS = 25000;

const state = {
  settings: null,
  registrations: [], // confirmed by the server: [{ themeId, themeTitle, members: [] }]
  pending: {}, // optimistic, waiting for the server: { themeId: [members] }
  drafts: {}, // names typed into a form: { themeId: [..] }
  students: [], // allowed names from settings.json, sorted
  openFormId: null, // theme id whose form is open
  expanded: new Set(), // taken themes whose team list is shown
  refreshing: false,
  loaded: false, // true after the first successful server response
};

const els = {
  list: document.getElementById("themeList"),
  banner: document.getElementById("banner"),
  summary: document.getElementById("summary"),
  refreshBtn: document.getElementById("refreshBtn"),
  maxMembers: document.getElementById("maxMembers"),
  lastUpdated: document.getElementById("lastUpdated"),
  toasts: null,
};

// An error reported by the server itself (the request reached it and it said no).
class ServerError extends Error {}

// ---------- helpers ----------

function backendConfigured() {
  const url = state.settings && state.settings.scriptUrl;
  return typeof url === "string" && url.startsWith("https://");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

function registrationFor(themeId) {
  return state.registrations.find((r) => String(r.themeId) === String(themeId));
}

function normalizeName(name) {
  return String(name).trim().replace(/\s+/g, " ");
}

function sameTeam(a, b) {
  const norm = (list) =>
    list
      .map((m) => normalizeName(m).toLowerCase())
      .sort()
      .join("|");
  return norm(a) === norm(b);
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state.registrations));
  } catch (e) {
    /* ignore */
  }
}

function loadCache() {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

// ---------- notifications ----------

function showBanner(message, type = "info") {
  els.banner.textContent = message;
  els.banner.className = "banner " + type;
  els.banner.hidden = false;
}

// Toasts stay fixed on screen, so they are visible wherever the user has scrolled.
function toast(
  message,
  type = "info",
  { duration = 5000, spinner = false } = {},
) {
  const node = el(
    "div",
    { class: `toast ${type}`, role: type === "error" ? "alert" : "status" },
    [
      spinner ? el("span", { class: "spinner" }) : null,
      el("span", { class: "toast-text", text: message }),
      el("button", {
        class: "toast-close",
        type: "button",
        "aria-label": "Închide",
        text: "×",
        onclick: () => dismiss(),
      }),
    ],
  );
  els.toasts.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));

  let timer = duration > 0 ? setTimeout(() => dismiss(), duration) : null;
  function dismiss() {
    clearTimeout(timer);
    node.classList.remove("show");
    setTimeout(() => node.remove(), 250);
  }
  return {
    dismiss,
    update(newMessage, newType, newDuration = 5000) {
      node.className = `toast ${newType} show`;
      node.querySelector(".toast-text").textContent = newMessage;
      const sp = node.querySelector(".spinner");
      if (sp) sp.remove();
      clearTimeout(timer);
      if (newDuration > 0) timer = setTimeout(() => dismiss(), newDuration);
    },
  };
}

// ---------- backend calls ----------

async function request(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(state.settings.scriptUrl, {
      ...options,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new ServerError(data.error || "Eroare necunoscută.");
    return data.registrations || [];
  } finally {
    clearTimeout(timeout);
  }
}

function fetchRegistrations() {
  return request({ method: "GET" });
}

function postRegistration(theme, members) {
  // text/plain avoids a CORS preflight, which Apps Script does not support.
  return request({
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "register",
      themeId: theme.id,
      themeTitle: theme.title,
      members,
    }),
  });
}

// ---------- rendering ----------

function render() {
  const { themes, maxMembers } = state.settings;
  const focused = document.activeElement;
  const focusKey = focused && focused.dataset ? focused.dataset.key : null;

  els.list.innerHTML = "";
  let freeCount = 0;

  themes.forEach((theme) => {
    const reg = registrationFor(theme.id);
    const pendingMembers = !reg ? state.pending[theme.id] : null;
    const status = reg ? "taken" : pendingMembers ? "pending" : "available";
    if (status === "available") freeCount++;

    const item = el("li", { class: "theme " + status });

    const statusLabel = {
      taken: "Ocupată",
      pending: "Se salvează…",
      available: "Disponibilă",
    }[status];
    const meta = el("div", { class: "theme-meta" }, [
      el("span", { class: "status " + status }, [
        status === "pending" ? el("span", { class: "spinner small" }) : null,
        document.createTextNode(statusLabel),
      ]),
      theme.file
        ? el("a", {
            href: encodeURI(theme.file),
            target: "_blank",
            rel: "noopener",
            text: "Vezi PDF",
            onclick: (e) => e.stopPropagation(), // don't expand/collapse when opening the PDF
          })
        : null,
    ]);

    const actions = el("div", { class: "theme-actions" });
    if (status === "available" && state.openFormId !== theme.id) {
      actions.appendChild(
        el("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Alege",
          disabled: !backendConfigured() || !state.students.length,
          onclick: () => openForm(theme.id),
        }),
      );
    }

    // Taken themes are collapsed; clicking the row reveals the team.
    const expanded = status === "taken" && state.expanded.has(theme.id);
    const headAttrs = { class: "theme-head" };
    if (status === "taken") {
      item.classList.add("expandable");
      if (expanded) item.classList.add("expanded");
      actions.appendChild(
        el("span", { class: "chevron", "aria-hidden": "true" }),
      );
      Object.assign(headAttrs, {
        role: "button",
        tabindex: "0",
        "aria-expanded": String(expanded),
        "data-key": `head-${theme.id}`,
        title: expanded ? "Ascunde echipa" : "Arată echipa",
        onclick: () => toggleExpanded(theme.id),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded(theme.id);
          }
        },
      });
    }

    item.appendChild(
      el("div", headAttrs, [
        el("div", { class: "theme-num", text: theme.id }),
        el("div", { class: "theme-body" }, [
          el("p", { class: "theme-title", text: theme.title }),
          meta,
        ]),
        actions,
      ]),
    );

    const members = reg ? (expanded ? reg.members : null) : pendingMembers;
    if (members) {
      const ul = el("ul");
      members.forEach((name) => ul.appendChild(el("li", { text: name })));
      const reveal = expanded && state.justToggled === theme.id;
      item.appendChild(
        el("div", { class: "members" + (reveal ? " reveal" : "") }, [
          el("strong", { text: `Echipa (${members.length}/${maxMembers})` }),
          ul,
        ]),
      );
    }

    if (status === "available" && state.openFormId === theme.id) {
      item.appendChild(buildForm(theme, maxMembers));
    }

    els.list.appendChild(item);
  });

  const suffix = state.refreshing && !state.loaded ? " (se actualizează…)" : "";
  els.summary.textContent = `${freeCount} din ${themes.length} teme disponibile${suffix}`;

  // Keep the cursor where it was after a background refresh.
  if (focusKey) {
    const again = document.querySelector(`[data-key="${focusKey}"]`);
    if (again) {
      again.focus();
      if (again.tagName === "INPUT")
        again.setSelectionRange(again.value.length, again.value.length);
    }
  }
}

function buildForm(theme, maxMembers) {
  const draft = state.drafts[theme.id] || (state.drafts[theme.id] = []);
  const fields = el("div", { class: "fields" });
  for (let i = 0; i < maxMembers; i++)
    fields.appendChild(buildCombo(theme, i, draft));

  return el(
    "form",
    {
      class: "register-form",
      "data-theme": theme.id,
      onsubmit: (e) => {
        e.preventDefault();
        handleSubmit(theme);
      },
    },
    [
      el("p", {
        text: `Căutați și selectați din listă numele membrilor echipei (între 1 și ${maxMembers}). Înscrierea nu poate fi anulată din pagină.`,
      }),
      fields,
      el("div", { class: "form-actions" }, [
        el("button", {
          class: "btn btn-primary",
          type: "submit",
          text: "Înscrie echipa",
        }),
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Anulează",
          onclick: () => {
            state.openFormId = null;
            render();
          },
        }),
      ]),
    ],
  );
}

// ---------- student picker ----------

// Lowercase and strip diacritics, so "stefan" finds "Ștefan".
function fold(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Canonical name from the list for typed text, or null.
function matchStudent(text) {
  const f = fold(text);
  return f ? state.students.find((name) => fold(name) === f) || null : null;
}

// Students already in a team (saved or being saved).
function busyStudents() {
  const set = new Set();
  state.registrations.forEach((r) =>
    r.members.forEach((m) => set.add(fold(m))),
  );
  Object.values(state.pending).forEach((list) =>
    list.forEach((m) => set.add(fold(m))),
  );
  return set;
}

function buildCombo(theme, i, draft) {
  const listId = `opts-${theme.id}-${i}`;
  const input = el("input", {
    type: "text",
    name: "member",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    "aria-label": `Membrul ${i + 1}`,
    "data-key": `${theme.id}-${i}`,
    placeholder:
      i === 0
        ? "Membrul 1 – căutați numele (obligatoriu)"
        : `Membrul ${i + 1} – căutați numele (opțional)`,
  });
  input.value = draft[i] || "";

  const list = el("ul", { class: "options", id: listId, role: "listbox" });
  list.hidden = true;
  const wrap = el("div", { class: "combo" }, [input, list]);
  if (input.value && !matchStudent(input.value)) wrap.classList.add("invalid");

  let options = []; // [{ name, disabled, node }]
  let active = -1;

  function chosenElsewhere() {
    const set = new Set();
    draft.forEach((v, j) => {
      if (j !== i && v) set.add(fold(v));
    });
    return set;
  }

  function setActive(index) {
    options.forEach((o) => o.node.classList.remove("active"));
    active = index;
    if (index >= 0) {
      options[index].node.classList.add("active");
      options[index].node.scrollIntoView({ block: "nearest" });
    }
  }

  function show() {
    const words = fold(input.value).split(" ").filter(Boolean);
    const busy = busyStudents();
    const other = chosenElsewhere();
    const current = fold(input.value);

    list.innerHTML = "";
    options = state.students
      .filter((name) => {
        const f = fold(name);
        return words.every((w) => f.includes(w));
      })
      .map((name) => {
        const f = fold(name);
        const reason = busy.has(f)
          ? "deja înscris(ă)"
          : other.has(f)
            ? "selectat(ă) deja"
            : "";
        const node = el(
          "li",
          {
            class:
              "option" +
              (reason ? " disabled" : "") +
              (f === current ? " selected" : ""),
            role: "option",
            "aria-disabled": reason ? "true" : "false",
            onmousedown: (e) => {
              e.preventDefault();
              if (!reason) choose(name);
            },
          },
          [
            el("span", { text: name }),
            reason ? el("span", { class: "option-note", text: reason }) : null,
          ],
        );
        list.appendChild(node);
        return { name, disabled: Boolean(reason), node };
      });

    if (!options.length)
      list.appendChild(
        el("li", {
          class: "option empty",
          text: "Niciun student găsit în listă",
        }),
      );
    setActive(options.findIndex((o) => !o.disabled));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function hide() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function choose(name) {
    input.value = name;
    draft[i] = name;
    wrap.classList.remove("invalid");
    hide();
  }

  function move(step) {
    if (list.hidden) return show();
    if (!options.length) return;
    let next = active;
    for (let n = 0; n < options.length; n++) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) return setActive(next);
    }
  }

  input.addEventListener("focus", show);
  input.addEventListener("input", () => {
    draft[i] = input.value;
    wrap.classList.remove("invalid");
    show();
  });
  input.addEventListener("blur", () => {
    hide();
    const match = matchStudent(input.value);
    if (match) {
      input.value = match;
      draft[i] = match;
    } else if (input.value.trim()) wrap.classList.add("invalid");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Escape") {
      hide();
    } else if (e.key === "Enter" && !list.hidden && active >= 0) {
      e.preventDefault();
      choose(options[active].name);
    }
  });

  return wrap;
}

function toggleExpanded(themeId) {
  if (state.expanded.has(themeId)) state.expanded.delete(themeId);
  else state.expanded.add(themeId);
  state.justToggled = themeId;
  render();
  state.justToggled = null;
}

function openForm(themeId) {
  state.openFormId = themeId;
  render();
  const input = document.querySelector(`form[data-theme="${themeId}"] input`);
  if (input) input.focus();
}

// ---------- actions ----------

async function handleSubmit(theme) {
  const typed = (state.drafts[theme.id] || [])
    .map(normalizeName)
    .filter(Boolean);
  const unknown = typed.filter((name) => !matchStudent(name));
  if (unknown.length) {
    document
      .querySelectorAll(`form[data-theme="${theme.id}"] .combo`)
      .forEach((c) => {
        const v = c.querySelector("input").value;
        if (v.trim() && !matchStudent(v)) c.classList.add("invalid");
      });
    toast(
      "Selectați numele din listă. Nu există în listă: " + unknown.join(", "),
      "error",
      { duration: 8000 },
    );
    return;
  }
  const members = typed.map(matchStudent);

  if (members.length === 0) {
    toast("Introduceți cel puțin un membru al echipei.", "error");
    return;
  }
  const lower = members.map((m) => m.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    toast("Același nume a fost introdus de mai multe ori.", "error");
    return;
  }
  const takenNames = new Set();
  state.registrations.forEach((r) =>
    r.members.forEach((m) => takenNames.add(m.toLowerCase())),
  );
  const clash = members.filter((m) => takenNames.has(m.toLowerCase()));
  if (clash.length) {
    toast("Deja înscris(ă) la altă temă: " + clash.join(", "), "error");
    return;
  }

  // Show the result immediately; the server confirms in the background.
  state.pending[theme.id] = members;
  state.openFormId = null;
  render();
  const note = toast(`Se salvează înscrierea la tema ${theme.id}…`, "info", {
    duration: 0,
    spinner: true,
  });

  try {
    state.registrations = await postRegistration(theme, members);
    succeed();
  } catch (err) {
    if (err instanceof ServerError) {
      fail(err.message);
    } else {
      // The request may have been saved even if the response got lost - check.
      try {
        state.registrations = await fetchRegistrations();
        const reg = registrationFor(theme.id);
        if (reg && sameTeam(reg.members, members)) succeed();
        else if (reg)
          fail(`Ne pare rău, tema ${theme.id} a fost aleasă de altă echipă.`);
        else
          fail(
            "Înscrierea nu a putut fi trimisă. Verificați conexiunea și încercați din nou.",
          );
      } catch (e) {
        fail(
          "Serverul nu răspunde. Reîmprospătați pagina pentru a verifica dacă înscrierea a fost salvată.",
        );
      }
    }
  }

  function succeed() {
    delete state.pending[theme.id];
    delete state.drafts[theme.id];
    state.loaded = true;
    saveCache();
    stampUpdated();
    render();
    note.update(
      `✓ Tema ${theme.id} a fost rezervată pentru ${members.join(", ")}.`,
      "success",
      7000,
    );
  }

  function fail(message) {
    delete state.pending[theme.id];
    // Re-open the form with the names still filled in, unless the theme is gone.
    if (!registrationFor(theme.id)) state.openFormId = theme.id;
    render();
    note.update(message, "error", 9000);
  }
}

async function refresh({ silent = false } = {}) {
  if (!backendConfigured() || state.refreshing) return;
  state.refreshing = true;
  els.refreshBtn.classList.add("loading");
  if (!state.loaded) render();

  try {
    state.registrations = await fetchRegistrations();
    state.loaded = true;
    if (state.students.length) els.banner.hidden = true;
    saveCache();
    stampUpdated();

    // Drop optimistic entries the server already has.
    for (const id of Object.keys(state.pending)) {
      if (registrationFor(id)) delete state.pending[id];
    }
    if (state.openFormId && registrationFor(state.openFormId)) {
      toast(
        `Ne pare rău, tema ${state.openFormId} tocmai a fost aleasă de altă echipă.`,
        "error",
        { duration: 8000 },
      );
      state.openFormId = null;
    }
  } catch (err) {
    if (!silent)
      toast("Serverul nu poate fi contactat: " + err.message, "error");
  } finally {
    state.refreshing = false;
    els.refreshBtn.classList.remove("loading");
    render();
  }
}

function stampUpdated() {
  els.lastUpdated.textContent =
    "Ultima actualizare: " + new Date().toLocaleTimeString("ro-RO");
}

// ---------- start ----------

async function init() {
  els.toasts = el("div", { class: "toasts", "aria-live": "polite" });
  document.body.appendChild(els.toasts);

  try {
    const res = await fetch("settings.json", { cache: "no-store" });
    state.settings = await res.json();
  } catch (err) {
    els.summary.textContent = "";
    showBanner(
      "Nu s-a putut încărca settings.json. Deschideți pagina printr-un server web " +
        "(de ex. GitHub Pages sau `python -m http.server`), nu cu dublu-clic pe fișier.",
      "error",
    );
    return;
  }

  state.settings.maxMembers = Number(state.settings.maxMembers) || 3;
  state.students = [
    ...new Set(
      (state.settings.students || []).map(normalizeName).filter(Boolean),
    ),
  ].sort((x, y) => x.localeCompare(y, "ro"));
  els.maxMembers.textContent = state.settings.maxMembers;

  if (!backendConfigured()) {
    render();
    showBanner(
      'Adresa serverului nu este setată. Adăugați URL-ul aplicației Apps Script la "scriptUrl" în settings.json.',
      "info",
    );
    return;
  }

  if (!state.students.length) {
    showBanner(
      'Lista studenților este goală. Adăugați numele în "students" din settings.json.',
      "error",
    );
  }

  // Show the last known state instantly, then update from the server.
  const cached = loadCache();
  if (cached) state.registrations = cached;
  render();

  els.refreshBtn.addEventListener("click", () => refresh());
  await refresh();
}

init();
