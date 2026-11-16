import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, appHome, closeOverlay, exec, focused, hc, home, layout, machines, nextCommand, notify, openOverlay, panes, props, readTextFile, run, setAgentOrder, setShared, shared, spaces, terminals, theme, updates, window, writeTextFile } from "herdr";
import { createHash } from "crypto";

const REFRESH_MS = 30_000;
const FOLLOW_MS = 1000;
const FOLLOW_GAP_MS = 250;
const TICK_MS = 30_000;
const LONG_MS = 600_000;
const FRESH_MS = 48 * 3_600_000;
const FRESH_TICK_MS = 600_000;
const LAUNCHED_MS = 60_000;
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const SHELF_FIRST = 10;
const SHELF_MORE = 25;
const FOUND_MAX = 40;
const ICON = "mods/workspace-chrome";
const OWN = "mods/anyhost/icons";
const ANYHOST = 'PATH="$HOME/.local/share/cmod/programs:$HOME/.local/bin:$PATH" exec anyhost "$@"';
const VIEW = 'export PATH="$HOME/.local/bin:$PATH"; hc label "$HC_TERMINAL_ID" "anyhost.view=$1"; exec hc attach "$2"';
const FILTER = "anyhost.filter";
const PULSE = "anyhost.pulse";
const PICKED_WORKTREE = "anyhost.pickedWorktree";
const TAB_NAMES = "anyhost.tabNames";
const SPACE_NAMES = "anyhost.spaceNames";
const ASK = "anyhost.ask";
const CHANGED = "anyhost.changed";
const UNDO = "anyhost.undo";
const WORKSPACES = "anyhost.workspaces";
const REVEAL = "anyhost.reveal";
const DISCARDED = "anyhost.discarded";
const MODES = [
  ["tabs", "Tabs", `${OWN}/app-window`],
  ["scroll", "Scroll", `${OWN}/gallery-horizontal`],
  ["master", "Master", `${OWN}/layout-panel-left`],
  ["dwindle", "Dwindle", `${OWN}/layout-dashboard`],
  ["grid", "Grid", `${OWN}/layout-grid`],
  ["stack", "Stack", `${OWN}/square-stack`],
  ["board", "Board", `${OWN}/kanban`],
];
const TILED = new Set(["scroll", "master", "dwindle", "grid", "stack"]);
const CYCLED = MODES.map(([mode]) => mode).filter((mode) => mode !== "board");
const SIDES = ["left", "right", "top"];
const VIEW_NODE = { tabs: "main", board: "board", tiles: "tiles" };
const WORKSPACE = { mode: "tabs", side: "left", ratio: 0.6, offset: 0, zoomed: null };
const ALL_WORK = "anyhost-all";
const START_MOST = 8;
const START_WIDTH = 560;
const FOCUS_STEP_MS = 50;
const FOCUS_WAIT_MS = 60_000;
const OPENING_SHOWN_MS = 60_000;
const SHAPES = [
  ["panel", "Side panel", `${OWN}/panel-right`],
  ["popup", "Popup", `${OWN}/picture-in-picture-2`],
  ["full", "Full screen", `${OWN}/maximize-2`],
  ["tab", "Tab", `${OWN}/app-window`],
];
const TABS_WIDTH = "anyhost.tabsWidth";
const OPENING_SPACE = "anyhost.openingSpace";
const OPENING_SPACE_MS = 15_000;
const DRAG_TAB = "anyhost.dragTab";
const TAB_MOST = 220;
const TAB_LEAST = 96;
const DRAG_SLOP = 4;
const DROP_SETTLES_MS = 1000;
const SPLIT_PLACE = { left: "right", right: "right", up: "down", down: "down" };
const SPLIT_ICON = { left: "panel-left", right: "panel-right", up: "panel-top", down: "panel-bottom" };
const PANEL_SHARE = 0.45;
const POPUP_SHARE = 0.75;
const PRESENT_FALLBACK_WIDTH = 1200;
const RATIO_STEP = 0.05;
const RATIO_MOST = 0.8;
const RATIO_LEAST = 0.2;
const SCROLL_WIDTH = 560;
const TILE_WIDTH = 420;
const BRANCH_FRESH_MS = 60_000;
const CLOSED_MOST = 20;
const CLOSE_SETTLES_MS = 3_000;
const RETIRED = ["anyhost.scope", "anyhost.projectSpace", "anyhost.moving", "anyhost.menu", "anyhost.views", "anyhost.projectMachine"];
const SESSION_LABEL = "anyhost.session";
const VIEW_LABEL = "anyhost.view";
const NONE = "none";
const SLEEP_LABEL = "anyhost.sleep";
const ALL = "all";
const TEMPORARY = "temporary";
const NO_FILTER = { project: null, worktree: null, machine: null, tags: [], states: [], include: [] };
const STATE = {
  blocked: { name: "Needs you", sentence: "It waits for your answer", icon: "mods/anyhost/icons/circle-alert", colors: ["#d97706", "#fbbf24"] },
  done: { name: "Done", sentence: "It finished", icon: "circle-check", colors: ["#059669", "#34d399"] },
  working: { name: "Working", sentence: "It is working", icon: "mods/anyhost/icons/circle-dashed", colors: ["#0284c7", "#38bdf8"] },
  tasks: { name: "Tasks running", sentence: "Its tasks are still running", icon: "mods/anyhost/icons/square-stack", colors: ["#7c3aed", "#a78bfa"] },
  idle: { name: "Idle", sentence: "It is idle", icon: "mods/anyhost/icons/circle", colors: ["#787774", "#9b9b9b"] },
};
const isRunning = (state) => state === "working" || state === "tasks";
const INCLUDES = [
  ["background", "Background", "layers"],
  ["temporary", "Temporary", "folder"],
  ["deleted", "Deleted", "mods/anyhost/icons/trash"],
];
const SHELVES = [
  ["working", "Working"],
  ["snoozed", "Snoozed"],
  ["settled", "Settled"],
  ["background", "Background"],
  ["temporary", "Temporary"],
  ["deleted", "Deleted"],
];
const SHELVES_WHOLE = new Set(["working", "snoozed"]);
const OPEN_SECTIONS = new Set(["pinned", "active", "working"]);
const LISTED_SECTIONS = new Set([...OPEN_SECTIONS, "snoozed", "settled"]);
const SYNCED = new Set(["inbox", "board", "projects", "footer", "tabs"]);
const CARDS_PER_STEP = 100;
const ASKS = { permission: "Approval", question: "Input", auth: "Login" };
const APPS = { "claude-vscode": "VS Code", codex_vscode: "VS Code", "claude-desktop": "Claude app" };
const HARNESS = { claude: { icon: "icons/claude.svg", name: "Claude Code", tint: "#d97757" }, codex: { icon: "icons/codex.svg", name: "Codex", tint: null } };
const SETTLE_AFTER = [1, 3, 7, 14, 30, null];
const SNOOZE_PRESETS = [{ after: 60 }, { after: 180 }, { day: "today", time: "18:00" }, { day: "tomorrow", time: "09:00" }, { day: "monday", time: "09:00" }];
const SNOOZE_UNITS = [
  ["minutes", "Minutes", 60_000],
  ["hours", "Hours", 3_600_000],
  ["days", "Days", 86_400_000],
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ACRONYMS = new Set(["API", "CLI", "CSS", "HTML", "JS", "JSON", "MCP", "PHP", "SDK", "SQL", "TS", "UI", "URL", "AI", "CI", "DB", "ID", "IO"]);
const DAY_MS = 86_400_000;
const UI = {
  text: { caption: 12, body: 13, title: 14 },
  height: { inline: 20, control: 28, row: 32 },
  icon: { small: 12, body: 14, lead: 16 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { pill: 4, control: 6, panel: 8 },
  dot: 8,
  rule: 2,
  motion: { duration: 150, easing: "ease-out" },
};
const MOTION_TRAVEL = 40;
const FRAME_MS = 16;
const MOTION_MOST = 40;
const FILTER_BODY_MOST = 460;
const CARD_HEIGHT = UI.space.xs * 2 + UI.height.inline * 3;
const MENU_WIDTH = 220;
const MENU_SEPARATOR = UI.space.xs * 2 + 1;
const BUSY_REASON = "Not while it runs or waits for you";
const HUES = [
  ["#4b5563", "#9ca3af"],
  ["#dc2626", "#f87171"],
  ["#ea580c", "#fb923c"],
  ["#d97706", "#fbbf24"],
  ["#ca8a04", "#facc15"],
  ["#65a30d", "#a3e635"],
  ["#16a34a", "#4ade80"],
  ["#059669", "#34d399"],
  ["#0d9488", "#2dd4bf"],
  ["#0891b2", "#22d3ee"],
  ["#0284c7", "#38bdf8"],
  ["#2563eb", "#60a5fa"],
  ["#4f46e5", "#818cf8"],
  ["#7c3aed", "#a78bfa"],
  ["#9333ea", "#c084fc"],
  ["#c026d3", "#e879f9"],
  ["#db2777", "#f472b6"],
  ["#e11d48", "#fb7185"],
];
const TAG_COLORS = {
  gray: ["#787774", "#9b9b9b"],
  brown: ["#9f6b53", "#ba856f"],
  orange: ["#d9730d", "#c77d48"],
  yellow: ["#cb912f", "#ca9849"],
  green: ["#448361", "#529e72"],
  blue: ["#337ea9", "#379ad3"],
  purple: ["#9065b0", "#9d68d3"],
  pink: ["#c14c8a", "#d15796"],
  red: ["#d44c47", "#df5452"],
};

const anyhost = async (args, timeout = 60_000, on = null) => {
  const r = await exec("sh", ["-c", ANYHOST, "anyhost", ...args], { timeout, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `anyhost ${args[0]} exited with ${r.code}`);
  return r.stdout;
};
const anyhostArgv = (...args) => ["sh", "-c", ANYHOST, "anyhost", ...args];
const messageOf = (error) => String(error?.message ?? error);
const nextTask = (cx) => new Promise((resolve) => cx.timer.after(0, () => resolve()));

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((child) => find(child, id)).find(Boolean) ?? null);
const narrow = (tree = layout()) => (find(tree, "sidebar")?.size?.px ?? Infinity) < 160;

const ago = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - (typeof at === "number" ? at : Date.parse(at))) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};
const since = (ms) => (ago(ms) === "now" ? "just now" : `${ago(ms)} ago`);
const isAfter = (at, than) => Boolean(at) && Boolean(than) && Date.parse(at) > Date.parse(than);
const byRecent = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

const titleOf = (s) => s.title || s.id.slice(0, 8);
const repoOf = (s) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/").toLowerCase() : "");
const repoNameOf = (s) => s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-1)[0];
const checkoutOf = (s) => (s.repoFolder ? s.cwd.slice(0, -(s.repoFolder.length + 1)) : s.cwd);
const isBackground = (entrypoint) => entrypoint.startsWith("sdk") || entrypoint === "codex_exec" || entrypoint === "mcp";
const isUnder = (path, root) => Boolean(root) && (path === root || path.startsWith(`${root}/`));
const isTemporaryIn = (cwd, roots) => !isUnder(cwd, roots?.home ?? "") && [...TEMP_ROOTS, roots?.claudeTmp ?? ""].some((root) => isUnder(cwd, root));
const hashed = new Map();
const hex12 = (text) => hashed.get(text) ?? hashed.set(text, createHash("sha256").update(text).digest("hex").slice(0, 12)).get(text);
const spaceOf = (key, checkout) => (key === TEMPORARY ? "anyhost-temporary" : key === NONE ? "anyhost-none" : `anyhost-w-${hex12(checkout)}`);
const projectSpaceBefore = (key) => `anyhost-p-${hex12(key)}`;
const placedSpace = (on, id) => (on ? `${on}/${id}` : id);
const orderOf = (remembered, live) => {
  const isLive = new Set(live);
  const after = new Map();
  let before = "";
  for (const key of remembered) {
    if (isLive.has(key)) before = key;
    else after.set(before, [...(after.get(before) ?? []), key]);
  }
  return [...(after.get("") ?? []), ...live.flatMap((key) => [key, ...(after.get(key) ?? [])])];
};
const stripOf = (pills, discarded) => {
  const after = new Map();
  for (const session of discarded) after.set(session.after, [...(after.get(session.after) ?? []), session]);
  const placed = new Set();
  const take = (key) => (after.get(key) ?? []).map((session) => (placed.add(session.key), { discarded: session }));
  const strip = take("");
  pills.forEach((pill, i) => {
    strip.push({ pill, i });
    for (const key of pill.sessions) strip.push(...take(key));
  });
  return [...strip, ...discarded.filter((session) => !placed.has(session.key)).map((session) => ({ discarded: session }))];
};
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const sameWorktree = (a, b) => Boolean(a) && Boolean(b) && a.machine === b.machine && a.folder === b.folder;
const tildeOf = (path, homeFolder) => (homeFolder && isUnder(path, homeFolder) ? `~${path.slice(homeFolder.length)}` : path);
const shortTitle = (title, max) => (title.length <= max ? title : `${title.slice(0, max).replace(/\s+\S*$/, "")}…`);
const idOf = () => createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8);

const prettied = new Map();
const prettyName = (name) =>
  prettied.get(name) ??
  prettied
    .set(
      name,
      name
        .split(/[-_.\s]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u)
        .filter(Boolean)
        .map((word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1)}`))
        .join(" "),
    )
    .get(name);
const isSameSession = (a, b) => {
  let count = 0;
  for (const key in b) {
    count++;
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((value, n) => value !== y[n])) return false;
  }
  return count === Object.keys(a).length;
};
const menuOffsetOf = (groups, item) => groups.flat().indexOf(item) * UI.height.row + groups.findIndex((group) => group.includes(item)) * MENU_SEPARATOR;
const projectNameOf = (key, names = {}, repoName = key.split("/").pop()) => (key === NONE ? "No project" : key === TEMPORARY ? "Temporary" : (names?.[key] ?? prettyName(repoName)));

const isFuture = (at, now = Date.now()) => Boolean(at) && Date.parse(at) > now;
const clockOf = (date) => `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const timeOf = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
const durationOf = (minutes) => (minutes % 1440 === 0 ? plural(minutes / 1440, "day") : minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute"));
const snoozeOf = (preset, now) => {
  if (preset.after !== undefined) {
    const wake = new Date(now.getTime() + preset.after * 60_000);
    return { id: `after-${preset.after}`, preset, label: `In ${durationOf(preset.after)}`, detail: wake.toDateString() === now.toDateString() ? clockOf(wake) : `${WEEKDAYS[wake.getDay()]} ${clockOf(wake)}`, until: wake.toISOString() };
  }
  const [hour, minute] = preset.time.split(":").map(Number);
  const ahead = preset.day === "today" ? 0 : preset.day === "tomorrow" ? 1 : (1 - now.getDay() + 7) % 7 || 7;
  const wake = new Date(now.getTime());
  wake.setDate(wake.getDate() + ahead);
  wake.setHours(hour, minute, 0, 0);
  if (wake.getTime() <= now.getTime()) return null;
  const label = ahead === 0 ? (hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening") : ahead === 1 ? "Tomorrow" : "Next week";
  return { id: `at-${preset.day}-${preset.time}`, preset, label, detail: label === "Next week" ? `${WEEKDAYS[wake.getDay()]} ${clockOf(wake)}` : clockOf(wake), until: wake.toISOString() };
};
const snoozesAt = (now) => {
  const minuteOf = (snooze) => Math.floor(Date.parse(snooze.until) / 60_000);
  const seen = new Set();
  return SNOOZE_PRESETS.map((preset) => snoozeOf(preset, now))
    .filter(Boolean)
    .sort((a, b) => minuteOf(a) - minuteOf(b))
    .filter((snooze) => {
      if (seen.has(minuteOf(snooze))) return false;
      seen.add(minuteOf(snooze));
      return true;
    });
};
const wakeLabelOf = (until, now = Date.now()) => {
  const left = Date.parse(until) - now;
  if (!(left > 0)) return "now";
  if (left < 3_600_000) return `${Math.max(1, Math.ceil(left / 60_000))}m`;
  if (left < DAY_MS) return `${Math.ceil(left / 3_600_000)}h`;
  return `${Math.ceil(left / DAY_MS)}d`;
};
const wakeAtOf = (until, now = new Date()) => {
  const wake = new Date(until);
  const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(wake) - midnight(now)) / DAY_MS);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? WEEKDAYS[wake.getDay()] : dayOf(wake);
  return `${day} at ${clockOf(wake)}`;
};
const customSnoozeOf = ({ mode, day, time, amount, unit }, now) => {
  if (mode === "duration") {
    const count = Number(amount);
    const unitMs = SNOOZE_UNITS.find(([id]) => id === unit)?.[2];
    if (!Number.isFinite(count) || count <= 0 || unitMs === undefined) return null;
    return new Date(now.getTime() + count * unitMs).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const clock = time.padStart(5, "0");
  const wake = new Date(`${day}T${clock}:00`);
  if (dayOf(wake) !== day || timeOf(wake) !== clock) return null;
  return wake.getTime() > now.getTime() ? wake.toISOString() : null;
};

const normalized = (name) => name.normalize("NFKC").trim();
const hueOf = (name) => {
  let index = 0;
  for (const glyph of normalized(name).toLowerCase() || "project") index = (index * 31 + glyph.codePointAt(0)) % HUES.length;
  return HUES[index];
};
const monogramOf = (name) => {
  const words = normalized(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [...normalized(name)][0] ?? "PR";
  const glyphs = [...words[0]];
  const second = glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ?? (words.length > 1 ? [...words.at(-1)][0] : glyphs.at(-1)) ?? glyphs[0];
  return [...`${glyphs[0]}${second}`.toUpperCase()].slice(0, 2).join("");
};
const iconPath = (icon) => (icon.includes("/") ? `${icon}.svg` : `${ICON}/${icon}.svg`);

const saved = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const filterOf = () => ({ ...NO_FILTER, ...shared(FILTER) });
const pickedWorktrees = () => shared(PICKED_WORKTREE) ?? {};
const setFilter = (change) => {
  const before = filterOf();
  setShared(FILTER, { ...before, ...("project" in change && change.project !== before.project ? { worktree: null } : {}), ...change });
};
const markOpening = (key, worktree, title) => {
  const id = spaceOf(key, worktree.folder);
  if (!spaces().some((sp) => sp.id === id || sp.id.endsWith(`/${id}`))) setShared(OPENING_SPACE, { id, until: Date.now() + OPENING_SPACE_MS, title });
};
const movedTo = (list, from, to) => {
  if (from < 0 || to < 0 || from === to || from >= list.length) return list;
  const rest = list.filter((_, at) => at !== from);
  return [...rest.slice(0, to), list[from], ...rest.slice(to)];
};
const isPastSlop = (p, e) => p !== null && p !== undefined && !p.isMoving && (Math.abs(e.position.x - p.downX) >= DRAG_SLOP || Math.abs(e.position.y - p.downY) >= DRAG_SLOP);
const orderWith = (order, shown) => {
  const isShown = new Set(shown);
  const placed = shown.filter((key) => order.includes(key));
  let slot = 0;
  return [...shown.filter((key) => !order.includes(key)), ...order.map((key) => (isShown.has(key) ? placed[slot++] : key))];
};
const endTabDrag = (isDropped) => {
  const drag = shared(DRAG_TAB);
  if (!drag) return null;
  setShared(DRAG_TAB, null);
  if (drag.overlay) closeOverlay(drag.overlay);
  if (!isDropped && drag.lifted) run("tab.select", { id: drag.tab });
  return drag;
};
const sideOf = (at, size) =>
  [
    ["left", at.x / size.width],
    ["right", 1 - at.x / size.width],
    ["up", at.y / size.height],
    ["down", 1 - at.y / size.height],
  ].reduce((a, b) => (b[1] < a[1] ? b : a))[0];
const splitInto = (addresses, side) => {
  const target = focused()?.pane;
  if (addresses.includes(focused()?.terminal)) return;
  if (!target) return notify({ title: "Pick a pane to split first", body: "Drop the tab on a tab's terminal to place it beside that terminal.", level: "warning" });
  for (const terminal of addresses) run("terminal.park", { terminal });
  run("pane.focus", { pane: target });
  for (const terminal of addresses) run("terminal.keep", { terminal, place: SPLIT_PLACE[side] });
  if (side === "left" || side === "up") run("pane.swap", { target });
};
const firstWorktreeOf = (key, machine = null) => {
  const first = (shared(PULSE)?.projects.find((p) => p.key === key)?.worktrees ?? []).find((w) => w.id !== null && !w.isGone && (machine === null || w.machine === machine));
  return first ? { machine: first.machine, folder: first.folder } : null;
};
const isFiltered = (f) => f.project !== null || f.worktree !== null || f.machine !== null || f.tags.length > 0 || f.states.length > 0 || f.include.length > 0;
const ask = (action) => setShared(ASK, { at: Date.now(), ...action });
const shownView = (tree = layout()) => Object.entries(VIEW_NODE).find(([, node]) => node === find(tree, "views")?.active)?.[0] ?? "tabs";
const shownTerminalsIn = (node) => {
  if (!node) return [];
  if (node.content?.terminal) return [node.content.terminal];
  if (node.type === "stack") return shownTerminalsIn((node.children ?? []).find((child) => child.id === node.active) ?? node.children?.[0]);
  return (node.children ?? []).flatMap(shownTerminalsIn);
};
const tileTerminals = (tree = layout()) => shownTerminalsIn(find(tree, "tiles"));
const shelfStop = (id) => `shelf-${id}`;
const paletteChildOf = (groups, cursor) => {
  let child = 0;
  let left = cursor;
  for (const [, rows] of groups) {
    child += 1;
    if (left < rows.length) return child + left;
    child += rows.length;
    left -= rows.length;
  }
  return child;
};
const layoutOf = (on) => machines().find((m) => (m.name ?? "") === on)?.layout ?? "loading";
const isLayoutLoaded = () => layoutOf("") !== "loading";
const workspaceOf = (id) => ({ ...WORKSPACE, ...(shared(WORKSPACES) ?? {})[id ?? ""] });
const changeWorkspace = (id, change) => {
  if (id) setShared(WORKSPACES, { ...shared(WORKSPACES), [id]: { ...workspaceOf(id), ...change } });
};
const workPlace = () => {
  const filter = filterOf();
  const known = shared(PULSE)?.workspaces ?? [];
  const all = spaces();
  const isOpen = (w) => all.some((sp) => sp.id === w.id);
  const picked = filter.worktree ? known.find((w) => sameWorktree(w, filter.worktree)) : undefined;
  if (picked && !isOpen(picked)) return { workspace: picked, space: null };
  if (!picked && filter.project !== null && !known.some((w) => w.key === filter.project && isOpen(w))) return { workspace: { id: null, key: filter.project }, space: null };
  const space = all.find((sp) => sp.active) ?? null;
  return { workspace: space ? (known.find((w) => w.id === space.id) ?? null) : null, space };
};
const replaced = (node, id, next) => (node?.id === id ? next : node?.children ? { ...node, children: node.children.map((child) => replaced(child, id, next)) } : node);

const tileIdOf = (terminal) => `tile-${terminal.replace(/[^a-z0-9]/gi, "-")}`;
const tileOf = (terminal, look) => ({ id: tileIdOf(terminal), type: "block", content: { terminal }, ...look });
const splitOf = (type, id, children, weights = children.map(() => 1)) => ({ id, type, gap: UI.space.sm, resizable: false, children: children.map((child, n) => ({ ...child, size: { weight: weights[n] } })) });
const offsetIn = (offset, count, shown) => Math.max(0, Math.min(offset, count - shown));
const scrollShown = (width) => Math.max(1, Math.floor(width / SCROLL_WIDTH));
const dwindleOf = (list, tile, type, depth) =>
  list.length === 1 ? tile(list[0]) : splitOf(type, depth === 0 ? "tiles" : `tiles-${depth}`, [tile(list[0]), dwindleOf(list.slice(1), tile, type === "row" ? "column" : "row", depth + 1)]);
const TILERS = {
  scroll: (list, tile, w, width) => {
    const shown = scrollShown(width);
    const offset = offsetIn(w.offset, list.length, shown);
    return splitOf("row", "tiles", list.slice(offset, offset + shown).map(tile));
  },
  master: (list, tile, w, width) => {
    if (list.length === 1) return splitOf("row", "tiles", [tile(list[0])]);
    const side = width < TILE_WIDTH * 2 ? "top" : w.side;
    const rest = splitOf(side === "top" ? "row" : "column", "tiles-stack", list.slice(1).map(tile));
    const master = tile(list[0]);
    if (side === "right") return splitOf("row", "tiles", [rest, master], [1 - w.ratio, w.ratio]);
    return splitOf(side === "top" ? "column" : "row", "tiles", [master, rest], [w.ratio, 1 - w.ratio]);
  },
  dwindle: (list, tile, _w, width) => (list.length === 1 ? splitOf("row", "tiles", [tile(list[0])]) : dwindleOf(list, tile, width < TILE_WIDTH * 2 ? "column" : "row", 0)),
  grid: (list, tile, _w, width) => {
    const columns = Math.max(1, Math.min(Math.ceil(Math.sqrt(list.length)), Math.floor(width / TILE_WIDTH)));
    const rows = Array.from({ length: Math.ceil(list.length / columns) }, (_, n) => list.slice(n * columns, (n + 1) * columns));
    return splitOf("column", "tiles", rows.map((row, n) => splitOf("row", `tiles-row-${n}`, row.map(tile))));
  },
  stack: (list, tile, _w, _width, focusedTerminal) => ({ id: "tiles", type: "stack", active: tileIdOf(list.includes(focusedTerminal) ? focusedTerminal : list[0]), children: list.map(tile) }),
};
const tilesOf = (mode, list, w, width, focusedTerminal, look) => {
  const tile = (terminal) => tileOf(terminal, look);
  if (w.zoomed && list.includes(w.zoomed)) return splitOf("row", "tiles", [tile(w.zoomed)]);
  return TILERS[mode](list, tile, w, width, focusedTerminal);
};
const rectsOf = (node, rect = { x: 0, y: 0, w: 1, h: 1 }, into = new Map()) => {
  if (!node) return into;
  if (node.content?.terminal) return into.set(node.content.terminal, rect);
  const children = node.type === "stack" ? [(node.children ?? []).find((child) => child.id === node.active) ?? node.children?.[0]].filter(Boolean) : (node.children ?? []);
  const total = children.reduce((sum, child) => sum + (child.size?.weight ?? 1), 0) || 1;
  let at = 0;
  for (const child of children) {
    const share = (child.size?.weight ?? 1) / total;
    const placed = node.type === "row" ? { x: rect.x + at * rect.w, y: rect.y, w: share * rect.w, h: rect.h } : node.type === "column" ? { x: rect.x, y: rect.y + at * rect.h, w: rect.w, h: share * rect.h } : rect;
    rectsOf(child, placed, into);
    at += share;
  }
  return into;
};
const STEPS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const neighbourOf = (rects, from, direction) => {
  const a = rects.get(from);
  if (!a) return null;
  const [dx, dy] = STEPS[direction];
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const [ax, ay] = centre(a);
  const isBeyond = (b) => (dx < 0 ? b.x + b.w <= a.x + 1e-6 : dx > 0 ? b.x >= a.x + a.w - 1e-6 : dy < 0 ? b.y + b.h <= a.y + 1e-6 : b.y >= a.y + a.h - 1e-6);
  const scored = [...rects]
    .filter(([terminal, b]) => terminal !== from && isBeyond(b))
    .map(([terminal, b]) => {
      const [bx, by] = centre(b);
      return { terminal, score: Math.abs(dx ? bx - ax : by - ay) + 2 * Math.abs(dx ? by - ay : bx - ax) };
    })
    .sort((x, y) => x.score - y.score);
  return scored[0]?.terminal ?? null;
};


class Part extends View {
  init(props) {
    this.owner = props.owner;
    this.key = props.key;
  }

  render() {
    return this.owner.renderPart(this.key);
  }
}

export default class Anyhost extends View {
  init(_props, cx) {
    const view = props()?.view ?? "inbox";
    this.kind = view;
    this.isSyncing = false;
    this.isDrawing = false;
    this.partViews = new Map();
    this.wanted = new Set();
    this.mounted = new Set();
    if (view === "projects") return this.initProjects(cx);
    if (view === "footer") return this.initFooter();
    if (view === "board") return this.initBoard(cx);
    if (view === "menu" || view === "filter") return this.initPopup(cx);
    if (view === "settings") return this.initSettings(cx);
    if (view === "snooze") return this.initSnooze(cx);
    if (view === "rename") return this.initRename(cx);
    if (view === "tags") return this.initTags(cx);
    if (view === "new") return this.initNew(cx);
    if (view === "machines") return this.initMachines(cx);
    if (view === "remove" || view === "confirm" || view === "present") return;
    if (view === "drop") return this.initDrop();
    if (view === "palette") return this.initPalette(cx);
    if (view === "tabs") return this.initTabs(cx);
    if (view === "worktree") return this.initWorktree(cx);
    this.initInbox(cx);
  }

  render(cx) {
    const view = this.kind;
    const t = theme();
    this.isDark = cx.theme().is_dark;
    if (SYNCED.has(view)) this.syncSoon(cx);
    this.isDrawing = true;
    const drawn = this.draw(view, t, cx);
    this.isDrawing = false;
    return drawn;
  }

  draw(view, t, cx) {
    if (view === "projects") return this.renderProjects(t).on_mouse_up("left", () => endTabDrag(false));
    if (view === "footer") return this.renderFooter(t).on_mouse_up("left", () => endTabDrag(false));
    if (view === "board") return this.renderBoard(t);
    if (view === "menu") return this.renderMenu(t);
    if (view === "filter") return this.renderFilter(t);
    if (view === "settings") return this.renderSettings(t);
    if (view === "snooze") return this.renderSnooze(t);
    if (view === "rename") return this.renderRename(t);
    if (view === "tags") return this.renderTags(t);
    if (view === "new") return this.renderNew(t);
    if (view === "machines") return this.renderMachines(t);
    if (view === "remove") return this.renderRemove(t);
    if (view === "confirm") return this.renderConfirm(t);
    if (view === "palette") return this.renderPalette(t);
    if (view === "tabs") return this.renderTabs(t);
    if (view === "present") return this.renderPresent(t);
    if (view === "drop") return this.renderDrop(t);
    if (view === "worktree") return this.renderWorktree(t);
    return this.renderInbox(t, cx)
      .on_mouse_move((e, cx) => {
        if (!isPastSlop(this.pressed, e)) return;
        this.pressed = { ...this.pressed, isMoving: true };
        const { address, title } = this.pressed;
        if (address) setShared(DRAG_TAB, { tab: null, title, space: null, terminals: [address], overlay: null, lifted: false, from: "inbox" });
        this.redrawAll(cx);
      })
      .on_mouse_up("left", (_e, cx) => {
        endTabDrag(false);
        this.dropCard(cx);
      });
  }

  dragCardOver(key) {
    const p = this.pressed;
    if (!p?.isMoving || p.over === key) return;
    this.pressed = { ...p, over: key };
    this.act((cx) => this.redrawAll(cx));
  }

  dropCard(cx) {
    const p = this.pressed;
    this.pressed = null;
    if (!p?.isMoving) return;
    this.dropped = p.key;
    if (!p.isPinned) return this.redrawAll(cx);
    const keys = this.shown?.sectionKeys.pinned ?? [];
    this.orderPins(cx, movedTo(keys, keys.indexOf(p.key), keys.indexOf(p.over)));
    this.redrawAll(cx);
  }

  syncSoon(cx) {
    if (this.isSyncing) return;
    this.isSyncing = true;
    cx.timer.after(0, (cx) => {
      this.isSyncing = false;
      this.sync(cx);
    });
  }

  sync(cx) {
    if (this.isDrawing) {
      this.isDrawing = false;
      cx.notify();
    }
    if (this.kind === "projects") return this.syncProjects(cx);
    if (this.kind === "footer") return this.syncFooter(cx);
    if (this.kind === "tabs") return this.syncTabs(cx);
    if (this.pressed?.isMoving && this.pressed.address && !shared(DRAG_TAB)) {
      this.pressed = null;
      this.redrawAll(cx);
    }
    const isRebuilt = this.rebuild();
    if (this.placeParts(cx) || isRebuilt) this.redrawAll(cx);
    if (this.kind === "board") this.boardReconcile(cx);
    else cx.timer.after(0, (cx) => this.reconcileWhenDue(cx));
  }

  partsOf() {
    if (this.kind === "projects") return this.projectsView?.byId;
    return (this.kind === "board" ? this.board : this.shown)?.model.byKey;
  }

  partKeys() {
    if (this.kind === "projects") return this.entries.map((entry) => entry.id);
    if (this.kind === "board") return this.board.cards.map((r) => r.key);
    const { sectionKeys, onScreen } = this.shown;
    const keys = [...sectionKeys.pinned, ...sectionKeys.active, ...sectionKeys.working, ...sectionKeys.snoozed, ...(this.found ?? []).map((r) => r.key), ...Object.values(onScreen).flat().map((r) => r.key)];
    for (const [id] of SHELVES) if (this.opened.has(id)) keys.push(...(sectionKeys[id] ?? []).slice(0, this.shelfShown[id] ?? SHELF_FIRST));
    return keys;
  }

  placeParts(cx) {
    const parts = this.partsOf();
    if (!parts) return false;
    const keys = new Set([...this.wanted, ...this.mounted, ...this.partKeys()]);
    this.wanted.clear();
    let isPlaced = false;
    for (const [key, view] of this.partViews) {
      if (keys.has(key)) continue;
      view.release();
      this.partViews.delete(key);
    }
    for (const key of keys) {
      if (this.partViews.has(key) || !parts.has(key)) continue;
      this.partViews.set(key, cx.new(Part, { owner: this, key }));
      isPlaced = true;
    }
    return isPlaced;
  }

  redrawAll(cx) {
    cx.notify();
    for (const view of this.partViews.values()) cx.notify(view);
  }

  act(work) {
    this.acts.push(work);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  renderPart(key) {
    const t = theme();
    const part = this.partsOf()?.get(key);
    if (!part) return div();
    if (this.kind === "projects") return this.entryElement(t, part);
    if (this.kind === "board") return this.cardElement({ t }, part);
    const { terminal, model, filter } = this.shown;
    return this.cardElement({ t, shown: terminal, model, filter }, part);
  }

  cardElement(ctx, r) {
    if (this.kind === "board") return this.boardCard(ctx.t, r, this.groupBy === "stage");
    return this.row(ctx, r, { withShelf: this.found !== null });
  }

  cardFor(ctx, r, mounted) {
    return this.partFor(r.key, mounted, () => this.cardElement(ctx, r));
  }

  partFor(key, mounted, draw) {
    const view = this.partViews.get(key);
    if (view && !mounted.has(key)) {
      mounted.add(key);
      return view;
    }
    this.wanted.add(key);
    return draw();
  }


  initData(cx, isPolled = () => true) {
    this.data = null;
    this.dataVersion = 0;
    this.readAt = null;
    this.error = null;
    this.pending = new Map();
    this.launched = new Map();
    this.pendingVersion = 0;
    this.refreshes = 0;
    this.applied = 0;
    this.signature = "";
    this.model = null;
    this.shown = null;
    this.acts = [];
    this.wake = null;
    this.isRedrawDue = false;
    this.isTaking = false;
    this.isFollowing = false;
    this.changedAt = shared(CHANGED) ?? 0;
    this.listed = "";
    this.branches = new Map(saved("branches", []));
    this.branchesVersion = 0;
    this.branchesReading = false;
    const cached = saved("listed", null);
    if (cached?.listed) {
      this.apply(cached.listed, 0, cached.readAt ?? null);
      this.rebuild();
      this.placeParts(cx);
    }
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.acts.length === 0) await new Promise((resolve) => (this.wake = resolve));
        for (const work of this.acts.splice(0)) work(cx);
        this.redrawCard(cx, null);
      }
    });
    cx.timer.every(TICK_MS, (cx) => this.redrawAll(cx));
    this.follow(cx, isPolled);
  }

  follow(cx, isPolled) {
    if (!isPolled()) return cx.timer.after(FOLLOW_MS, (cx) => this.follow(cx, isPolled));
    const asked = ++this.refreshes;
    const askedAt = Date.now();
    const wait = this.isFollowing ? ["--wait", String(this.version)] : [];
    cx.spawn(async (cx) => {
      try {
        const listed = await anyhost(["list", "--json", "--brief", ...wait]);
        this.isFollowing = true;
        if (asked >= this.applied) {
          this.error = null;
          await this.take(cx, listed, asked);
        }
      } catch (error) {
        this.isFollowing = false;
        this.error = messageOf(error);
        this.dataVersion++;
      }
      cx.notify();
      cx.timer.after(this.isFollowing ? Math.max(0, FOLLOW_GAP_MS - (Date.now() - askedAt)) : REFRESH_MS, (cx) => this.follow(cx, isPolled));
    });
  }

  refresh(cx) {
    const asked = ++this.refreshes;
    cx.spawn(async (cx) => {
      try {
        const listed = await anyhost(["list", "--json", "--brief"]);
        if (asked < this.applied) return;
        this.error = null;
        await this.take(cx, listed, asked);
      } catch (error) {
        this.error = messageOf(error);
        this.dataVersion++;
      }
      cx.notify();
    });
  }

  async take(cx, listed, asked) {
    const readAt = Date.now();
    if (!this.apply(listed, asked, readAt)) return;
    this.isTaking = true;
    try {
      await nextTask(cx);
      save("listed", { listed, readAt });
      await nextTask(cx);
      const steps = this.cardSteps();
      while (!steps.next().done) await nextTask(cx);
    } finally {
      this.isTaking = false;
    }
  }

  apply(listed, asked, readAt) {
    this.applied = Math.max(this.applied, asked);
    const before = this.pending.size;
    for (const [key, change] of this.pending) if (asked > change.until) this.pending.delete(key);
    if (this.pending.size !== before) this.pendingVersion++;
    this.readAt = readAt;
    if (listed === this.listed && this.data !== null) return false;
    const { here = "", machines: devices = [], agents: sessions, settleAfterDays = null, projectNames = {}, projectOrder = [], pinOrder = [], lastMachine, tags = {}, stages = [], version } = JSON.parse(listed);
    this.version = version;
    this.listed = listed;
    this.data = { here, devices, sessions, settleAfterDays, projectNames, projectOrder, pinOrder, lastMachine, tags, stages };
    this.devices = new Map(devices.map((d) => [d.name, d]));
    this.dataVersion++;
    return true;
  }

  deviceOf(name) {
    return this.devices?.get(name) ?? null;
  }

  hereName() {
    return this.data?.devices.find((d) => d.id === this.data.here)?.name ?? "";
  }

  placeOf(machine) {
    if (machine !== this.hereName()) return machine;
    return this.deviceOf(machine)?.os === "darwin" ? "This Mac" : "This computer";
  }

  onOf(machine) {
    if (machine === this.hereName()) return "";
    const d = this.deviceOf(machine);
    return d?.connected && d.herdr ? d.herdr : null;
  }

  liveInputs() {
    const all = terminals().filter((x) => x.state === "live");
    const listed = agents();
    const isLooking = window()?.active === true;
    const at = focused();
    const tree = layout();
    const view = shownView(tree);
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    const focusedTerminal = view !== "board" ? (at?.terminal ?? panes().find((p) => p.tab === at?.tab && p.focused && p.terminal)?.terminal ?? null) : null;
    return { all, listed, isLooking, view, tiles: tileTerminals(tree), paned, isNarrow: narrow(tree), activeSpace: spaces().find((sp) => sp.active)?.id ?? null, shown: isLooking ? focusedTerminal : null, focusedTab: at?.tab ?? null, focusedTerminal };
  }

  signatureOf(live, filter) {
    const agentPart = live.listed.map((a) => `${a.address}:${a.status}`).join(",");
    const terminalPart = live.all.map((x) => `${x.address}:${x.status ?? ""}:${x.program?.shell ? 1 : 0}:${x.labels?.[SESSION_LABEL] ?? ""}:${x.labels?.[VIEW_LABEL] ?? ""}:${x.labels?.["herdr.space"] ?? ""}:${x.parent ?? ""}:${x.report?.kind ?? ""}`).join(",");
    const now = Date.now();
    const woke = this.cardsNow().wakes.filter((at) => at <= now).at(-1) ?? 0;
    return `${this.dataVersion}|${this.pendingVersion}|${this.branchesVersion}|${Math.floor(now / FRESH_TICK_MS)}|${woke}|${this.sticky ?? ""}|${live.isNarrow}|${live.shown}|${live.focusedTerminal}|${live.activeSpace}|${live.view}:${live.tiles.join(",")}|${[...live.paned].join(",")}|${JSON.stringify(filter)}|${agentPart}|${terminalPart}`;
  }

  rebuild() {
    if (this.data === null || this.isTaking) return false;
    const filter = this.kind === "board" ? this.boardFilter() : filterOf();
    const live = this.liveInputs();
    const work = this.kind === "board" ? this.workNow() : null;
    const isStart = work?.mode === "start";
    const opening = shared(OPENING_SPACE);
    const openingTitle = isStart && opening && opening.until > Date.now() && opening.id === work.workspace?.id ? opening.title : null;
    const signature = `${this.signatureOf(live, filter)}|${isStart}|${openingTitle}`;
    if (signature === this.signature) return false;
    this.signature = signature;
    this.live = live;
    this.model = this.computeModel(live, filter);
    if (this.kind === "board") this.board = { ...this.boardOf(this.model, filter), isStart, openingTitle };
    else this.shown = this.shownOf(this.model, live, filter);
    return true;
  }

  cardOf(s, here, names) {
    const change = this.pending.get(s.id) ?? {};
    const machine = s.holder || s.machine;
    const kind = isTemporaryIn(s.cwd, this.deviceOf(machine)?.roots) ? TEMPORARY : isBackground(s.entrypoint ?? "") ? "background" : "own";
    const projectKey = kind === TEMPORARY ? TEMPORARY : s.repo ? repoOf(s) : NONE;
    const checkout = checkoutOf(s);
    const atMs = Date.parse(s.lastActivity);
    const settledAt = change.settledAt ?? s.settledAt ?? "";
    const snoozedUntil = change.snoozedUntil ?? s.snoozedUntil ?? "";
    const visitedAt = change.visitedAt ?? s.visitedAt ?? "";
    return {
      key: s.id,
      session: s,
      space: spaceOf(projectKey, checkout),
      address: null,
      status: { working: "working", waiting: "blocked", idle: "idle" }[s.status] ?? "idle",
      background: s.background === true,
      statusSinceMs: Date.parse(s.statusSince ?? "") || null,
      title: change.title ?? titleOf(s),
      machine,
      projectKey,
      projectName: projectNameOf(projectKey, names, s.repo ? repoNameOf(s) : undefined),
      kind,
      app: APPS[s.entrypoint] ?? null,
      harness: s.tool,
      checkout,
      archived: change.archived ?? Boolean(s.archived),
      deleted: change.deleted ?? Boolean(s.deleted),
      pinned: (change.pinned ?? s.pinned ?? "") !== "",
      pinnedAt: change.pinned ?? s.pinned ?? "",
      settled: change.settled ?? s.settled === true,
      settledAt,
      settledMs: Date.parse(settledAt) || 0,
      snoozedUntil,
      snoozedMs: Date.parse(snoozedUntil),
      tags: change.tags ?? s.tags ?? [],
      stage: change.stage ?? s.stage ?? "",
      visitedAt,
      lastSaid: s.lastSaid ?? "",
      isRemote: machine !== here,
      at: s.lastActivity,
      atMs,
      isNewer: isAfter(s.lastActivity, visitedAt),
    };
  }

  namesNow() {
    const names = { ...this.data?.projectNames };
    for (const [key, change] of this.pending) {
      if (!key.startsWith("name:") || !("name" in change)) continue;
      if (change.name === null) delete names[key.slice(5)];
      else names[key.slice(5)] = change.name;
    }
    return names;
  }

  orderNow() {
    return this.pending.get("order")?.order ?? this.data?.projectOrder ?? [];
  }

  orderProjects(cx, shown) {
    const next = orderWith(this.orderNow(), shown);
    if (next.join("\0") === this.orderNow().join("\0")) return;
    this.change(cx, "order", { order: next }, () => anyhost(["organize", JSON.stringify([{ op: "orderProjects", projects: next }])]), "anyhost could not keep the order of your projects");
  }

  pinOrderNow() {
    return this.pending.get("pins")?.order ?? this.data?.pinOrder ?? [];
  }

  orderPins(cx, shown) {
    const next = orderWith(this.pinOrderNow(), shown);
    if (next.join("\0") === this.pinOrderNow().join("\0")) return;
    this.frozen = null;
    this.change(cx, "pins", { order: next }, () => anyhost(["organize", JSON.stringify([{ op: "orderPins", sessions: next }])]), "anyhost could not keep the order of your pins");
  }

  cardsNow() {
    const steps = this.cardSteps();
    while (!steps.next().done);
    return this.cards;
  }

  *cardSteps() {
    const key = `${this.dataVersion}|${this.pendingVersion}`;
    if (key === this.cardsKey) return;
    const { sessions } = this.data;
    const here = this.hereName();
    const names = this.namesNow();
    const context = JSON.stringify([here, names, this.data.devices.map((d) => [d.name, d.roots])]);
    const kept = this.cardBySession ?? new Map();
    const bySession = new Map();
    const cards = [];
    for (const s of sessions) {
      const change = this.pending.get(s.id);
      const old = kept.get(s.id);
      const card = old && old.change === change && old.context === context && (old.s === s || isSameSession(old.s, s)) ? old.card : this.cardOf(s, here, names);
      bySession.set(s.id, { s, change, context, card });
      cards.push(card);
      if (cards.length % CARDS_PER_STEP === 0) {
        yield;
        if (`${this.dataVersion}|${this.pendingVersion}` !== key) return;
      }
    }
    this.cardBySession = bySession;
    const worktrees = new Map();
    for (const c of cards) {
      if (c.kind !== "own" || c.deleted) continue;
      const at = `${c.projectKey}\0${c.machine}`;
      worktrees.set(at, (worktrees.get(at) ?? new Set()).add(c.checkout));
    }
    this.cardsKey = key;
    this.cards = { list: cards, worktrees, names, wakes: cards.map((c) => c.snoozedMs).filter(Number.isFinite).sort((a, b) => a - b) };
    return this.cards;
  }

  searchedOf(r) {
    return `${r.title} ${r.projectName} ${r.projectKey} ${r.machine} ${r.app ?? ""} ${r.session.cwd} ${r.lastSaid}`.toLowerCase();
  }

  computeModel(live, filter) {
    const now = Date.now();
    const here = this.hereName();
    const statusOf = new Map(live.listed.map((a) => [a.address, a]));
    const byAddress = new Map(live.all.map((x) => [x.address, x]));
    const { list, worktrees } = this.cardsNow();
    const cards = list.map((c) => ({ ...c, views: [] }));
    const homes = new Map(cards.map((c) => [`${c.machine}\0${c.space}`, c]));
    const cardOf = new Map(cards.map((c) => [c.key, c]));
    const byTerminal = new Map(cards.filter((c) => c.session.terminal).map((c) => [c.session.terminal, c]));
    for (const x of live.all) {
      const viewed = cardOf.get(x.labels?.[VIEW_LABEL] ?? "");
      if (viewed) viewed.views.push(x.address);
      const card = byTerminal.get(x.address) ?? cardOf.get(x.labels?.[SESSION_LABEL] ?? "");
      const agent = statusOf.get(x.address);
      if (card && (agent || !x.program?.shell || this.launched.has(x.address))) Object.assign(card, { address: x.address, status: card.harness === "codex" ? (agent?.status ?? card.status) : card.status, deleted: false, archived: this.pending.get(card.key)?.archived ?? (card.archived && !live.paned.has(x.address)), app: null, isRemote: x.address.includes("/") ? card.isRemote : false, machine: x.address.includes("/") ? card.machine : here });
    }
    const rows = cards;
    for (const r of rows) {
      const placed = r.address ? byAddress.get(r.address)?.labels?.["herdr.space"] : undefined;
      const home = placed && placed !== r.space ? homes.get(`${r.machine}\0${placed}`) : undefined;
      if (home) Object.assign(r, { space: home.space, projectKey: home.projectKey, projectName: home.projectName, checkout: home.checkout });
      Object.assign(r, this.stateOf(r, byAddress.get(r.address), live.shown, now));
    }
    const rowByKey = new Map(rows.map((r) => [r.key, r]));
    for (const r of rows.filter((r) => r.address && !r.isOffline && r.state !== "blocked")) {
      const kid = live.all.find((x) => x.parent === r.address && statusOf.get(x.address)?.status === "blocked");
      if (kid) Object.assign(r, { state: "blocked", label: `Subagent: ${ASKS[kid.report?.kind] ?? "Needs you"}`, since: kid.status_ms ?? r.since });
    }
    const childrenOf = new Map();
    for (const r of rows) {
      const parent = r.session.parent ? rowByKey.get(r.session.parent) : undefined;
      r.isChild = Boolean(parent) && !parent.archived && !parent.deleted;
      if (r.isChild) childrenOf.set(parent.key, [...(childrenOf.get(parent.key) ?? []), r]);
    }
    const isShownKind = (r) => r.kind === "own" || filter.include.includes(r.kind);
    const passes = (r) =>
      (filter.project === null || r.projectKey === filter.project) &&
      (filter.worktree === null || sameWorktree({ machine: r.machine, folder: r.checkout }, filter.worktree)) &&
      (filter.machine === null || r.machine === filter.machine) &&
      (filter.tags.length === 0 || r.tags.some((tag) => filter.tags.includes(tag))) &&
      (filter.states.length === 0 || filter.states.includes(r.state));
    const sections = { pinned: [], active: [], working: [], snoozed: [], settled: [], background: [], temporary: [], deleted: [] };
    for (const r of rows) {
      r.section = this.sectionOf(r, now, isShownKind(r), filter);
      if (r.section && passes(r)) sections[r.section].push(r);
    }
    const urgency = { blocked: 0, done: 1, idle: 2, working: 3, tasks: 3 };
    sections.pinned = this.pinnedOf(sections.pinned);
    sections.active.sort((a, b) => urgency[a.state] - urgency[b.state] || (a.state === "blocked" ? a.since - b.since : b.since - a.since));
    sections.working.sort((a, b) => b.since - a.since);
    sections.snoozed.sort((a, b) => a.snoozedMs - b.snoozedMs || byKey(a, b));
    sections.settled.sort((a, b) => b.settledMs - a.settledMs || byKey(a, b));
    sections.deleted.sort(byRecent);
    sections.background.sort(byRecent);
    sections.temporary.sort(byRecent);
    const kidsOf = new Map();
    for (const x of live.all) if (x.parent && !x.labels?.[SESSION_LABEL]) kidsOf.set(x.parent, [...(kidsOf.get(x.parent) ?? []), x]);
    let pulse = null;
    const model = { rows, byKey: rowByKey, childrenOf, worktrees, sections, now, kidsOf, statusOf };
    Object.defineProperty(model, "pulse", { get: () => (pulse ??= this.pulseOf(rows, live)) });
    return model;
  }

  pinnedOf(rows) {
    const pinRank = new Map(this.pinOrderNow().map((key, at) => [key, at]));
    return rows.filter((r) => r.pinned).sort((a, b) => (pinRank.get(a.key) ?? -1) - (pinRank.get(b.key) ?? -1) || b.pinnedAt.localeCompare(a.pinnedAt) || byKey(a, b));
  }

  stateOf(c, terminal, shown, now) {
    const holder = this.deviceOf(c.machine);
    const at = c.atMs || now;
    const isOffline = Boolean(holder && holder.id !== this.data.here && !holder.connected && !c.address);
    const isShown = Boolean(c.address) && (c.address === shown || c.views.includes(shown)) && this.sticky !== c.key;
    const isUnread = !isShown && c.isNewer;
    const state = c.status === "blocked" || c.status === "working" ? c.status : c.background ? "tasks" : now - at < FRESH_MS ? "done" : "idle";
    const since = state === "blocked" || isRunning(state) ? (c.statusSinceMs ?? terminal?.status_ms ?? at) : at;
    const label = isOffline ? "Offline" : state === "blocked" ? (ASKS[terminal?.report?.kind] ?? (terminal?.status === "error" ? "Error" : "Needs you")) : state === "idle" ? "" : STATE[state].name;
    return { state, label, since, isUnread, isOffline, seenAt: isOffline ? (holder.seenAt ?? null) : null };
  }

  sectionOf(r, now, isShownKind, filter) {
    if (r.deleted) return filter.include.includes("deleted") ? "deleted" : null;
    if (r.archived) return null;
    if (r.isChild || r.kind !== "own") return r.state === "blocked" && !r.isOffline ? "active" : !r.isChild && isShownKind ? r.kind : null;
    if (r.snoozedMs > now) return "snoozed";
    if (r.settled) return "settled";
    if (r.pinned) return "pinned";
    if (isRunning(r.state)) return "working";
    return "active";
  }

  countsOf(rows) {
    const open = rows.filter((r) => OPEN_SECTIONS.has(r.section) && !r.isOffline);
    return Object.fromEntries(Object.keys(STATE).map((state) => [state, open.filter((r) => r.state === state).length]));
  }

  branchOf(machine, folder) {
    return this.branches.get(`${machine}\0${folder}`) ?? null;
  }

  worktreesOf(p) {
    const here = this.hereName();
    const byFolder = new Map();
    for (const r of p.rows) {
      const at = `${r.machine}\0${r.checkout}`;
      const w = byFolder.get(at) ?? { machine: r.machine, folder: r.checkout, rows: [], newest: 0 };
      w.rows.push(r);
      w.newest = Math.max(w.newest, Date.parse(r.at) || 0);
      byFolder.set(at, w);
    }
    return [...byFolder.values()]
      .map((w) => {
        const read = this.branchOf(w.machine, w.folder);
        const on = this.onOf(w.machine);
        return { machine: w.machine, folder: w.folder, key: p.key, id: on === null ? null : placedSpace(on, spaceOf(p.key, w.folder)), branch: read?.branch ?? w.folder.split("/").pop(), isMain: read?.isMain ?? false, isGone: read?.isGone ?? false, ...this.countsOf(w.rows), newest: w.newest };
      })
      .sort((a, b) => (b.machine === here) - (a.machine === here) || b.isMain - a.isMain || b.newest - a.newest);
  }

  workspacesOf(rows) {
    const known = new Map();
    for (const r of rows) {
      const on = this.onOf(r.machine);
      if (r.deleted || on === null) continue;
      const id = placedSpace(on, r.space);
      if (known.has(id)) continue;
      const isLoose = r.projectKey === NONE || r.projectKey === TEMPORARY;
      const branch = this.branchOf(r.machine, r.checkout)?.branch ?? r.checkout.split("/").pop();
      known.set(id, { id, key: r.projectKey, machine: r.machine, folder: isLoose ? null : r.checkout, name: isLoose ? r.projectName : `${r.projectName} · ${branch}` });
    }
    return [...known.values()];
  }

  pulseOf(rows, live) {
    const here = this.hereName();
    const kidsWorking = live.all.filter((x) => x.parent && !x.labels?.[SESSION_LABEL] && live.listed.find((a) => a.address === x.address)?.status === "working").length;
    const machinesListed = [...this.data.devices]
      .sort((a, b) => (a.name === here ? -1 : b.name === here ? 1 : a.name.localeCompare(b.name)))
      .map((d) => ({ name: d.name, place: this.placeOf(d.name), home: d.roots?.home ?? "", on: this.onOf(d.name), connected: d.id === this.data.here || d.connected, seenAt: d.seenAt ?? null, working: rows.filter((r) => r.machine === d.name && r.kind === "own" && !r.isChild && isRunning(r.state)).length }));
    const projects = new Map();
    const names = this.cardsNow().names;
    const counted = rows.filter((r) => LISTED_SECTIONS.has(r.section) && r.projectKey !== TEMPORARY);
    for (const r of counted) {
      const p = projects.get(r.projectKey) ?? { key: r.projectKey, name: r.projectName, defaultName: projectNameOf(r.projectKey, {}, r.session.repo ? repoNameOf(r.session) : undefined), isNamed: names[r.projectKey] !== undefined, rows: [], newest: 0 };
      p.rows.push(r);
      p.newest = Math.max(p.newest, Date.parse(r.at) || 0);
      projects.set(r.projectKey, p);
    }
    const listed = [...projects.values()].map((p) => {
      const onMachines = [...new Set(p.rows.map((r) => r.machine))];
      const checkouts = Object.fromEntries(onMachines.map((m) => [m, [...new Set(p.rows.filter((r) => r.machine === m).sort(byRecent).map((r) => r.checkout))]]));
      return { key: p.key, name: p.name, defaultName: p.defaultName, isNamed: p.isNamed, ...this.countsOf(p.rows), worktrees: p.key === NONE ? [] : this.worktreesOf(p), machines: onMachines, checkouts, newest: p.newest };
    });
    const order = this.orderNow();
    const placeOf = (p) => (p.key === NONE ? Infinity : order.indexOf(p.key));
    listed.sort((a, b) => placeOf(a) - placeOf(b) || b.newest - a.newest);
    return { here, error: this.error, readAt: this.readAt, all: { ...this.countsOf(counted), overall: rows.filter((r) => !r.isOffline && isRunning(r.state)).length + kidsWorking, machines: machinesListed }, projects: listed, workspaces: this.workspacesOf(rows), sessions: Object.fromEntries(rows.filter((r) => r.address).map((r) => [r.key, { state: r.state, pinned: r.pinned }])), pinned: this.pinnedOf(rows.filter((r) => r.section === "pinned")).map((r) => ({ key: r.key, title: r.title, harness: r.harness, space: this.onOf(r.machine) === null ? null : placedSpace(this.onOf(r.machine), r.space) })), known: [...new Map(rows.filter((r) => !r.deleted && r.projectKey !== TEMPORARY).map((r) => [r.projectKey, { key: r.projectKey, name: r.projectName }])).values()] };
  }


  change(cx, key, changed, work, failed) {
    const entry = { ...this.pending.get(key), ...changed, until: Infinity };
    this.pending.set(key, entry);
    this.pendingVersion++;
    cx.spawn(async (cx) => {
      try {
        await work();
        if (this.pending.get(key) === entry) entry.until = this.refreshes;
      } catch (error) {
        this.dropChange(key, changed);
        this.redraw(cx);
        notify({ title: failed, body: messageOf(error), level: "error" });
      }
      this.changedAt = Date.now();
      setShared(CHANGED, this.changedAt);
      this.refresh(cx);
    });
    this.redrawCard(cx, key);
  }

  redraw(cx) {
    this.rebuild();
    this.placeParts(cx);
    this.redrawAll(cx);
  }

  redrawCard(cx, key) {
    this.rebuild();
    this.placeParts(cx);
    cx.notify();
    const view = key === null ? undefined : this.partViews.get(key);
    if (view) cx.notify(view);
    if (this.isRedrawDue) return;
    this.isRedrawDue = true;
    cx.timer.after(FRAME_MS, (cx) => {
      this.isRedrawDue = false;
      this.redrawAll(cx);
    });
  }

  dropChange(key, changed) {
    const current = this.pending.get(key);
    if (current === undefined) return;
    const next = { ...current };
    for (const field of Object.keys(changed)) if (next[field] === changed[field]) delete next[field];
    this.pending.set(key, next);
    this.pendingVersion++;
  }

  archive(cx, r, archived, isClosed = false) {
    if (r.archived === archived) return;
    this.frozen = null;
    this.closed = archived && (isClosed || Boolean(r.address)) ? [r.key, ...this.closed.filter((key) => key !== r.key)].slice(0, CLOSED_MOST) : this.closed.filter((key) => key !== r.key || archived);
    save("closed", this.closed);
    this.change(cx, r.key, { archived }, async () => {
      await anyhost(["archive", r.key, ...(archived ? [] : ["--undo"])]);
      if (archived) notify({ title: `Archived ${r.title.slice(0, 50)}`, body: isClosed ? "Click to reopen it." : "Click to undo.", level: "info", action: { name: `anyhost.restore-${r.key.slice(0, 8)}` } });
    }, archived ? "anyhost could not archive it" : "anyhost could not restore it");
  }

  restore(cx, r) {
    const wasClosed = this.closed.includes(r.key);
    this.archive(cx, r, false);
    if (wasClosed) this.open({ ...r, archived: false }, cx);
  }

  reopenClosed(cx) {
    const r = this.closed.map((key) => this.model?.byKey.get(key)).find((row) => row?.archived && !row.deleted);
    if (!r) return notify({ title: "No closed session to reopen", level: "info", timeout: 3000 });
    this.restore(cx, r);
  }

  closeTabs(cx, tabs) {
    const byAddress = new Map(terminals().map((x) => [x.address, x]));
    const leaving = [];
    for (const tab of tabs) {
      const ps = panes().filter((p) => p.tab === tab);
      const rows = [...new Set(ps.map((p) => byAddress.get(p.terminal)?.labels?.[SESSION_LABEL]).filter(Boolean))].map((key) => this.model?.byKey.get(key)).filter(Boolean);
      if (rows.some((r) => r.pinned)) continue;
      if (rows.length === 0) run("tab.close", { id: tab, confirmed: true });
      for (const p of ps.filter((p) => !byAddress.get(p.terminal)?.labels?.[SESSION_LABEL])) run("pane.close", { pane: p.pane });
      leaving.push(...rows);
    }
    this.askArchive(cx, leaving, true);
  }

  closeShown(cx) {
    const view = shownView();
    const at = focused();
    if (view === "tabs" && at?.tab) return this.closeTabs(cx, [at.tab]);
    const key = view === "tiles" ? terminals().find((x) => x.address === at?.terminal)?.labels?.[SESSION_LABEL] : undefined;
    const r = key ? this.model?.byKey.get(key) : undefined;
    if (r) this.askArchive(cx, [r], true);
  }

  askArchive(cx, rows, isClosed = false) {
    const leaving = rows.filter((r) => !r.pinned && !r.archived);
    const running = leaving.filter((r) => isRunning(r.state) || r.state === "blocked");
    if (running.length === 0) return leaving.forEach((r) => this.archive(cx, r, true, isClosed));
    const [first] = running;
    this.confirm({
      title: running.length === 1 ? `Archive ${first.title.slice(0, 50)}?` : `Archive ${running.length} running sessions?`,
      body: running.length === 1 ? `${STATE[first.state].sentence}. Archiving stops it once its current work ends, and Restore opens it again.` : "Archiving stops each once its current work ends, and Restore opens it again.",
      go: "Archive",
      ask: { action: "archiveNow", keys: leaving.map((r) => r.key), isClosed },
    });
  }

  confirm(shown) {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 380, props: { view: "confirm", ...shown } });
  }

  visit(cx, r, at, failed) {
    this.change(cx, r.key, { visitedAt: at }, () => anyhost(["visit", r.key, "--at", at]), failed);
  }

  markUnread(cx, r) {
    this.sticky = r.key;
    this.visit(cx, r, new Date(Date.parse(r.at) - 1).toISOString(), "anyhost could not mark it unread");
  }

  markRead(cx, r, failed = "anyhost could not mark it read") {
    this.visit(cx, r, new Date(Math.max(Date.now(), Date.parse(r.at) || 0)).toISOString(), failed);
  }

  undoToast(done, r, command) {
    notify({ title: `${done} ${r.title.slice(0, 50)}`, body: "Click to undo.", level: "info", action: { name: `anyhost.${command}-${r.key.slice(0, 8)}` } });
  }

  takeUndone(key) {
    const undone = this.undone.get(key) ?? {};
    this.undone.delete(key);
    return undone;
  }

  togglePin(cx, r) {
    return r.pinned ? this.unpin(cx, r) : this.pin(cx, r);
  }

  pin(cx, r, snoozedUntil = "") {
    this.frozen = null;
    const restored = isFuture(snoozedUntil) ? snoozedUntil : "";
    this.change(cx, r.key, { pinned: new Date().toISOString(), settled: false, snoozedUntil: restored }, async () => {
      await anyhost(["pin", r.key]);
      if (restored) await anyhost(["snooze", r.key, restored]);
    }, "anyhost could not pin it");
  }

  unpin(cx, r) {
    this.frozen = null;
    this.undone.set(r.key, { snoozedUntil: r.snoozedUntil });
    this.change(cx, r.key, { pinned: "" }, async () => {
      await anyhost(["pin", r.key, "--undo"]);
      this.undoToast("Unpinned", r, "repin");
    }, "anyhost could not unpin it");
  }

  toggleSettle(cx, r) {
    if (isRunning(r.state) || r.state === "blocked") return;
    return r.section === "settled" ? this.unsettle(cx, r) : this.settle(cx, r);
  }

  settle(cx, r) {
    this.frozen = null;
    this.undone.set(r.key, { pinned: r.pinned, snoozedUntil: r.snoozedUntil });
    this.change(cx, r.key, { settled: true, settledAt: new Date().toISOString(), pinned: "", snoozedUntil: "" }, async () => {
      await anyhost(["settle", r.key]);
      this.undoToast("Settled", r, "unsettle");
    }, "anyhost could not settle it");
  }

  unsettle(cx, r, { pinned = false, snoozedUntil = "" } = {}) {
    this.frozen = null;
    const restored = isFuture(snoozedUntil) ? snoozedUntil : "";
    this.change(cx, r.key, { settled: false, ...(pinned ? { pinned: new Date().toISOString() } : {}), ...(restored ? { snoozedUntil: restored } : {}) }, async () => {
      await anyhost(["settle", r.key, "--undo"]);
      if (pinned) await anyhost(["pin", r.key]);
      if (restored) await anyhost(["snooze", r.key, restored]);
    }, "anyhost could not unsettle it");
  }

  snooze(cx, r, until) {
    this.frozen = null;
    this.change(cx, r.key, { snoozedUntil: until ?? "" }, async () => {
      await anyhost(["snooze", r.key, ...(until ? [until] : ["--undo"])]);
      if (until) notify({ title: `Snoozed ${r.title.slice(0, 50)}`, body: `It comes back ${wakeAtOf(until)}. Click to undo.`, level: "info", action: { name: `anyhost.wake-${r.key.slice(0, 8)}` } });
    }, until ? "anyhost could not snooze it" : "anyhost could not wake it");
  }

  nameProject(cx, key, name) {
    this.change(cx, `name:${key}`, { name }, () => anyhost(["project-name", key, ...(name === null ? ["--undo"] : [name])]), "anyhost could not rename the project");
  }

  openSettings() {
    const archived = (this.model?.rows ?? []).filter((r) => r.archived && !r.deleted && !r.isChild).sort(byRecent);
    openOverlay({ mod: "anyhost", kind: "dialog", width: 460, props: { view: "settings", settleAfterDays: this.data?.settleAfterDays ?? null, archived: archived.map((r) => ({ key: r.key, title: r.title, harness: r.harness, at: r.at, projectKey: r.projectKey, projectName: r.projectName, machine: r.isRemote ? this.placeOf(r.machine) : "" })) } });
  }

  undoOf(changes) {
    const undo = [];
    for (const change of changes) {
      const tag = change.op === "dropTag" ? this.data?.tags[change.id] : undefined;
      if (tag) undo.push({ op: "defineTag", id: change.id, ...tag }, ...this.data.sessions.filter((s) => (s.tags ?? []).includes(change.id)).map((s) => ({ op: "tagSession", session: s.id, tag: change.id, on: true })));
      if (change.op === "defineStages" && (this.data?.stages ?? []).some((s) => !change.stages.some((kept) => kept.id === s.id))) undo.push({ op: "defineStages", stages: this.data.stages });
    }
    return undo;
  }

  organize(cx, changes, optimistic = []) {
    const undo = this.undoOf(changes);
    if (undo.length > 0) {
      setShared(UNDO, { at: Date.now(), changes: undo });
      notify({ title: changes.some((c) => c.op === "dropTag") ? "Deleted the tag" : "Deleted the stage", body: "Click to undo.", level: "info", action: { name: "anyhost.undo" } });
    }
    for (const [key, changed] of optimistic) {
      this.pending.set(key, { ...this.pending.get(key), ...changed, until: Infinity });
    }
    if (this.data) {
      const tags = { ...this.data.tags };
      let stages = this.data.stages;
      for (const change of changes) {
        if (change.op === "defineTag") tags[change.id] = { name: change.name, color: change.color };
        if (change.op === "dropTag") delete tags[change.id];
        if (change.op === "defineStages") stages = change.stages;
      }
      this.data = { ...this.data, tags, stages };
      this.dataVersion++;
    }
    this.pendingVersion++;
    cx.spawn(async (cx) => {
      try {
        await anyhost(["organize", JSON.stringify(changes)]);
        for (const [key] of optimistic) {
          const entry = this.pending.get(key);
          if (entry) entry.until = this.refreshes;
        }
      } catch (error) {
        for (const [key, changed] of optimistic) this.dropChange(key, changed);
        this.redraw(cx);
        notify({ title: "anyhost could not change it", body: messageOf(error), level: "error" });
      }
      this.changedAt = Date.now();
      setShared(CHANGED, this.changedAt);
      this.refresh(cx);
    });
    this.redraw(cx);
  }

  remove(cx, r) {
    const holder = this.deviceOf(r.machine);
    const on = holder && holder.id !== this.data.here ? this.onOf(r.machine) : null;
    this.frozen = null;
    this.change(cx, r.key, { deleted: true }, async () => {
      if (holder && holder.id !== this.data.here && on === null) throw new Error(`${holder.name} holds it, and the Herdr app does not reach ${holder.name}.`);
      await anyhost(["delete", r.key], LONG_MS, on || null);
      notify({ title: `Deleted ${r.title.slice(0, 50)}`, body: "Click to undo.", level: "info", action: { name: `anyhost.open-${r.key.slice(0, 8)}` } });
    }, "anyhost could not delete it");
  }

  confirmDelete(r) {
    if (isRunning(r.state) || r.state === "blocked") return;
    this.confirm({ title: `Delete ${r.title}?`, body: "Its files leave every machine. Its backup in R2 stays, so Restore brings it back.", go: "Delete", ask: { action: "delete", key: r.key } });
  }


  open(r, cx) {
    const filter = filterOf();
    const worktree = { machine: r.machine, folder: r.checkout };
    if (filter.project !== null && filter.project !== r.projectKey) setFilter({ project: r.projectKey });
    else if (filter.worktree !== null && !sameWorktree(filter.worktree, worktree)) setFilter({ worktree });
    const on = this.onOf(r.machine);
    const id = on === null ? null : placedSpace(on, r.space);
    if (workspaceOf(id).mode === "board") changeWorkspace(id, { mode: "tabs" });
    if (r.address) return this.focusSession(r.address, r);
    if (this.opening.has(r.key)) return;
    if (r.archived) this.archive(cx, r, false);
    if (r.deleted) this.change(cx, r.key, { deleted: false }, async () => undefined, "");
    this.launch(r, on ?? "", (at) => this.focusWhenShown(at, r.title));
  }

  launch(r, on, opened) {
    this.opening.set(r.key, Date.now());
    this.terminalFor(r, on)
      .then(opened)
      .catch((error) => {
        this.opening.delete(r.key);
        notify({ title: `anyhost could not open ${r.title.slice(0, 40)}`, body: messageOf(error), level: "error" });
      });
  }

  async terminalFor(r, on) {
    if (r.session.tool === "claude") return this.openedAt(JSON.parse(await anyhost(["open", r.key, "--json"], LONG_MS, on || null)).terminal, on);
    const placed = ["--label", `herdr.space=${r.space}`, "--label", `herdr.tab=${r.key.slice(0, 8)}`, "--label", `${SESSION_LABEL}=${r.key}`];
    const answer = await hc(["run", "--bg", "--keep", "--no-parent", "--json", ...(on ? ["--on", on] : []), ...placed, "--", ...anyhostArgv("resume", r.key, ...(on === "" && r.isRemote ? ["--take"] : []))]);
    if (answer.code !== 0) throw new Error((answer.stderr || answer.stdout).trim());
    return this.openedAt(JSON.parse(answer.stdout).address, on);
  }

  openedAt(terminal, on) {
    const at = on ? `${on}/${terminal}` : terminal;
    this.launched.set(at, Date.now());
    return at;
  }

  adopt(r) {
    void hc(["label", r.address, `herdr.space=${r.space}`, `herdr.tab=${r.key.slice(0, 8)}`]);
  }

  focusSession(address, r = null) {
    const ps = panes();
    const pane = ps.find((p) => p.terminal === address);
    if (!pane) {
      const isParked = !terminals().find((x) => x.address === address)?.labels?.["herdr.space"];
      if (r && isParked) this.adopt(r);
      this.focusWhenShown(address, r?.title ?? address);
      return;
    }
    run("pane.focus", { terminal: address });
    if (shownView() === "tiles") return setShared(REVEAL, { terminal: address, at: Date.now() });
    const other = ps.find((p) => p.tab === pane.tab && p.zoomed && p.pane !== pane.pane);
    if (other) run("pane.zoom", { pane: other.pane });
  }

  parkInto(address, target) {
    if (target) this.moves.set(address, target);
    else this.moves.delete(address);
    save("moves", [...this.moves]);
  }

  peek(r) {
    if (r.address) return run("terminal.peek", { terminal: r.address });
    if (this.opening.has(r.key)) return;
    this.launch(r, this.onOf(r.machine) ?? "", (at) => run("terminal.peek", { terminal: at }));
  }

  present(cx, r, shape) {
    if (shape === "tab") {
      this.closePresented();
      return this.open(r, cx);
    }
    if (r.address) return this.showIn(r, r.address, shape);
    if (this.opening.has(r.key)) return;
    this.launch(r, this.onOf(r.machine) ?? "", (at) => this.showIn(r, at, shape));
  }

  showIn(r, address, shape) {
    const frame = (find(layout(), "sidebar")?.hidden ? 0 : (this.sidebarWidth ?? 0)) + (shared(TABS_WIDTH) ?? PRESENT_FALLBACK_WIDTH);
    const placed = shape === "full" ? { width: 1, height: 1, at: { x: 0, y: 0 } } : shape === "popup" ? { width: POPUP_SHARE, height: POPUP_SHARE } : { width: PANEL_SHARE, height: 1, at: { x: Math.round(frame * (1 - PANEL_SHARE)), y: 0 } };
    const bar = { type: "block", size: { px: UI.height.row }, content: { mod: "anyhost", props: { view: "present", key: r.key, title: r.title, shape } } };
    if (this.presented && this.presented.shape !== shape) closeOverlay(this.presented.id);
    const id = openOverlay({ kind: "window", key: `anyhost-${shape}`, ...placed, layout: { type: "column", children: [bar, { type: "block", content: { terminal: address } }] } });
    this.presented = { id, shape, key: r.key };
    this.opening.delete(r.key);
  }

  closePresented() {
    if (this.presented) closeOverlay(this.presented.id);
    this.presented = null;
  }

  showHere(r, direction) {
    const at = focused();
    if (!at?.pane) return;
    const split = (terminal) => run("pane.split", { pane: at.pane, direction, argv: ["sh", "-c", VIEW, "view", r.key, terminal] });
    if (r.address) return split(r.address);
    if (!this.opening.has(r.key)) this.launch(r, this.onOf(r.machine) ?? "", split);
  }

  moveTab({ terminals: addresses, key, worktree, name }) {
    const on = this.onOf(worktree.machine);
    const away = addresses.filter((address) => (address.includes("/") ? address.split("/")[0] : "") !== (on ?? ""));
    if (on === null || away.length > 0) return notify({ title: `The tab runs on another machine than ${name}`, body: "Move its session there with Move to… in its menu.", level: "warning" });
    const tab = idOf();
    for (const address of addresses) this.moveTerminal(address, { space: spaceOf(key, worktree.folder), tab });
    notify({ title: `Moved the tab to ${name}`, level: "info", timeout: 2000 });
  }

  moveToTab(r, tab) {
    const address = r.address;
    if (!address || address.includes("/")) return;
    const space = spaces().find((sp) => sp.tabs.some((x) => x.id === tab));
    if (!space) return;
    this.moveTerminal(address, { space: space.id, tab });
  }

  worktreeToShow(key, machine) {
    const first = firstWorktreeOf(key, machine);
    if (first !== null) return first;
    const here = this.hereName();
    const newest = (this.model?.rows ?? []).filter((r) => r.projectKey === key && !r.deleted && this.onOf(r.machine) !== null && (machine === null || r.machine === machine)).sort((a, b) => (b.machine === here) - (a.machine === here) || byRecent(a, b))[0];
    return newest ? { machine: newest.machine, folder: newest.checkout } : null;
  }

  showProject(key, machine = null) {
    const worktree = this.worktreeToShow(key, machine);
    if (worktree === null) return notify({ title: `No machine the Herdr app reaches holds ${projectNameOf(key, this.namesNow())}`, body: "Add the machine that holds it, and its sessions show here.", level: "warning" });
    if (key !== NONE && key !== TEMPORARY) setFilter({ project: key, worktree });
    this.showWorkspace(key, worktree);
  }

  showWorkspace(key, worktree) {
    this.selecting = null;
    setShared(PICKED_WORKTREE, { ...pickedWorktrees(), [key]: worktree });
    const on = this.onOf(worktree.machine);
    const id = spaceOf(key, worktree.folder);
    const space = on === null ? null : placedSpace(on, id);
    const layoutState = on === null ? "unavailable" : layoutOf(on);
    if (layoutState !== "loading" && (space === null || spaces().some((sp) => sp.id === space) || layoutState === "unavailable")) setShared(OPENING_SPACE, null);
    if (on === null) return notify({ title: `The Herdr app does not reach ${worktree.machine}`, body: "Add the machine, and its workspaces show here.", level: "warning" });
    if (spaces().some((sp) => sp.id === space)) {
      run("space.select", { id: space });
      return this.fillWorkspace(key, worktree);
    }
    if (layoutState === "loading") return void (this.afterLayout = { on, run: () => this.showWorkspace(key, worktree) });
    if (layoutState === "unavailable") return notify({ title: `The Herdr app does not reach ${this.placeOf(worktree.machine)} now`, body: "Its workspaces open once it answers again.", level: "warning" });
    const held = this.fillWorkspace(key, worktree);
    const newest = [...held].sort(byRecent)[0];
    this.selecting = { space, until: Date.now() + OPENING_SPACE_MS };
    setShared(OPENING_SPACE, { id, until: this.selecting.until, title: newest?.title ?? "a terminal" });
    if (held.some((r) => r.address || this.opening.has(r.key))) return;
    if (newest) return this.launch(newest, on, (at) => this.focusWhenShown(at, newest.title));
    void hc(["run", "--bg", "--keep", "--no-parent", "--json", ...(on ? ["--on", on] : []), "--cwd", worktree.folder, "--label", `herdr.space=${id}`, "--", "sh", "-c", 'exec "${SHELL:-/bin/sh}" -l']);
  }

  fillWorkspace(key, worktree) {
    if (!this.model || this.onOf(worktree.machine) === null) return [];
    const id = spaceOf(key, worktree.folder);
    const byAddress = new Map(terminals().map((x) => [x.address, x]));
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    const held = this.model.rows.filter((r) => r.space === id && r.machine === worktree.machine && !r.isChild && OPEN_SECTIONS.has(r.section));
    for (const r of held) {
      if (!r.address || this.moves.has(r.address)) continue;
      const placed = byAddress.get(r.address)?.labels?.["herdr.space"];
      if (!placed && !paned.has(r.address)) this.adopt(r);
    }
    return held;
  }

  moveTerminal(address, target) {
    this.parkInto(address, target);
    run("terminal.park", { terminal: address });
  }

  startIn(project, cx, { machine = null, folder = null } = {}) {
    const pulse = shared(PULSE);
    const p = project ?? null;
    const machinesWith = p ? Object.keys(p.checkouts ?? {}).filter((m) => (p.checkouts[m] ?? []).length > 0 && (m === pulse.here || pulse.all.machines.find((d) => d.name === m)?.connected)) : [];
    const picked = p ? pickedWorktrees()[p.key] : undefined;
    const chosen = machine ?? (machinesWith.includes(picked?.machine) ? picked.machine : machinesWith.includes(pulse.here) ? pulse.here : machinesWith[0]);
    const where = folder ?? (picked?.machine === chosen ? picked.folder : p?.checkouts?.[chosen]?.[0]);
    if (!chosen || !where) return this.newSession();
    const on = pulse.all.machines.find((m) => m.name === chosen)?.on ?? null;
    const name = p?.name ?? where.split("/").pop();
    notify({ title: `Starting a session in ${name}`, body: `On ${pulse.all.machines.find((m) => m.name === chosen)?.place ?? chosen}, in ${tildeOf(where, pulse.all.machines.find((m) => m.name === chosen)?.home ?? "")}.`, level: "info", timeout: 3000 });
    if (on !== null) this.selecting = { space: placedSpace(on, spaceOf(p?.key ?? NONE, where)), until: Date.now() + 15_000 };
    this.startAt(cx, chosen, where, on, `anyhost could not start a session in ${name}`);
  }

  startAt(cx, machine, folder, on, failure) {
    cx.spawn(async (cx) => {
      try {
        const { session } = JSON.parse(await anyhost(["new", machine, folder, "--json"], LONG_MS));
        this.refresh(cx);
        if (on !== null) this.focusOpened(JSON.parse(await anyhost(["open", session, "--json"], LONG_MS, on || null)).terminal, on);
      } catch (error) {
        notify({ title: failure, body: messageOf(error), level: "error" });
      }
    });
  }

  focusOpened(terminal, on) {
    this.focusWhenShown(this.openedAt(terminal, on), "the new session");
  }

  focusWhenShown(address, title) {
    this.focusing = { address, title, until: Date.now() + FOCUS_WAIT_MS };
    this.act((cx) => this.stepFocus(cx));
  }

  newSession() {
    const pulse = shared(PULSE);
    if (!pulse) return;
    const at = focused();
    const current = this.model?.rows.find((r) => r.address && r.address === at?.terminal)?.projectKey ?? pulse.workspaces.find((w) => w.id === at?.space)?.key ?? null;
    openOverlay({ mod: "anyhost", kind: "dialog", width: 520, props: { view: "new", current, homes: Object.fromEntries((this.data?.devices ?? []).map((d) => [d.name, d.roots?.home ?? ""])) } });
  }


  initInbox(cx) {
    for (const key of RETIRED) if (shared(key) != null) setShared(key, null);
    this.keys = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search" });
    this.found = null;
    this.search.on("change", (_e, cx) => {
      this.found = this.foundOf(this.model);
      this.placeParts(cx);
      this.redrawAll(cx);
    });
    this.search.on("focus", () => void (this.isSearching = true));
    this.search.on("blur", () => void (this.isSearching = false));
    this.opened = new Set(saved("shelves", []));
    this.listScroll = ScrollHandle.new();
    this.departing = new Map();
    this.unfolded = new Set(saved("unfolded", []));
    this.shelfShown = {};
    this.frozen = null;
    this.isPointerIn = false;
    this.cursor = null;
    this.hovered = null;
    this.sticky = null;
    this.askedAt = shared(ASK)?.at ?? 0;
    this.window = idOf();
    this.reported = null;
    this.reportedAt = 0;
    this.closed = saved("closed", []);
    this.undone = new Map();
    this.moves = new Map(saved("moves", []));
    this.opening = new Map();
    this.wasOpen = null;
    this.focusing = null;
    this.selecting = null;
    this.pulsed = "";
    this.reconciledKey = "";
    this.arrived = 0;
    this.initData(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.keys.focus();
        if (command === "new") this.newHere(cx);
        if (command === "filter") this.openFilter();
        if (command === "palette") this.openPalette();
        if (command === "board") this.openBoard(filterOf().project);
        if (command === "search") this.search.focus();
        if (command === "close") this.closeShown(cx);
        if (command === "reopen") this.reopenClosed(cx);
        const undone = command === "undo" ? shared(UNDO) : null;
        if (undone?.changes) {
          setShared(UNDO, null);
          this.organize(cx, undone.changes);
        }
        const [, verb, id] = /^(open|menu|restore|unsettle|repin|wake|present-panel|present-popup|present-full)-(.+)$/.exec(command) ?? [];
        const r = id ? this.model?.rows.find((row) => row.key.startsWith(id)) : null;
        if (r && verb === "open") this.open(r, cx);
        if (r && verb?.startsWith("present-")) this.present(cx, r, verb.slice("present-".length));
        if (r && verb === "menu") this.menu(r);
        if (r && verb === "restore") this.restore(cx, r);
        if (r && verb === "unsettle") this.unsettle(cx, r, this.takeUndone(r.key));
        if (r && verb === "repin") this.pin(cx, r, this.takeUndone(r.key).snoozedUntil);
        if (r && verb === "wake") this.snooze(cx, r, null);
        this.redrawAll(cx);
      }
    });
  }

  reconcileWhenDue(cx) {
    if (!this.model || !isLayoutLoaded()) return;
    const key = `${this.signature}|${Math.floor(Date.now() / TICK_MS)}|${shared(ASK)?.at ?? 0}|${shared(CHANGED) ?? 0}|${this.live.focusedTab}|${panes().length}|${spaces().length}|${machines().map((m) => m.layout).join(",")}`;
    if (key === this.reconciledKey) return;
    this.reconciledKey = key;
    this.reconcile(cx);
  }

  reconcile(cx) {
    const project = filterOf().project;
    if (this.searchedIn !== undefined && project !== this.searchedIn) {
      if (this.search.value() !== "") this.search.set_value("");
      this.found = null;
      this.cursor = null;
      this.shelfShown = {};
    }
    this.searchedIn = project;
    const model = this.model;
    const live = this.live;
    if (!model || !live || this.data === null) return;
    const waiting = this.afterLayout;
    if (waiting && layoutOf(waiting.on) !== "loading") {
      this.afterLayout = null;
      waiting.run();
    }
    const written = JSON.stringify(model.pulse);
    if (written !== this.pulsed) {
      this.pulsed = written;
      setShared(PULSE, { ...model.pulse, at: Date.now() });
    }
    this.publishDiscarded(model);
    const order = this.orderNow();
    const arrived = model.pulse.projects.filter((p) => p.key !== NONE && !order.includes(p.key)).map((p) => p.key);
    if (arrived.length > 0 && arrived.join("\0") !== this.orderArrived) {
      this.orderArrived = arrived.join("\0");
      this.orderProjects(cx, arrived);
    }
    const changed = shared(CHANGED) ?? 0;
    if (changed > this.changedAt) {
      this.changedAt = changed;
      this.refresh(cx);
    }
    const asked = shared(ASK);
    if (asked && asked.at > this.askedAt) {
      this.askedAt = asked.at;
      this.perform(asked, cx);
    }
    this.followScreen(model, live);
    const shownRow = live.shown ? model.rows.find((r) => r.address === live.shown || r.views.includes(live.shown)) : undefined;
    if (this.sticky && shownRow?.key !== this.sticky) {
      this.sticky = null;
      cx.notify();
    }
    this.reportShown(live);
    this.readBranches(cx, model);
    this.parkLeaving(model, live);
    this.moveFromProjectSpaces(model, live);
    this.fillShownWorkspace(live);
    this.nameTabs(model);
    this.nameSpaces(model);
    this.stepMoves(live);
    this.stepFocus(cx);
    for (const [key, at] of this.opening) if (model.byKey.get(key)?.address || Date.now() - at > OPENING_SHOWN_MS) this.opening.delete(key);
    for (const [address, at] of this.launched) if (Date.now() - at > LAUNCHED_MS) this.launched.delete(address);
  }

  perform(asked, cx) {
    if (asked.action === "showProject") return this.showProject(asked.key, asked.machine ?? null);
    if (asked.action === "showWorkspace") return this.showWorkspace(asked.key, asked.worktree);
    if (asked.action === "startIn") return this.startIn(asked.project, cx, { machine: asked.machine ?? null, folder: asked.folder ?? null });
    if (asked.action === "startFolder") return this.startFolder(asked.machine, asked.folder, cx);
    if (asked.action === "organize") return this.organize(cx, asked.changes, asked.optimistic ?? []);
    if (asked.action === "orderProjects") return this.orderProjects(cx, asked.order);
    if (asked.action === "board") return this.openBoard(asked.project ?? null);
    if (asked.action === "newHere") return this.newHere(cx);
    if (asked.action === "readProject") return (this.model?.rows ?? []).filter((r) => r.projectKey === asked.project.key && (!asked.worktree || sameWorktree(asked.worktree, { machine: r.machine, folder: r.checkout })) && r.isUnread && !r.archived).forEach((r) => this.markRead(cx, r));
    if (asked.action === "newWorktree") return this.newWorktree(cx, asked.project, asked.branch, asked.from ?? null);
    if (asked.action === "removeWorktree") return this.removeWorktree(cx, asked.machine, asked.folder);
    if (asked.action === "moveTab") return this.moveTab(asked);
    if (asked.action === "closeTabs") return this.closeTabs(cx, asked.tabs);
    if (asked.action === "archiveNow") return asked.keys.map((key) => this.model?.byKey.get(key)).filter(Boolean).forEach((r) => this.archive(cx, r, true, asked.isClosed));
    if (asked.action === "reopen") return this.reopenClosed(cx);
    if (asked.action === "nameProject") return this.nameProject(cx, asked.project, asked.name);
    if (asked.action === "settings") return this.openSettings();
    const r = this.model?.byKey.get(asked.key);
    if (!r) return;
    if (asked.action === "open") return this.open(r, cx);
    if (asked.action === "present") return this.present(cx, r, asked.shape);
    if (asked.action === "menu") return this.menu(r, asked.tabActions ?? null);
    if (asked.action === "peek") return this.peek(r);
    if (asked.action === "sleep") return r.address && hc(["label", r.address, `${SLEEP_LABEL}=${Date.now()}`]);
    if (asked.action === "pin") return this.togglePin(cx, r);
    if (asked.action === "settle") return this.toggleSettle(cx, r);
    if (asked.action === "snooze") return this.snooze(cx, r, asked.until ?? null);
    if (asked.action === "archive") return this.askArchive(cx, [r]);
    if (asked.action === "restore") return this.archive(cx, r, false);
    if (asked.action === "unread") return this.markUnread(cx, r);
    if (asked.action === "read") return this.markRead(cx, r);
    if (asked.action === "confirmDelete") return this.confirmDelete(r);
    if (asked.action === "delete") return this.remove(cx, r);
    if (asked.action === "filterProject") return setFilter({ project: r.projectKey, include: r.kind === "own" || filterOf().include.includes(r.kind) ? filterOf().include : [...filterOf().include, r.kind] });
    if (asked.action === "showHere") return this.showHere(r, asked.direction);
    if (asked.action === "moveToTab") return this.moveToTab(r, asked.tab);
    if (asked.action === "startHere") return this.startIn(this.model?.pulse.projects.find((p) => p.key === r.projectKey) ?? null, cx, { machine: r.machine, folder: r.checkout });
    if (asked.action === "move") return this.moveTo(cx, r, asked.to);
  }

  async mainCheckoutOf(folder, on) {
    const found = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { on: on || null });
    if (found.code !== 0) throw new Error((found.stderr || found.stdout).trim() || `${folder} is not a git checkout`);
    return found.stdout.trim().replace(/\/\.git$/, "");
  }

  newWorktree(cx, project, branch, from) {
    const origin = from ?? this.worktreeToShow(project.key, null);
    const on = origin === null ? null : this.onOf(origin.machine);
    if (origin === null || on === null) return notify({ title: `No machine the Herdr app reaches holds ${project.name}`, level: "warning" });
    cx.spawn(async (cx) => {
      try {
        const main = await this.mainCheckoutOf(origin.folder, on);
        const others = (project.checkouts?.[origin.machine] ?? []).filter((folder) => folder !== main);
        const parent = others.length > 0 ? others[0].split("/").slice(0, -1).join("/") : main.split("/").slice(0, -1).join("/");
        const name = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const folder = `${parent}/${others.length > 0 ? name : `${main.split("/").pop()}-${name}`}`;
        const exists = (await exec("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { on: on || null })).code === 0;
        const added = await exec("git", ["-C", origin.folder, "worktree", "add", ...(exists ? [folder, branch] : ["-b", branch, folder, "HEAD"])], { on: on || null, timeout: LONG_MS });
        if (added.code !== 0) throw new Error((added.stderr || added.stdout).trim());
        const worktree = { machine: origin.machine, folder };
        setShared(PICKED_WORKTREE, { ...pickedWorktrees(), [project.key]: worktree });
        setFilter({ project: project.key, worktree });
        this.startIn(project, cx, worktree);
      } catch (error) {
        notify({ title: `anyhost could not make the worktree ${branch}`, body: messageOf(error), level: "error" });
      }
    });
  }

  removeWorktree(cx, machine, folder) {
    const on = this.onOf(machine);
    if (on === null) return notify({ title: `The Herdr app does not reach ${machine}`, level: "warning" });
    cx.spawn(async () => {
      try {
        const main = await this.mainCheckoutOf(folder, on);
        if (main === folder) throw new Error(`${tildeOf(folder, home())} is the main checkout, which holds the repository.`);
        const removed = await exec("git", ["-C", main, "worktree", "remove", folder], { on: on || null });
        if (removed.code !== 0) throw new Error((removed.stderr || removed.stdout).trim());
        if (sameWorktree(filterOf().worktree, { machine, folder })) setFilter({ worktree: null });
        notify({ title: `Removed the worktree ${folder.split("/").pop()}`, body: "Its branch stays.", level: "success", timeout: 3000 });
      } catch (error) {
        notify({ title: "anyhost could not remove the worktree", body: messageOf(error), level: "error" });
      }
    });
  }

  startFolder(machine, folder, cx) {
    const on = shared(PULSE)?.all.machines.find((m) => m.name === machine)?.on ?? null;
    this.startAt(cx, machine, folder, on, "anyhost could not start a session");
  }

  moveTo(cx, r, to) {
    notify({ title: `Moving ${r.title.slice(0, 40)} to ${to}`, body: "It moves once its turn ends.", level: "info", timeout: 3000 });
    cx.spawn(async (cx) => {
      try {
        await anyhost(["move", r.key, to], LONG_MS);
        notify({ title: `Moved ${r.title.slice(0, 40)} to ${to}`, level: "success" });
      } catch (error) {
        notify({ title: `anyhost could not move it to ${to}`, body: messageOf(error), level: "error" });
      }
      this.refresh(cx);
    });
  }

  followScreen(model, live) {
    const at = live.focusedTerminal;
    if (at === this.followed) return;
    this.followed = at;
    const filter = filterOf();
    const labels = at ? live.all.find((x) => x.address === at)?.labels : undefined;
    const r = model.byKey.get(labels?.[SESSION_LABEL] ?? labels?.[VIEW_LABEL] ?? "");
    if (!r) return;
    const worktree = { machine: r.machine, folder: r.checkout };
    if (filter.worktree !== null && !sameWorktree(filter.worktree, worktree)) return setFilter({ project: r.projectKey, worktree });
    if (filter.project !== null && r.projectKey !== filter.project) setFilter({ project: r.projectKey });
  }

  reportShown(live) {
    const tab = panes().filter((pane) => pane.tab === live.focusedTab && pane.terminal);
    const zoomed = tab.some((pane) => pane.zoomed);
    const inView = live.view === "tabs" ? tab.filter((pane) => !zoomed || pane.zoomed).map((pane) => pane.terminal) : live.view === "tiles" ? live.tiles : [];
    const all = terminals();
    const terminalOf = new Map(all.filter((x) => x.labels?.[SESSION_LABEL]).map((x) => [x.labels[SESSION_LABEL], x.address]));
    const viewed = new Map(all.filter((x) => x.labels?.[VIEW_LABEL]).map((x) => [x.address, terminalOf.get(x.labels[VIEW_LABEL])]));
    const onScreen = live.isLooking ? [...new Set([...inView, live.shown].filter(Boolean).map((address) => viewed.get(address) ?? address))].sort() : [];
    const report = onScreen.join(" ");
    if (report === this.reported && Date.now() - this.reportedAt < REFRESH_MS) return;
    this.reported = report;
    this.reportedAt = Date.now();
    anyhost(["shown", this.window, ...onScreen]).catch(() => void (this.reported = null));
  }

  nameTabs(model) {
    const ps = panes();
    const known = shared(TAB_NAMES);
    const names = { ...known };
    const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL] ?? x.labels?.[VIEW_LABEL]]));
    let changed = known == null;
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        const sessions = [...new Set(ps.filter((p) => p.tab === tab.id && p.terminal).map((p) => sessionAt.get(p.terminal)).filter(Boolean))];
        const first = model.byKey.get(sessions[0] ?? "");
        if (!first) continue;
        const isNamedByPerson = tab.named && !ps.some((p) => p.tab === tab.id && p.terminal === tab.name);
        if (names[tab.id] === undefined) {
          names[tab.id] = isNamedByPerson ? null : "";
          changed = true;
        }
        const name = `${shortTitle(first.title, 40)}${sessions.length > 1 ? ` +${sessions.length - 1}` : ""}`;
        if ((isNamedByPerson && tab.name !== names[tab.id]) || tab.name === name) continue;
        run("tab.rename", { id: tab.id, name });
        names[tab.id] = name;
        changed = true;
      }
    }
    if (changed) setShared(TAB_NAMES, names);
  }

  nameSpaces(model) {
    const names = new Map(model.pulse.workspaces.map((w) => [w.id, w.name]));
    const given = shared(SPACE_NAMES) ?? {};
    const next = { ...given };
    for (const space of spaces()) {
      const name = names.get(space.id);
      const isNamedByPerson = space.named && space.name !== given[space.id];
      if (!name || space.name === name || isNamedByPerson) continue;
      run("space.rename", { id: space.id, name });
      next[space.id] = name;
    }
    if (Object.keys(next).some((id) => next[id] !== given[id])) setShared(SPACE_NAMES, next);
  }

  stepMoves(live) {
    for (const [address, target] of this.moves) {
      const terminal = live.all.find((x) => x.address === address);
      if (!terminal) {
        this.parkInto(address, null);
        continue;
      }
      if (terminal.labels?.["herdr.space"]) continue;
      void hc(["label", address, `herdr.space=${target.space.split("/").pop()}`, `herdr.tab=${target.tab.split("/").pop()}`]);
      this.parkInto(address, null);
    }
  }

  stepFocus(cx) {
    const waiting = this.focusing;
    const landed = waiting ? panes().find((p) => p.terminal === waiting.address) : undefined;
    if (landed) {
      this.focusing = null;
      const space = spaces().find((sp) => sp.tabs.some((x) => x.id === landed.tab))?.id;
      if (space && space !== focused()?.space) run("space.select", { id: space });
      this.focusSession(waiting.address);
    } else if (waiting && Date.now() > waiting.until) {
      this.focusing = null;
      notify({ title: `Herdr has not shown ${waiting.title.slice(0, 40)}`, body: `Its terminal ${waiting.address} runs, and no pane showed it within ${FOCUS_WAIT_MS / 1000} s.`, level: "error" });
    } else if (waiting && !this.focusStep) {
      this.focusStep = true;
      cx.timer.after(FOCUS_STEP_MS, (cx) => {
        this.focusStep = false;
        this.stepFocus(cx);
      });
    }
    if (this.selecting) {
      if (spaces().some((sp) => sp.id === this.selecting.space)) {
        run("space.select", { id: this.selecting.space });
        this.selecting = null;
      } else if (Date.now() > this.selecting.until) this.selecting = null;
      if (this.selecting === null) setShared(OPENING_SPACE, null);
    }
  }

  readBranches(cx, model) {
    if (this.branchesReading) return;
    const isLooking = window()?.active === true;
    const worktrees = new Map(model.rows.filter((r) => !r.deleted && r.kind === "own" && r.projectKey !== NONE && this.onOf(r.machine) !== null).map((r) => [`${r.machine}\0${r.checkout}`, { machine: r.machine, folder: r.checkout }]));
    const due = [...worktrees].filter(([at]) => !this.branches.has(at) || (isLooking && Date.now() - this.branches.get(at).at > BRANCH_FRESH_MS));
    if (due.length === 0) return;
    this.branchesReading = true;
    cx.spawn(async (cx) => {
      for (let n = 0; n < due.length; n += 8) await Promise.all(due.slice(n, n + 8).map(async ([at, worktree]) => this.branches.set(at, { ...this.branches.get(at), ...(await this.readBranch(worktree)), at: Date.now() })));
      this.branchesReading = false;
      this.branchesVersion++;
      save("branches", [...this.branches]);
      cx.notify();
    });
  }

  async readBranch({ machine, folder }) {
    const on = this.onOf(machine) || null;
    try {
      const [head, places] = await Promise.all([exec("git", ["-C", folder, "symbolic-ref", "--short", "-q", "HEAD"], { on }), exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { on })]);
      if (places.code !== 0) return { isGone: true };
      const [top, common] = places.stdout.trim().split("\n");
      return { branch: head.code === 0 ? head.stdout.trim() : "detached", isMain: common === `${top}/.git`, isGone: false };
    } catch {
      return {};
    }
  }

  parkLeaving(model, live) {
    const isOpen = new Map(model.rows.filter((r) => r.address).map((r) => [r.key, r.isChild || OPEN_SECTIONS.has(r.section)]));
    const before = this.wasOpen;
    this.wasOpen = isOpen;
    if (before === null) return;
    for (const r of model.rows) if (r.address && before.get(r.key) === true && isOpen.get(r.key) === false && live.paned.has(r.address)) run("terminal.park", { terminal: r.address });
  }

  machineAt(address) {
    if (!address.includes("/")) return this.hereName();
    const herdr = address.split("/")[0];
    return this.data.devices.find((d) => d.herdr === herdr)?.name ?? null;
  }

  moveFromProjectSpaces(model, live) {
    const stranded = live.all.filter((x) => (x.labels?.["herdr.space"] ?? "").startsWith("anyhost-p-") && !this.moves.has(x.address));
    if (stranded.length === 0) return;
    const projects = new Map([...new Set(model.rows.map((r) => r.projectKey))].map((key) => [projectSpaceBefore(key), key]));
    for (const x of stranded) {
      const placed = x.labels["herdr.space"];
      const tab = x.labels?.["herdr.tab"] || idOf();
      const r = model.byKey.get(x.labels?.[SESSION_LABEL] || x.labels?.[VIEW_LABEL] || "");
      if (r) {
        this.moveTerminal(x.address, { space: r.space, tab });
        continue;
      }
      const key = projects.get(placed);
      const machine = this.machineAt(x.address);
      const worktree = key && machine ? this.worktreeToShow(key, machine) : null;
      if (worktree) this.moveTerminal(x.address, { space: spaceOf(key, worktree.folder), tab });
    }
  }

  publishDiscarded(model) {
    const open = new Map();
    for (const r of model.rows) {
      const on = r.isChild || !OPEN_SECTIONS.has(r.section) ? null : this.onOf(r.machine);
      if (on === null) continue;
      const space = placedSpace(on, r.space);
      open.set(space, (open.get(space) ?? new Map()).set(r.key, r));
    }
    const ps = panes();
    const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
    const orders = saved("tabOrder", {});
    const next = { ...orders };
    const discarded = {};
    for (const space of spaces()) {
      const rows = open.get(space.id);
      if (!rows) continue;
      const live = space.tabs.flatMap((tab) => ps.filter((p) => p.tab === tab.id).map((p) => sessionAt.get(p.terminal))).filter((key) => rows.has(key));
      const order = orderOf(orders[space.id] ?? [], live).filter((key) => rows.has(key));
      next[space.id] = order;
      const isLive = new Set(live);
      let after = "";
      for (const key of order) {
        const r = rows.get(key);
        if (isLive.has(key)) after = key;
        else if (!r.address) (discarded[space.id] ??= []).push([key, r.title, r.harness, after]);
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(orders)) save("tabOrder", next);
    const written = JSON.stringify(discarded);
    if (written === this.discardedWritten) return;
    this.discardedWritten = written;
    setShared(DISCARDED, discarded);
  }

  fillShownWorkspace(live) {
    if (!live.isLooking || live.activeSpace === null) return;
    const shown = this.model.pulse.workspaces.find((w) => w.id === live.activeSpace);
    if (shown) this.fillWorkspace(shown.key, { machine: shown.machine, folder: shown.folder });
  }

  shownOf(model, live, filter) {
    const { sections } = model;
    const order = [...sections.pinned, ...sections.active, ...sections.working];
    const addresses = order.map((r) => r.address).filter(Boolean);
    if (addresses.join(" ") !== this.agentOrder) {
      this.agentOrder = addresses.join(" ");
      setAgentOrder(addresses);
    }
    const sectionKeys = Object.fromEntries(Object.entries(sections).map(([name, rows]) => [name, rows.map((r) => r.key)]));
    const isOnScreen = (r) => Boolean(r.address) && (r.address === live.focusedTerminal || r.views.includes(live.focusedTerminal));
    const filterKey = JSON.stringify(filter);
    const held = this.frozen?.view === filterKey ? new Set(Object.values(this.frozen.sections).flat()) : null;
    this.arrived = held === null ? 0 : Object.values(sectionKeys).flat().filter((key) => !held.has(key)).length;
    this.found = this.foundOf(model);
    return {
      model,
      filter,
      filterKey,
      terminal: live.focusedTerminal,
      isNarrow: live.isNarrow,
      railed: order.filter((r) => r.address || r.state === "blocked" || r.state === "done"),
      sectionKeys,
      onScreen: Object.fromEntries(SHELVES.map(([id]) => [id, (sections[id] ?? []).filter(isOnScreen)])),
      projectName: filter.project === null ? null : (model.rows.find((r) => r.projectKey === filter.project)?.projectName ?? projectNameOf(filter.project, this.cardsNow().names)),
    };
  }

  foundOf(model) {
    const query = this.search.value().trim().toLowerCase();
    if (query === "" || !model) return null;
    return model.rows.filter((r) => !r.isChild && this.searchedOf(r).includes(query)).slice(0, FOUND_MAX);
  }

  renderInbox(t, cx) {
    const shown = this.shown;
    if (shown === null) return this.frameOf(t, [this.searchBar(t, filterOf(), null)], [this.empty(t, this.error === null ? "Reading your sessions…" : "anyhost could not read your sessions yet. It tries again every 30 seconds.")]);
    const { model, filter } = shown;
    if (shown.isNarrow) return this.rail(t, shown.railed);
    const isHolding = this.isPointerIn || this.keys.is_focused();
    if (!isHolding || this.frozen?.view !== shown.filterKey) {
      this.frozen = isHolding ? { view: shown.filterKey, sections: shown.sectionKeys } : null;
      this.arrived = 0;
    }
    const held = this.frozen?.sections ?? shown.sectionKeys;
    const rowsOf = (keys) => keys.map((key) => model.byKey.get(key)).filter(Boolean);
    const pinned = rowsOf(held.pinned);
    const dragged = this.pressed?.isMoving ? this.pressed : null;
    const placed = { pinned: dragged ? movedTo(pinned, pinned.findIndex((r) => r.key === dragged.key), pinned.findIndex((r) => r.key === dragged.over)) : pinned, active: rowsOf(held.active) };
    const mounted = new Set();
    const ctx = { t, shown: shown.terminal, model, filter, mounted };
    const shelves = this.shelvesOf(held, shown);
    const found = this.found;
    this.visible = found ?? [...placed.pinned, ...placed.active, ...shelves.visible];
    const body = found !== null ? (found.length === 0 ? [this.empty(t, "No sessions found")] : found.map((r) => this.cardFor(ctx, r, mounted))) : this.listRows(ctx, placed, shelves);
    this.mounted = mounted;
    if (this.isArriving) cx.timer.after(FRAME_MS, (cx) => cx.notify());
    if (this.departing.size > 0) cx.timer.after(UI.motion.duration + FRAME_MS, (cx) => cx.notify());
    const hover = (el) =>
      el.on_hover((on, cx) => {
        this.isPointerIn = on;
        cx.notify();
      });
    return this.frameOf(t, [this.searchBar(t, filter, shown.projectName), ...this.filterChips(t, filter, shown.projectName)], body, hover, found === null && this.arrived > 0 ? [this.arrivals(t, this.arrived)] : []);
  }

  frameOf(t, head, body, decorate = (el) => el, over = []) {
    return v_flex()
      .id("anyhost")
      .track_focus(this.keys)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size) => (this.sidebarWidth = size.width))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .children(head)
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .child(decorate(v_flex().id("ah-list").flex_1().min_h(0).px(UI.space.sm).pb(UI.space.sm).gap(1).overflow_y_scrollbar().track_scroll(this.listScroll)).children(body))
          .children(over.map((el) => h_flex().absolute().top(UI.space.xs).left(0).right(0).justify_center().child(el))),
      );
  }

  shelvesOf(held, { model, filter, onScreen }) {
    const visible = [];
    const shelves = [];
    for (const [id, label] of SHELVES) {
      const keys = held[id] ?? [];
      if (keys.length === 0) continue;
      if (id === "deleted" && !filter.include.includes("deleted")) continue;
      const isOpen = this.opened.has(id);
      const limit = this.shelfShown[id] ?? SHELF_FIRST;
      const isWhole = SHELVES_WHOLE.has(id);
      const shown = isOpen ? keys.slice(0, isWhole ? keys.length : limit).map((key) => model.byKey.get(key)).filter(Boolean) : onScreen[id];
      visible.push({ key: shelfStop(id), shelf: id }, ...shown);
      shelves.push({ id, label, count: keys.length, shown, isOpen, more: isOpen && !isWhole && keys.length > limit ? Math.min(SHELF_MORE, keys.length - limit) : 0 });
    }
    return { visible, shelves };
  }

  listRows(ctx, sections, { shelves }) {
    const { t, model } = ctx;
    const card = (r) => {
      const subs = this.subsOf(r, model);
      return { key: r.key, r, height: CARD_HEIGHT + (subs.isOpen ? UI.space.xs + subs.rows.length * UI.height.row : 0), el: () => this.cardFor(ctx, r, ctx.mounted) };
    };
    const head = (id, label) => ({ key: `head-${id}`, height: UI.height.row, el: () => this.sectionHead(t, id, label) });
    const hasPins = sections.pinned.length > 0;
    const blocks = {
      "ah-active": [...(hasPins ? [head("pinned", "Pinned"), ...sections.pinned.map(card)] : []), ...(hasPins && sections.active.length > 0 ? [head("active", "Active")] : []), ...sections.active.map(card)],
      "ah-shelves": shelves.flatMap((shelf) => [
        { key: `shelf-${shelf.id}`, height: UI.height.row, el: () => this.shelf(t, shelf) },
        ...shelf.shown.map(card),
        ...(shelf.more > 0 ? [{ key: `more-${shelf.id}`, height: UI.height.row, el: () => this.more(t, `ah-more-${shelf.id}`, shelf.more, () => (this.shelfShown[shelf.id] = (this.shelfShown[shelf.id] ?? SHELF_FIRST) + SHELF_MORE)) }] : []),
      ]),
    };
    const motion = this.motionOf(blocks, model);
    const placedBlock = (id) =>
      div()
        .id(id)
        .relative()
        .flex_none()
        .w_full()
        .h(motion.heights[id])
        .children([
          ...blocks[id].map((item) => {
            const at = motion.layout.get(item.key);
            const isEntering = motion.isMoving && motion.before.get(item.key)?.block !== id;
            return this.placedAt(item.key, isEntering ? at.top - Math.min(item.height, MOTION_TRAVEL) : at.top, isEntering ? 0 : 1, motion.isMoving, item.el());
          }),
          ...[...this.departing].filter(([, gone]) => gone.block === id).map(([key, gone]) => this.placedAt(key, gone.top - Math.min(gone.height, MOTION_TRAVEL), 0, true, this.cardFor(ctx, model.byKey.get(key), ctx.mounted))),
        ]);
    const stale = this.error !== null && this.readAt !== null ? [this.note(t, `Can't reach anyhost · last read ${since(this.readAt)}`, t.blocked)] : [];
    const isEmpty = sections.pinned.length + sections.active.length === 0 && shelves.length === 0;
    const list = [
      ...stale,
      placedBlock("ah-active"),
      ...(isEmpty ? [this.empty(t, isFiltered(ctx.filter) ? "Nothing here matches the filter" : "All caught up")] : []),
      div().id("ah-push").flex_1().min_h(UI.space.sm),
      placedBlock("ah-shelves"),
    ];
    this.listChildren = list.length;
    return list;
  }

  motionOf(blocks, model) {
    const layout = new Map();
    const heights = {};
    for (const [block, items] of Object.entries(blocks)) {
      let y = 0;
      for (const { key, height, r } of items) {
        layout.set(key, { block, top: y, height, isCard: Boolean(r) });
        y += height + 1;
      }
      heights[block] = Math.max(0, y - 1);
    }
    const before = this.placed ?? new Map();
    const now = Date.now();
    for (const [key, was] of before) if (!layout.has(key) && was.isCard && model.byKey.has(key) && !this.departing.has(key)) this.departing.set(key, { ...was, until: now + UI.motion.duration });
    for (const [key, gone] of this.departing) if (layout.has(key) || gone.until <= now) this.departing.delete(key);
    const entering = [...layout].filter(([key, at]) => before.get(key)?.block !== at.block).length;
    const isMoving = this.placed !== undefined && !this.isToggling && entering + this.departing.size <= MOTION_MOST;
    if (!isMoving) this.departing.clear();
    this.isToggling = false;
    this.isArriving = isMoving && entering > 0;
    this.placed = layout;
    return { layout, heights, before, isMoving };
  }

  placedAt(key, top, opacity, isMoving, el) {
    const placed = div().id(`ah-at-${key}`).absolute().top(top).left(0).w_full().opacity(opacity).child(el);
    return isMoving ? placed.transition("top", UI.motion).transition("opacity", UI.motion) : placed;
  }

  item(id) {
    return h_flex().id(id).h(UI.height.row).px(UI.space.sm).gap(UI.space.sm).flex_none().items_center().rounded(UI.radius.control);
  }

  isCursorOn(key) {
    return this.cursor === key && this.keys?.is_focused() === true;
  }

  ring(t) {
    return div().absolute().inset_0().rounded(UI.radius.control).border_1().border_color(t.accent);
  }

  surface(el, t, { isSelected = false, isDragged = false, hover = (s) => s } = {}) {
    if (isDragged) return el.bg(t.raised).shadow_md().cursor_grabbing();
    if (isSelected) return el.bg(t.selected);
    return el.hover((s) => hover(s.bg(t.hover)));
  }

  sectionHead(t, id, label) {
    return this.item(`ah-head-${id}`).text_size(UI.text.caption).font_medium().text_color(t.dim).child(label);
  }

  toggleShelf(id, cx) {
    if (!this.opened.delete(id)) {
      this.opened.add(id);
      this.listScroll.scroll_to_item(this.listChildren - 1);
    }
    save("shelves", [...this.opened]);
    this.isToggling = true;
    cx.notify();
  }

  shelf(t, { id, label, count, isOpen }) {
    return this.item(`ah-shelf-${id}`)
      .text_size(UI.text.caption)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .relative()
      .when(this.isCursorOn(shelfStop(id)), (el) => el.child(this.ring(t)))
      .on_click((_e, cx) => this.toggleShelf(id, cx))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().flex_none().font_normal().child(String(count)))
      .child(svg(`${ICON}/chevron-${isOpen ? "down" : "right"}.svg`).size(UI.icon.small).flex_none());
  }

  searchBar(t, filter, projectName) {
    return h_flex()
      .px(UI.space.sm)
      .pt(UI.space.sm)
      .pb(UI.space.xs)
      .gap(UI.space.xs)
      .flex_none()
      .items_center()
      .child(
        h_flex()
          .h(UI.height.control)
          .flex_1()
          .min_w(0)
          .px(UI.space.sm)
          .gap(UI.space.sm)
          .items_center()
          .rounded(UI.radius.control)
          .hover((s) => s.bg(t.hover))
          .child(this.searchField(t, this.search)),
      )
      .child(
        h_flex()
          .id("ah-filter")
          .size(UI.height.control)
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(UI.radius.control)
          .text_color(isFiltered(filter) ? t.foreground : t.dim)
          .when(isFiltered(filter), (el) => el.bg(t.hover))
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Filter sessions")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.openFilter();
          })
          .child(svg(iconPath(`${OWN}/list-filter`)).size(UI.icon.body)),
      )
      .child(this.iconButton(t, "ah-new", "square-pen", projectName ? `New session in ${projectName}` : "New session", (cx) => this.newHere(cx)));
  }

  filterChips(t, filter, project) {
    const without = (field, value) => setFilter({ [field]: Array.isArray(filter[field]) ? filter[field].filter((x) => x !== value) : null });
    const worktree = filter.worktree === null ? null : (this.branchOf(filter.worktree.machine, filter.worktree.folder)?.branch ?? filter.worktree.folder.split("/").pop());
    const chips = [
      ...(project !== null ? [["project", filter.project, project, t.foreground, "folder"]] : []),
      ...(worktree !== null ? [["worktree", filter.worktree.folder, worktree, t.foreground, "git-branch"]] : []),
      ...(filter.machine !== null ? [["machine", filter.machine, this.placeOf(filter.machine), t.muted, "server"]] : []),
      ...filter.states.map((state) => ["states", state, STATE[state].name, this.stateColor(state), STATE[state].icon]),
      ...filter.tags.filter((id) => this.data?.tags[id]).map((id) => ["tags", id, this.data.tags[id].name, this.tagColor(this.data.tags[id].color), `${OWN}/tag`]),
      ...filter.include.map((kind) => ["include", kind, INCLUDES.find(([k]) => k === kind)[1], t.muted, "plus"]),
    ];
    if (chips.length === 0) return [];
    return [h_flex().px(UI.space.sm).pb(UI.space.xs).gap(UI.space.xs).flex_none().flex_wrap().children(chips.map(([field, value, label, color, icon]) => this.chip(t, label, color, { icon, remove: { id: `ah-chip-x-${field}-${value}`, onClick: () => without(field, value) } })))];
  }

  newHere(cx) {
    const { project, worktree } = filterOf();
    const known = project === null || project === NONE ? null : this.model?.pulse.projects.find((p) => p.key === project);
    return known ? this.startIn(known, cx, worktree ?? {}) : this.newSession();
  }

  openFilter() {
    const pulse = shared(PULSE);
    const tags = Object.keys(this.data?.tags ?? {}).length;
    const machinesCount = pulse?.all.machines.length ?? 0;
    const rows = 1 + (pulse?.known.length ?? 0) + Object.keys(STATE).length + tags + (machinesCount > 1 ? machinesCount : 0) + INCLUDES.length;
    const heads = 3 + (tags > 0 ? 1 : 0) + (machinesCount > 1 ? 1 : 0);
    const bodyHeight = Math.min(FILTER_BODY_MOST, rows * UI.height.row + heads * UI.height.control);
    const clearHeight = UI.height.row + UI.space.xs * 2 + 1;
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: bodyHeight + clearHeight + UI.space.xs * 2 + 2, props: { view: "filter", bodyHeight, projects: pulse?.known ?? [], machines: (pulse?.all.machines ?? []).map((m) => ({ name: m.name, place: m.place })), tags: this.data?.tags ?? {} } });
  }

  openPalette() {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 560, height: 0.7, props: { view: "palette", sessions: this.sessionsShown(this.model?.rows ?? []), current: filterOf().project } });
  }

  openBoard(project) {
    if (project !== filterOf().project) setFilter({ project });
    const active = spaces().find((sp) => sp.active) ?? null;
    const shown = (shared(PULSE)?.workspaces ?? []).find((w) => w.id === active?.id);
    if (project === null || shown?.key === project) return changeWorkspace(active?.id ?? ALL_WORK, { mode: "board" });
    const worktree = this.worktreeToShow(project, null);
    const on = worktree === null ? null : this.onOf(worktree.machine);
    if (on !== null) changeWorkspace(placedSpace(on, spaceOf(project, worktree.folder)), { mode: "board" });
    this.showProject(project);
  }

  worktreeOf(r) {
    if (r.projectKey === NONE || r.projectKey === TEMPORARY) return null;
    if ((this.model?.worktrees.get(`${r.projectKey}\0${r.machine}`)?.size ?? 0) < 2) return null;
    return this.branchOf(r.machine, r.checkout)?.branch ?? r.checkout.split("/").pop();
  }

  row(ctx, r, { withShelf = false } = {}) {
    const { t, shown, model } = ctx;
    const isShown = Boolean(r.address) && (r.address === shown || r.views.includes(shown));
    const isHovered = this.hovered === r.key;
    const recedes = !isShown && (r.archived || r.deleted || r.isOffline || r.state === "idle" || r.section === "settled" || r.section === "snoozed");
    const opening = this.opening?.has(r.key) && !r.address;
    const status = isHovered ? this.actions(t, r) : opening ? this.spinnerLabel(t, "Opening") : this.status(t, r);
    const frame = this.frame(t, r, isShown);
    const worktree = this.worktreeOf(r);
    const shelfName = r.deleted ? "Deleted" : r.archived ? "Archived" : r.section === "snoozed" ? "Snoozed" : r.section === "settled" ? "Settled" : null;
    const source = r.session.source ? model.byKey.get(r.session.source) : undefined;
    const meta = [withShelf ? shelfName : null, r.projectName, r.isRemote ? this.placeOf(r.machine) : null, r.app, r.isChild ? `subagent of ${model.byKey.get(r.session.parent)?.title?.slice(0, 30) ?? ""}` : source ? `fork of ${source.title.slice(0, 30)}` : null].filter(Boolean).join(" · ");
    const subs = this.subsOf(r, model);
    const tags = r.tags.map((id) => this.data.tags[id]).filter(Boolean);
    const stage = this.data.stages.find((s) => s.id === r.stage);
    return frame
      .child(
        v_flex()
          .px(UI.space.sm)
          .py(UI.space.xs)
          .opacity(recedes && !isHovered ? 0.7 : 1)
          .transition("opacity", UI.motion)
          .child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.xs)
              .items_center()
              .child(this.mark(t, r.projectName, false, r.projectKey === NONE || r.projectKey === TEMPORARY))
              .child(div().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(meta))
              .when(worktree !== null, (line) => line.child(h_flex().min_w(0).gap(UI.space.xs).items_center().text_size(UI.text.caption).text_color(t.dim).child(svg(`${ICON}/git-branch.svg`).size(UI.icon.small).flex_none()).child(div().truncate().child(worktree))))
              .child(div().flex_1())
              .child(status),
          )
          .child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.sm)
              .items_center()
              .child(this.harnessIcon(t, r))
              .child(div().min_w(0).truncate().text_size(UI.text.body).when(r.isUnread, (el) => el.font_semibold()).when(!recedes && !r.isUnread, (el) => el.font_medium()).text_color(recedes ? t.muted : t.foreground).child(r.title))
              .when(r.pinned && !r.archived && !r.deleted, (line) => line.child(this.pinMark(t, r)))
              .child(div().flex_1()),
          )
          .child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.xs)
              .items_center()
              .when(Boolean(stage), (row) => row.child(this.chip(t, stage.name, this.tagColor("gray"), { isOutlined: true })))
              .children(tags.slice(0, 3).map((tag) => this.chip(t, tag.name, this.tagColor(tag.color))))
              .when(tags.length > 3, (row) => row.child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(`+${tags.length - 3}`)))
              .child(div().flex_1().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(r.lastSaid || "No reply yet"))
              .when(subs.rows.length > 0, (row) => row.child(this.subagentFold(t, r, subs))),
          ),
      )
      .when(subs.isOpen, (el) => el.pb(UI.space.xs).children(this.subRows(t, subs)));
  }

  chip(t, name, color, { isOutlined = false, icon = null, remove = null } = {}) {
    return h_flex()
      .h(UI.height.inline)
      .px(UI.space.xs)
      .gap(UI.space.xs)
      .flex_none()
      .max_w(140)
      .items_center()
      .rounded(UI.radius.pill)
      .text_size(UI.text.caption)
      .text_color(color)
      .when(isOutlined, (el) => el.border_1().border_color(color + "66"))
      .when(!isOutlined, (el) => el.bg(color + "24"))
      .when(icon !== null, (el) => el.child(svg(iconPath(icon)).size(UI.icon.small).flex_none()))
      .child(div().min_w(0).truncate().child(name))
      .when(remove !== null, (el) =>
        el.child(
          div()
            .id(remove.id)
            .size(UI.icon.lead)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(UI.radius.pill)
            .cursor_pointer()
            .hover((s) => s.bg(color + "33"))
            .tooltip("Remove the filter")
            .on_click(remove.onClick)
            .child(svg(`${ICON}/x.svg`).size(UI.icon.small)),
        ),
      );
  }

  tagColor(color) {
    return (TAG_COLORS[color] ?? TAG_COLORS.gray)[this.isDark ? 1 : 0];
  }

  stateColor(state) {
    return (STATE[state] ?? STATE.idle).colors[this.isDark ? 1 : 0];
  }

  stateChip(t, state, label) {
    return this.chip(t, label, this.stateColor(state), { icon: (STATE[state] ?? STATE.idle).icon });
  }

  spinnerLabel(t, text) {
    return h_flex().flex_none().gap(UI.space.xs).items_center().text_size(UI.text.caption).text_color(this.stateColor("working")).child(svg(`${ICON}/spinner.svg`).size(UI.icon.small).spin(900)).child(text);
  }

  status(t, r) {
    if (r.isOffline) return div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(r.seenAt ? `Offline ${ago(r.seenAt)}` : "Offline");
    if (r.section === "snoozed") return this.wakeLabel(r);
    if (r.section === "settled") return div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(ago(r.settledAt));
    if (r.state === "idle") return div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(ago(r.at));
    if (r.state === "done") return this.stateLabel(r.state, r.label);
    return h_flex()
      .flex_none()
      .gap(UI.space.sm)
      .items_center()
      .child(div().text_size(UI.text.caption).text_color(t.dim).child(ago(r.since)))
      .child(r.state === "blocked" ? this.stateChip(t, r.state, r.label) : this.stateLabel(r.state, r.label));
  }

  stateLabel(state, label) {
    return h_flex()
      .flex_none()
      .gap(UI.space.xs)
      .items_center()
      .text_size(UI.text.caption)
      .text_color(this.stateColor(state))
      .child(svg(iconPath((STATE[state] ?? STATE.idle).icon)).size(UI.icon.small).flex_none())
      .child(label);
  }

  wakeLabel(r) {
    return h_flex()
      .id(`ah-wake-${r.key}`)
      .flex_none()
      .gap(UI.space.xs)
      .items_center()
      .text_size(UI.text.caption)
      .text_color(this.stateColor("working"))
      .tooltip(`Comes back ${wakeAtOf(r.snoozedUntil)}`)
      .child(svg(iconPath(`${OWN}/alarm-clock`)).size(UI.icon.small))
      .child(wakeLabelOf(r.snoozedUntil));
  }

  pinMark(t, r) {
    const isOver = this.pinHovered === r.key;
    return div()
      .id(`ah-pin-${r.key}`)
      .size(UI.icon.body)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(UI.radius.pill)
      .text_color(isOver ? t.foreground : t.dim)
      .cursor_pointer()
      .tooltip("Unpin")
      .on_hover((on, cx) => {
        this.pinHovered = on ? r.key : this.pinHovered === r.key ? null : this.pinHovered;
        cx.notify();
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.act((cx) => this.unpin(cx, r));
      })
      .child(svg(iconPath(isOver ? "pin-off" : "pin")).size(UI.icon.small));
  }

  actions(t, r) {
    if (r.deleted) return this.textButton(t, `ah-restore-${r.key}`, "Restore", () => this.act((cx) => this.open(r, cx)));
    if (r.archived)
      return h_flex()
        .flex_none()
        .gap(UI.space.xs)
        .items_center()
        .child(this.textButton(t, `ah-restore-${r.key}`, "Restore", () => this.act((cx) => this.archive(cx, r, false))))
        .child(this.iconButton(t, `ah-delete-${r.key}`, `${OWN}/trash`, "Delete", () => this.confirmDelete(r), UI.height.inline));
    if (r.section === "snoozed") return this.iconButton(t, `ah-unsnooze-${r.key}`, `${OWN}/alarm-clock-off`, "Wake now", () => this.act((cx) => this.snooze(cx, r, null)), UI.height.inline);
    if (r.section === "settled") return this.iconButton(t, `ah-unsettle-${r.key}`, `${OWN}/undo-2`, "Unsettle", () => this.act((cx) => this.unsettle(cx, r)), UI.height.inline);
    if (isRunning(r.state) || r.state === "blocked") return this.status(t, r);
    return this.iconButton(t, `ah-settle-${r.key}`, "check", "Settle", () => this.act((cx) => this.settle(cx, r)), UI.height.inline);
  }

  textButton(t, id, label, onClick) {
    return div()
      .id(id)
      .h(UI.height.inline)
      .px(UI.space.xs)
      .flex()
      .flex_none()
      .items_center()
      .rounded(UI.radius.pill)
      .text_size(UI.text.caption)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  frame(t, r, isShown) {
    const isReordered = r.section === "pinned" && this.found === null;
    const canDrag = isReordered || Boolean(r.address);
    const isDragged = this.pressed?.isMoving === true && this.pressed.key === r.key;
    return v_flex()
      .id(`ah-${r.key}`)
      .flex_none()
      .rounded(UI.radius.control)
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected: isShown, isDragged }))
      .relative()
      .when(this.isCursorOn(r.key), (el) => el.child(this.ring(t)))
      .on_hover((on, cx) => {
        if (on) this.hovered = r.key;
        else if (this.hovered === r.key) this.hovered = null;
        if (on && isReordered) this.dragCardOver(r.key);
        cx.notify();
      })
      .when(canDrag, (el) =>
        el.on_mouse_down("left", (e) => {
          this.dropped = null;
          this.pressed = { key: r.key, over: r.key, address: r.address, title: r.title, isPinned: isReordered, downX: e.position.x, downY: e.position.y, isMoving: false };
        }),
      )
      .on_click(() => {
        if (this.dropped === r.key) return void (this.dropped = null);
        this.act((cx) => this.open(r, cx));
      })
      .on_mouse_down("right", () => this.menu(r));
  }

  subsOf(r, model) {
    const children = (model.childrenOf.get(r.key) ?? []).map((c) => ({ id: `ah-child-${c.key}`, title: c.title, state: c.state, open: (cx) => this.open(c, cx) }));
    const kids = r.address ? (model.kidsOf.get(r.address) ?? []).map((k) => ({ id: `ah-kid-${k.address}`, title: k.name || k.template || k.program?.name || k.address, state: model.statusOf.get(k.address)?.status ?? "idle", open: () => run(model.statusOf.has(k.address) ? "pane.focus" : "terminal.peek", { terminal: k.address }) })) : [];
    const rows = [...children, ...kids];
    return { rows, working: rows.filter((row) => row.state === "working").length, isOpen: rows.length > 0 && this.unfolded.has(r.key) };
  }

  subagentFold(t, r, subs) {
    return div()
      .id(`ah-fold-${r.key}`)
      .h(UI.height.inline)
      .px(UI.space.xs)
      .gap(UI.space.xs)
      .flex()
      .flex_none()
      .items_center()
      .rounded(UI.radius.pill)
      .text_size(UI.text.caption)
      .text_color(subs.working > 0 ? this.stateColor("working") : t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!this.unfolded.delete(r.key)) this.unfolded.add(r.key);
        save("unfolded", [...this.unfolded]);
        cx.notify();
        this.act(() => undefined);
      })
      .child(svg(`${ICON}/chevron-${subs.isOpen ? "down" : "right"}.svg`).size(UI.icon.small).flex_none())
      .child(`${subs.rows.length} ${subs.rows.length === 1 ? "subagent" : "subagents"}${subs.working > 0 ? ` · ${subs.working} working` : ""}`);
  }

  subRows(t, subs) {
    return subs.rows.map((s) =>
      this.item(s.id)
        .pl(UI.space.sm + UI.icon.body + UI.space.sm)
        .text_size(UI.text.caption)
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.act((cx) => s.open(cx));
        })
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.title))
        .when(s.state !== "idle", (el) => el.child(this.stateChip(t, s.state, (STATE[s.state] ?? STATE.idle).name))),
    );
  }

  menu(r, tabActions = null) {
    const s = r.session;
    const at = focused();
    const tabs = at?.space ? (spaces().find((sp) => sp.id === at.space)?.tabs ?? []).filter((x) => !panes().some((p) => p.tab === x.id && p.terminal === r.address)).map((x) => ({ id: x.id, name: x.name })) : [];
    const targets = s.tool === "claude" && !r.isRemote && !r.archived && !r.deleted ? (this.data?.devices ?? []).filter((d) => d.id !== this.data.here && d.connected).map((d) => d.name) : [];
    const shown = {
      view: "menu",
      key: r.key,
      title: r.title,
      hasTerminal: Boolean(r.address),
      canSleep: Boolean(r.address) && s.tool === "claude",
      isLocal: Boolean(r.address) && !r.address.includes("/"),
      canShowHere: Boolean(at?.pane) && s.tool === "claude" && !r.archived && !r.deleted && at?.terminal !== r.address && !r.views.includes(at?.terminal),
      pinned: r.pinned,
      settled: r.section === "settled",
      snoozed: r.section === "snoozed",
      archived: r.archived,
      deleted: r.deleted,
      state: r.state,
      isUnread: r.isUnread,
      isFiltered: filterOf().project === r.projectKey,
      projectName: r.projectName,
      canStartHere: r.projectKey !== TEMPORARY,
      cwd: s.cwd,
      tabs,
      targets,
      tags: this.data?.tags ?? {},
      tagged: r.tags,
      stages: this.data?.stages ?? [],
      stage: r.stage,
      tabActions,
      canReopen: this.closed.some((key) => this.model?.byKey.get(key)?.archived),
    };
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: MENU_WIDTH * 2 + UI.space.sm, height: this.menuHeight(this.sessionMenuGroups(shown)), props: shown });
  }

  menuHeight(groups) {
    const shown = groups.filter((group) => group.length > 0);
    const items = shown.flat();
    const panelOf = (rows, separators) => rows * UI.height.row + separators * MENU_SEPARATOR + UI.space.xs * 2 + 2 + UI.space.lg;
    return Math.max(panelOf(items.length, shown.length - 1), ...items.filter((item) => item.sub).map((item) => menuOffsetOf(shown, item) + panelOf(item.sub.length, item.sub.filter((sub) => sub.separatorBefore).length)));
  }

  key(e, cx) {
    if (e.key === "escape" && this.search.value() !== "") {
      this.search.set_value("");
      this.found = null;
      return this.redrawAll(cx);
    }
    if (this.visible === undefined || this.isSearching) return;
    const at = this.visible.findIndex((r) => r.key === this.cursor);
    const r = this.visible[at] ?? null;
    const move = (step) => {
      const next = this.visible[Math.max(0, Math.min(this.visible.length - 1, (at < 0 ? (step > 0 ? -1 : this.visible.length) : at) + step))];
      this.cursor = next?.key ?? null;
      this.redrawAll(cx);
    };
    if (e.key === "j" || e.key === "down") return move(1);
    if (e.key === "k" || e.key === "up") return move(-1);
    if (e.key === "/") return this.search.focus();
    if (e.key === "escape") {
      this.cursor = null;
      return this.redrawAll(cx);
    }
    const target = r ?? this.model?.rows.find((row) => row.address && (row.address === this.live?.shown || row.views.includes(this.live?.shown)));
    if (r?.shelf && (e.key === "enter" || e.key === "space")) return this.toggleShelf(r.shelf, cx);
    if (e.keystroke === "cmd-shift-s" && target?.session && !target.archived && !target.deleted) return this.toggleSettle(cx, target);
    if (!r?.session) return;
    if (e.key === "enter") return this.act((cx) => this.open(r, cx));
    if (e.key === "space") return this.peek(r);
    if (e.key === "u") return r.isUnread ? this.markRead(cx, r) : this.markUnread(cx, r);
    if (e.key === "e") return r.archived ? this.archive(cx, r, false) : this.askArchive(cx, [r]);
    if (e.key === "p") return this.togglePin(cx, r);
    if (e.keystroke === "s" && !r.archived && !r.deleted) return this.toggleSettle(cx, r);
    if (e.key === "t") return this.openTags(r);
  }

  openTags(r) {
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: 360, props: { view: "tags", key: r.key, tagged: r.tags, tags: this.data?.tags ?? {} } });
  }

  note(t, text, color) {
    return div().px(UI.space.sm).py(UI.space.sm).flex_none().text_size(UI.text.caption).text_color(color).child(text);
  }

  arrivals(t, count) {
    return h_flex()
      .id("ah-arrived")
      .h(UI.height.control)
      .px(UI.space.md)
      .gap(UI.space.xs)
      .items_center()
      .rounded(UI.radius.panel)
      .bg(t.popover)
      .border_1()
      .border_color(t.border)
      .shadow_lg()
      .text_size(UI.text.body)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.frozen = null;
        this.listScroll.scroll_to_item(0);
        cx.notify();
      })
      .child(svg(iconPath(`${OWN}/chevron-up`)).size(UI.icon.small))
      .child(`${count} new`);
  }

  empty(t, text) {
    return div().px(UI.space.sm).py(UI.space.xl).flex_none().text_size(UI.text.caption).text_color(t.dim).text_center().child(text);
  }

  more(t, id, count, showMore) {
    return this.reveal(t, id, "chevron-down", `Show ${count} more`, showMore);
  }

  reveal(t, id, icon, label, onClick) {
    return this.item(id)
      .text_size(UI.text.body)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        onClick();
        cx.notify();
      })
      .child(svg(iconPath(icon)).size(UI.icon.body).flex_none())
      .child(label);
  }

  rail(t, items) {
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .pt(UI.space.sm)
      .children(
        items.map((r) =>
          this.item(`ah-rail-${r.key}`)
            .gap(UI.space.xs)
            .justify_center()
            .hover((s) => s.bg(t.hover))
            .tooltip(r.title)
            .on_click(() => this.act((cx) => this.open(r, cx)))
            .child(this.mark(t, r.projectName, false, r.projectKey === NONE || r.projectKey === TEMPORARY))
            .child(svg(iconPath(STATE[r.state].icon)).size(UI.icon.small).text_color(this.stateColor(r.state))),
        ),
      );
  }

  harnessIcon(t, r) {
    const harness = HARNESS[r.harness] ?? HARNESS.claude;
    return div()
      .id(`ah-harness-${r.key}`)
      .size(UI.icon.body)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .tooltip(harness.name)
      .child(harness.tint ? svg(harness.icon).size(UI.icon.small).text_color(harness.tint) : image(harness.icon).size(UI.icon.small));
  }

  iconButton(t, id, icon, tooltip, onClick, size = UI.height.control) {
    return div()
      .id(id)
      .size(size)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(size === UI.height.inline ? UI.radius.pill : UI.radius.control)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tooltip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(iconPath(icon)).size(size === UI.height.inline ? UI.icon.small : UI.icon.body));
  }

  mark(t, name, dim = false, isFolder = false) {
    if (isFolder) return div().size(UI.icon.lead).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg(`${ICON}/folder.svg`).size(UI.icon.body));
    const hue = hueOf(name || "~")[this.isDark ? 1 : 0];
    return div()
      .size(UI.icon.lead)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(UI.radius.pill)
      .opacity(dim ? 0.4 : 1)
      .bg(hue + "24")
      .text_size(UI.icon.lead / 2)
      .font_bold()
      .text_color(hue)
      .child(monogramOf(name || "~"));
  }


  initProjects(cx) {
    this.hovered = null;
    this.pressed = null;
    this.dropped = null;
    this.order = null;
    this.isPointerIn = false;
    this.cursor = null;
    this.keys = cx.focus_handle();
    this.projectsScroll = ScrollHandle.new();
    this.entries = [];
    this.projectsKey = "";
    this.projectsView = null;
    this.refreshProjects();
    this.placeParts(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.keys.focus();
        if (command === "all") setFilter({ project: null });
        const picked = /^pick-(\d+)$/.exec(command);
        const entry = picked ? this.entries?.[Number(picked[1]) - 1] : undefined;
        if (entry) this.pickEntry(entry);
        this.redrawAll(cx);
      }
    });
  }

  syncProjects(cx) {
    if (!this.refreshProjects()) return;
    this.placeParts(cx);
    this.redrawAll(cx);
  }

  refreshProjects() {
    const pulse = shared(PULSE);
    const filter = filterOf();
    const isHolding = this.isPointerIn || this.keys.is_focused();
    const isNarrow = narrow();
    const key = `${pulse?.at ?? ""}|${JSON.stringify(filter)}|${isHolding}|${isNarrow}|${this.order?.join("\0")}`;
    if (key === this.projectsKey) return false;
    this.projectsKey = key;
    if (!pulse) return false;
    if (!isHolding || this.order === null) this.order = pulse.projects.map((p) => p.key);
    const byKey = new Map(pulse.projects.map((p) => [p.key, p]));
    const projects = [...this.order.map((key) => byKey.get(key)).filter(Boolean), ...pulse.projects.filter((p) => !this.order.includes(p.key))];
    this.entries = projects.flatMap((p) => [{ id: p.key, project: p, worktree: null }, ...(p.worktrees.length > 1 ? p.worktrees : []).map((w) => ({ id: `${p.key}\0${w.machine}\0${w.folder}`, project: p, worktree: w }))]);
    this.projectsView = { pulse, filter, projects, isNarrow, byId: new Map(this.entries.map((entry) => [entry.id, entry])) };
    return true;
  }

  renderProjects(t) {
    if (this.projectsView === null) return v_flex().size_full().bg(t.chrome).child(this.empty(t, "Reading your projects…"));
    const { pulse, filter, projects, isNarrow } = this.projectsView;
    if (isNarrow) return this.projectsRail(t, projects, filter);
    const mounted = new Set();
    this.mounted = mounted;
    return v_flex()
      .id("anyhost-projects")
      .track_focus(this.keys)
      .on_key_down((e, cx) => this.projectKey(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .child(div().px(UI.space.sm).pt(UI.space.sm).flex_none().child(this.allCard(t, pulse, filter.project === null)))
      .child(
        v_flex()
          .id("ah-projects")
          .flex_1()
          .min_h(0)
          .px(UI.space.sm)
          .pb(UI.space.sm)
          .gap(1)
          .overflow_y_scrollbar()
          .track_scroll(this.projectsScroll)
          .on_hover((on, cx) => {
            this.isPointerIn = on;
            if (!on) this.pressed = null;
            this.redrawAll(cx);
          })
          .on_mouse_up("left", (_e, cx) => this.dropProject(cx))
          .children(this.entries.map((entry) => this.partFor(entry.id, mounted, () => this.entryElement(t, entry)))),
      );
  }

  entryElement(t, entry) {
    const { pulse, filter } = this.projectsView;
    if (entry.worktree) return this.worktreeRow(t, entry, pulse, filter);
    return this.projectCard(t, entry.project, pulse, filter.project === entry.project.key && (filter.worktree === null || entry.project.worktrees.length < 2));
  }

  projectKey(e, cx) {
    const at = this.entries.findIndex((entry) => entry.id === this.cursor);
    if (e.key === "j" || e.key === "down") this.cursor = this.entries[Math.min(this.entries.length - 1, at + 1)]?.id ?? null;
    if (e.key === "k" || e.key === "up") this.cursor = at <= 0 ? ALL : this.entries[at - 1].id;
    const shown = this.entries.findIndex((entry) => entry.id === this.cursor);
    if (shown >= 0 && shown !== at) this.projectsScroll.scroll_to_item(shown);
    const entry = this.entries[at] ?? null;
    if (e.key === "enter" && entry) this.pickEntry(entry);
    if (e.key === "enter" && !entry) setFilter({ project: null });
    if (e.key === "n" && entry) ask({ action: "startIn", project: entry.project, ...(entry.worktree ? { machine: entry.worktree.machine, folder: entry.worktree.folder } : {}) });
    if (e.key === "escape") run("pane.go", { direction: "right" });
    this.redrawAll(cx);
  }

  pickEntry(entry) {
    return entry.worktree ? this.pickWorktree(entry.project, entry.worktree) : this.pickProject(entry.project);
  }

  slots(t, counts) {
    const slot = (count, state) =>
      h_flex()
        .id(`ah-slot-${state}`)
        .w(32)
        .gap(UI.space.xs)
        .flex_none()
        .items_center()
        .justify_end()
        .text_size(UI.text.caption)
        .font_medium()
        .text_color(this.stateColor(state))
        .tooltip(STATE[state].name)
        .when(count > 0, (el) => el.child(svg(iconPath(STATE[state].icon)).size(UI.icon.small)).child(String(count)));
    const totals = shared(PULSE)?.all ?? counts;
    return h_flex().flex_none().items_center().children(Object.keys(STATE).filter((state) => totals[state] > 0).map((state) => slot(counts[state], state)));
  }

  projectsRail(t, projects, filter) {
    const tile = (id, project, child) =>
      div()
        .id(id)
        .size(UI.height.row)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(UI.radius.control)
        .cursor_pointer()
        .map((el) => this.surface(el, t, { isSelected: filter.project === (project?.key ?? null) }))
        .tooltip(project ? project.name : "All projects")
        .on_click(() => (project ? this.pickProject(project) : setFilter({ project: null })))
        .child(child);
    return v_flex()
      .id("anyhost-projects")
      .size_full()
      .pt(UI.space.sm)
      .gap(UI.space.xs)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(tile("ah-rail-all", null, this.leadIcon("layers").text_color(t.muted)))
      .overflow_y_scrollbar()
      .children(projects.map((p) => tile(`ah-rail-${p.key}`, p, this.mark(t, p.name, false, p.key === NONE))));
  }

  leadIcon(icon) {
    return div().size(UI.icon.lead).flex_none().flex().items_center().justify_center().child(svg(iconPath(icon)).size(UI.icon.body));
  }

  allCard(t, pulse, isSelected) {
    const isStale = pulse.error !== null && pulse.readAt !== null;
    return this.item("ah-project-all")
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected }))
      .relative()
      .when(this.isCursorOn(ALL), (el) => el.child(this.ring(t)))
      .when(isStale, (el) => el.tooltip(`Can't reach anyhost · counts from ${since(pulse.readAt)}`))
      .on_click(() => {
        this.cursor = null;
        setFilter({ project: null });
      })
      .child(this.leadIcon("layers").text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().text_color(isStale ? t.blocked : t.foreground).child("All projects"))
      .child(this.slots(t, pulse.all));
  }

  projectCard(t, p, pulse, isSelected) {
    const id = `project:${p.key}`;
    const hovered = this.hovered === id;
    const canStart = Object.values(p.checkouts ?? {}).some((list) => list.length > 0);
    const pressed = this.pressed;
    const isDragged = pressed?.isMoving === true && pressed.key === p.key;
    const isTarget = pressed?.isMoving === true && pressed.over === p.key && pressed.key !== p.key && p.key !== NONE;
    const dropsAbove = isTarget && this.order.indexOf(pressed.key) > this.order.indexOf(p.key);
    return this.item(`ah-${id}`)
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected, isDragged }))
      .relative()
      .when(isTarget, (el) => el.child(div().absolute().left(0).right(0).h(UI.rule).bg(t.accent).when(dropsAbove, (bar) => bar.top(0)).when(!dropsAbove, (bar) => bar.bottom(0))))
      .when(this.isCursorOn(p.key), (el) => el.child(this.ring(t)))
      .on_hover((on, cx) => {
        if (on) this.hovered = id;
        else if (this.hovered === id) this.hovered = null;
        if (on && this.pressed !== null && (this.pressed.key !== p.key || this.pressed.isMoving)) this.pressed = { ...this.pressed, over: p.key, isMoving: true };
        this.redrawAll(cx);
      })
      .on_mouse_down("left", () => {
        this.dropped = null;
        if (p.key !== NONE) this.pressed = { key: p.key, over: p.key, isMoving: false };
      })
      .when(Boolean(shared(DRAG_TAB)) && hovered, (el) => el.bg(t.selected).child(this.ring(t)))
      .on_mouse_up("left", (_e, cx) => (shared(DRAG_TAB) ? this.dropTabOn(p, null) : this.dropProject(cx)))
      .on_click(() => {
        if (this.dropped === p.key) return void (this.dropped = null);
        this.pickProject(p);
      })
      .on_mouse_down("right", () => this.projectMenu(p, pulse))
      .child(this.mark(t, p.name, false, p.key === NONE))
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().child(p.name))
      .child(shared(DRAG_TAB) && hovered ? this.moveHere(t) : hovered && canStart && p.key !== NONE ? this.iconButton(t, `ah-pen-${id}`, "square-pen", `New session in ${p.name}`, () => ask({ action: "startIn", project: p }), UI.height.inline) : this.slots(t, p));
  }

  worktreeRow(t, { id, project, worktree }, pulse, filter) {
    const rowId = `worktree:${hex12(`${worktree.machine}\0${worktree.folder}`)}`;
    const hovered = this.hovered === rowId;
    const isSelected = sameWorktree(filter.worktree, worktree);
    const elsewhere = worktree.machine === pulse.here ? null : pulse.all.machines.find((m) => m.name === worktree.machine)?.place ?? worktree.machine;
    const canStart = worktree.id !== null && !worktree.isGone;
    return this.item(`ah-${rowId}`)
      .h(UI.height.control)
      .pl(UI.space.sm + UI.icon.lead + UI.space.sm)
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected }))
      .relative()
      .when(this.isCursorOn(id), (el) => el.child(this.ring(t)))
      .tooltip(worktree.isGone ? `${worktree.folder} is gone` : worktree.folder)
      .on_hover((on, cx) => {
        if (on) this.hovered = rowId;
        else if (this.hovered === rowId) this.hovered = null;
        if (on && this.pressed?.isMoving) this.pressed = { ...this.pressed, over: project.key };
        this.redrawAll(cx);
      })
      .when(Boolean(shared(DRAG_TAB)) && hovered, (el) => el.bg(t.selected).child(this.ring(t)))
      .on_mouse_up("left", () => shared(DRAG_TAB) && this.dropTabOn(project, worktree))
      .on_click(() => this.pickWorktree(project, worktree))
      .on_mouse_down("right", () => this.projectMenu(project, pulse, worktree))
      .child(svg(`${ICON}/git-branch.svg`).size(UI.icon.small).flex_none().text_color(isSelected ? t.foreground : t.dim))
      .child(div().flex_shrink(1).min_w(0).truncate().text_size(UI.text.body).text_color(isSelected ? t.foreground : worktree.isGone ? t.dim : t.muted).child(worktree.branch))
      .when(elsewhere !== null, (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(elsewhere)))
      .child(div().flex_1())
      .child(shared(DRAG_TAB) && hovered ? this.moveHere(t) : hovered && canStart ? this.iconButton(t, `ah-pen-${rowId}`, "square-pen", `New session in ${worktree.branch}`, () => ask({ action: "startIn", project, machine: worktree.machine, folder: worktree.folder }), UI.height.inline) : this.slots(t, worktree));
  }

  projectMenu(p, pulse, worktree = null) {
    const shown = { view: "menu", project: p, worktree, here: pulse.here, homes: Object.fromEntries(pulse.all.machines.map((m) => [m.name, m.home])), machines: pulse.all.machines.filter((m) => m.connected).map((m) => m.name) };
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: MENU_WIDTH * 2 + UI.space.sm, height: this.menuHeight(this.projectMenuGroups(shown)), props: shown });
  }

  moveHere(t) {
    return div().flex_none().text_size(UI.text.caption).font_medium().text_color(t.accent).child("Move here");
  }

  dropTabOn(p, worktree) {
    const drag = endTabDrag(true);
    if (!drag) return;
    const target = worktree ?? firstWorktreeOf(p.key);
    if (target === null) return notify({ title: `No checkout of ${p.name} is open here`, body: "Open one of its worktrees, then drop the tab on it.", level: "warning" });
    ask({ action: "moveTab", terminals: drag.terminals, key: p.key, worktree: { machine: target.machine, folder: target.folder }, name: worktree ? `${p.name} · ${worktree.branch}` : p.name });
  }

  dropProject(cx) {
    const pressed = this.pressed;
    this.pressed = null;
    if (pressed?.isMoving) this.dropped = pressed.key;
    if (pressed?.isMoving && pressed.over !== pressed.key && pressed.over !== NONE) {
      const order = movedTo(this.order, this.order.indexOf(pressed.key), this.order.indexOf(pressed.over));
      this.order = order;
      ask({ action: "orderProjects", order: order.filter((key) => key !== NONE) });
      this.refreshProjects();
      this.placeParts(cx);
    }
    this.redrawAll(cx);
  }

  pickProject(p) {
    this.cursor = null;
    const worktree = firstWorktreeOf(p.key);
    if (worktree !== null) markOpening(p.key, worktree, p.name);
    setFilter({ project: p.key, worktree });
    ask({ action: "showProject", key: p.key, machine: null });
  }

  pickWorktree(p, w) {
    const worktree = { machine: w.machine, folder: w.folder };
    this.cursor = null;
    markOpening(p.key, worktree, p.name);
    setFilter({ project: p.key, worktree });
    ask({ action: "showWorkspace", key: p.key, worktree });
  }


  initFooter() {
    this.footer = null;
    this.refreshFooter();
  }

  syncFooter(cx) {
    if (this.refreshFooter()) cx.notify();
  }

  refreshFooter() {
    const machinesList = shared(PULSE)?.all.machines ?? [];
    const offline = machinesList.filter((m) => !m.connected).length;
    const footer = {
      label: machinesList.length <= 1 ? "Add a machine" : offline > 0 ? `${machinesList.length} machines · ${offline} offline` : `${machinesList.length} machines`,
      collapsed: narrow(),
      isUpdateReady: Boolean(updates().app.ready),
    };
    if (this.footer !== null && footer.label === this.footer.label && footer.collapsed === this.footer.collapsed && footer.isUpdateReady === this.footer.isUpdateReady) return false;
    this.footer = footer;
    return true;
  }

  renderFooter(t) {
    const { label, collapsed, isUpdateReady } = this.footer;
    const row = (id, icon, text, action, extra = null) =>
      this.item(id)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .when(collapsed, (el) => el.w(UI.height.row).px(0).justify_center().tooltip(text))
        .on_click(action)
        .child(this.leadIcon(icon))
        .when(!collapsed, (el) => el.child(div().flex_1().min_w(0).truncate().child(text)))
        .when(extra !== null && !collapsed, (el) => el.child(extra));
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .px(UI.space.sm)
      .pt(UI.space.xs)
      .pb(UI.space.sm)
      .text_size(UI.text.body)
      .when(collapsed, (el) => el.px(0).items_center())
      .child(row("ah-footer-machines", "server", label, () => openOverlay({ mod: "anyhost", kind: "dialog", width: 460, props: { view: "machines" } })))
      .child(row("ah-footer-settings", "settings", "Settings", () => ask({ action: "settings" }), isUpdateReady ? this.dot(t.accent) : null));
  }

  dot(color) {
    return div().size(UI.dot).flex_none().rounded(UI.dot / 2).bg(color);
  }


  initBoard(cx) {
    this.dragging = null;
    this.over = null;
    this.dropped = null;
    this.hovered = null;
    this.renaming = null;
    this.board = null;
    this.groupBy = saved("groupBy", "stage");
    this.opening = new Map();
    this.isAdding = false;
    this.adding = InputState.new({ placeholder: "Stage name" });
    this.adding.on("submit", (_e, cx) => {
      const name = this.adding.value().trim();
      this.adding.set_value("");
      this.isAdding = false;
      if (name !== "") this.saveStages(cx, [...this.data.stages, { id: idOf(), name }]);
      cx.notify();
    });
    this.adding.on("blur", (_e, cx) => {
      this.isAdding = false;
      cx.notify();
    });
    this.stageName = InputState.new({ placeholder: "Stage name" });
    this.stageName.on("submit", (_e, cx) => this.renameStage(cx));
    this.stageName.on("blur", (_e, cx) => this.renameStage(cx));
    this.initData(cx, () => this.isBoardShown());
  }

  saveStages(cx, stages) {
    this.organize(cx, [{ op: "defineStages", stages }]);
  }

  renameStage(cx) {
    const id = this.renaming;
    if (id === null) return;
    this.renaming = null;
    const name = this.stageName.value().trim();
    if (name !== "" && name !== this.data.stages.find((s) => s.id === id)?.name) this.saveStages(cx, this.data.stages.map((s) => (s.id === id ? { ...s, name } : s)));
    cx.notify();
  }

  isBoardShown() {
    return shownView() === "board";
  }

  boardFilter() {
    const { project, worktree } = filterOf();
    return { ...NO_FILTER, project, worktree };
  }

  boardOf(model, { project, worktree }) {
    const cards = model.rows.filter((r) => r.kind === "own" && !r.isChild && !r.archived && !r.deleted && (project === null || r.projectKey === project) && (worktree === null || sameWorktree(worktree, { machine: r.machine, folder: r.checkout }))).sort((a, b) => (b.state === "blocked") - (a.state === "blocked") || b.since - a.since);
    const stages = this.data.stages;
    const pulse = shared(PULSE);
    const workspaceName = worktree === null ? null : (pulse?.workspaces ?? []).find((w) => sameWorktree(w, worktree))?.name;
    return {
      model,
      cards,
      name: workspaceName ?? (project === null ? "All projects" : (pulse?.projects ?? []).find((p) => p.key === project)?.name ?? projectNameOf(project, this.data.projectNames)),
      state: Object.entries(STATE).map(([state, { name }]) => ({ id: state, name, cards: cards.filter((r) => r.state === state), isStage: false })),
      stage: [{ id: "", name: "No stage", cards: cards.filter((r) => !stages.some((s) => s.id === r.stage)), isStage: true }, ...stages.map((s) => ({ id: s.id, name: s.name, cards: cards.filter((r) => r.stage === s.id), isStage: true }))],
    };
  }

  renderStart(t, board) {
    if (board.openingTitle !== null) return v_flex().id("ah-start").size_full().items_center().justify_center().bg(t.background).child(this.spinnerLabel(t, `Opening ${board.openingTitle.slice(0, 60)}`));
    const recent = [...board.cards].sort((a, b) => b.since - a.since).slice(0, START_MOST);
    return v_flex()
      .id("ah-start")
      .size_full()
      .items_center()
      .overflow_y_scrollbar()
      .bg(t.background)
      .text_color(t.foreground)
      .child(
        v_flex()
          .w_full()
          .max_w(START_WIDTH)
          .px(UI.space.lg)
          .pt(UI.space.xl)
          .gap(UI.space.sm)
          .child(
            h_flex()
              .gap(UI.space.sm)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(UI.text.title).font_semibold().child(board.name))
              .child(this.choice(t, "ah-start-new", "New session", false, () => ask({ action: "newHere" }))),
          )
          .child(div().text_size(UI.text.caption).text_color(t.dim).child(recent.length === 0 ? "No sessions yet. Start one to see it here." : "No session is open. Pick one to continue it."))
          .children(
            recent.map((r) =>
              this.item(`ah-start-${r.key}`)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.act(() => this.askOpen(r, "tab")))
                .child(this.harnessIcon(t, r))
                .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).child(r.title))
                .child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(since(r.since)))
                .child(this.isAskedOpen(r) ? this.spinnerLabel(t, "Opening") : this.status(t, r)),
            ),
          ),
      );
  }

  askOpen(r, shape) {
    if (!r.address) this.opening.set(r.key, Date.now());
    ask({ action: "present", key: r.key, shape });
  }

  isAskedOpen(r) {
    return !r.address && Date.now() - (this.opening.get(r.key) ?? 0) < OPENING_SHOWN_MS;
  }

  boardReconcile(cx) {
    const changed = shared(CHANGED) ?? 0;
    const isShown = this.isBoardShown();
    const isStale = isShown && !this.wasShown && Date.now() - (this.readAt ?? 0) > REFRESH_MS;
    this.wasShown = isShown;
    if (changed <= this.changedAt && !isStale) return;
    this.changedAt = Math.max(this.changedAt, changed);
    this.refresh(cx);
  }

  renderBoard(t) {
    const board = this.board;
    if (board === null) return v_flex().size_full().bg(t.background).child(this.empty(t, "Reading your sessions…"));
    if (board.isStart) return this.renderStart(t, board);
    const { model, cards } = board;
    const columns = board[this.groupBy];
    const projectName = board.name;
    const mounted = new Set();
    this.mounted = mounted;
    return v_flex()
      .id("ah-board")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => {
        this.dragging = null;
        this.over = null;
        this.redrawAll(cx);
      })
      .child(
        h_flex()
          .h(UI.height.row + UI.space.sm)
          .px(UI.space.lg)
          .gap(UI.space.sm)
          .flex_none()
          .items_center()
          .child(div().text_size(UI.text.title).font_semibold().child(projectName))
          .child(div().text_size(UI.text.caption).text_color(t.dim).child(`${cards.length} ${cards.length === 1 ? "session" : "sessions"}`))
          .child(div().flex_1())
          .child(div().text_size(UI.text.caption).text_color(t.dim).child("Group by"))
          .children(
            [
              ["stage", "Stage"],
              ["state", "State"],
            ].map(([id, label]) => this.choice(t, `ah-group-${id}`, label, this.groupBy === id, () => {
              this.groupBy = id;
              save("groupBy", id);
              this.act(() => undefined);
            })),
          ),
      )
      .child(
        h_flex()
          .id("ah-columns")
          .flex_1()
          .min_h(0)
          .px(UI.space.lg)
          .pb(UI.space.lg)
          .gap(UI.space.md)
          .items_start()
          .overflow_x_scrollbar()
          .children(columns.map((column) => this.column(t, column, model, mounted)))
          .when(this.groupBy === "stage", (el) =>
            el.child(
              v_flex()
                .w(260)
                .flex_none()
                .p(UI.space.sm)
                .child(
                  this.isAdding
                    ? this.input(t, this.adding)
                    : this.reveal(t, "ah-add-stage", "plus", "Add stage", () => {
                        this.isAdding = true;
                        this.adding.focus();
                      }),
                ),
            ),
          ),
      );
  }

  searchField(t, state) {
    return h_flex().flex_1().min_w(0).h_full().gap(UI.space.sm).items_center().text_color(t.dim).child(svg(`${ICON}/search.svg`).size(UI.icon.body).flex_none()).child(Input.new(state).flex_1().h_full().text_size(UI.text.body).text_color(t.foreground));
  }

  input(t, state) {
    return Input.new(state).h(UI.height.row).px(UI.space.sm).rounded(UI.radius.control).border_1().border_color(t.input).bg(t.background).text_size(UI.text.body).text_color(t.foreground);
  }

  choice(t, id, label, isChosen, onClick, icon = null) {
    return h_flex()
      .id(id)
      .h(UI.height.control)
      .px(UI.space.sm)
      .gap(UI.space.xs)
      .flex_none()
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.caption)
      .cursor_pointer()
      .when(isChosen, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!isChosen, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => {
        onClick(cx);
        cx.notify();
      })
      .when(icon !== null, (el) => el.child(svg(iconPath(icon)).size(UI.icon.small)))
      .child(label);
  }

  column(t, column, model, mounted) {
    const isOver = this.dragging !== null && this.over === column.id && column.isStage;
    const stages = this.data.stages;
    const at = stages.findIndex((s) => s.id === column.id);
    const isNamed = column.isStage && column.id !== "";
    const reorder = (cx, to) => {
      const next = [...stages];
      const [moved] = next.splice(at, 1);
      next.splice(to, 0, moved);
      this.saveStages(cx, next);
    };
    const label =
      this.renaming === column.id
        ? this.input(t, this.stageName).w(150).h(UI.height.control)
        : div()
            .id(`ah-col-name-${column.id || "none"}`)
            .when(isNamed, (el) =>
              el
                .cursor_pointer()
                .tooltip("Rename the stage")
                .on_click((_e, cx) => {
                  this.renaming = column.id;
                  this.stageName.set_value(column.name);
                  this.stageName.focus();
                  cx.notify();
                }),
            )
            .child(column.isStage ? div().text_size(UI.text.body).font_medium().text_color(t.foreground).child(column.name) : this.stateChip(t, column.id, column.name));
    const header = this.item(`ah-col-head-${column.id || "none"}`)
      .px(UI.space.xs)
      .child(label)
      .child(div().text_size(UI.text.caption).text_color(t.dim).child(String(column.cards.length)))
      .child(div().flex_1())
      .when(isNamed && this.hovered === `col:${column.id}` && this.renaming === null, (el) =>
        el
          .when(at > 0, (row) => row.child(this.iconButton(t, `ah-left-${column.id}`, "chevron-left", "Move left", (cx) => reorder(cx, at - 1), UI.height.inline)))
          .when(at < stages.length - 1, (row) => row.child(this.iconButton(t, `ah-right-${column.id}`, "chevron-right", "Move right", (cx) => reorder(cx, at + 1), UI.height.inline)))
          .child(this.iconButton(t, `ah-drop-${column.id}`, `${OWN}/trash`, column.cards.length > 0 ? `Delete the stage: its ${column.cards.length} sessions move to No stage` : "Delete the stage", (cx) => this.saveStages(cx, stages.filter((s) => s.id !== column.id)), UI.height.inline)),
      );
    return v_flex()
      .id(`ah-col-${column.id || "none"}`)
      .w(260)
      .flex_none()
      .h_full()
      .p(UI.space.sm)
      .gap(UI.space.sm)
      .rounded(UI.radius.panel)
      .bg(isOver ? t.selected : t.surface)
      .on_hover((on, cx) => {
        if (on) this.hovered = `col:${column.id}`;
        if (on && this.dragging !== null) this.over = column.id;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const key = this.dragging;
        this.dragging = null;
        this.over = null;
        const r = key ? model.byKey.get(key) : undefined;
        if (r && column.isStage && r.stage !== column.id) {
          this.dropped = key;
          this.organize(cx, [{ op: "stageSession", session: key, stage: column.id }], [[key, { stage: column.id }]]);
        }
        this.redrawAll(cx);
      })
      .child(header)
      .child(
        v_flex()
          .id(`ah-col-cards-${column.id || "none"}`)
          .flex_1()
          .min_h(0)
          .gap(UI.space.sm)
          .overflow_y_scrollbar()
          .children(column.cards.map((r) => this.cardFor({ t }, r, mounted)))
          .when(column.cards.length === 0 && column.isStage, (el) => el.child(this.empty(t, this.dragging !== null ? "Drop it here" : "Drag a card here"))),
      );
  }

  boardCard(t, r, isDraggable) {
    const tags = r.tags.map((id) => this.data.tags[id]).filter(Boolean);
    const isDragged = this.dragging === r.key;
    return v_flex()
      .id(`ah-card-${r.key}`)
      .p(UI.space.md)
      .gap(UI.space.sm)
      .flex_none()
      .rounded(UI.radius.panel)
      .bg(t.background)
      .border_1()
      .border_color(isDragged ? t.accent : t.border)
      .opacity(isDragged ? 0.5 : 1)
      .cursor_pointer()
      .hover((s) => s.border_color(t.input))
      .on_mouse_down("left", (_e, cx) => {
        this.dropped = null;
        if (!isDraggable) return;
        this.dragging = r.key;
        cx.notify();
        this.act(() => undefined);
      })
      .on_click(() =>
        this.act(() => {
          if (this.dropped === r.key) return void (this.dropped = null);
          this.askOpen(r, "panel");
        }),
      )
      .on_mouse_down("right", () => ask({ action: "menu", key: r.key }))
      .child(h_flex().gap(UI.space.sm).items_center().child(this.harnessIcon(t, r)).child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().child(r.title)))
      .when(r.lastSaid !== "", (el) => el.child(div().truncate().text_size(UI.text.caption).text_color(t.dim).child(r.lastSaid)))
      .child(
        h_flex()
          .gap(UI.space.xs)
          .flex_wrap()
          .items_center()
          .child(this.isAskedOpen(r) ? this.spinnerLabel(t, "Opening") : this.status(t, r))
          .children(tags.map((tag) => this.chip(t, tag.name, this.tagColor(tag.color))))
          .child(div().flex_1())
          .child(div().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(r.projectName)),
      );
  }

  button(t, id, label, isPrimary, onClick) {
    return div()
      .id(id)
      .h(UI.height.row)
      .px(UI.space.md)
      .flex()
      .flex_none()
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.body)
      .font_medium()
      .cursor_pointer()
      .when(isPrimary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!isPrimary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }


  initPopup(cx) {
    this.at = null;
    this.subAt = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  renderMenu(t) {
    const p = props();
    const groups = p.project ? this.projectMenuGroups(p) : this.sessionMenuGroups(p);
    return this.popupMenu(t, groups.filter((group) => group.length > 0));
  }

  projectMenuGroups(p) {
    const project = p.project;
    const isRepository = project.key !== NONE && project.key !== TEMPORARY;
    const w = p.worktree ?? (project.worktrees.length === 1 ? project.worktrees[0] : null);
    const at = w === null ? null : { machine: w.machine, folder: w.folder };
    const mode = w?.id ? workspaceOf(w.id).mode : null;
    const inGit = isRepository && project.worktrees.length > 0;
    const copies = [
      ...(w ? [{ id: "copy-path", icon: "folder", label: "Folder path", copy: w.folder }] : []),
      ...(w ? [{ id: "copy-branch", icon: "git-branch", label: "Branch", copy: w.branch }] : []),
      ...(isRepository ? [{ id: "copy-repo", icon: `${OWN}/hash`, label: "Repository", copy: project.key }] : []),
    ];
    return [
      [
        ...(inGit ? [{ id: "new-here", icon: "square-pen", label: w ? `New session in ${w.branch}` : "New session", ask: { action: "startIn", project, ...at } }] : []),
        ...(inGit ? [{ id: "worktree-new", icon: `${OWN}/git-branch-plus`, label: w ? `New worktree from ${w.branch}…` : "New worktree…", open: "worktree", from: at }] : []),
        ...(p.worktree ? [{ id: "worktree-remove", icon: `${OWN}/trash`, label: "Remove worktree", disabled: p.worktree.isMain, reason: "The main checkout stays", isDestructive: true, ask: { action: "removeWorktree", ...at } }] : []),
      ],
      [
        ...(!p.worktree && isRepository ? [{ id: "rename", icon: `${OWN}/pencil`, label: "Rename…", open: "rename" }] : []),
        ...(w?.id ? [{ id: "view", icon: `${OWN}/layout-grid`, label: "View", sub: MODES.map(([id, label, icon]) => ({ id: `mode-${id}`, icon: mode === id ? "check" : icon, label, mode: id, workspace: { id: w.id, key: project.key, worktree: at } })) }] : []),
        ...(!p.worktree && project.machines.length > 1 ? [{ id: "show-on", icon: "server", label: "Show it on", sub: project.machines.filter((m) => p.machines.includes(m)).map((m) => ({ id: `on-${m}`, icon: "server", label: m, ask: { action: "showProject", key: project.key, machine: m } })) }] : []),
        { id: "read-all", icon: "circle-check", label: "Mark all read", ask: { action: "readProject", project, worktree: p.worktree ? at : null } },
      ],
      copies.length > 0 ? [{ id: "copy", icon: `${OWN}/copy`, label: "Copy", sub: copies }] : [],
    ];
  }

  sessionMenuGroups(p) {
    const tagged = this.tagged ?? p.tagged;
    const tagItems = [...Object.entries(p.tags).map(([id, tag]) => ({ id: `tag-${id}`, icon: tagged.includes(id) ? "check" : `${OWN}/tag`, label: tag.name, toggle: id })), { id: "tags-edit", icon: "plus", label: "New tag…", open: "tags" }];
    const stageItems = [{ id: "stage-none", icon: p.stage === "" ? "check" : "minus", label: "No stage", ask: { action: "organize", changes: [{ op: "stageSession", session: p.key, stage: "" }], optimistic: [[p.key, { stage: "" }]] } }, ...p.stages.map((s) => ({ id: `stage-${s.id}`, icon: p.stage === s.id ? "check" : "square", label: s.name, ask: { action: "organize", changes: [{ op: "stageSession", session: p.key, stage: s.id }], optimistic: [[p.key, { stage: s.id }]] } })), { id: "stages-edit", icon: "plus", label: "New stage…", open: "stages" }];
    const tabs = p.tabActions;
    const isBusy = isRunning(p.state) || p.state === "blocked";
    const now = new Date();
    const snoozeItems = [...snoozesAt(now).map((snooze) => ({ id: `snooze-${snooze.id}`, label: snooze.label, detail: snooze.detail, snooze })), { id: "snooze-custom", label: "Custom…", open: "snooze", separatorBefore: true }];
    return [
      tabs
        ? [
            { id: "close-tab", icon: "x", label: "Close tab", disabled: p.pinned, reason: "Unpin it to close it", ask: { action: "closeTabs", tabs: [tabs.tab] } },
            { id: "close-others", icon: "x", label: "Close other tabs", disabled: tabs.others.length === 0, reason: "No other tab is open", ask: { action: "closeTabs", tabs: tabs.others } },
            { id: "close-right", icon: "x", label: "Close tabs to the right", disabled: tabs.right.length === 0, reason: "No tab is to its right", ask: { action: "closeTabs", tabs: tabs.right } },
            { id: "reopen", icon: `${OWN}/archive-restore`, label: "Reopen closed tab", disabled: !p.canReopen, reason: "No closed tab to reopen", ask: { action: "reopen" } },
          ]
        : [],
      [
        { id: "peek", icon: `${OWN}/eye`, label: "Peek", ask: { action: "peek" } },
        ...(p.canSleep ? [{ id: "sleep", icon: `${OWN}/moon`, label: "Sleep", disabled: isBusy, reason: BUSY_REASON, ask: { action: "sleep" } }] : []),
        ...(p.canStartHere ? [{ id: "start-here", icon: "square-pen", label: "New session in its folder", ask: { action: "startHere" } }] : []),
      ],
      p.archived || p.deleted
        ? []
        : [
            { id: "pin", icon: p.pinned ? "pin-off" : "pin", label: p.pinned ? "Unpin" : "Pin", ask: { action: "pin" } },
            { id: "settle", icon: "circle-check", label: p.settled ? "Unsettle" : "Settle", disabled: isBusy, reason: BUSY_REASON, ask: { action: "settle" } },
            p.snoozed ? { id: "wake", icon: `${OWN}/alarm-clock-off`, label: "Wake now", ask: { action: "snooze", until: null } } : { id: "snooze", icon: "clock", label: "Snooze", disabled: p.state === "blocked", reason: "It waits for you, which wakes a snooze at once", sub: snoozeItems },
          ],
      [
        { id: "tags", icon: `${OWN}/tag`, label: "Tags", sub: tagItems },
        { id: "stage", icon: `${OWN}/kanban`, label: "Stage", sub: stageItems },
      ],
      [
        ...(!p.archived && !p.deleted && (p.state === "idle" || p.state === "done") ? [p.isUnread ? { id: "read", icon: "circle-check", label: "Mark read", ask: { action: "read" } } : { id: "unread", icon: `${OWN}/mail-open`, label: "Mark unread", ask: { action: "unread" } }] : []),
        p.isFiltered ? { id: "all", icon: "layers", label: "Show all projects", filter: null } : { id: "only", icon: `${OWN}/list-filter`, label: `Filter by ${p.projectName}`, ask: { action: "filterProject" } },
      ],
      [
        ...(!p.deleted ? [{ id: "open-in", icon: `${OWN}/panel-right`, label: "Open in", sub: SHAPES.map(([shape, label, icon]) => ({ id: `open-${shape}`, icon, label, ask: { action: "present", shape } })) }] : []),
        ...(p.canShowHere
          ? [
              { id: "here-right", icon: `${OWN}/columns-2`, label: "Show beside this pane", ask: { action: "showHere", direction: "right" } },
              { id: "here-down", icon: `${OWN}/rows-2`, label: "Show below this pane", ask: { action: "showHere", direction: "down" } },
            ]
          : []),
        ...(p.isLocal && p.tabs.length > 0 ? [{ id: "to-tab", icon: "files", label: "Move to tab", sub: p.tabs.map((x) => ({ id: `tab-${x.id}`, icon: "terminal", label: x.name, ask: { action: "moveToTab", tab: x.id } })) }] : []),
        ...(p.targets.length > 0 ? [{ id: "move", icon: "server", label: "Move to machine", sub: p.targets.map((to) => ({ id: `move-${to}`, icon: "server", label: to, ask: { action: "move", to } })) }] : []),
      ],
      [{ id: "copy", icon: `${OWN}/copy`, label: "Copy", sub: [...(p.cwd ? [{ id: "copy-path", icon: "folder", label: "Folder path", copy: p.cwd }] : []), { id: "copy-id", icon: `${OWN}/hash`, label: "Session ID", copy: p.key }] }],
      [
        ...(p.deleted ? [{ id: "undelete", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "open" } }] : p.archived ? [{ id: "restore", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "restore" } }] : [{ id: "archive", icon: "archive", label: "Archive", ask: { action: "archive" }, disabled: p.pinned, reason: "Unpin it to archive it" }]),
        ...(!p.deleted ? [{ id: "delete", icon: `${OWN}/trash`, label: "Delete…", ask: { action: "confirmDelete" }, isDestructive: true, disabled: isBusy, reason: BUSY_REASON }] : []),
      ],
    ];
  }

  choose(item, cx) {
    const p = props();
    if (item.toggle !== undefined) {
      const tagged = this.tagged ?? p.tagged;
      const isOn = !tagged.includes(item.toggle);
      this.tagged = isOn ? [...tagged, item.toggle] : tagged.filter((x) => x !== item.toggle);
      ask({ action: "organize", changes: [{ op: "tagSession", session: p.key, tag: item.toggle, on: isOn }], optimistic: [[p.key, { tags: this.tagged }]] });
      return cx.notify();
    }
    closeOverlay(p.overlay);
    if (item.copy !== undefined) return cx.write_to_clipboard(item.copy);
    if (item.filter !== undefined) return setFilter({ project: item.filter });
    if (item.mode !== undefined) {
      changeWorkspace(item.workspace.id, { mode: item.mode, zoomed: null });
      return ask({ action: "showWorkspace", key: item.workspace.key, worktree: item.workspace.worktree });
    }
    if (item.open === "worktree") return openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "worktree", project: p.project, from: item.from ?? null, fromBranch: p.worktree?.branch ?? (p.project.worktrees.length === 1 ? p.project.worktrees[0].branch : null) } });
    if (item.open === "tags") return openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: 360, props: { view: "tags", key: p.key, tagged: p.tagged, tags: p.tags } });
    if (item.open === "stages") return openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: 360, props: { view: "tags", isStage: true, key: p.key, stage: p.stage, stages: p.stages } });
    if (item.open === "snooze") return openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "snooze", key: p.key, title: p.title } });
    if (item.open === "rename") return openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "rename", project: p.project } });
    if (item.snooze !== undefined) {
      const until = item.snooze.preset.after !== undefined ? snoozeOf(item.snooze.preset, new Date()).until : isFuture(item.snooze.until) ? item.snooze.until : null;
      if (until === null) return notify({ title: "anyhost could not snooze it", body: "That snooze time has passed. Choose another time.", level: "warning" });
      return ask({ key: p.key, action: "snooze", until });
    }
    if (item.ask) ask({ key: p.key, ...item.ask });
  }

  popupMenu(t, groups) {
    const items = groups.flat();
    const opened = items.find((item) => item.id === this.at && item.sub && !item.disabled) ?? null;
    const entry = (item, onHover, isAt) => {
      const color = item.disabled ? t.dim : item.isDestructive ? t.ansi1 : t.foreground;
      return this.item(`ah-menu-${item.id}`)
        .text_color(color)
        .when(!item.disabled && isAt, (el) => el.bg(t.selected))
        .when(!item.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(Boolean(item.disabled && item.reason), (el) => el.tooltip(item.reason))
        .on_hover((on, cx) => {
          if (on) onHover(cx);
        })
        .on_click((_e, cx) => {
          if (!item.disabled && !item.sub) this.choose(item, cx);
        })
        .when(item.icon !== undefined, (el) => el.child(this.leadIcon(item.icon).text_color(item.disabled ? t.dim : item.isDestructive ? t.ansi1 : t.muted)))
        .child(div().flex_1().truncate().child(item.label))
        .when(item.detail !== undefined, (el) => el.child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(item.detail)))
        .when(Boolean(item.sub), (el) => el.child(svg(`${ICON}/chevron-right.svg`).size(UI.icon.small).flex_none().text_color(t.dim)));
    };
    const hoverAt = (item) => (cx) => {
      this.at = item.id;
      this.subAt = null;
      cx.notify();
    };
    const hoverSub = (item) => (cx) => {
      this.subAt = item.id;
      cx.notify();
    };
    const panel = () => this.panel(t).w(MENU_WIDTH).text_size(UI.text.body);
    return h_flex()
      .id("ah-menu")
      .track_focus(this.handle)
      .size_full()
      .items_start()
      .gap(UI.space.xs)
      .on_key_down((e, cx) => this.menuKey(e, cx, items, opened))
      .child(panel().children(groups.flatMap((group, n) => [...(n > 0 ? [this.divider(t)] : []), ...group.map((item) => entry(item, hoverAt(item), this.at === item.id && this.subAt == null))])))
      .when(opened !== null, (el) => el.child(panel().mt(menuOffsetOf(groups, opened)).children(opened.sub.flatMap((item) => [...(item.separatorBefore ? [this.divider(t)] : []), entry(item, hoverSub(item), this.subAt === item.id)]))));
  }

  menuKey(e, cx, items, opened) {
    const inSub = opened !== null && this.subAt != null;
    const list = (inSub ? opened.sub : items).filter((item) => !item.disabled);
    const at = list.findIndex((item) => item.id === (inSub ? this.subAt : this.at));
    const move = (step) => list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length]?.id ?? null;
    if (e.key === "down" || e.key === "up") {
      if (inSub) this.subAt = move(e.key === "down" ? 1 : -1);
      else this.at = move(e.key === "down" ? 1 : -1);
    }
    const current = inSub ? opened.sub.find((item) => item.id === this.subAt) : items.find((item) => item.id === this.at);
    const firstSub = (item) => item?.sub?.find((sub) => !sub.disabled)?.id ?? null;
    if (e.key === "right" && !inSub && current?.sub && !current.disabled) this.subAt = firstSub(current);
    if (e.key === "left" && inSub) this.subAt = null;
    if ((e.key === "enter" || e.key === "space") && current && !current.disabled) {
      if (current.sub && !inSub) this.subAt = firstSub(current);
      else this.choose(current, cx);
    }
    if (e.key === "escape") {
      if (inSub) this.subAt = null;
      else closeOverlay(props().overlay);
    }
    cx.notify();
  }

  renderFilter(t) {
    const p = props();
    const f = filterOf();
    const toggle = (field, value) => setFilter({ [field]: f[field].includes(value) ? f[field].filter((x) => x !== value) : [...f[field], value] });
    const option = (id, label, isOn, onClick, lead, isDisabled = false) =>
      this.item(`ah-f-${id}`)
        .when(!isDisabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => onClick()))
        .child(lead)
        .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).text_color(isDisabled ? t.dim : t.foreground).child(label))
        .when(isOn, (el) => el.child(svg(`${ICON}/check.svg`).size(UI.icon.body).text_color(t.foreground)));
    const head = (text) => this.item(`ah-f-head-${text}`).h(UI.height.control).text_size(UI.text.caption).font_medium().text_color(t.dim).child(text);
    const icon = (name, color = t.muted) => this.leadIcon(name).text_color(color);
    const projects = [...p.projects].sort((a, b) => (a.key === NONE) - (b.key === NONE) || a.name.localeCompare(b.name));
    return this.panel(t)
      .id("ah-filter-panel")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .w_full()
      .child(
        v_flex()
          .id("ah-filter-body")
          .h(p.bodyHeight)
          .flex_none()
          .overflow_y_scrollbar()
          .child(head("Project"))
          .child(option("all", "All projects", f.project === null, () => setFilter({ project: null }), icon("layers")))
          .children(projects.map((project) => option(`p-${project.key}`, project.name, f.project === project.key, () => {
            if (f.project === project.key) return setFilter({ project: null });
            setFilter({ project: project.key });
            ask({ action: "showProject", key: project.key, machine: null });
          }, this.mark(t, project.name, false, project.key === NONE))))
          .child(head("State"))
          .children(Object.entries(STATE).map(([state, { name, icon: stateIcon }]) => option(`s-${state}`, name, f.states.includes(state), () => toggle("states", state), icon(stateIcon, this.stateColor(state)))))
          .when(Object.keys(p.tags).length > 0, (el) => el.child(head("Tags")).children(Object.entries(p.tags).map(([id, tag]) => option(`t-${id}`, tag.name, f.tags.includes(id), () => toggle("tags", id), div().size(UI.icon.lead).flex_none().flex().items_center().justify_center().child(this.dot(this.tagColor(tag.color)))))))
          .when(p.machines.length > 1, (el) => el.child(head("Machine")).children(p.machines.map((m) => option(`m-${m.name}`, m.place, f.machine === m.name, () => setFilter({ machine: f.machine === m.name ? null : m.name }), icon("server")))))
          .child(head("Also show"))
          .children(INCLUDES.map(([kind, label, includeIcon]) => option(`i-${kind}`, label, f.include.includes(kind), () => toggle("include", kind), icon(includeIcon)))),
      )
      .child(this.divider(t))
      .child(option("clear", "Clear filters", false, () => setShared(FILTER, NO_FILTER), icon("x", isFiltered(f) ? t.muted : t.dim), !isFiltered(f)));
  }

  panel(t) {
    return v_flex().p(UI.space.xs).bg(t.popover).rounded(UI.radius.panel).border_1().border_color(t.border).shadow_lg();
  }

  divider(t) {
    return div().h(1).my(UI.space.xs).mx(UI.space.xs).flex_none().bg(t.border);
  }

  initSettings(cx) {
    this.initPopup(cx);
    this.restored = new Set();
    this.hovered = null;
  }

  renderSettings(t) {
    const p = props();
    const chosen = this.chosenDays === undefined ? p.settleAfterDays : this.chosenDays;
    const choose = (days, cx) => {
      this.chosenDays = days;
      cx.spawn(async (cx) => {
        try {
          await anyhost(["settle", "--after", days === null ? "never" : String(days)]);
          setShared(CHANGED, Date.now());
        } catch (error) {
          this.chosenDays = undefined;
          notify({ title: "anyhost could not change when sessions settle", body: messageOf(error), level: "error" });
          cx.notify();
        }
      });
    };
    return v_flex()
      .id("ah-settings")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.lg)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(UI.text.title).font_semibold().child("Settings"))
      .child(
        v_flex()
          .gap(UI.space.sm)
          .child(div().text_size(UI.text.body).font_medium().child("Settle an idle session after"))
          .child(h_flex().gap(UI.space.xs).flex_wrap().children(SETTLE_AFTER.map((days) => this.choice(t, `ah-after-${days}`, days === null ? "Off" : plural(days, "day"), days === chosen, (cx) => choose(days, cx)))))
          .child(div().text_size(UI.text.caption).text_color(t.dim).child("A settled session moves to the Settled shelf. Pinned, snoozed, working and waiting sessions never settle by themselves.")),
      )
      .child(this.archivedList(t, p.archived.filter((a) => !this.restored.has(a.key))))
      .child(
        this.item("ah-herdr-settings")
          .text_size(UI.text.body)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => {
            closeOverlay(p.overlay);
            run("app.settings");
          })
          .child(this.leadIcon("settings"))
          .child(div().flex_1().child("Herdr app settings"))
          .when(updates().app.ready, (el) => el.child(div().text_size(UI.text.caption).text_color(t.accent).child("Update ready"))),
      );
  }

  archivedList(t, archived) {
    const groups = new Map();
    for (const a of archived) {
      if (!groups.has(a.projectKey)) groups.set(a.projectKey, { key: a.projectKey, name: a.projectName, rows: [] });
      groups.get(a.projectKey).rows.push(a);
    }
    const entry = (a) =>
      this.item(`ah-archived-${a.key}`)
        .hover((s) => s.bg(t.hover))
        .child(this.harnessIcon(t, a))
        .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).child(a.title))
        .child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(a.machine ? `${a.machine} · ${ago(a.at)}` : ago(a.at)))
        .child(
          this.iconButton(t, `ah-archived-restore-${a.key}`, `${OWN}/archive-restore`, "Restore", (cx) => {
            this.restored.add(a.key);
            ask({ action: "restore", key: a.key });
            cx.notify();
          }, UI.height.inline),
        )
        .child(this.iconButton(t, `ah-archived-delete-${a.key}`, `${OWN}/trash`, "Delete…", () => ask({ action: "confirmDelete", key: a.key }), UI.height.inline));
    const head = (group) =>
      this.item(`ah-archived-head-${group.key}`)
        .text_size(UI.text.caption)
        .font_medium()
        .text_color(t.muted)
        .child(this.mark(t, group.name, false, group.key === NONE || group.key === TEMPORARY))
        .child(div().flex_1().min_w(0).truncate().child(group.name))
        .child(div().flex_none().font_normal().text_color(t.dim).child(String(group.rows.length)));
    return v_flex()
      .gap(UI.space.sm)
      .child(h_flex().gap(UI.space.sm).items_center().child(div().text_size(UI.text.body).font_medium().child("Archived")).child(div().text_size(UI.text.caption).text_color(t.dim).child(String(archived.length))))
      .when(archived.length === 0, (el) => el.child(div().text_size(UI.text.caption).text_color(t.dim).child("No archived sessions. A session you archive leaves the list and waits here.")))
      .when(archived.length > 0, (el) =>
        el.child(
          v_flex()
            .id("ah-archived")
            .max_h(320)
            .gap(1)
            .overflow_y_scrollbar()
            .children([...groups.values()].flatMap((group) => [head(group), ...group.rows.map(entry)])),
        ),
      );
  }

  initSnooze(cx) {
    const initial = new Date(Date.now() + 3_600_000);
    this.mode = "date";
    this.unit = "hours";
    this.error = null;
    this.handle = cx.focus_handle();
    const field = (placeholder, value) => {
      const state = InputState.new({ placeholder });
      state.set_value(value);
      state.on("change", (_e, cx) => {
        this.error = null;
        cx.notify();
      });
      state.on("submit", (_e, cx) => this.submitSnooze(cx));
      return state;
    };
    this.day = field("YYYY-MM-DD", dayOf(initial));
    this.clock = field("HH:MM", timeOf(initial));
    this.amount = field("2", "2");
    cx.timer.after(120, () => this.day.focus());
  }

  submitSnooze(cx) {
    const p = props();
    const until = customSnoozeOf({ mode: this.mode, day: this.day.value().trim(), time: this.clock.value().trim(), amount: this.amount.value().trim(), unit: this.unit }, new Date());
    if (until === null) {
      this.error = this.mode === "date" ? "Choose a valid date and time in the future." : "Enter a positive duration.";
      return cx.notify();
    }
    closeOverlay(p.overlay);
    ask({ action: "snooze", key: p.key, until });
  }

  renderSnooze(t) {
    const p = props();
    const field = (label, el) => v_flex().flex_1().min_w(0).gap(UI.space.xs).child(div().text_size(UI.text.caption).text_color(t.muted).child(label)).child(el);
    const mode = (id, label) =>
      this.choice(t, `ah-snooze-${id}`, label, this.mode === id, () => {
        this.mode = id;
        this.error = null;
        (id === "date" ? this.day : this.amount).focus();
      });
    return v_flex()
      .id("ah-snooze")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(UI.text.title).font_semibold().child("Custom snooze"))
      .child(div().text_size(UI.text.body).text_color(t.muted).child(`Choose when ${shortTitle(p.title, 60)} comes back to your list.`))
      .child(h_flex().gap(UI.space.xs).child(mode("date", "Date and time")).child(mode("duration", "Duration")))
      .child(
        this.mode === "date"
          ? h_flex().gap(UI.space.sm).child(field("Date", this.input(t, this.day))).child(field("Time", this.input(t, this.clock)))
          : h_flex()
              .items_start()
              .gap(UI.space.sm)
              .child(field("Snooze for", this.input(t, this.amount)))
              .child(field("Unit", h_flex().min_h(UI.height.row).gap(UI.space.xs).items_center().children(SNOOZE_UNITS.map(([id, label]) => this.choice(t, `ah-unit-${id}`, label, this.unit === id, () => (this.unit = id)))))),
      )
      .when(this.error !== null, (el) => el.child(div().text_size(UI.text.caption).text_color(t.blocked).child(this.error ?? "")))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-snooze-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
          .child(this.button(t, "ah-snooze-go", "Snooze", true, (cx) => this.submitSnooze(cx))),
      );
  }

  initRename(cx) {
    const { project } = props();
    this.name = InputState.new({ placeholder: project.defaultName });
    this.name.set_value(project.name);
    this.name.on("submit", () => this.saveName(this.name.value()));
    cx.timer.after(120, () => this.name.focus());
  }

  saveName(text) {
    const { project, overlay } = props();
    const name = text === null ? null : text.trim();
    closeOverlay(overlay);
    if (name === project.name) return;
    ask({ action: "nameProject", project: project.key, name: name === "" || name === project.defaultName ? null : name });
  }

  renderPresent(t) {
    const p = props();
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex()
      .id("ah-present")
      .size_full()
      .px(UI.space.sm)
      .gap(UI.space.xs)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().child(p.title))
      .children(
        SHAPES.map(([shape, label, icon]) =>
          div()
            .id(`ah-present-${shape}`)
            .size(UI.height.inline)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(UI.radius.control)
            .cursor_pointer()
            .tooltip(label)
            .when(shape === p.shape, (el) => el.bg(t.selected).text_color(t.foreground))
            .when(shape !== p.shape, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_mouse_down("left", stop)
            .on_click(() => {
              if (shape !== p.shape) ask({ action: "present", key: p.key, shape });
            })
            .child(svg(iconPath(icon)).size(UI.icon.small)),
        ),
      )
      .child(
        div()
          .id("ah-present-close")
          .size(UI.height.inline)
          .flex()
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(UI.radius.control)
          .cursor_pointer()
          .tooltip("Close")
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click(() => closeOverlay(p.overlay))
          .child(svg(`${ICON}/x.svg`).size(UI.icon.small)),
      );
  }

  renderRename(t) {
    const p = props();
    return v_flex()
      .id("ah-rename")
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .child(div().text_size(UI.text.title).font_semibold().child("Rename project"))
      .child(div().text_size(UI.text.body).text_color(t.muted).child("Every machine shows this name."))
      .child(v_flex().gap(UI.space.xs).child(this.input(t, this.name)).child(div().text_size(UI.text.caption).text_color(t.dim).truncate().child(`Repository: ${p.project.key}`)))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .when(p.project.isNamed, (el) => el.child(this.button(t, "ah-rename-reset", `Reset to ${p.project.defaultName}`, false, () => this.saveName(null))))
          .child(div().flex_1())
          .child(this.button(t, "ah-rename-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
          .child(this.button(t, "ah-rename-go", "Save", true, () => this.saveName(this.name.value()))),
      );
  }


  initTags(cx) {
    const p = props();
    this.isStage = p.isStage === true;
    this.noun = this.isStage ? "stage" : "tag";
    this.tagged = this.isStage ? (p.stage ? [p.stage] : []) : [...p.tagged];
    this.catalog = this.isStage ? Object.fromEntries(p.stages.map((s) => [s.id, { name: s.name }])) : { ...p.tags };
    this.editing = null;
    this.query = InputState.new({ placeholder: `Search or create a ${this.noun}` });
    this.query.on("change", (_e, cx) => cx.notify());
    this.query.on("submit", (_e, cx) => {
      const text = this.query.value().trim();
      const match = Object.entries(this.catalog).find(([, tag]) => tag.name.toLowerCase() === text.toLowerCase());
      if (match) this.toggleTag(match[0]);
      else if (text !== "") this.createTag(text);
      this.query.set_value("");
      cx.notify();
    });
    this.rename = InputState.new({ placeholder: this.isStage ? "Stage name" : "Tag name" });
    this.rename.on("submit", (_e, cx) => {
      this.saveTag(this.editing, { name: this.rename.value().trim() });
      this.editing = null;
      cx.notify();
    });
    this.handle = cx.focus_handle();
    cx.timer.after(150, () => this.query.focus());
  }

  stagesListed() {
    return Object.entries(this.catalog).map(([id, { name }]) => ({ id, name }));
  }

  toggleTag(id) {
    const p = props();
    const isOn = !this.tagged.includes(id);
    if (this.isStage) {
      this.tagged = isOn ? [id] : [];
      const stage = this.tagged[0] ?? "";
      return ask({ action: "organize", changes: [{ op: "stageSession", session: p.key, stage }], optimistic: [[p.key, { stage }]] });
    }
    this.tagged = isOn ? [...this.tagged, id] : this.tagged.filter((x) => x !== id);
    ask({ action: "organize", changes: [{ op: "tagSession", session: p.key, tag: id, on: isOn }], optimistic: [[p.key, { tags: this.tagged }]] });
  }

  createTag(name) {
    const p = props();
    const id = idOf();
    if (this.isStage) {
      this.catalog[id] = { name };
      this.tagged = [id];
      return ask({ action: "organize", changes: [{ op: "defineStages", stages: this.stagesListed() }, { op: "stageSession", session: p.key, stage: id }], optimistic: [[p.key, { stage: id }]] });
    }
    const colors = Object.keys(TAG_COLORS);
    const color = colors[Object.keys(this.catalog).length % colors.length];
    this.catalog[id] = { name, color };
    this.tagged = [...this.tagged, id];
    ask({ action: "organize", changes: [{ op: "defineTag", id, name, color }, { op: "tagSession", session: p.key, tag: id, on: true }], optimistic: [[p.key, { tags: this.tagged }]] });
  }

  saveTag(id, change) {
    const tag = this.catalog[id];
    if (!tag || (change.name !== undefined && change.name === "")) return;
    this.catalog[id] = { ...tag, ...change };
    ask({ action: "organize", changes: [this.isStage ? { op: "defineStages", stages: this.stagesListed() } : { op: "defineTag", id, ...this.catalog[id] }] });
  }

  dropTag(id) {
    const p = props();
    delete this.catalog[id];
    this.tagged = this.tagged.filter((x) => x !== id);
    this.editing = null;
    if (this.isStage) return ask({ action: "organize", changes: [{ op: "defineStages", stages: this.stagesListed() }], optimistic: [[p.key, { stage: this.tagged[0] ?? "" }]] });
    ask({ action: "organize", changes: [{ op: "dropTag", id }], optimistic: [[p.key, { tags: this.tagged }]] });
  }

  renderTags(t) {
    const p = props();
    const text = this.query.value().trim().toLowerCase();
    const listed = Object.entries(this.catalog).filter(([, tag]) => text === "" || tag.name.toLowerCase().includes(text));
    const isNew = text !== "" && !Object.values(this.catalog).some((tag) => tag.name.toLowerCase() === text);
    const color = (c) => (TAG_COLORS[c] ?? TAG_COLORS.gray)[this.isDark ? 1 : 0];
    const chipOf = (name, tagColor) => (this.isStage ? this.chip(t, name, this.tagColor("gray"), { isOutlined: true }) : this.chip(t, name, this.tagColor(tagColor)));
    const tagRow = ([id, tag]) =>
      v_flex()
        .id(`ah-tag-${id}`)
        .flex_none()
        .child(
          this.item(`ah-tag-row-${id}`)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.toggleTag(id);
              cx.notify();
            })
            .child(chipOf(tag.name, tag.color))
            .child(div().flex_1())
            .when(this.tagged.includes(id), (el) => el.child(svg(`${ICON}/check.svg`).size(UI.icon.body).text_color(t.foreground)))
            .child(
              this.iconButton(t, `ah-tag-edit-${id}`, `${OWN}/ellipsis`, `Edit the ${this.noun}`, (cx) => {
                this.editing = this.editing === id ? null : id;
                this.rename.set_value(tag.name);
                cx.notify();
              }, UI.height.inline),
            ),
        )
        .when(this.editing === id, (el) =>
          el.child(
            v_flex()
              .px(UI.space.sm)
              .py(UI.space.xs)
              .gap(UI.space.sm)
              .child(this.input(t, this.rename))
              .when(!this.isStage, (edit) => edit.child(
                h_flex()
                  .gap(UI.space.xs)
                  .flex_wrap()
                  .children(
                    Object.keys(TAG_COLORS).map((c) =>
                      div()
                        .id(`ah-color-${id}-${c}`)
                        .size(UI.height.inline)
                        .rounded(UI.radius.pill)
                        .bg(color(c))
                        .cursor_pointer()
                        .when(tag.color === c, (sw) => sw.border_2().border_color(t.foreground))
                        .tooltip(c)
                        .on_click((_e, cx) => {
                          this.saveTag(id, { color: c });
                          cx.notify();
                        }),
                    ),
                  ),
              ))
              .child(
                this.item(`ah-tag-drop-${id}`)
                  .text_size(UI.text.body)
                  .text_color(t.ansi1)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.dropTag(id);
                    cx.notify();
                  })
                  .child(this.leadIcon(`${OWN}/trash`))
                  .child(`Delete the ${this.noun}`),
              ),
          ),
        );
    return this.panel(t)
      .id("ah-tags")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .size_full()
      .gap(UI.space.xs)
      .child(this.input(t, this.query).flex_none())
      .child(
        v_flex()
          .id("ah-tags-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(listed.map(tagRow))
          .when(isNew, (el) =>
            el.child(
              this.item("ah-tag-create")
                .text_size(UI.text.body)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.createTag(this.query.value().trim());
                  this.query.set_value("");
                  cx.notify();
                })
                .child("Create")
                .child(chipOf(this.query.value().trim(), Object.keys(TAG_COLORS)[Object.keys(this.catalog).length % Object.keys(TAG_COLORS).length])),
            ),
          )
          .when(listed.length === 0 && !isNew, (el) => el.child(this.empty(t, `Type a name to create a ${this.noun}`))),
      );
  }


  initNew(cx) {
    const pulse = shared(PULSE);
    const p = props();
    this.machine = pulse?.here ?? "";
    this.cursorAt = 0;
    this.newScroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.folder = InputState.new({ placeholder: "Or a folder: ~/Developer/app" });
    this.folder.on("submit", () => {
      const folder = this.folder.value().trim().replace(/^~(?=\/|$)/, props().homes?.[this.machine] || home());
      if (folder === "") return;
      ask({ action: "startFolder", machine: this.machine, folder });
      closeOverlay(props().overlay);
    });
    this.choices = () => {
      const list = (shared(PULSE)?.projects ?? []).filter((project) => (project.checkouts?.[this.machine] ?? []).length > 0 && project.key !== NONE);
      const current = list.find((project) => project.key === p.current);
      const ordered = [...(current ? [current] : []), ...list.filter((project) => project !== current).sort((a, b) => b.newest - a.newest)];
      return ordered.flatMap((project) => (project.checkouts[this.machine] ?? []).map((folder, n) => ({ project, folder, isFirst: n === 0, isCurrent: project === current })));
    };
    cx.timer.after(120, () => this.handle.focus());
  }

  renderNew(t) {
    const p = props();
    const pulse = shared(PULSE);
    const choices = this.choices();
    this.cursorAt = Math.min(this.cursorAt, Math.max(0, choices.length - 1));
    const homeFolder = p.homes?.[this.machine] ?? "";
    const pick = (choice) => {
      ask({ action: "startIn", project: choice.project, machine: this.machine, folder: choice.folder });
      closeOverlay(p.overlay);
    };
    const machinesList = (pulse?.all.machines ?? []).filter((m) => m.connected);
    return v_flex()
      .id("ah-new")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.cursorAt = Math.min(choices.length - 1, this.cursorAt + 1);
        if (e.key === "up") this.cursorAt = Math.max(0, this.cursorAt - 1);
        if (e.key === "down" || e.key === "up") this.newScroll.scroll_to_item(this.cursorAt);
        if (e.key === "enter" && choices[this.cursorAt]) pick(choices[this.cursorAt]);
        if (e.key === "escape") closeOverlay(p.overlay);
        cx.notify();
      })
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(UI.text.title).font_semibold().child("New session in…")).child(div().text_size(UI.text.caption).text_color(t.dim).child("↑↓ Enter")))
      .child(
        v_flex()
          .id("ah-new-list")
          .max_h(340)
          .gap(1)
          .overflow_y_scrollbar()
          .track_scroll(this.newScroll)
          .children(
            choices.map((choice, n) =>
              this.item(`ah-new-${n}`)
                .cursor_pointer()
                .when(n === this.cursorAt, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_hover((on, cx) => {
                  if (on && this.cursorAt !== n) {
                    this.cursorAt = n;
                    cx.notify();
                  }
                })
                .on_click(() => pick(choice))
                .child(choice.isFirst ? this.mark(t, choice.project.name) : this.leadIcon("git-branch").text_color(t.dim))
                .when(choice.isFirst, (el) => el.child(div().flex_none().text_size(UI.text.body).text_color(t.foreground).child(choice.project.name)))
                .child(div().flex_1().min_w(0).text_size(UI.text.caption).text_color(t.dim).whitespace_nowrap().overflow_hidden().truncate().child(tildeOf(choice.folder, homeFolder)))
                .when(choice.isCurrent && choice.isFirst, (el) => el.child(div().flex_none().text_size(UI.text.caption).text_color(t.muted).child("Current"))),
            ),
          )
          .when(choices.length === 0, (el) => el.child(this.empty(t, "No project has a checkout on this machine yet"))),
      )
      .child(this.input(t, this.folder))
      .when(machinesList.length > 1, (el) =>
        el.child(
          h_flex()
            .gap(UI.space.xs)
            .items_center()
            .flex_wrap()
            .child(div().pr(UI.space.xs).text_size(UI.text.caption).text_color(t.dim).child("Runs on"))
            .children(
              machinesList.map((m) =>
                this.choice(t, `ah-m-${m.name}`, m.place, m.name === this.machine, () => {
                  this.machine = m.name;
                  this.cursorAt = 0;
                }, "server"),
              ),
            ),
        ),
      );
  }


  initMachines(cx) {
    this.adding = null;
    this.failed = null;
    this.hovered = null;
    this.listed = null;
    this.target = InputState.new({ placeholder: "Or ssh: user@host" });
    this.target.on("submit", (_e, cx) => this.addMachine(cx, this.target.value().trim()));
    cx.spawn(async (cx) => {
      try {
        this.listed = JSON.parse(await anyhost(["machines", "--json"]));
      } catch (error) {
        this.failed = messageOf(error);
      }
      cx.notify();
    });
  }

  addMachine(cx, target) {
    if (!target || this.adding) return;
    this.adding = target;
    this.failed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await anyhost(["machines", "--add", target], LONG_MS);
        notify({ title: `Added ${target}`, body: "Its sessions show on every machine.", level: "success" });
        this.listed = JSON.parse(await anyhost(["machines", "--json"]));
        setShared(CHANGED, Date.now());
      } catch (error) {
        this.failed = messageOf(error);
      }
      this.adding = null;
      cx.notify();
    });
  }

  renderMachines(t) {
    const pulse = shared(PULSE);
    const here = this.listed?.here;
    const devices = [...(this.listed?.machines ?? [])].sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : a.name.localeCompare(b.name)));
    const working = new Map((pulse?.all.machines ?? []).map((m) => [m.name, m.working]));
    const candidates = (this.listed?.candidates ?? []).filter((c) => !devices.some((d) => d.name === c.target));
    return v_flex()
      .id("ah-machines")
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(UI.text.title).font_semibold().child("Machines"))
      .child(
        v_flex()
          .gap(1)
          .when(this.listed === null && this.failed === null, (el) => el.child(this.empty(t, "Reading your machines…")))
          .children(
            devices.map((d) => {
              const isHere = d.id === here;
              const connected = isHere || d.connected;
              const hovered = this.hovered === d.id;
              const busy = working.get(d.name) ?? 0;
              return this.item(`ah-machine-${d.id}`)
                .hover((s) => s.bg(t.hover))
                .on_hover((on, cx) => {
                  this.hovered = on ? d.id : this.hovered === d.id ? null : this.hovered;
                  cx.notify();
                })
                .child(div().size(UI.icon.lead).flex_none().flex().items_center().justify_center().child(connected ? this.dot(t.muted) : this.dot(t.dim).opacity(0.5)))
                .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).child(isHere ? `${d.name} · ${d.os === "darwin" ? "This Mac" : "This computer"}` : d.name))
                .child(hovered && !isHere ? this.textButton(t, `ah-remove-${d.id}`, "Remove", () => openOverlay({ mod: "anyhost", kind: "dialog", width: 380, props: { view: "remove", id: d.id, name: d.name } })) : div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(connected ? (busy > 0 ? `${busy} working` : "Connected") : d.seenAt ? `Offline for ${ago(d.seenAt)}` : "Offline"));
            }),
          ),
      )
      .child(div().h(1).bg(t.border))
      .child(div().text_size(UI.text.body).font_medium().child("Add a machine"))
      .child(div().text_size(UI.text.caption).text_color(t.muted).child("anyhost installs itself there over ssh, joins it to your machines, and the Herdr app reaches it."))
      .children(
        candidates.map((c) =>
          this.item(`ah-c-${c.target}`)
            .when(c.online, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.addMachine(cx, c.target)))
            .child(this.leadIcon(c.os === "macOS" ? "monitor" : "server").text_color(t.muted))
            .child(div().flex_1().text_size(UI.text.body).text_color(c.online ? t.foreground : t.dim).child(c.target))
            .child(this.adding === c.target ? svg(`${ICON}/spinner.svg`).size(UI.icon.small).text_color(this.stateColor("working")).spin(900) : div().text_size(UI.text.caption).text_color(t.dim).child(c.online ? "Add" : "Offline")),
        ),
      )
      .child(this.input(t, this.target))
      .when(this.adding !== null, (el) => el.child(this.spinnerLabel(t, `Installing on ${this.adding}`)))
      .when(this.failed !== null, (el) => el.child(div().text_size(UI.text.caption).text_color(t.blocked).child(this.failed ?? "")));
  }

  renderRemove(t) {
    const p = props();
    return v_flex()
      .id("ah-remove")
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(UI.text.title).font_semibold().child(`Remove ${p.name}?`))
      .child(div().text_size(UI.text.body).text_color(t.muted).child("It stops backing up. Its sessions stay listed and you can still resume them."))
      .when(this.failed != null, (el) => el.child(div().text_size(UI.text.caption).text_color(t.blocked).child(this.failed ?? "")))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-remove-keep", "Keep it", true, () => closeOverlay(p.overlay)))
          .child(
            this.button(t, "ah-remove-go", this.removing ? "Removing…" : "Remove", false, (cx) => {
              if (this.removing) return;
              this.removing = true;
              cx.notify();
              cx.spawn(async (cx) => {
                try {
                  await anyhost(["machines", "--remove", p.name]);
                  setShared(CHANGED, Date.now());
                  closeOverlay(props().overlay);
                } catch (error) {
                  this.failed = messageOf(error);
                  this.removing = false;
                  cx.notify();
                }
              });
            }),
          ),
      );
  }

  initWorktree(cx) {
    this.branch = InputState.new({ placeholder: "Branch name" });
    this.branch.on("submit", () => this.createWorktree());
    cx.timer.after(120, () => this.branch.focus());
  }

  createWorktree() {
    const p = props();
    const branch = this.branch.value().trim();
    if (branch === "") return;
    closeOverlay(p.overlay);
    ask({ action: "newWorktree", project: p.project, branch, from: p.from });
  }

  renderWorktree(t) {
    const p = props();
    return v_flex()
      .id("ah-worktree")
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .child(div().text_size(UI.text.title).font_semibold().truncate().child(`New worktree in ${p.project.name}`))
      .child(div().text_size(UI.text.body).text_color(t.muted).child(`A checkout of its own beside the others, on a new branch${p.fromBranch ? ` from ${p.fromBranch}` : ""} or an existing one, with a workspace and a session of its own.`))
      .child(this.input(t, this.branch))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-worktree-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
          .child(this.button(t, "ah-worktree-go", "Create", true, () => this.createWorktree())),
      );
  }

  renderConfirm(t) {
    const p = props();
    return v_flex()
      .id("ah-confirm")
      .w_full()
      .p(UI.space.lg)
      .gap(UI.space.md)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(UI.text.title).font_semibold().truncate().child(p.title))
      .child(div().text_size(UI.text.body).text_color(t.muted).child(p.body))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-confirm-keep", "Keep it", true, () => closeOverlay(p.overlay)))
          .child(
            this.button(t, "ah-confirm-go", p.go, false, () => {
              closeOverlay(p.overlay);
              ask(p.ask);
            }),
          ),
      );
  }

  initPalette(cx) {
    this.cursorAt = 0;
    this.paletteScroll = ScrollHandle.new();
    this.palette = props();
    this.query = InputState.new({ placeholder: "Search sessions, projects and actions" });
    this.groups = this.paletteGroups();
    this.query.on("change", (_e, cx) => {
      this.cursorAt = 0;
      this.groups = this.paletteGroups();
      cx.notify();
    });
    this.query.on("submit", () => this.groups.flatMap(([, rows]) => rows)[this.cursorAt]?.run());
    cx.timer.after(120, () => this.query.focus());
  }

  paletteGroups() {
    const p = this.palette;
    const text = this.query.value().trim().toLowerCase();
    const has = (...names) => text === "" || names.some((name) => (name ?? "").toLowerCase().includes(text));
    const close = (then) => () => {
      closeOverlay(p.overlay);
      then();
    };
    const projects = shared(PULSE)?.projects ?? [];
    const current = projects.find((project) => project.key === p.current) ?? null;
    const actions = [
      { id: "new", icon: "square-pen", title: current ? `New session in ${current.name}` : "New session", run: close(() => ask({ action: "newHere" })) },
      { id: "tab", icon: "plus", title: "New tab", run: close(() => run("tab.new")) },
      { id: "space", icon: "folder-plus", title: "New space", run: close(() => run("space.new")) },
      { id: "board", icon: `${OWN}/kanban`, title: `Board · ${current ? current.name : "All projects"}`, run: close(() => ask({ action: "board", project: p.current })) },
    ].filter((a) => has(a.title));
    const shownProjects = projects
      .filter((project) => has(project.name))
      .sort((a, b) => b.newest - a.newest)
      .map((project) => ({
        id: `p-${project.key}`,
        project,
        title: project.name,
        run: close(() => {
          setFilter({ project: project.key });
          ask({ action: "showProject", key: project.key, machine: null });
        }),
      }));
    const sessions = p.sessions
      .filter((s) => (text === "" ? !s.archived && s.kind === "own" : has(s.title, s.projectName)))
      .slice(0, text === "" ? 12 : 40)
      .map((s) => ({ id: `s-${s.key}`, session: s, title: s.title, run: close(() => ask({ action: "open", key: s.key })) }));
    return [
      ["Actions", actions],
      ["Projects", shownProjects],
      [text === "" ? "Recent sessions" : "Sessions", sessions],
    ].filter(([, rows]) => rows.length > 0);
  }

  sessionItem(t, id, s) {
    return this.item(id)
      .child(this.harnessIcon(t, s))
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).text_color(s.archived ? t.muted : t.foreground).child(s.title))
      .child(div().flex_none().max_w(160).truncate().text_size(UI.text.caption).text_color(t.dim).child(s.archived ? `${s.projectName} · Archived` : s.projectName))
      .child(this.status(t, s));
  }

  sessionsShown(rows) {
    return rows
      .filter((r) => !r.deleted && !r.isChild)
      .sort(byRecent)
      .map((r) => ({ key: r.key, title: r.title, harness: r.harness, state: r.state, label: r.label, at: r.at, since: r.since, isOffline: r.isOffline, seenAt: r.seenAt, archived: r.archived, section: r.section, snoozedUntil: r.snoozedUntil, settledAt: r.settledAt, kind: r.kind, projectKey: r.projectKey, projectName: r.projectName }));
  }

  initTabs(cx) {
    this.pressed = null;
    this.hovered = null;
    this.tabScroll = ScrollHandle.new();
    this.width = 0;
    this.height = 0;
    this.pointerY = 0;
    this.barBounds = null;
    this.dropped = null;
    this.closing = new Map();
    this.revealedAt = shared(REVEAL)?.at ?? Date.now();
    this.tabsKey = "";
    this.placing = null;
    this.focusTarget = null;
    this.shownIndex = -1;
    this.tabsView = null;
    this.tabsSignature = "";
    this.refreshTabs(this.workNow());
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.workspaceCommand(command);
        cx.notify();
      }
    });
  }

  workspaceCommand(command) {
    const work = this.workNow();
    const [, verb, direction] = /^(go|move)-(left|right|up|down)$/.exec(command) ?? [];
    const [, mode] = /^view-(\w+)$/.exec(command) ?? [];
    if (verb === "go") return this.go(work, direction);
    if (verb === "move") return this.move(work, direction);
    if (command === "next" || command === "prev") return this.cycle(work, command === "next" ? 1 : -1);
    if (command === "zoom") return this.zoom(work);
    if (command === "promote") return this.promote(work);
    if (command === "mode") return this.setMode(work, CYCLED[(CYCLED.indexOf(work.mode) + 1) % CYCLED.length]);
    if (command === "grow" || command === "shrink") return this.resize(work, command === "grow" ? RATIO_STEP : -RATIO_STEP);
    if (command === "scroll-left" || command === "scroll-right") return this.scroll(work, command === "scroll-left" ? -1 : 1);
    if (mode && MODES.some(([id]) => id === mode)) this.setMode(work, mode);
  }

  workNow() {
    const { workspace, space } = workPlace();
    const ps = panes();
    const list = (space?.tabs ?? []).flatMap((tab) => ps.filter((p) => p.tab === tab.id && p.terminal).map((p) => ({ tab: tab.id, terminal: p.terminal })));
    const settingsId = space?.id ?? workspace?.id ?? ALL_WORK;
    const settings = workspaceOf(settingsId);
    const canTile = Boolean(find(layout(), "tiles")) && list.length > 0;
    const mode = space === null ? (settings.mode === "board" ? "board" : "start") : TILED.has(settings.mode) && !canTile ? "tabs" : settings.mode;
    const at = focused()?.terminal ?? null;
    return { workspace, space, id: space?.id ?? null, settingsId, list, terminals: list.map((c) => c.terminal), mode, settings, focused: list.some((c) => c.terminal === at) ? at : null };
  }

  tilesFor(work) {
    const frame = find(layout(), "main")?.content?.pane ?? {};
    const look = { background: frame.background, radius: frame.radius, border: frame.border, ...(frame.focus ? { focus: { border: frame.focus } } : {}) };
    return tilesOf(work.mode, work.terminals, work.settings, this.tilesWidth(), this.focusTarget ?? work.focused, look);
  }

  tilesWidth() {
    const panel = find(layout(), "panel");
    return this.width - (panel && !panel.hidden ? (panel.size?.px ?? 0) + UI.space.sm : 0);
  }

  syncTabs(cx) {
    const work = this.workNow();
    const drag = shared(DRAG_TAB);
    if (drag?.from === "inbox" && !drag.overlay && work.mode === "tabs") this.openDrop(drag, false, cx);
    if (this.pressed?.isMoving && !shared(DRAG_TAB)) {
      this.pressed = null;
      cx.notify();
    }
    const dropped = this.dropped;
    if (dropped && (Date.now() > dropped.until || (work.space?.tabs ?? []).findIndex((x) => x.id === dropped.tab) === dropped.target)) {
      this.dropped = null;
      cx.notify();
    }
    const tree = layout();
    const width = this.tilesWidth();
    const key = `${work.mode}|${work.id}|${work.terminals.join(",")}|${JSON.stringify(work.settings)}|${scrollShown(width)}:${Math.floor(width / TILE_WIDTH)}|${find(tree, "views")?.active}|${tileTerminals(tree).join(",")}|${this.focusTarget ?? ""}|${shared(REVEAL)?.at ?? 0}|${spaces().reduce((sum, sp) => sum + sp.tabs.length, 0)}|${panes().length}|${isLayoutLoaded()}|${(shared(PULSE)?.pinned ?? []).map((p) => p.key).join(",")}|${(work.space?.tabs ?? []).map((tab) => tab.id).join(",")}`;
    if (key !== this.tabsKey) {
      this.tabsKey = key;
      this.tabsReconcile(cx);
    }
    if (this.refreshTabs(work)) cx.notify();
  }

  refreshTabs(work) {
    const root = layout();
    const tiles = tileTerminals(root);
    const tabIds = new Set(spaces().flatMap((sp) => sp.tabs.map((x) => x.id)));
    for (const [id, at] of this.closing) if (!tabIds.has(id) || Date.now() - at > CLOSE_SETTLES_MS * 3) this.closing.delete(id);
    const ps = panes();
    const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
    const focusedTab = work.list.find((c) => c.terminal === work.focused)?.tab ?? null;
    const visible = new Set(work.list.filter((c) => tiles.includes(c.terminal)).map((c) => c.tab));
    const known = shared(PULSE)?.sessions ?? {};
    const pills = (work.space?.tabs ?? []).map((tab) => {
      const inTab = ps.filter((p) => p.tab === tab.id);
      const sessions = [...new Set(inTab.map((p) => sessionAt.get(p.terminal)).filter(Boolean))];
      const ofSessions = Object.keys(STATE).find((state) => sessions.some((key) => known[key]?.state === state));
      return {
        tab,
        program: inTab.find((p) => p.program?.agent)?.program ?? inTab[0]?.program,
        sessions,
        isPinned: sessions.some((key) => known[key]?.pinned),
        state: ofSessions ?? (tab.status === "blocked" || tab.status === "working" || tab.status === "done" ? tab.status : null),
        isShown: work.mode === "tabs" ? tab.active : TILED.has(work.mode) ? tab.id === focusedTab : false,
        isVisible: TILED.has(work.mode) && visible.has(tab.id),
      };
    });
    const tabbed = new Set(pills.flatMap((pill) => pill.sessions));
    const isAll = filterOf().project === null;
    const pinnedAway = (shared(PULSE)?.pinned ?? []).filter((p) => !tabbed.has(p.key) && (isAll || p.space === work.id)).map((p) => ({ ...p, after: "", isPinned: true }));
    const away = new Set(pinnedAway.map((p) => p.key));
    const discarded = [...pinnedAway, ...(shared(DISCARDED)?.[work.id ?? ""] ?? []).map(([key, title, harness, after]) => ({ key, title, harness, after })).filter((session) => !away.has(session.key))];
    const active = stripOf(pills.filter((pill) => !this.closing.has(pill.tab.id)), discarded).findIndex((at) => at.pill?.isShown);
    if (active >= 0 && active !== this.shownIndex) this.tabScroll.scroll_to_item(active);
    this.shownIndex = active;
    const w = window();
    const sidebar = find(root, "sidebar");
    const panel = find(root, "panel");
    const panelBody = find(root, "panel-body")?.active;
    this.tabsView = {
      isLoaded: isLayoutLoaded(),
      work,
      pills,
      discarded,
      lights: w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights ? Math.max(UI.space.sm, root.traffic_lights[0] + 64 - (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0))) : UI.space.sm,
      hasViews: Boolean(find(root, "views")),
      hasButtons: Boolean(w?.buttons),
      project: work.workspace?.name ?? (work.workspace?.key ? (shared(PULSE)?.known.find((p) => p.key === work.workspace.key)?.name ?? projectNameOf(work.workspace.key)) : null),
      panels: { files: Boolean(panel) && !panel.hidden && panelBody === "files", changes: Boolean(panel) && !panel.hidden && panelBody === "changes" },
    };
    const signature = JSON.stringify([this.tabsView.isLoaded, pills.map((pill) => [pill.tab.id, pill.tab.name, pill.tab.index, pill.program?.icon ?? null, pill.program?.tint ?? null, pill.sessions, pill.state, pill.isPinned, pill.isShown, pill.isVisible]), discarded, work.mode, work.id, work.settings, work.focused, work.terminals, this.tabsView.lights, this.tabsView.hasViews, this.tabsView.hasButtons, this.tabsView.project, this.tabsView.panels]);
    if (signature === this.tabsSignature) return false;
    this.tabsSignature = signature;
    return true;
  }

  tabsReconcile(cx) {
    if (!find(layout(), "views") || !isLayoutLoaded()) return;
    const work = this.workNow();
    const reveal = shared(REVEAL);
    if (reveal && reveal.at > this.revealedAt) {
      this.revealedAt = reveal.at;
      if (TILED.has(work.mode)) this.focusTarget = reveal.terminal;
    }
    if (this.focusTarget !== null && !work.terminals.includes(this.focusTarget)) this.focusTarget = null;
    if (this.focusTarget !== null && TILED.has(work.mode) && !tileTerminals().includes(this.focusTarget) && this.bringIntoView(work, this.focusTarget)) return;
    const node = work.mode === "tabs" ? VIEW_NODE.tabs : work.mode === "board" || work.mode === "start" ? VIEW_NODE.board : VIEW_NODE.tiles;
    const shown = () => {
      if (find(layout(), "views")?.active !== node) run("layout.select", { stack: "views", child: node });
      if (this.focusTarget !== null && (!TILED.has(work.mode) || tileTerminals().includes(this.focusTarget))) {
        run("pane.focus", { terminal: this.focusTarget });
        this.focusTarget = null;
      }
    };
    if (TILED.has(work.mode)) this.placeTiles(cx, this.tilesFor(work), shown);
    else shown();
    for (const tab of spaces().flatMap((sp) => sp.tabs)) {
      const inTab = panes().filter((p) => p.tab === tab.id);
      if (inTab.length > 0 && inTab.every((p) => p.mod === "anyhost")) run("tab.close", { id: tab.id, confirmed: true });
    }
    this.pinTabsFirst(work);
    cx.notify();
  }

  pinTabsFirst(work) {
    const pinned = (shared(PULSE)?.pinned ?? []).map((p) => p.key);
    const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
    const ps = panes();
    const rankOf = (tab) => Math.min(...ps.filter((p) => p.tab === tab.id).map((p) => pinned.indexOf(sessionAt.get(p.terminal))).filter((at) => at >= 0));
    const first = (work.space?.tabs ?? []).filter((tab) => Number.isFinite(rankOf(tab))).sort((a, b) => rankOf(a) - rankOf(b));
    const at = first.findIndex((tab, slot) => tab.index !== slot + 1);
    if (at >= 0) run("tab.move", { id: first[at].id, index: at + 1 });
  }

  bringIntoView(work, terminal) {
    const change = this.viewChangeFor(work, terminal);
    if (change === null) return false;
    changeWorkspace(work.id, change);
    return true;
  }

  viewChangeFor(work, terminal) {
    if (work.settings.zoomed) return work.settings.zoomed === terminal ? null : { zoomed: terminal };
    if (work.mode !== "scroll") return null;
    const at = work.terminals.indexOf(terminal);
    const shown = scrollShown(this.tilesWidth());
    const offset = offsetIn(work.settings.offset, work.terminals.length, shown);
    const next = at < offset ? at : at >= offset + shown ? at - shown + 1 : offset;
    return next === work.settings.offset ? null : { offset: next };
  }

  placeTiles(cx, node, then) {
    const wanted = JSON.stringify(node);
    if (this.placing === wanted) return;
    this.placing = wanted;
    const path = `${appHome()}/layouts/${shared("layout")}.json`;
    cx.spawn(async () => {
      try {
        const text = await readTextFile(path);
        const root = text === null ? null : JSON.parse(text);
        const placed = find(root, "tiles");
        if (placed && JSON.stringify(placed) !== wanted) await writeTextFile(path, `${JSON.stringify(replaced(root, "tiles", node), null, 2)}\n`, text);
      } finally {
        this.placing = null;
      }
      then();
    });
  }

  want(work, terminal) {
    if (!terminal) return;
    if (!TILED.has(work.mode)) return run("pane.focus", { terminal });
    this.focusTarget = terminal;
    if (tileTerminals().includes(terminal)) {
      run("pane.focus", { terminal });
      this.focusTarget = null;
    }
  }

  go(work, direction) {
    if (!TILED.has(work.mode)) return run("pane.go", { direction });
    if (work.focused === null) return this.want(work, work.terminals[0]);
    const isBack = direction === "left" || direction === "up";
    if (work.mode === "stack" || work.settings.zoomed) return this.cycle(work, isBack ? -1 : 1);
    const next = neighbourOf(rectsOf(find(layout(), "tiles")), work.focused, direction);
    if (next) return this.want(work, next);
    if (work.mode === "scroll" && (direction === "left" || direction === "right")) this.cycle(work, isBack ? -1 : 1);
  }

  cycle(work, step) {
    if (work.mode === "tabs") return run(step > 0 ? "tab.next" : "tab.prev");
    if (work.terminals.length === 0) return;
    const at = work.terminals.indexOf(work.focused);
    this.want(work, work.terminals[(Math.max(0, at) + (at < 0 ? 0 : step) + work.terminals.length) % work.terminals.length]);
  }

  move(work, direction) {
    if (work.mode === "tabs") return run("pane.swap", { direction });
    const tabs = work.space?.tabs ?? [];
    const at = tabs.findIndex((x) => x.id === work.list.find((c) => c.terminal === work.focused)?.tab);
    const to = tabs[at + (direction === "left" || direction === "up" ? -1 : 1)];
    if (at < 0 || !to) return;
    run("tab.move", { id: tabs[at].id, index: to.index });
    this.focusTarget = work.focused;
  }

  promote(work) {
    const tabs = work.space?.tabs ?? [];
    const tab = work.mode === "tabs" ? tabs.find((x) => x.active)?.id : work.list.find((c) => c.terminal === work.focused)?.tab;
    if (!tab) return;
    const isMaster = tabs[0]?.id === tab;
    if (isMaster && tabs.length < 2) return;
    run("tab.move", { id: isMaster ? tabs[1].id : tab, index: 1 });
    if (TILED.has(work.mode)) this.focusTarget = work.focused;
  }

  zoom(work) {
    if (!TILED.has(work.mode)) return run("pane.zoom");
    if (work.focused === null && !work.settings.zoomed) return;
    changeWorkspace(work.id, { zoomed: work.settings.zoomed ? null : work.focused });
    this.focusTarget = work.settings.zoomed ?? work.focused;
  }

  resize(work, step) {
    if (work.mode !== "master") return;
    changeWorkspace(work.id, { ratio: Math.round(Math.max(RATIO_LEAST, Math.min(RATIO_MOST, work.settings.ratio + step)) * 100) / 100 });
  }

  scroll(work, step) {
    if (work.mode !== "scroll") return;
    const shown = scrollShown(this.tilesWidth());
    const offset = offsetIn(offsetIn(work.settings.offset, work.terminals.length, shown) + step, work.terminals.length, shown);
    changeWorkspace(work.id, { offset });
    const at = work.terminals.indexOf(work.focused);
    if (at >= 0 && (at < offset || at >= offset + shown)) this.focusTarget = work.terminals[at < offset ? offset : offset + shown - 1];
  }

  setMode(work, mode) {
    changeWorkspace(work.settingsId, { mode, zoomed: null });
    if (mode !== "board") this.focusTarget = work.focused;
  }

  renderTabs(t) {
    const { isLoaded, work, lights, hasViews, hasButtons, project, panels } = this.tabsView;
    const pills = this.tabsView.pills.filter((pill) => !this.closing.has(pill.tab.id));
    const shownTabs = pills.map((pill) => pill.tab);
    const strip = this.stripLayout(isLoaded ? pills : [], isLoaded ? this.tabsView.discarded : []);
    return h_flex()
      .id("ah-tabs")
      .size_full()
      .min_w(0)
      .pl(lights)
      .pr(UI.space.sm)
      .gap(UI.space.xs)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .on_size_change((size, cx) => {
        this.height = size.height;
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width;
        setShared(TABS_WIDTH, Math.round(size.width));
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        this.pointerY = e.local_position.y;
        this.barBounds = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y, width: e.bounds.width, height: e.bounds.height };
        const p = this.pressed;
        if (isPastSlop(p, e)) this.startDrag(p, pills, work, cx);
      })
      .on_hover((on, cx) => {
        if (!on && this.pressed?.isMoving && this.pointerY > this.height / 2) this.liftOut(work, pills, cx);
      })
      .on_mouse_up("left", (_e, cx) => this.releaseTab(strip, pills, cx))
      .child(
        h_flex()
          .id("ah-tab-list")
          .flex_1()
          .min_w(0)
          .h_full()
          .gap(UI.space.xs)
          .items_center()
          .overflow_x_scroll()
          .track_scroll(this.tabScroll)
          .when(isLoaded && strip.slots.length === 0, (el) => el.child(div().px(UI.space.sm).text_size(UI.text.caption).text_color(t.dim).child(project ? `No open sessions in ${project}` : "No open sessions")))
          .children(strip.slots.map((slot) => (slot.pill ? this.tabPill(t, slot, work, pills, shownTabs) : this.sessionPill(t, slot)))),
      )
      .child(
        h_flex()
          .id("ah-tab-tools")
          .flex_none()
          .gap(UI.space.xs)
          .items_center()
          .when(isLoaded, (el) =>
            el.child(this.iconButton(t, "ah-tab-new", "plus", project && work.workspace?.key !== NONE ? `New session in ${project}` : "New session", () => ask({ action: "newHere" }))).children(
              [
                ["files", "Files", "mods/files/file"],
                ["changes", "Changes", "mods/changes/changes"],
              ].map(([id, label, icon]) => this.panelButton(t, id, label, icon, panels[id])),
            ),
          )
          .when(isLoaded && hasViews, (el) => el.child(h_flex().id("ah-modes").flex_none().gap(1).items_center().children(MODES.map(([mode, label, icon]) => this.modeButton(t, mode, label, icon, work)))))
          .when(hasButtons, (el) => el.child(this.iconButton(t, "ah-window-min", "minus", "Minimize", () => run("window.minimize"))).child(this.iconButton(t, "ah-window-max", "square", "Maximize", () => run("window.maximize"))).child(this.iconButton(t, "ah-window-close", "x", "Close", () => run("window.close")))),
      );
  }

  stripLayout(pills, discarded) {
    const p = this.pressed?.isMoving ? this.pressed : null;
    const from = p ? pills.findIndex((pill) => pill.tab.id === p.tab) : -1;
    if (from < 0) return { slots: stripOf(this.droppedOrder(pills), discarded), target: null };
    const target = p.target ?? from;
    return { slots: stripOf(movedTo(pills, from, target), discarded), target };
  }

  droppedOrder(pills) {
    const d = this.dropped;
    return d === null ? pills : movedTo(pills, pills.findIndex((pill) => pill.tab.id === d.tab), d.target);
  }

  startDrag(p, pills, work, cx) {
    const pill = pills.find((x) => x.tab.id === p.tab);
    if (!pill) return;
    setShared(DRAG_TAB, { tab: p.tab, title: pill.tab.name, space: work.space?.id ?? null, terminals: panes().filter((x) => x.tab === p.tab && x.terminal).map((x) => x.terminal), overlay: null, lifted: false });
    this.pressed = { ...p, isMoving: true };
    cx.notify();
  }

  dragOver(tab, pills, cx) {
    const p = this.pressed;
    if (!p?.isMoving || p.tab === tab.id) return;
    const target = pills.findIndex((pill) => pill.tab.id === tab.id);
    if (target < 0 || target === p.target) return;
    this.pressed = { ...p, target };
    cx.notify();
  }

  liftOut(work, pills, cx) {
    const drag = shared(DRAG_TAB);
    if (!drag || drag.overlay || this.barBounds === null || (work.mode !== "tabs" && work.mode !== "start")) return;
    const at = pills.findIndex((x) => x.tab.id === drag.tab);
    const neighbour = pills[at + 1] ?? pills[at - 1];
    if (at < 0 || !neighbour) return;
    const lifted = pills[at].tab.active;
    if (lifted) run("tab.select", { id: neighbour.tab.id });
    this.openDrop(drag, lifted, cx);
  }

  openDrop(drag, lifted, cx) {
    const b = this.barBounds;
    if (b === null) return;
    const zoom = this.height / (find(layout(), "tabs")?.size?.px || this.height);
    const overlay = openOverlay({ kind: "window", frame: "none", width: b.width / (b.x + b.width), height: 1, at: { x: Math.round(b.x / zoom), y: 0 }, mod: "anyhost", props: { view: "drop" } });
    setShared(DRAG_TAB, { ...drag, overlay, lifted });
    cx.notify();
  }

  releaseTab(strip, pills, cx) {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed?.isMoving) return;
    endTabDrag(true);
    const from = pills.findIndex((pill) => pill.tab.id === pressed.tab);
    if (strip.target !== null && from >= 0 && strip.target !== from && pills[strip.target]) {
      run("tab.move", { id: pressed.tab, index: pills[strip.target].tab.index });
      this.dropped = { tab: pressed.tab, target: strip.target, until: Date.now() + DROP_SETTLES_MS };
    }
    cx.notify();
  }

  closeNow(pill, shownTabs, cx) {
    const { tab } = pill;
    if (pill.isPinned) return;
    if (isRunning(pill.state) || pill.state === "blocked") return ask({ action: "closeTabs", tabs: [tab.id] });
    const at = shownTabs.findIndex((x) => x.id === tab.id);
    const next = shownTabs[at + 1] ?? shownTabs[at - 1];
    this.closing.set(tab.id, Date.now());
    if (tab.active && next) run("tab.select", { id: next.id });
    ask({ action: "closeTabs", tabs: [tab.id] });
    cx.notify();
  }

  panelButton(t, id, label, icon, isOpen) {
    return div()
      .id(`ah-panel-${id}`)
      .size(UI.height.control)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(UI.radius.control)
      .cursor_pointer()
      .tooltip(label)
      .when(isOpen, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!isOpen, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        if (isOpen) return run("layout.hide", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: id });
        run("layout.show", { id: "panel" });
      })
      .child(svg(iconPath(icon)).size(UI.icon.body));
  }

  modeButton(t, mode, label, icon, work) {
    const isChosen = (work.mode === "start" ? "tabs" : work.mode) === mode;
    const side = work.settings.side;
    const nextSide = SIDES[(SIDES.indexOf(side) + 1) % SIDES.length];
    const tooltip = mode === "master" && isChosen ? `Master on the ${side} at ${Math.round(work.settings.ratio * 100)}% · click for the ${nextSide}` : label;
    return div()
      .id(`ah-mode-${mode}`)
      .size(UI.height.control)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(UI.radius.control)
      .cursor_pointer()
      .tooltip(tooltip)
      .when(isChosen, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!isChosen, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (mode === "master" && isChosen) changeWorkspace(work.id, { side: nextSide });
        else this.setMode(work, mode);
        cx.notify();
      })
      .child(svg(iconPath(icon)).size(UI.icon.body));
  }

  tabSized(el) {
    return el.flex_1().min_w(TAB_LEAST).max_w(TAB_MOST).h(UI.height.control).overflow_hidden();
  }

  sessionPill(t, slot) {
    const session = slot.discarded;
    const id = `discarded-${session.key}`;
    const isHovered = this.hovered === id;
    return this.tabSized(h_flex().id(`ah-tab-${id}`))
      .px(UI.space.sm)
      .gap(UI.space.sm)
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.body)
      .text_color(session.isPinned ? t.muted : t.dim)
      .cursor_pointer()
      .tooltip(session.isPinned ? `${session.title} · pinned` : `${session.title} · asleep, click to continue`)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_hover((on, cx) => {
        if (on) this.hovered = id;
        else if (this.hovered === id) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => ask({ action: "open", key: session.key }))
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        ask({ action: "archive", key: session.key });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        ask({ action: "menu", key: session.key });
      })
      .child(this.harnessIcon(t, session))
      .child(div().flex_1().min_w(0).truncate().child(session.title))
      .child(this.tabEnd(t, id, session.isPinned, isHovered, "Archive", () => ask({ action: "archive", key: session.key })));
  }

  tabEnd(t, id, isPinned, isShown, label, onClose) {
    if (isPinned) return svg(iconPath("pin")).size(UI.icon.small).flex_none().text_color(t.dim);
    return div()
      .id(`ah-tab-close-${id}`)
      .size(UI.icon.lead)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(UI.radius.pill)
      .opacity(isShown ? 1 : 0)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClose(cx);
      })
      .child(svg(`${ICON}/x.svg`).size(UI.icon.small));
  }

  tabPill(t, slot, work, pills, shownTabs) {
    const { tab, program, sessions, state, isShown, isVisible } = slot.pill;
    const isHovered = this.hovered === tab.id;
    const isDragged = this.pressed !== null && this.pressed.tab === tab.id && this.pressed.isMoving;
    const i = shownTabs.findIndex((x) => x.id === tab.id);
    const lead =
      state === "working"
        ? svg(`${ICON}/spinner.svg`).size(UI.icon.body).flex_none().text_color(this.stateColor("working")).spin(900)
        : state !== null && state !== "idle"
          ? svg(iconPath(STATE[state].icon)).size(UI.icon.body).flex_none().text_color(this.stateColor(state))
          : !program?.icon
            ? null
            : program.tint
              ? svg(program.icon).size(UI.icon.body).flex_none().text_color(t.muted)
              : image(program.icon).size(UI.icon.body).flex_none();
    return this.tabSized(h_flex().id(`ah-tab-${tab.id}`))
      .px(UI.space.sm)
      .gap(UI.space.sm)
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.body)
      .cursor_pointer()
      .tooltip(tab.name)
      .text_color(isDragged || isShown || isVisible ? t.foreground : t.muted)
      .map((el) => this.surface(el, t, { isSelected: isShown, isDragged, hover: (s) => s.text_color(t.foreground) }))
      .on_hover((on, cx) => {
        if (on) this.hovered = tab.id;
        else if (this.hovered === tab.id) this.hovered = null;
        if (on) this.dragOver(tab, pills, cx);
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressed = { tab: tab.id, target: null, downX: e.position.x, downY: e.position.y, isMoving: false };
        if (e.click_count === 2) run("tab.rename", { id: tab.id });
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed?.isMoving) return;
        this.pressed = null;
        if (TILED.has(work.mode)) {
          this.want(work, work.list.find((c) => c.tab === tab.id)?.terminal);
          return cx.notify();
        }
        if (work.mode === "board") this.setMode(work, "tabs");
        run("tab.select", { id: tab.id });
      })
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        this.closeNow(slot.pill, shownTabs, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        const tabActions = { tab: tab.id, others: shownTabs.filter((x) => x.id !== tab.id).map((x) => x.id), right: shownTabs.slice(i + 1).map((x) => x.id) };
        if (sessions.length > 0) return ask({ action: "menu", key: sessions[0], tabActions });
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: work.space?.id } } });
      })
      .when(lead !== null, (el) => el.child(lead))
      .child(div().flex_1().min_w(0).truncate().child(tab.name))
      .child(this.tabEnd(t, tab.id, slot.pill.isPinned, (isShown || isHovered) && !isDragged, sessions.length > 0 ? "Close and archive · Reopen closed tab brings it back" : "Close the tab", (cx) => this.closeNow(slot.pill, shownTabs, cx)));
  }

  initDrop() {
    this.zone = null;
  }

  renderDrop(t) {
    const tree = layout();
    const sizeOf = (id) => find(tree, id)?.size?.px ?? 0;
    const panel = find(tree, "panel");
    return v_flex()
      .id("ah-drop")
      .size_full()
      .on_mouse_up("left", () => this.dropInto())
      .child(div().id("ah-drop-strip").w_full().h(sizeOf("tabs")).flex_none().on_hover((on) => on && this.backToStrip()))
      .child(
        div()
          .id("ah-drop-area")
          .flex_1()
          .min_h(0)
          .mr(panel && !panel.hidden ? sizeOf("panel") : 0)
          .mb(sizeOf("status"))
          .relative()
          .on_mouse_move((e, cx) => {
            const side = sideOf(e.local_position, e.bounds);
            if (side === this.zone) return;
            this.zone = side;
            cx.notify();
          })
          .when(this.zone !== null, (el) => el.child(this.dropZone(t, this.zone))),
      );
  }

  dropZone(t, side) {
    const isSide = side === "left" || side === "right";
    const zone = div()
      .id(`ah-drop-${side}`)
      .p(UI.space.xs)
      .when(isSide, (el) => el.w_1_2().h_full())
      .when(!isSide, (el) => el.w_full().h_1_2())
      .child(
        v_flex()
          .size_full()
          .relative()
          .items_center()
          .justify_center()
          .rounded(UI.radius.control)
          .border_1()
          .border_color(t.accent)
          .child(div().absolute().top(0).left(0).size_full().rounded(UI.radius.control).bg(t.accent).opacity(0.14))
          .child(this.chip(t, `Split ${side} · ${shortTitle(shared(DRAG_TAB)?.title ?? "", 40)}`, t.foreground, { icon: `mods/anyhost/icons/${SPLIT_ICON[side]}` })),
      );
    return (isSide ? h_flex() : v_flex())
      .absolute()
      .top(0)
      .left(0)
      .size_full()
      .when(side === "right" || side === "down", (el) => el.justify_end())
      .child(zone);
  }

  dropInto() {
    const side = this.zone;
    const drag = endTabDrag(side !== null);
    closeOverlay(props().overlay);
    if (drag && side !== null) splitInto(drag.terminals, side);
  }

  backToStrip() {
    const drag = shared(DRAG_TAB);
    if (drag?.lifted) run("tab.select", { id: drag.tab });
    if (drag) setShared(DRAG_TAB, { ...drag, overlay: null, lifted: false });
    closeOverlay(props().overlay);
  }

  renderPalette(t) {
    const p = this.palette;
    const groups = this.groups;
    const count = groups.reduce((sum, [, rows]) => sum + rows.length, 0);
    this.cursorAt = Math.min(this.cursorAt, Math.max(0, count - 1));
    let index = 0;
    const row = (choice) => {
      const at = index++;
      const s = choice.session;
      const item = s
        ? this.sessionItem(t, `ah-pal-${choice.id}`, s)
        : this.item(`ah-pal-${choice.id}`)
            .child(choice.project ? this.mark(t, choice.project.name, false, choice.project.key === NONE) : this.leadIcon(choice.icon).text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).text_color(t.foreground).child(choice.title))
            .when(Boolean(choice.project), (el) => el.child(this.slots(t, choice.project)));
      return item
        .cursor_pointer()
        .when(at === this.cursorAt, (el) => el.bg(t.selected))
        .on_hover((on, cx) => {
          if (on && this.cursorAt !== at) {
            this.cursorAt = at;
            cx.notify();
          }
        })
        .on_click(() => choice.run());
    };
    return v_flex()
      .id("ah-palette")
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.cursorAt = Math.min(count - 1, this.cursorAt + 1);
        if (e.key === "up") this.cursorAt = Math.max(0, this.cursorAt - 1);
        if (e.key === "down" || e.key === "up") this.paletteScroll.scroll_to_item(paletteChildOf(groups, this.cursorAt));
        if (e.key === "escape") closeOverlay(p.overlay);
        cx.notify();
      })
      .child(
        h_flex()
          .h(UI.height.row + UI.space.lg)
          .px(UI.space.lg)
          .gap(UI.space.sm)
          .flex_none()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(this.searchField(t, this.query)),
      )
      .child(
        v_flex()
          .id("ah-palette-list")
          .flex_1()
          .min_h(0)
          .p(UI.space.sm)
          .gap(1)
          .overflow_y_scrollbar()
          .track_scroll(this.paletteScroll)
          .when(count === 0, (el) => el.child(this.empty(t, "Nothing matches")))
          .children(groups.flatMap(([label, rows]) => [this.item(`ah-pal-head-${label}`).h(UI.height.control).text_size(UI.text.caption).font_medium().text_color(t.dim).child(label), ...rows.map(row)])),
      );
  }

}
