import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, appHome, closeOverlay, exec, focused, hc, home, keys, layout, machines, nextCommand, notify, openOverlay, panes, pickFolder, props, readTextFile, run, setAgentOrder, setShared, shared, spaces, terminals, theme, updates, window, writeTextFile } from "herdr";
import { createHash } from "crypto";

const REFRESH_MS = 30_000;
const FOLLOW_MS = 1000;
const FINISHED_KEPT_MS = 60_000;
const TICK_MS = 30_000;
const LONG_MS = 600_000;
const FRESH_MS = 48 * 3_600_000;
const FRESH_TICK_MS = 600_000;
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const SHELF_FIRST = 10;
const SHELF_MORE = 25;
const FOUND_MAX = 40;
const FOUND_ARCHIVED = "found-archived";
const ICON = "mods/workspace-chrome";
const OWN = "mods/anyhost/icons";
const ANYHOST = 'PATH="$HOME/.local/share/cmod/programs:$HOME/.local/bin:$PATH" exec anyhost "$@"';
const VIEW = 'export PATH="$HOME/.local/bin:$PATH"; hc label "$HC_TERMINAL_ID" "anyhost.view=$1"; exec hc attach "$2"';
const FILTER = "anyhost.filter";
const PULSE = "anyhost.pulse";
const PICKED_WORKTREE = "anyhost.pickedWorktree";
const TAB_NAMES = "anyhost.tabNames";
const SPACE_NAMES = "anyhost.spaceNames";
const CHANGED = "anyhost.changed";
const WORKSPACES = "anyhost.workspaces";
const WANTED = "anyhost.wanted";
const PRESENTED = "anyhost.presented";
const STICKY = "anyhost.sticky";
const WINDOWS = "anyhost.windows";
const STATUS_WORDS = "anyhost.statusWords";
const MODES = [
  ["tabs", "Tabs", `${OWN}/app-window`],
  ["scroll", "Scroll", `${OWN}/gallery-horizontal`],
  ["master", "Master", `${OWN}/layout-panel-left`],
  ["dwindle", "Dwindle", `${OWN}/layout-dashboard`],
  ["grid", "Grid", `${OWN}/layout-grid`],
  ["stack", "Stack", `${OWN}/square-stack`],
  ["board", "Board", `${OWN}/kanban`],
];
const PANELS = [
  ["files", "Files", "mods/files/file"],
  ["changes", "Changes", "mods/changes/changes"],
  ["cmod", "Views", `${OWN}/blocks`],
];
const TILED = new Set(["scroll", "master", "dwindle", "grid", "stack"]);
const CYCLED = MODES.map(([mode]) => mode).filter((mode) => mode !== "board");
const SIDES = ["left", "right", "top"];
const VIEW_NODE = { tabs: "main", board: "board", tiles: "tiles" };
const ON_BOARD = new Set(["board", "start", "opening"]);
const WORKSPACE = { mode: "tabs" };
const LAYOUT = { mode: "tabs", side: "left", ratio: 0.6, offset: 0, order: [] };
const RECENT_MS = 750;
const OPEN_GRACE_MS = 5000;
const RECENT_MOST = 50;
const ALL_WORK = "anyhost-all";
const START_MOST = 8;
const START_WIDTH = 560;
const LOADING_SLOW_S = 3;
const TOASTS = "anyhost.toasts";
const OPENED = "anyhost.opened";
const TOAST_MS = 5000;
const TOAST_ERROR_MS = 10_000;
const TOAST_TICK_MS = 100;
const TOAST_MOST = 4;
const TOAST_WIDTH = 360;
const OPEN_QUIET_MS = 30_000;
const TOAST_LOOK = {
  info: { icon: "mods/anyhost/icons/circle", colors: ["#787774", "#9b9b9b"] },
  success: { icon: "circle-check", colors: ["#059669", "#34d399"] },
  warning: { icon: "mods/anyhost/icons/circle-alert", colors: ["#d97706", "#fbbf24"] },
  error: { icon: "mods/anyhost/icons/circle-x", colors: ["#dc2626", "#f87171"] },
};
const SHAPES = [
  ["panel", "Side panel", `${OWN}/panel-right`],
  ["popup", "Popup", `${OWN}/picture-in-picture-2`],
  ["full", "Full screen", `${OWN}/maximize-2`],
  ["tab", "Tab", `${OWN}/app-window`],
];
const OPENING = "anyhost.opening";
const DRAG_TAB = "anyhost.dragTab";
const SPLIT = "anyhost.split";
const TAB_MOST = 220;
const TAB_LEAST = 96;
const DRAG_SLOP = 4;
const PAGE_ROWS = 10;
const OUTBOX = "anyhost.outbox";
const PREFERENCES = "anyhost.preferences";
const SPLIT_PLACE = { left: "right", right: "right", up: "down", down: "down" };
const SPLIT_ICON = { left: "panel-left", right: "panel-right", up: "panel-top", down: "panel-bottom" };
const POPUP_SHARE = 0.75;
const PLACE_TRIES = 5;
const RATIO_STEP = 0.05;
const RATIO_MOST = 0.8;
const RATIO_LEAST = 0.2;
const SCROLL_WIDTH = 560;
const TILE_WIDTH = 420;
const CLOSED_MOST = 20;
const RETIRED = ["anyhost.scope", "anyhost.projectSpace", "anyhost.moving", "anyhost.menu", "anyhost.views", "anyhost.projectMachine", "anyhost.ask", "anyhost.reveal", "anyhost.openingSpace", "anyhost.discarded", "anyhost.undo", "anyhost.undone"];
const SESSION_LABEL = "anyhost.session";
const VIEW_LABEL = "anyhost.view";
const NONE = "none";
const SLEEP_LABEL = "anyhost.sleep";
const ALL = "all";
const TEMPORARY = "temporary";
const NO_FILTER = { project: null, worktree: null, machine: null, tags: [], states: [], include: [] };
const STATE = {
  blocked: { name: "Needs you", icon: "mods/anyhost/icons/circle-alert", colors: ["#d97706", "#fbbf24"] },
  done: { name: "Done", icon: "circle-check", colors: ["#059669", "#34d399"] },
  working: { name: "Working", icon: "mods/anyhost/icons/circle-dashed", colors: ["#0284c7", "#38bdf8"] },
  tasks: { name: "Tasks running", icon: "mods/anyhost/icons/square-stack", colors: ["#7c3aed", "#a78bfa"] },
  idle: { name: "Idle", icon: "mods/anyhost/icons/circle", colors: ["#787774", "#9b9b9b"] },
};
const isRunning = (state) => state === "working" || state === "tasks";
const noteStatusWords = (all) => {
  const was = shared(STATUS_WORDS) ?? {};
  const now = Object.fromEntries(all.map((x) => [x.address, was[x.address]?.word === (x.status ?? null) ? was[x.address] : { word: x.status ?? null, at: x.address in was ? Date.now() : 0 }]));
  if (JSON.stringify(now) !== JSON.stringify(was)) setShared(STATUS_WORDS, now);
};
const wordChangedAt = (address) => shared(STATUS_WORDS)?.[address]?.at ?? 0;
const liveStateOf = (known, terminal) => {
  const word = terminal && !terminal.address.includes("/") && wordChangedAt(terminal.address) > (known.since ?? 0) ? terminal.status : null;
  if (word === "working") return "working";
  if (word === "blocked" || word === "error") return "blocked";
  return word && (known.state === "working" || known.state === "blocked") ? (known.background ? "tasks" : "done") : known.state;
};
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
const RESORTED = ["archived", "deleted", "pinned", "settled", "snoozedUntil", "move"];
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
const INSTANT = { duration: 0 };
const MOTION_MOST = 40;
const FILTER_BODY_MOST = 460;
const CARD_HEIGHT = UI.space.xs * 2 + UI.height.inline * 3;
const SUBAGENT_HEIGHT = UI.space.xs * 2 + UI.height.inline * 2;
const URGENCY = { blocked: 0, done: 1, idle: 2, working: 3, tasks: 3 };
const byUrgency = (a, b) => URGENCY[a.state] - URGENCY[b.state] || (a.state === "blocked" ? a.since - b.since : b.since - a.since);
const recedes = (r, isShown) => !isShown && (r.archived || r.deleted || r.isOffline || r.isAsleep || r.section === "settled" || r.section === "snoozed");
const PICKER_HEIGHT = UI.height.row * 10 + UI.space.lg;
const MENU_WIDTH = 220;
const MENU_SEPARATOR = UI.space.xs * 2 + 1;
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

const COMMAND_MS = 60_000;
const anyhost = async (args, timeout = COMMAND_MS, on = null) => {
  const r = await exec("sh", ["-c", ANYHOST, "anyhost", ...args], { timeout, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `anyhost ${args[0]} exited with ${r.code}`);
  return r.stdout;
};
const anyhostArgv = (...args) => ["sh", "-c", ANYHOST, "anyhost", ...args];
const messageOf = (error) => String(error?.message ?? error);
const nextTask = (cx) => new Promise((resolve) => cx.timer.after(0, () => resolve()));
const isOlderVersion = (version, than) => {
  const [run, changes] = String(version ?? "").split(".");
  const [thanRun, thanChanges] = String(than ?? "").split(".");
  return run === thanRun && Number(changes) < Number(thanChanges);
};

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
const hasWorktrees = (key) => key !== NONE && key !== TEMPORARY;
const spaceOf = (key, checkout) => (key === TEMPORARY ? "anyhost-temporary" : key === NONE ? "anyhost-none" : `anyhost-w-${hex12(checkout)}`);
const isWorkspace = (space) => space === "anyhost-temporary" || space === "anyhost-none" || space.startsWith("anyhost-w-");
const placedSpace = (on, id) => (on ? `${on}/${id}` : id);
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
const MENU_SUB_MOST = 10;
const menuPanelOf = (body) => body + UI.space.xs * 2 + 2 + UI.space.lg;
const subBodyOf = (sub) => Math.min(sub.length * UI.height.row + sub.filter((item) => item.separatorBefore).length * MENU_SEPARATOR, MENU_SUB_MOST * UI.height.row);
const menuSizeOf = (groups) => {
  const shown = groups.filter((group) => group.length > 0);
  const main = menuPanelOf(shown.flat().length * UI.height.row + (shown.length - 1) * MENU_SEPARATOR);
  return Math.max(main, ...shown.flat().filter((item) => item.sub).map((item) => menuPanelOf(subBodyOf(item.sub))));
};
const subTopOf = (groups, item) => Math.max(0, Math.min(menuOffsetOf(groups, item), menuSizeOf(groups) - menuPanelOf(subBodyOf(item.sub))));
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
const pickedWorktrees = () => preference("pickedWorktree", {});
const setFilter = (change) => {
  const before = filterOf();
  setShared(FILTER, { ...before, ...("project" in change && change.project !== before.project ? { worktree: null } : {}), ...change });
};
const movedTo = (list, from, to) => {
  if (from < 0 || to < 0 || from === to || from >= list.length) return list;
  const rest = list.filter((_, at) => at !== from);
  return [...rest.slice(0, to), list[from], ...rest.slice(to)];
};
const rovedTo = ({ keystroke }, at, count, { loop = false, letters = false } = {}) => {
  if (count === 0) return null;
  if (keystroke === "home") return 0;
  if (keystroke === "end") return count - 1;
  const step = { down: 1, up: -1, pagedown: PAGE_ROWS, pageup: -PAGE_ROWS, "ctrl-n": 1, "ctrl-p": -1, ...(letters ? { j: 1, k: -1 } : {}) }[keystroke];
  if (step === undefined) return null;
  if (at < 0) return step > 0 ? 0 : count - 1;
  return loop ? (at + step + count) % count : Math.max(0, Math.min(count - 1, at + step));
};
const reorderStepOf = ({ key, modifiers }) => (modifiers.shift && !modifiers.alt && (modifiers.platform || modifiers.control) ? { up: -1, down: 1 }[key] : undefined);
const startsOf = (sizes, gap) => {
  let start = 0;
  return sizes.map((size) => {
    const at = start;
    start += size + gap;
    return at;
  });
};
const landingOf = (sizes, from, shift, gap) => {
  const centers = startsOf(sizes, gap).map((start, at) => start + sizes[at] / 2);
  const dragged = centers[from] + shift;
  return centers.reduce((closest, center, at) => (Math.abs(center - dragged) < Math.abs(centers[closest] - dragged) ? at : closest), from);
};
const offsetsOf = (ids, sizes, sorted, gap) => {
  const rest = startsOf(sizes, gap);
  const now = startsOf(sorted.map((id) => sizes[ids.indexOf(id)]), gap);
  return new Map(ids.map((id, at) => [id, now[sorted.indexOf(id)] - rest[at]]));
};

class Drag {
  constructor(id, at, { sortable = null, bounds = null, ...payload } = {}) {
    Object.assign(this, payload);
    this.id = id;
    this.down = at;
    this.at = at;
    this.sortable = sortable;
    this.bounds = bounds;
    this.isMoving = false;
    this.isOutside = false;
  }

  get from() {
    return this.sortable ? this.sortable.ids.indexOf(this.id) : -1;
  }

  get shift() {
    return this.sortable?.axis === "x" ? this.at.x - this.down.x : this.at.y - this.down.y;
  }

  get target() {
    if (!this.isMoving || this.isOutside || this.from < 0) return this.from;
    return landingOf(this.sortable.sizes, this.from, this.shift, this.sortable.gap);
  }

  moveTo(at) {
    this.at = at;
    this.isOutside = false;
    if (this.isMoving) return false;
    this.isMoving = Math.abs(at.x - this.down.x) >= DRAG_SLOP || Math.abs(at.y - this.down.y) >= DRAG_SLOP;
    return this.isMoving;
  }

  sorted() {
    return movedTo(this.sortable.ids, this.from, this.target);
  }

  offsets() {
    const { ids, sizes, gap } = this.sortable;
    return offsetsOf(ids, sizes, this.sorted(), gap);
  }
}
const outboxOf = () => shared(OUTBOX) ?? {};
const queued = () => Object.entries(outboxOf()).sort(([, a], [, b]) => a.at - b.at);
const unadopted = () => {
  const adopted = new Set(shared(PULSE)?.adopted ?? []);
  return queued().filter(([id]) => !adopted.has(id));
};
const enqueue = ({ changes = {}, ops = [], run = [], failed = "anyhost could not change it", toast = null, opens = null, hold = null, show = null }) => {
  const id = idOf();
  setShared(OUTBOX, { ...outboxOf(), [id]: { at: Date.now(), changes, ops, run, failed, toast, opens, ...(hold ? { hold } : {}), ...(show ? { show } : {}) } });
  return id;
};
const isHeld = (entry, now = Date.now()) => entry.hold !== undefined && entry.sent === undefined && (now - entry.at < TOAST_MS || (shared(TOASTS) ?? []).some((x) => x.hold === entry.hold));
const heldKeys = () => new Set(queued().filter(([, entry]) => isHeld(entry)).flatMap(([, entry]) => Object.keys(entry.changes)));
const heldArchiveOf = (key) => queued().find(([, entry]) => isHeld(entry) && entry.changes[key]?.archived === true)?.[1].hold ?? null;
const undoHeld = (hold) => {
  const outbox = outboxOf();
  const isDropped = (entry) => entry.hold === hold && entry.sent === undefined;
  const dropped = Object.values(outbox).filter(isDropped);
  setShared(TOASTS, (shared(TOASTS) ?? []).filter((x) => x.hold !== hold));
  if (dropped.length === 0) return false;
  setShared(OUTBOX, Object.fromEntries(Object.entries(outbox).filter(([, entry]) => !isDropped(entry))));
  const show = dropped.find((entry) => entry.show)?.show;
  if (show) {
    cancelWant();
    if (show.space && show.space !== spaces().find((sp) => sp.active)?.id) run("space.select", { id: show.space });
    run("tab.select", { id: show.tab });
  }
  return true;
};
const LOADED_AT = Date.now();
const deadlineOf = (entry) => entry.run.reduce((total, step) => total + (step.timeout ?? COMMAND_MS), 0);
const isInFlight = (entry, now) => entry.sent !== undefined && entry.sent >= LOADED_AT && now - entry.sent < deadlineOf(entry);
const preferencesOf = () => shared(PREFERENCES) ?? {};
const preference = (key, fallback) => preferencesOf()[key] ?? fallback;
const entriesOf = (key) => {
  const value = preference(key, {});
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
};
const withPreference = (preferences, change, value) => {
  const [key, entry] = change.slice("pref:".length).split("\0");
  if (entry === undefined) return value === null ? Object.fromEntries(Object.entries(preferences).filter(([each]) => each !== key)) : { ...preferences, [key]: value };
  const was = preferences[key];
  const entries = typeof was === "object" && was !== null && !Array.isArray(was) ? was : {};
  const next = value === null ? Object.fromEntries(Object.entries(entries).filter(([each]) => each !== entry)) : { ...entries, [entry]: value };
  return Object.keys(next).length === 0 ? withPreference(preferences, `pref:${key}`, null) : { ...preferences, [key]: next };
};
const sendPreference = (change, op, hold = null) => {
  const preferences = withPreference(preferencesOf(), change, op.value);
  if (JSON.stringify(preferences) === JSON.stringify(preferencesOf())) return;
  setShared(PREFERENCES, preferences);
  const outbox = outboxOf();
  const unsent = Object.keys(outbox).filter((id) => outbox[id].done === undefined && !outbox[id].sent && change in outbox[id].changes);
  if (unsent.length > 0) setShared(OUTBOX, Object.fromEntries(Object.entries(outbox).filter(([id]) => !unsent.includes(id))));
  enqueue({ changes: { [change]: { value: op.value } }, run: [{ args: ["organize", JSON.stringify([{ op: "prefer", ...op }])] }], hold });
};
const prefer = (key, value) => sendPreference(`pref:${key}`, { key, value });
const preferEntry = (key, entry, value, hold = null) => sendPreference(`pref:${key}\0${entry}`, { key, entry, value }, hold);
const closedKeys = () =>
  Object.entries(entriesOf("closed"))
    .sort(([, a], [, b]) => b - a)
    .map(([key]) => key);
const openingOf = () => shared(OPENING) ?? {};
const isOpening = (key) => openingOf()[key] === true;
const markSessionOpening = (key, isNow) => {
  if (isOpening(key) === isNow) return;
  const { [key]: _was, ...rest } = openingOf();
  setShared(OPENING, isNow ? { ...rest, [key]: true } : rest);
};
const settleQueued = (id, done) => {
  const { [id]: entry, ...rest } = outboxOf();
  if (entry) setShared(OUTBOX, done === null ? rest : { ...rest, [id]: { ...entry, done } });
};
const worktreeIdOf = (w) => `${w.machine}\0${w.folder}`;
const worktreeOf = (id) => ({ machine: id.slice(0, id.indexOf("\0")), folder: id.slice(id.indexOf("\0") + 1) });
const placeIn = (order, key) => (key === NONE ? Infinity : order.indexOf(key));
const movedBefore = (order, items, before) => {
  const rest = order.filter((key) => !items.includes(key));
  const at = before === null ? -1 : rest.indexOf(before);
  const place = at < 0 ? rest.length : at;
  return [...rest.slice(0, place), ...items, ...rest.slice(place)];
};
const withMoves = (order, moves = []) => moves.reduce((each, { items, before }) => movedBefore(each, items, before), order);
const orderIn = (key, adopted) => withMoves(adopted, unadopted().flatMap(([, entry]) => (entry.changes[key]?.move ? [entry.changes[key].move] : [])));
const queueMove = (key, now, items, before, op) => {
  if (items.length === 0 || movedBefore(now, items, before).join("\0") === now.join("\0")) return false;
  enqueue({ changes: { [key]: { move: { items, before } } }, run: [{ args: ["organize", JSON.stringify([op])] }] });
  return true;
};
const neighbourAfter = (order, key) => order[order.indexOf(key) + 1] ?? null;
const pinsInOrder = () => orderIn("pins", (shared(PULSE)?.pinned ?? []).map((p) => p.key));
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
const splitInto = (addresses, side, target = focused()?.pane) => {
  if (addresses.includes(panes().find((p) => p.pane === target)?.terminal)) return;
  if (!target) return notify({ title: "Pick a pane to split first", body: "Drop the tab on a tab's terminal to place it beside that terminal.", level: "warning" });
  for (const terminal of addresses) run("terminal.park", { terminal });
  setShared(SPLIT, { terminals: addresses, side, target, stage: "parked" });
};
const LAYOUT_DOC = `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"doc.get","params":{"name":"herdr-app"}}' | PATH="$HOME/.local/bin:$PATH" hc connect`;
const readLayoutDoc = async () => {
  const read = await exec("sh", ["-c", LAYOUT_DOC], { timeout: 10_000 });
  if (read.code !== 0) throw new Error(read.stderr.trim() || `hc connect exited with ${read.code}`);
  return JSON.parse(read.stdout.split("\n").find((line) => line.trim() !== "") ?? "{}").result?.value ?? {};
};
const sessionTree = (node, sessionAt) => {
  if (!node) return null;
  if (node.type === "block") {
    const session = sessionAt.get(node.content?.terminal);
    return session ? { session } : null;
  }
  const children = (node.children ?? []).map((child) => sessionTree(child, sessionAt)).filter(Boolean);
  if (children.length < 2) return children[0] ?? null;
  return { split: node.type === "column" ? "down" : "right", children };
};
const leavesOf = (tree) => (tree.session ? [tree.session] : tree.children.flatMap(leavesOf));
const panesOfTab = (tab, sessionAt) => {
  const sessions = [...new Set(panes().filter((p) => p.tab === tab && p.terminal).map((p) => sessionAt.get(p.terminal)).filter(Boolean))];
  return sessions.length === 0 ? null : sessions.length === 1 ? { session: sessions[0] } : { split: "right", children: sessions.map((session) => ({ session })) };
};
const placementsOf = (tree) =>
  tree.session ? [] : tree.children.flatMap((child, i) => [...(i === 0 ? [] : [{ session: leavesOf(child)[0], anchor: leavesOf(tree.children[i - 1])[0], side: tree.split }]), ...placementsOf(child)]);
const stepSplit = () => {
  const split = shared(SPLIT);
  if (!split) return;
  const ps = panes();
  const target = ps.find((p) => p.pane === split.target);
  const live = new Set(terminals().map((x) => x.address));
  if (!target || !split.terminals.every((terminal) => live.has(terminal))) return setShared(SPLIT, null);
  const placed = split.terminals.map((terminal) => ps.find((p) => p.terminal === terminal));
  if (split.stage === "parked") {
    if (placed.some(Boolean)) return;
    run("pane.focus", { pane: split.target });
    for (const terminal of split.terminals) run("terminal.keep", { terminal, place: SPLIT_PLACE[split.side] });
    return setShared(SPLIT, { ...split, stage: "kept" });
  }
  if (!placed[0] || placed[0].tab !== target.tab) return;
  setShared(SPLIT, null);
  if (split.side === "left" || split.side === "up") run("pane.swap", { pane: placed[0].pane, target: split.target });
};
const firstWorktreeOf = (key, machine = null) => {
  const first = (shared(PULSE)?.projects.find((p) => p.key === key)?.worktrees ?? []).find((w) => w.id !== null && !w.isGone && (machine === null || w.machine === machine));
  return first ? { machine: first.machine, folder: first.folder } : null;
};
const isFiltered = (f) => f.project !== null || f.worktree !== null || f.machine !== null || f.tags.length > 0 || f.states.length > 0 || f.include.length > 0;
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
const workspaceOf = (id) => ({ ...WORKSPACE, ...preference("workspaces", {})[id ?? ""] });
const changeWorkspace = (id, change) => {
  if (id) preferEntry("workspaces", id, { ...workspaceOf(id), ...change });
};
const spaceOfTerminal = (address) => {
  const tab = panes().find((p) => p.terminal === address)?.tab;
  return spaces().find((sp) => sp.tabs.some((x) => x.id === tab))?.id ?? null;
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
const removed = (node, id) => (node?.children ? { ...node, children: node.children.filter((child) => child.id !== id).map((child) => removed(child, id)) } : node);
const placedIn = (root, id, node, parent) => {
  const placed = find(root, id);
  if (JSON.stringify(placed) === JSON.stringify(node)) return null;
  if (node === null) return removed(root, id);
  if (placed) return replaced(root, id, node);
  const into = parent === null ? null : find(root, parent);
  return into ? replaced(root, parent, { ...into, children: [...into.children, node] }) : null;
};
const windowsNow = () => shared(WINDOWS) ?? {};
const withWindow = (windows, id, fields) => {
  if (fields.gone) return Object.fromEntries(Object.entries(windows).filter(([each]) => each !== id));
  return { ...windows, [id]: { ...windows[id], ...fields } };
};
const changeWindow = (id, fields) => {
  const before = windowsNow();
  const next = withWindow(before, id, fields ?? { gone: true });
  if (JSON.stringify(next[id] ?? null) === JSON.stringify(before[id] ?? null)) return;
  setShared(WINDOWS, next);
  enqueue({ changes: { [`window:${id}`]: fields ?? { gone: true } }, run: [{ args: ["organize", JSON.stringify([{ op: "window", id, fields }])] }] });
};
const windowLayoutOf = (tab) => {
  const record = windowsNow()[tab ?? ""];
  return { ...LAYOUT, ...record?.layout, zoomed: record?.zoomed ?? null };
};
const changeWindowLayout = (tab, change) => {
  if (!tab) return;
  const { zoomed, ...layout } = change;
  const { zoomed: _zoomed, ...current } = windowLayoutOf(tab);
  changeWindow(tab, { ...(Object.keys(layout).length > 0 ? { layout: { ...current, ...layout } } : {}), ...("zoomed" in change ? { zoomed } : {}) });
};
const inOrder = (order, list) => [...order.filter((x) => list.includes(x)), ...list.filter((x) => !order.includes(x))];
const tabOfTerminal = (address) => panes().find((p) => p.terminal === address)?.tab ?? null;
const spaceOfTab = (tab) => spaces().find((sp) => sp.tabs.some((x) => x.id === tab))?.id ?? null;
const isInFilter = (space) => {
  const { project, worktree } = filterOf();
  if (project === null) return true;
  const w = (shared(PULSE)?.workspaces ?? []).find((each) => each.id === space);
  return Boolean(w) && w.key === project && (worktree === null || sameWorktree(w, worktree));
};
const sessionsOfTab = (tab) => {
  const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
  return [...new Set(panes().filter((p) => p.tab === tab && p.terminal).map((p) => sessionAt.get(p.terminal)).filter(Boolean))];
};
const windowFacts = (tab, pane = null) => {
  const space = spaces().find((sp) => sp.tabs.some((x) => x.id === tab)) ?? null;
  const tabs = space?.tabs ?? [];
  const at = tabs.findIndex((x) => x.id === tab);
  const inTab = panes().filter((p) => p.tab === tab);
  const shown = inTab.find((p) => p.pane === pane) ?? inTab.find((p) => p.focused) ?? inTab[0] ?? null;
  const all = terminals();
  const terminal = all.find((x) => x.address === shown?.terminal) ?? null;
  const parent = terminal?.parent ? (all.find((x) => x.address === terminal.parent) ?? null) : null;
  return {
    tab,
    space: space?.id ?? null,
    name: tabs[at]?.name ?? "",
    others: tabs.filter((x) => x.id !== tab).map((x) => x.id),
    right: tabs.slice(at + 1).map((x) => x.id),
    pane: shown?.pane ?? null,
    isPane: pane !== null,
    zoomed: Boolean(shown?.zoomed),
    terminal: shown?.terminal ?? null,
    cwd: shown?.cwd ?? "",
    toProgram: terminal?.labels?.["herdr.right-click"] === "program",
    parent: parent ? { address: parent.address, name: parent.name || parent.address } : null,
    session: terminal?.labels?.[SESSION_LABEL] || sessionsOfTab(tab)[0] || null,
  };
};
const MODIFIER_GLYPHS = [["ctrl", "⌃"], ["alt", "⌥"], ["shift", "⇧"], ["cmd", "⌘"]];
const KEY_GLYPHS = { enter: "↩", left: "←", right: "→", up: "↑", down: "↓", backspace: "⌫", tab: "⇥", escape: "⎋" };
const keyLabelOf = (combo) => {
  const [, held = "", key] = combo.match(/^((?:(?:ctrl|alt|shift|cmd)-)*)(.+)$/) ?? [];
  const named = KEY_GLYPHS[key] ?? key.toUpperCase();
  if (window()?.platform !== "macos") return [...held.split("-").filter(Boolean).map((m) => m[0].toUpperCase() + m.slice(1)), named].join("+");
  return `${MODIFIER_GLYPHS.filter(([m]) => held.split("-").includes(m)).map(([, glyph]) => glyph).join("")}${named}`;
};
const keyFor = (action) => {
  const here = keys().filter((k) => k.section === "global" || k.section === `layout:${shared("layout")}`);
  const bound = here.find((k) => k.action === action && (k.section !== "global" || !here.some((o) => o.keys === k.keys && o.section !== "global")));
  return bound ? keyLabelOf(bound.keys) : undefined;
};
const wantedOf = () => shared(WANTED) ?? null;
const want = (wanted) => setShared(WANTED, { id: idOf(), at: Date.now(), act: "focus", ...wanted });
const cancelWant = () => {
  if (wantedOf() !== null) setShared(WANTED, null);
};
const isPanedSession = (key) => terminals().some((x) => x.state === "live" && x.labels?.[SESSION_LABEL] === key && panes().some((p) => p.terminal === x.address));
const loadingOf = () => {
  const w = wantedOf();
  if (w === null || w.act !== "focus") return null;
  if (w.starting) return w;
  if (w.session) return isPanedSession(w.session) ? null : w;
  if (w.terminal) return panes().some((p) => p.terminal === w.terminal && spaceOfTab(p.tab) === w.space) ? null : w;
  return w.space && !spaces().some((sp) => sp.id === w.space) ? w : null;
};
const reachOf = (machine) => {
  const pulse = shared(PULSE);
  if (!pulse || machine === pulse.here) return "";
  return pulse.all.machines.find((m) => m.name === machine)?.on ?? null;
};
const targetOf = (r) => ({ key: r.key, title: r.title, tool: r.tool ?? r.session?.tool ?? r.harness ?? "claude", machine: r.machine, space: r.space, checkout: r.checkout ?? null, address: r.address ?? null, archived: Boolean(r.archived), deleted: Boolean(r.deleted), isRemote: Boolean(r.isRemote), isChild: Boolean(r.isChild) });
const liveTabs = () => new Set(spaces().flatMap((sp) => sp.tabs.map((x) => x.id)));
const awakeSessions = () => new Set(terminals().filter((x) => x.state === "live").map((x) => x.labels?.[SESSION_LABEL]).filter(Boolean));
const sleptSessionOf = (key) => {
  const facts = shared(PULSE)?.sessions?.[key];
  return facts && !facts.address && sleptWindows().some((w) => w.sessions.includes(key)) ? facts : null;
};
const sleptLayoutOf = (key) => {
  const live = liveTabs();
  const found = Object.entries(windowsNow()).find(([id, w]) => !live.has(id) && w.panes && leavesOf(w.panes).includes(key));
  return found ? { tab: found[0], tree: found[1].panes } : null;
};
const sleptWindows = () => {
  const facts = shared(PULSE)?.sessions ?? {};
  const live = liveTabs();
  const awake = awakeSessions();
  const records = Object.entries(windowsNow());
  return records.flatMap(([id, w]) => {
    if (live.has(id) || !w.panes || !w.space) return [];
    const asleep = leavesOf(w.panes).filter((key) => facts[key] && !awake.has(key));
    if (asleep.length === 0) return [];
    const r = facts[asleep[0]];
    const before = records.filter(([other, o]) => live.has(other) && o.space === w.space && o.panes && (o.index ?? 0) < (w.index ?? 0)).sort(([, a], [, b]) => b.index - a.index)[0];
    return [{ id, key: asleep[0], sessions: asleep, title: r.title, harness: r.tool, after: before ? leavesOf(before[1].panes)[0] : "", space: w.space }];
  });
};
const openStepOf = (s, on) =>
  s.tool === "claude"
    ? { args: ["open", s.key, "--json"], timeout: LONG_MS, on: on || null }
    : { hc: ["run", "--bg", "--keep", "--no-parent", "--json", ...(on ? ["--on", on] : []), ...(s.isChild ? [] : ["--label", `herdr.space=${s.space}`, "--label", `herdr.tab=${s.key.slice(0, 8)}`]), "--label", `${SESSION_LABEL}=${s.key}`, "--", ...anyhostArgv("resume", s.key, ...(on === "" && s.isRemote ? ["--take"] : []))] };
const startOpening = (s, on) => {
  if (isOpening(s.key)) return;
  markSessionOpening(s.key, true);
  enqueue({ changes: s.deleted ? { [s.key]: { deleted: false } } : {}, run: [openStepOf(s, on)], opens: s.key, failed: `anyhost could not open ${s.title.slice(0, 40)}` });
};
const openSession = (s, how = {}) => {
  const on = reachOf(s.machine);
  const space = on === null ? null : placedSpace(on, s.space);
  if (space !== null && workspaceOf(space).mode === "board") changeWorkspace(space, { mode: "tabs" });
  const slept = s.address || on !== "" ? null : sleptLayoutOf(s.key);
  const now = Date.now();
  setShared(OPENED, { ...Object.fromEntries(Object.entries(shared(OPENED) ?? {}).filter(([, at]) => now - at < OPEN_QUIET_MS)), [s.key]: now });
  if (!s.address) startOpening(s, on ?? "");
  for (const key of slept ? leavesOf(slept.tree) : []) {
    const other = key === s.key ? null : sleptSessionOf(key);
    if (other) startOpening(other, "");
  }
  want({ session: s.key, space, title: s.title, machine: s.machine, folder: s.checkout, ...(slept && how.act === undefined ? { layout: { from: slept.tab, steps: placementsOf(slept.tree) } } : {}), ...how });
};
const startSession = (machine, folder, on, failed, space = null, project = null) => {
  if (on !== null) want({ starting: true, space, title: "New session", machine, folder, project });
  enqueue({ run: [{ args: ["new", machine, folder, "--json"], timeout: LONG_MS, ...(on !== null ? { wants: wantedOf().id } : {}) }], failed });
};
const presentedOf = () => shared(PRESENTED) ?? null;
const presentedLayout = ({ key, title, row, address }, shape) => ({
  id: "present",
  type: "column",
  children: [
    { id: "present-bar", type: "block", size: { px: UI.height.row }, content: { mod: "anyhost", props: { view: "present", key, title, shape, row } } },
    { id: "present-terminal", type: "block", content: { terminal: address } },
  ],
});
const closePresented = () => {
  const presented = presentedOf();
  if (presented?.overlay) closeOverlay(presented.overlay);
  if (presented?.shape === "panel" && find(layout(), "panel-body")?.active === "present") run("layout.hide", { id: "panel" });
  setShared(PRESENTED, null);
};
const presentTerminal = (r, address, shape) => {
  const presented = presentedOf();
  if (presented && presented.shape !== shape) closePresented();
  const shown = { key: r.key, title: r.title, row: { ...targetOf(r), address }, address };
  if (shape === "panel") return setShared(PRESENTED, { ...shown, shape });
  const placed = shape === "full" ? { width: 1, height: 1, at: { x: 0, y: 0 } } : { width: POPUP_SHARE, height: POPUP_SHARE };
  setShared(PRESENTED, { ...shown, shape, overlay: openOverlay({ kind: "window", key: `anyhost-${shape}`, ...placed, layout: presentedLayout(shown, shape) }) });
};

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


const LIST_PART = "#list";
const HEAD_PART = "#head";
const LIFTED_PART = "#lifted";
const isSameValue = (a, b) => Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));
const isShallowSame = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => isSameValue(a[key], b[key]));
};

class Part extends View {
  init(props) {
    this.owner = props.owner;
    this.key = props.key;
  }

  render(cx) {
    return this.owner.renderPart(this.key, cx);
  }
}

export default class Anyhost extends View {
  init(_props, cx) {
    const given = props() ?? {};
    const view = given.view ?? (given.tab === "pane" ? "terminal-menu" : given.overlay && typeof given.title === "string" ? "toast" : "inbox");
    this.kind = view;
    if (view === "terminal-menu") return this.handOffTerminalMenu(given);
    if (view === "toast") return this.takeToast(given);
    if (view === "toasts") return this.initToasts(cx);
    this.isSyncing = false;
    this.isDrawing = false;
    this.partViews = new Map();
    this.wanted = new Set();
    this.mounted = new Set();
    this.pressed = null;
    this.dropped = null;
    this.dragKeys = cx.focus_handle();
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
    if (view === "remove" || view === "confirm" || view === "present" || view === "pane") return;
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
    if (view === "terminal-menu" || view === "toast") return div();
    if (view === "toasts") return this.renderToasts(t);
    if (view === "projects") return this.renderProjects(t).on_mouse_up("left", () => endTabDrag(false));
    if (view === "footer") return this.renderFooter(t).on_mouse_up("left", () => endTabDrag(false));
    if (view === "board") return this.renderBoard(t, cx);
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
    if (view === "pane") return this.renderPane(t);
    if (view === "worktree") return this.renderWorktree(t);
    return this.renderInbox(t, cx)
      .on_mouse_move((e, cx) => {
        const drag = this.pressed;
        if (!drag) return;
        if (this.isPressGone()) return this.cancelDrag(cx);
        if (drag.moveTo(e.position)) {
          this.dragKeys.focus();
          if (drag.address) setShared(DRAG_TAB, { tab: null, title: drag.title, space: null, terminals: [drag.address], overlay: null, lifted: false, from: "inbox" });
          return this.redrawDragStart(cx, drag.id);
        }
        if (drag.isMoving && drag.sortable) this.redrawDrag(cx);
      })
      .on_hover((on, cx) => {
        if (!on) this.leaveDrag(cx, Boolean(this.pressed?.address));
      })
      .on_mouse_up("left", (_e, cx) => {
        endTabDrag(false);
        this.dropCard(cx);
      });
  }

  dragCatcher() {
    return div()
      .id("ah-drag-keys")
      .absolute()
      .size(0)
      .track_focus(this.dragKeys)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.cancelDrag(cx);
      });
  }

  isPressGone() {
    const id = this.pressed?.id;
    if (id === undefined) return false;
    if (this.kind === "tabs") return this.closing.has(id) || !(this.tabsView?.slots ?? []).some((slot) => slot.id === id);
    if (this.kind !== "inbox" && this.kind !== "board") return false;
    const r = this.model?.byKey.get(id);
    return !r || r.archived || r.deleted;
  }

  cancelDrag(cx) {
    const drag = this.pressed;
    this.pressed = null;
    if (drag?.isMoving) this.dropped = drag.id;
    endTabDrag(false);
    this.redrawAll(cx);
  }

  wasDragged(id) {
    const was = this.pressed?.isMoving === true || this.dropped === id;
    this.dropped = null;
    return was;
  }

  leaveDrag(cx, isCarried) {
    const drag = this.pressed;
    if (!drag) return;
    if (!drag.isMoving) {
      this.pressed = null;
      return;
    }
    if (!isCarried) return this.cancelDrag(cx);
    drag.isOutside = true;
    this.redrawAll(cx);
  }

  pinSortable() {
    const ids = (this.frozen?.sections ?? this.shown?.sectionKeys)?.pinned ?? [];
    return { ids, sizes: ids.map((key) => this.placed?.get(key)?.height ?? CARD_HEIGHT), gap: 1, axis: "y" };
  }

  moveCursor(cx, key) {
    const was = this.cursor;
    this.cursor = key;
    const at = this.childAt?.get(key);
    if (at !== undefined) (this.kind === "projects" ? this.projectsScroll : this.listScroll).scroll_to_item(at);
    for (const each of [was, key]) {
      const view = this.partViews.get(each);
      if (view) cx.notify(view);
      else if (each === ALL || !this.listView) cx.notify();
      else cx.notify(this.listView);
    }
  }

  movePin(cx, r, step) {
    const keys = this.shown?.sectionKeys.pinned ?? [];
    const at = keys.indexOf(r.key);
    if (at < 0 || at + step < 0 || at + step >= keys.length) return;
    this.movePins(cx, [r.key], step < 0 ? keys[at + step] : (keys[at + step + 1] ?? null));
    this.redrawAll(cx);
  }

  dropCard(cx) {
    const drag = this.pressed;
    this.pressed = null;
    if (!drag?.isMoving) return;
    this.dropped = drag.id;
    if (drag.sortable && drag.target !== drag.from) this.movePins(cx, [drag.id], neighbourAfter(drag.sorted(), drag.id));
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
      this.redrawList(cx);
    }
    if (this.kind === "projects") return this.syncProjects(cx);
    if (this.kind === "footer") return this.syncFooter(cx);
    if (this.kind === "tabs") return this.syncTabs(cx);
    if (this.kind === "inbox" && this.listView === undefined) {
      this.listView = cx.new(Part, { owner: this, key: LIST_PART });
      this.headView = cx.new(Part, { owner: this, key: HEAD_PART });
      cx.notify();
    }
    if (this.building) {
      this.syncSoon(cx);
      if (this.building.next().done) this.building = null;
    }
    const live = this.liveInputs();
    const opening = JSON.stringify(openingOf());
    const inputs = this.inputsOf(live, this.modelInputsOf(live), opening);
    if (inputs === this.inputs) return;
    this.inputs = inputs;
    const isOpeningMoved = opening !== this.opening;
    this.opening = opening;
    if (this.pressed?.isMoving && this.pressed.address && !shared(DRAG_TAB)) {
      this.pressed = null;
      this.redrawAll(cx);
    }
    if (this.isPressGone()) this.cancelDrag(cx);
    this.adoptOutbox(cx);
    if (this.readPreferences()) {
      this.placeParts(cx);
      this.redrawAll(cx);
    }
    const isRebuilt = this.rebuild(live, this.modelInputsOf(live));
    const isPlaced = this.placeParts(cx);
    if (isRebuilt || isPlaced || isOpeningMoved) this.redrawChanged(cx, isPlaced);
    if (this.kind === "board") return this.boardReconcile(cx);
    cx.timer.after(0, (cx) => this.reconcileWhenDue(cx, live));
  }

  partsOf() {
    if (this.kind === "projects") return this.projectsView?.byId;
    if (this.kind === "tabs") return this.tabsView?.slotById;
    return (this.kind === "board" ? this.board : this.shown)?.model.byKey;
  }

  partKeys() {
    if (this.kind === "projects") return this.entries.map((entry) => entry.id);
    if (this.kind === "tabs") return this.tabsView.slots.map((slot) => slot.id);
    if (this.kind === "board") return this.board.cards.map((r) => r.key);
    const { sectionKeys, onScreen } = this.shown;
    const keys = [...sectionKeys.pinned, ...sectionKeys.active, ...sectionKeys.working, ...sectionKeys.snoozed, ...(this.found === null ? [] : this.foundShown().filter((r) => !r.shelf)).map((r) => r.key), ...Object.values(onScreen).flat().map((r) => r.key)];
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
    this.redrawList(cx);
    if (this.liftedView) cx.notify(this.liftedView);
    for (const view of this.partViews.values()) cx.notify(view);
    this.drawn = null;
  }

  redrawList(cx) {
    cx.notify();
    if (this.listView) cx.notify(this.listView);
    if (this.headView) cx.notify(this.headView);
  }

  redrawDrag(cx) {
    if (this.listView) cx.notify(this.listView);
    if (this.liftedView) cx.notify(this.liftedView);
    if (!this.listView && !this.liftedView) cx.notify();
  }

  redrawDragStart(cx, key) {
    cx.notify();
    this.redrawDrag(cx);
    const view = this.partViews.get(key);
    if (view) cx.notify(view);
  }

  redrawChanged(cx, isPlaced) {
    if (this.kind === "board" ? this.board === null || this.board.isStart || this.board.loading !== null : this.kind === "projects" ? this.projectsView === null || this.projectsView.isNarrow : this.kind === "inbox" && this.shown === null) return this.redrawAll(cx);
    const drawn = new Map();
    for (const [key, view] of this.partViews) {
      const now = this.drawnOf(key);
      const was = this.drawn?.get(key);
      drawn.set(key, now);
      if (now === null || was == null || !isShallowSame(was, now)) cx.notify(view);
    }
    this.drawn = drawn;
    const { root, list, head } = this.framesOf();
    if (isPlaced || root !== this.rootKey) {
      this.rootKey = root;
      cx.notify();
    }
    if (isPlaced || list !== this.listKey) {
      this.listKey = list;
      if (this.listView) cx.notify(this.listView);
    }
    if (head !== this.headKey) {
      this.headKey = head;
      if (this.headView) cx.notify(this.headView);
    }
  }

  drawnOf(key) {
    const part = this.partsOf()?.get(key);
    if (!part) return null;
    const isDragged = this.pressed?.isMoving === true && this.pressed.id === key;
    if (this.kind === "tabs") return { slot: JSON.stringify(part), isPicked: this.picked === key, isShownable: this.picked === null, isHovered: this.hovered === key || this.hovered === `discarded-${key}`, isDragged, isOpening: isOpening(key) };
    if (this.kind === "projects") {
      const { pulse, filter } = this.projectsView;
      const hoverId = part.worktree ? `worktree:${hex12(`${part.worktree.machine}\0${part.worktree.folder}`)}` : `project:${part.project.key}`;
      return { entry: JSON.stringify(part), filter: JSON.stringify(filter), places: part.worktree ? JSON.stringify([pulse.here, pulse.all.machines]) : "", isHovered: this.hovered === hoverId, isCursor: this.isCursorOn(key), isCarrying: Boolean(shared(DRAG_TAB)), isMoving: this.pressed?.isMoving === true };
    }
    if (this.kind === "board") return { ...part, extra: JSON.stringify([part.tags.map((id) => this.data.tags[id] ?? null), isOpening(part.key), isDragged, this.groupBy]) };
    return this.cardDrawnOf(this.shown, part);
  }

  framesOf() {
    if (this.kind === "board") {
      const board = this.board;
      return { root: JSON.stringify([board.name, board.cards.length, this.groupBy, board[this.groupBy].map((column) => [column.id, column.name, column.isStage, column.cards.map((r) => r.key)]), this.data.stages]), list: "", head: "" };
    }
    if (this.kind === "projects") {
      const { pulse, filter } = this.projectsView;
      return { root: JSON.stringify([pulse.all, filter.project === null, this.isCursorOn(ALL)]), list: JSON.stringify(this.entries.map((entry) => entry.id)), head: "" };
    }
    if (this.kind === "tabs") {
      const { isLoaded, isAll, labels, project, slots, lights, hasViews, hasButtons, openPanel, work } = this.tabsView;
      return { root: JSON.stringify([isLoaded, lights, hasViews, hasButtons, project, openPanel, work.mode, work.id, work.settings, work.workspace?.key ?? null]), list: JSON.stringify([isLoaded, isAll, labels, project, slots.map((slot) => [slot.id, slot.lane, slot.isPinned])]), head: "" };
    }
    const shown = this.shown;
    return {
      root: shown.isNarrow ? JSON.stringify(shown.railed.map((r) => [r.key, r.state, r.label, r.title, r.projectName, r.isUnread, r.address])) : "",
      list: this.listKeyOf(shown),
      head: JSON.stringify([shown.filterKey, shown.projectName, this.data?.tags]),
    };
  }

  cardDrawnOf(shown, r) {
    const { model, terminal } = shown;
    const subs = this.subsOf(r, model);
    const drawnSubs = ({ isOpen, rows }) => [isOpen, rows.map(({ id, row, subs, kid }) => (row ? [id, row.title, row.state, row.label, row.since, row.at, row.section, row.isAsleep, row.isOffline, row.isUnread, row.lastSaid, row.address === terminal || row.views.includes(terminal), drawnSubs(subs)] : [id, kid.title, kid.state]))];
    const tags = r.tags.map((id) => this.data.tags[id]?.name ?? "");
    const extra = JSON.stringify([
      Boolean(r.address) && (r.address === terminal || r.views.includes(terminal)),
      this.worktreeOf(r),
      r.session.source ? (model.byKey.get(r.session.source)?.title ?? "") : "",
      r.isChild ? (model.byKey.get(r.parent)?.title ?? "") : "",
      drawnSubs(subs),
      tags,
      this.data.stages.find((stage) => stage.id === r.stage)?.name ?? "",
      this.found !== null,
      isOpening(r.key),
      this.unfolded?.has(r.key) ?? false,
    ]);
    return { ...r, extra };
  }

  listKeyOf(shown) {
    const heights = Object.values(shown.sectionKeys)
      .flat()
      .filter((key) => this.unfolded?.has(key))
      .map((key) => {
        const r = shown.model.byKey.get(key);
        return r ? `${key}:${this.subsOf(r, shown.model).rows.length}` : key;
      });
    return JSON.stringify([shown.sectionKeys, shown.filterKey, (this.found === null ? [] : this.foundShown()).map((r) => r.key), heights, this.arrived]);
  }

  runActs(cx, after) {
    this.acts = [];
    this.wake = null;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.acts.length === 0) await new Promise((resolve) => (this.wake = resolve));
        for (const work of this.acts.splice(0)) work(cx);
        after(cx);
      }
    });
  }

  act(work) {
    this.acts.push(work);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  renderPart(key, cx) {
    const t = theme();
    if (key === LIST_PART) return this.kind === "tabs" ? this.renderTabList(t) : this.kind === "projects" ? this.renderProjectList(t) : this.renderList(t, cx);
    if (key === HEAD_PART) return this.renderHead(t);
    if (key === LIFTED_PART) return this.renderLifted(t);
    const part = this.partsOf()?.get(key);
    if (!part) return div();
    if (this.kind === "tabs") return this.slotElement(t, part);
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
    this.retryWait = 0;
    this.pending = new Map();
    this.snapshot = null;
    this.snapshotAt = 0;
    this.outboxSeen = "";
    this.adopted = [];
    this.pendingVersion = 0;
    this.signature = "";
    this.model = null;
    this.shown = null;
    this.building = null;
    this.received = null;
    this.isFollowing = false;
    this.changedAt = shared(CHANGED) ?? 0;
    this.listed = "";
    this.branches = new Map(saved("branches", []));
    this.branchesVersion = 0;
    this.branchesReading = false;
    const cached = saved("listed", null);
    if (cached?.listed) this.receive(cx, cached.listed, cached.askedAt ?? 0, cached.readAt ?? null);
    this.runActs(cx, (cx) => this.redrawCard(cx, null));
    cx.timer.every(TICK_MS, (cx) => this.redrawAll(cx));
    this.follow(cx, isPolled);
  }

  follow(cx, isPolled) {
    if (!isPolled()) return cx.timer.after(FOLLOW_MS, (cx) => this.follow(cx, isPolled));
    if (this.received !== null) return cx.timer.after(FRAME_MS, (cx) => this.follow(cx, isPolled));
    const askedAt = Date.now();
    const wait = this.isFollowing && this.version !== undefined ? ["--wait", String(this.version)] : [];
    cx.spawn(async (cx) => {
      try {
        const listed = await anyhost(["list", "--json", "--brief", ...wait]);
        this.isFollowing = true;
        this.retryWait = 0;
        this.receive(cx, listed, askedAt, Date.now());
      } catch (error) {
        this.isFollowing = false;
        this.retryWait = Math.min(this.retryWait * 2 || FOLLOW_MS, REFRESH_MS);
        console.error(`anyhost could not read the sessions, and reads again in ${this.retryWait / 1000} s: ${messageOf(error)}`);
      }
      cx.notify();
      cx.timer.after(this.isFollowing ? 0 : this.retryWait, (cx) => this.follow(cx, isPolled));
    });
  }

  refresh(cx) {
    const askedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const listed = await anyhost(["list", "--json", "--brief"]);
        this.receive(cx, listed, askedAt, Date.now());
      } catch (error) {
        console.error(`anyhost could not read the sessions: ${messageOf(error)}`);
      }
      cx.notify();
    });
  }

  receive(cx, listed, askedAt, readAt) {
    this.received = { listed, askedAt, readAt };
    cx.timer.after(0, (cx) => {
      const received = this.received;
      if (received === null) return;
      this.received = null;
      void this.take(cx, received.listed, received.askedAt, received.readAt);
      cx.notify();
    });
  }

  async take(cx, listed, askedAt, readAt = Date.now()) {
    const isNew = this.apply(listed, askedAt, readAt);
    if (isNew) this.building = this.cardSteps();
    this.adoptOutbox(cx);
    if (!isNew) return;
    await nextTask(cx);
    save("listed", { listed, readAt, askedAt });
  }

  apply(listed, askedAt, readAt) {
    const isSame = listed === this.listed && this.data !== null;
    const read = isSame ? null : JSON.parse(listed);
    if (read !== null && isOlderVersion(read.version, this.version)) return false;
    this.readAt = readAt;
    this.snapshotAt = Math.max(this.snapshotAt, askedAt);
    if (isSame) return false;
    const { here = "", machines: devices = [], agents: sessions, settleAfterDays = null, projectNames = {}, projectOrder = [], pinOrder = [], lastMachine, tags = {}, stages = [], worktreeOrder = {}, preferences = {}, windows = {}, version } = read;
    this.version = version;
    this.listed = listed;
    this.snapshot = { here, devices, sessions, settleAfterDays, projectNames, projectOrder, pinOrder, lastMachine, tags, stages, worktreeOrder, preferences, windows };
    this.data = this.snapshot;
    this.outboxSeen = "";
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
    noteStatusWords(all);
    const listed = agents();
    const isLooking = window()?.active === true;
    const at = focused();
    const tree = layout();
    const ps = panes();
    const allSpaces = spaces();
    const paned = new Set(ps.map((p) => p.terminal).filter(Boolean));
    const { shown } = this.workNow();
    const focusedTerminal = shown?.terminal ?? null;
    const layouts = machines().map((m) => m.layout).join(",");
    const placed = `${ps.map((p) => `${p.pane}:${p.tab}:${p.terminal ?? ""}`).join(",")}|${allSpaces.map((sp) => sp.id).join(",")}|${layouts}|${at?.space ?? ""}:${at?.pane ?? ""}`;
    return { all, listed, isLooking, view: shownView(tree), tiles: tileTerminals(tree), paned, isNarrow: narrow(tree), activeSpace: allSpaces.find((sp) => sp.active)?.id ?? null, shown: isLooking ? focusedTerminal : null, focusedTab: shown?.tab ?? null, focusedTerminal, placed, shape: `${at?.tab ?? ""}|${ps.length}|${allSpaces.length}|${layouts}` };
  }

  modelInputsOf(live) {
    if (this.data === null || this.building) return null;
    const filter = this.kind === "board" ? this.boardFilter() : filterOf();
    const work = this.kind === "board" ? this.workNow() : null;
    const isStart = work?.mode === "start";
    const loading = work?.mode === "opening" ? loadingOf() : null;
    return { key: `${this.signatureOf(live, filter)}|${isStart}|${loading?.id ?? ""}|${loading?.session ?? ""}`, filter, isStart, loading };
  }

  inputsOf(live, modelInputs, opening) {
    return `${opening}|${modelInputs?.key ?? ""}|${Math.floor(Date.now() / TICK_MS)}|${this.snapshotAt}|${live.placed}|${shared(CHANGED) ?? 0}|${wantedOf()?.id ?? ""}|${JSON.stringify(outboxOf())}|${(shared(TOASTS) ?? []).map((x) => x.id).join()}|${JSON.stringify(preferencesOf())}|${Boolean(shared(DRAG_TAB))}|${Boolean(shared(SPLIT))}|${this.pressed?.isMoving === true}`;
  }

  signatureOf(live, filter) {
    const agentPart = live.listed.map((a) => `${a.address}:${a.status}`).join(",");
    const terminalPart = live.all.map((x) => `${x.address}:${x.status ?? ""}:${x.program?.shell ? 1 : 0}:${x.labels?.[SESSION_LABEL] ?? ""}:${x.labels?.[VIEW_LABEL] ?? ""}:${x.labels?.["herdr.space"] ?? ""}:${x.parent ?? ""}:${x.report?.kind ?? ""}`).join(",");
    const now = Date.now();
    const woke = this.cardsNow().wakes.filter((at) => at <= now).at(-1) ?? 0;
    return `${this.dataVersion}|${this.pendingVersion}|${this.branchesVersion}|${Math.floor(now / FRESH_TICK_MS)}|${woke}|${shared(STICKY) ?? ""}|${live.isNarrow}|${live.shown}|${live.focusedTerminal}|${live.activeSpace}|${live.view}:${live.tiles.join(",")}|${[...live.paned].join(",")}|${JSON.stringify(filter)}|${agentPart}|${terminalPart}`;
  }

  rebuild(live = this.liveInputs(), modelInputs = this.modelInputsOf(live)) {
    if (modelInputs === null || modelInputs.key === this.signature) return false;
    const { key: signature, filter, isStart, loading } = modelInputs;
    this.signature = signature;
    this.live = live;
    this.model = this.computeModel(live, filter);
    if (this.kind === "board") this.board = { ...this.boardOf(this.model, filter), isStart, loading };
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
      parent: change.parent ?? s.parent ?? "",
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
    return withMoves(this.data?.projectOrder ?? [], this.pending.get("order")?.moves);
  }

  pinOrderNow() {
    return withMoves(this.data?.pinOrder ?? [], this.pending.get("pins")?.moves);
  }

  worktreeOrderNow(key) {
    return withMoves((this.data?.worktreeOrder?.[key] ?? []).map(worktreeIdOf), this.pending.get(`worktrees:${key}`)?.moves);
  }

  movePins(cx, sessions, before) {
    this.adoptOutbox(cx);
    if (queueMove("pins", this.pinOrderNow(), sessions, before, { op: "movePins", sessions, before })) this.adoptOutbox(cx);
  }

  adoptOutbox(cx) {
    const outbox = shared(OUTBOX) ?? null;
    const seen = `${this.snapshotAt}|${JSON.stringify(outbox)}`;
    if (seen === this.outboxSeen) {
      this.sendOutbox(cx);
      return false;
    }
    this.outboxSeen = seen;
    const pending = new Map();
    let tags = { ...this.snapshot?.tags };
    let stages = this.snapshot?.stages ?? [];
    const entries = queued();
    const isResorted = entries.some(([id, entry]) => !this.adopted.includes(id) && Object.values(entry.changes).some((fields) => RESORTED.some((field) => field in fields)));
    if (isResorted) this.frozen = null;
    for (const [, entry] of entries) {
      if (entry.done !== undefined && entry.done <= this.snapshotAt) continue;
      for (const [key, fields] of Object.entries(entry.changes)) {
        const { move, ...rest } = fields;
        const was = pending.get(key);
        pending.set(key, { ...was, ...rest, ...(move ? { moves: [...(was?.moves ?? []), move] } : {}) });
      }
      for (const op of entry.ops) {
        if (op.op === "defineTag") tags = { ...tags, [op.id]: { name: op.name, color: op.color } };
        if (op.op === "dropTag") delete tags[op.id];
        if (op.op === "defineStages") stages = op.stages;
      }
    }
    if (this.snapshot && this.kind === "inbox") {
      const windows = [...pending].filter(([key]) => key.startsWith("window:")).reduce((each, [key, fields]) => withWindow(each, key.slice("window:".length), fields), this.snapshot.windows ?? {});
      if (JSON.stringify(windows) !== JSON.stringify(windowsNow())) setShared(WINDOWS, windows);
      const preferences = { ...this.snapshot.preferences };
      const kept = [...pending].filter(([key]) => key.startsWith("pref:")).reduce((each, [key, fields]) => withPreference(each, key, fields.value), preferences);
      if (JSON.stringify(kept) !== JSON.stringify(preferencesOf())) setShared(PREFERENCES, kept);
    }
    const adopted = entries.map(([id]) => id);
    const isChanged = JSON.stringify([...pending]) !== JSON.stringify([...this.pending]) || adopted.join() !== this.adopted.join();
    this.pending = pending;
    this.adopted = adopted;
    if (isChanged) this.pendingVersion++;
    if (this.snapshot && (JSON.stringify(tags) !== JSON.stringify(this.data.tags) || stages !== this.data.stages)) {
      this.data = { ...this.snapshot, tags, stages };
      this.dataVersion++;
    }
    this.movePreferencesHere();
    this.collectOutbox();
    this.sendOutbox(cx);
    if (isChanged) this.redrawCard(cx, null);
    return isChanged;
  }

  readPreferences() {
    const seen = JSON.stringify(this.kind === "board" ? [preference("groupBy", "stage")] : [entriesOf("shelves"), entriesOf("unfolded")]);
    if (seen === this.preferencesSeen) return false;
    const isFirst = this.preferencesSeen === undefined;
    this.preferencesSeen = seen;
    if (this.kind === "board") this.groupBy = preference("groupBy", "stage");
    else {
      this.opened = new Set(Object.keys(entriesOf("shelves")));
      this.unfolded = new Set(Object.keys(entriesOf("unfolded")));
    }
    return !isFirst;
  }

  movePreferencesHere() {
    if (this.snapshot === null || this.isMoved) return;
    this.isMoved = true;
    const local = this.kind === "board" ? [["groupBy", "groupBy"]] : [["shelves", "shelves"], ["unfolded", "unfolded"], ["closed", "closed"]];
    for (const [stored, key] of local) {
      const value = saved(stored, null);
      if (value !== null && this.snapshot.preferences[key] === undefined) prefer(key, value);
      try {
        localStorage.removeItem(stored);
      } catch {}
    }
    if (this.kind === "board") return;
    for (const [stored, key] of [[WORKSPACES, "workspaces"], [PICKED_WORKTREE, "pickedWorktree"]]) {
      const value = shared(stored);
      if (value != null && this.snapshot.preferences[key] === undefined) prefer(key, value);
      if (value != null) setShared(stored, null);
    }
  }

  collectOutbox() {
    const now = Date.now();
    const outbox = outboxOf();
    const kept = Object.fromEntries(Object.entries(outbox).filter(([, entry]) => entry.done === undefined || now - entry.done < FINISHED_KEPT_MS));
    if (Object.keys(kept).length !== Object.keys(outbox).length) setShared(OUTBOX, kept);
  }

  sendOutbox(cx) {
    const now = Date.now();
    const held = new Set();
    for (const [id, entry] of queued()) {
      if (entry.done !== undefined) continue;
      const keys = [...Object.keys(entry.changes), ...(entry.ops.length > 0 ? ["ops"] : [])];
      const isBehind = keys.some((key) => held.has(key));
      for (const key of keys) held.add(key);
      if (isBehind || isInFlight(entry, now) || isHeld(entry, now)) continue;
      this.sendEntry(cx, id, entry, now);
    }
  }

  sendEntry(cx, id, entry, now) {
    setShared(OUTBOX, { ...outboxOf(), [id]: { ...entry, sent: now } });
    cx.spawn(async (cx) => {
      try {
        for (const step of entry.run) await this.runStep(step);
        settleQueued(id, Date.now());
        if (entry.toast) notify(entry.toast);
      } catch (error) {
        settleQueued(id, null);
        if (entry.opens) markSessionOpening(entry.opens, false);
        const wanted = wantedOf();
        if (wanted && (wanted.session === entry.opens || entry.run.some((step) => step.wants === wanted.id))) setShared(WANTED, null);
        notify({ title: entry.failed ?? "anyhost could not change it", body: messageOf(error), level: "error" });
      }
      this.changedAt = Date.now();
      setShared(CHANGED, this.changedAt);
      this.refresh(cx);
    });
  }

  async runStep(step) {
    if (step.hc) {
      const answer = await hc(step.hc);
      if (answer.code !== 0) throw new Error((answer.stderr || answer.stdout).trim());
      return;
    }
    if (step.app) return void run(step.app[0], step.app[1]);
    if (step.exec) {
      const answer = await exec(step.exec[0], step.exec.slice(1), { on: step.on ?? null, timeout: step.timeout ?? COMMAND_MS });
      if (answer.code !== 0) throw new Error((answer.stderr || answer.stdout).trim());
      return;
    }
    const answer = await anyhost(step.args, step.timeout, step.on ?? null);
    const wanted = wantedOf();
    if (step.wants && wanted?.id === step.wants) setShared(WANTED, { ...wanted, session: JSON.parse(answer).session, starting: false });
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
      if (card && (agent || !x.program?.shell)) Object.assign(card, { address: x.address, status: card.harness === "codex" ? (agent?.status ?? card.status) : card.status, deleted: false, archived: this.pending.get(card.key)?.archived ?? (card.archived && !live.paned.has(x.address)), app: null, isRemote: x.address.includes("/") ? card.isRemote : false, machine: x.address.includes("/") ? card.machine : here });
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
    for (const r of rows) {
      r.isChild = rowByKey.has(r.parent);
      if (r.parent && !r.isChild) r.kind = "background";
    }
    const childrenOf = new Map();
    const descendantsOf = new Map();
    for (const r of rows.filter((r) => r.isChild)) {
      childrenOf.set(r.parent, [...(childrenOf.get(r.parent) ?? []), r]);
      const seen = new Set([r.key]);
      let root = rowByKey.get(r.parent);
      while (root.isChild && !seen.has(root.key)) {
        seen.add(root.key);
        root = rowByKey.get(root.parent);
      }
      descendantsOf.set(root.key, [...(descendantsOf.get(root.key) ?? []), r]);
    }
    for (const [key, descendants] of descendantsOf) {
      const r = rowByKey.get(key);
      if (r.isOffline || r.state === "blocked") continue;
      const shown = descendants.filter((c) => !c.archived && !c.deleted);
      const waiting = shown.find((c) => c.state === "blocked" && !c.isOffline);
      const working = shown.filter((c) => isRunning(c.state));
      if (waiting) Object.assign(r, { state: "blocked", label: `Subagent: ${waiting.label}`, since: waiting.since });
      else if (working.length > 0 && !isRunning(r.state)) Object.assign(r, { state: "tasks", label: STATE.tasks.name, since: Math.min(...working.map((c) => c.since)) });
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
    sections.pinned = this.pinnedOf(sections.pinned);
    sections.active.sort(byUrgency);
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
    Object.defineProperty(model, "pulse", { get: () => (pulse ??= this.pulseOf(rows)) });
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
    const isShown = Boolean(c.address) && (c.address === shown || c.views.includes(shown)) && shared(STICKY) !== c.key;
    const isUnread = !isShown && c.isNewer;
    const listed = c.status === "blocked" || c.status === "working" ? c.status : c.background ? "tasks" : now - at < FRESH_MS ? "done" : "idle";
    const state = liveStateOf({ state: listed, since: c.statusSinceMs, background: c.background }, terminal);
    const since = state === "blocked" || isRunning(state) ? ((state === listed ? c.statusSinceMs : wordChangedAt(terminal.address)) ?? terminal?.status_ms ?? at) : at;
    const label = isOffline ? "Offline" : state === "blocked" ? (ASKS[terminal?.report?.kind] ?? (terminal?.status === "error" ? "Error" : "Needs you")) : state === "idle" ? "" : STATE[state].name;
    return { state, label, since, isUnread, isOffline, isAsleep: !c.address && !c.session.status, seenAt: isOffline ? (holder.seenAt ?? null) : null };
  }

  sectionOf(r, now, isShownKind, filter) {
    if (r.isChild) return null;
    if (r.deleted) return filter.include.includes("deleted") ? "deleted" : null;
    if (r.archived) return null;
    if (r.kind !== "own") return r.state === "blocked" && !r.isOffline ? "active" : isShownKind ? r.kind : null;
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
    const order = this.worktreeOrderNow(p.key);
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
      .sort((a, b) => placeIn(order, worktreeIdOf(a)) - placeIn(order, worktreeIdOf(b)) || (b.machine === here) - (a.machine === here) || b.isMain - a.isMain || b.newest - a.newest);
  }

  workspacesOf(rows) {
    const known = new Map();
    for (const r of [...rows].sort(byRecent)) {
      const on = this.onOf(r.machine);
      if (r.deleted || on === null) continue;
      const id = placedSpace(on, r.space);
      const isHeld = !r.isChild && OPEN_SECTIONS.has(r.section);
      const w = known.get(id);
      if (w) {
        if (isHeld && w.newest === null) w.newest = this.factsOf(r);
        if (isHeld && r.address) w.live++;
        continue;
      }
      const isLoose = !hasWorktrees(r.projectKey);
      const branch = this.branchOf(r.machine, r.checkout)?.branch ?? r.checkout.split("/").pop();
      known.set(id, { id, key: r.projectKey, machine: r.machine, folder: isLoose ? null : r.checkout, checkout: r.checkout, at: Date.parse(r.at) || 0, name: isLoose ? r.projectName : `${r.projectName} · ${branch}`, newest: isHeld ? this.factsOf(r) : null, live: isHeld && r.address ? 1 : 0 });
    }
    return [...known.values()];
  }

  factsOf(r) {
    return { ...targetOf(r), isChild: Boolean(r.isChild), state: r.state, since: r.statusSinceMs, background: r.background, pinned: r.pinned, section: r.section, snoozedUntil: r.snoozedUntil, projectKey: r.projectKey, projectName: r.projectName, kind: r.kind, isUnread: r.isUnread, cwd: r.session.cwd, tags: r.tags, stage: r.stage, views: r.views, at: r.at };
  }

  pulseOf(rows) {
    const here = this.hereName();
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
      const unread = p.rows.filter((r) => r.isUnread && !r.archived).map((r) => ({ key: r.key, at: r.at, machine: r.machine, checkout: r.checkout }));
      return { key: p.key, name: p.name, defaultName: p.defaultName, isNamed: p.isNamed, ...this.countsOf(p.rows), worktrees: hasWorktrees(p.key) ? this.worktreesOf(p) : [], machines: onMachines, checkouts, newest: p.newest, unread };
    });
    const order = this.orderNow();
    listed.sort((a, b) => placeIn(order, a.key) - placeIn(order, b.key) || b.newest - a.newest);
    return { here, device: this.data.here, adopted: this.adopted, projectOrder: order, pinOrder: this.pinOrderNow(), all: { ...this.countsOf(counted), machines: machinesListed }, projects: listed, workspaces: this.workspacesOf(rows), sessions: Object.fromEntries(rows.filter((r) => r.address || (!r.isChild && OPEN_SECTIONS.has(r.section))).map((r) => [r.key, this.factsOf(r)])), closed: closedKeys().map((key) => rows.find((r) => r.key === key)).filter((r) => r?.archived && !r.deleted).map((r) => this.factsOf(r)), tags: this.data.tags, stages: this.data.stages, tagUses: Object.fromEntries(Object.keys(this.data.tags).map((id) => [id, rows.filter((r) => r.tags.includes(id)).map((r) => r.key)])), targets: this.data.devices.filter((d) => d.id !== this.data.here && d.connected).map((d) => d.name), settleAfterDays: this.data.settleAfterDays, pinned: this.pinnedOf(rows.filter((r) => r.section === "pinned")).map((r) => ({ key: r.key, title: r.title, harness: r.harness, state: r.state, space: this.onOf(r.machine) === null ? null : placedSpace(this.onOf(r.machine), r.space) })), known: [...new Map(rows.filter((r) => !r.deleted && r.projectKey !== TEMPORARY).map((r) => [r.projectKey, { key: r.projectKey, name: r.projectName }])).values()] };
  }


  change(cx, changes, run, failed, hold = null, ops = [], show = null) {
    enqueue({ changes, ops, run: run.map((step) => (Array.isArray(step) ? { args: step } : step)), failed, hold, show });
    if (this.pending !== undefined) this.adoptOutbox(cx);
  }

  holdFor(cx, title, body = "Click to undo.") {
    const hold = idOf();
    notify({ title, body, level: "info", timeout: TOAST_MS, hold, action: { name: `anyhost.undo-${hold}` } });
    if (this.pending !== undefined) cx.timer.after(TOAST_MS, (cx) => this.sendOutbox(cx));
    return hold;
  }

  redraw(cx) {
    this.rebuild();
    this.placeParts(cx);
    this.redrawAll(cx);
  }

  redrawCard(cx, key) {
    this.rebuild();
    this.redrawChanged(cx, this.placeParts(cx));
    const view = key === null ? undefined : this.partViews.get(key);
    if (view) cx.notify(view);
  }

  archive(cx, r, archived, { isClosed = false, hold = null, show = null } = {}) {
    const held = archived ? null : heldArchiveOf(r.key);
    if (held !== null) return void undoHeld(held);
    if (r.archived === archived) return;
    const undo = archived ? (hold ?? this.holdFor(cx, `Archived ${r.title.slice(0, 50)}`)) : null;
    if (archived && (isClosed || Boolean(r.address))) {
      preferEntry("closed", r.key, Date.now(), undo);
      for (const key of closedKeys().slice(CLOSED_MOST)) preferEntry("closed", key, null, undo);
    } else if (!archived) preferEntry("closed", r.key, null);
    this.change(cx, { [r.key]: { archived } }, [["archive", r.key, ...(archived ? [] : ["--undo"])]], archived ? "anyhost could not archive it" : "anyhost could not restore it", undo, [], show);
  }

  archiveAll(cx, rows, { isClosed = false, panes: closed = [], show = null, isConfirmed = false } = {}) {
    const leaving = rows.filter((r) => !r.pinned && !r.archived);
    if (leaving.length === 0) return void closed.forEach((pane) => run("pane.close", { pane }));
    const midTurn = leaving.filter((r) => r.state === "blocked" || isRunning(r.state));
    if (!isConfirmed && midTurn.length > 0) return this.confirmArchive(leaving, midTurn, { isClosed, panes: closed, show });
    const [first] = leaving;
    const hold = this.holdFor(cx, leaving.length === 1 ? `${isClosed ? "Closed" : "Archived"} ${first.title.slice(0, 50)}` : `${isClosed ? "Closed" : "Archived"} ${leaving.length} sessions`);
    leaving.forEach((r, i) => this.archive(cx, r, true, { isClosed, hold, show: i === 0 ? show : null }));
    if (closed.length > 0) enqueue({ run: closed.map((pane) => ({ app: ["pane.close", { pane }] })), hold });
  }

  confirmArchive(leaving, midTurn, how) {
    const verb = how.isClosed ? "Close" : "Archive";
    const [first] = midTurn;
    const doing = first.state === "blocked" ? "waits for you" : "is working";
    const others = midTurn.length > 1 ? ` and ${midTurn.length - 1} more ${midTurn.length === 2 ? "session" : "sessions"} mid-turn` : "";
    this.confirm({
      title: leaving.length === 1 ? `${verb} ${first.title}?` : `${verb} ${leaving.length} sessions?`,
      body: `${first.title} ${doing}${others}. ${how.isClosed ? "Closing" : "Archiving"} stops Claude Code mid-turn. Restore brings the session back.`,
      go: verb,
      archive: { ...how, rows: leaving.map(({ key, title, address, state }) => ({ key, title, address, state, archived: false, pinned: false })) },
    });
    return true;
  }

  restore(cx, r) {
    const wasClosed = closedKeys().includes(r.key);
    this.archive(cx, r, false);
    if (wasClosed) this.open({ ...r, archived: false }, cx);
  }

  reopenClosed(cx) {
    const r = shared(PULSE)?.closed?.[0];
    if (!r) return notify({ title: "No closed session to reopen", level: "info", timeout: 3000 });
    this.restore(cx, r);
  }

  closeTabs(cx, tabs, show = null) {
    const byAddress = new Map(terminals().map((x) => [x.address, x]));
    const leaving = [];
    const closed = [];
    for (const tab of tabs) {
      const ps = panes().filter((p) => p.tab === tab);
      const rows = [...new Set(ps.map((p) => byAddress.get(p.terminal)?.labels?.[SESSION_LABEL]).filter(Boolean))].map((key) => this.sessionRowOf(key)).filter(Boolean);
      if (rows.some((r) => r.pinned)) continue;
      if (rows.length === 0) {
        run("tab.close", { id: tab, confirmed: true });
        continue;
      }
      closed.push(...ps.filter((p) => !byAddress.get(p.terminal)?.labels?.[SESSION_LABEL]).map((p) => p.pane));
      leaving.push(...rows);
    }
    return this.archiveAll(cx, leaving, { isClosed: true, panes: closed, show });
  }

  sessionRowOf(key) {
    if (this.model) return this.model.byKey.get(key);
    const known = shared(PULSE)?.sessions?.[key];
    return known ? { key, ...known } : undefined;
  }


  confirm(shown) {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 380, props: { view: "confirm", ...shown } });
  }

  visit(cx, r, at, failed) {
    this.change(cx, { [r.key]: { visitedAt: at } }, [["visit", r.key, "--at", at]], failed);
  }

  markUnread(cx, r) {
    setShared(STICKY, r.key);
    this.visit(cx, r, new Date(Date.parse(r.at) - 1).toISOString(), "anyhost could not mark it unread");
  }

  markRead(cx, r, failed = "anyhost could not mark it read") {
    this.visit(cx, r, new Date(Math.max(Date.now(), Date.parse(r.at) || 0)).toISOString(), failed);
  }

  togglePin(cx, r) {
    return r.pinned ? this.unpin(cx, r) : this.pin(cx, r);
  }

  pin(cx, r) {
    this.change(cx, { [r.key]: { pinned: new Date().toISOString(), settled: false, snoozedUntil: "" } }, [["pin", r.key]], "anyhost could not pin it");
  }

  unpin(cx, r) {
    this.change(cx, { [r.key]: { pinned: "" } }, [["pin", r.key, "--undo"]], "anyhost could not unpin it", this.holdFor(cx, `Unpinned ${r.title.slice(0, 50)}`));
  }

  toggleSettle(cx, r) {
    return r.section === "settled" ? this.unsettle(cx, r) : this.settle(cx, r);
  }

  settle(cx, r) {
    this.change(cx, { [r.key]: { settled: true, settledAt: new Date().toISOString(), pinned: "", snoozedUntil: "" } }, [["settle", r.key]], "anyhost could not settle it", this.holdFor(cx, `Settled ${r.title.slice(0, 50)}`));
  }

  unsettle(cx, r) {
    this.change(cx, { [r.key]: { settled: false } }, [["settle", r.key, "--undo"]], "anyhost could not unsettle it");
  }

  snooze(cx, r, until) {
    this.change(cx, { [r.key]: { snoozedUntil: until ?? "" } }, [["snooze", r.key, ...(until ? [until] : ["--undo"])]], until ? "anyhost could not snooze it" : "anyhost could not wake it", until ? this.holdFor(cx, `Snoozed ${r.title.slice(0, 50)}`, `It comes back ${wakeAtOf(until)}. Click to undo.`) : null);
  }

  nameProject(cx, key, name) {
    this.change(cx, { [`name:${key}`]: { name } }, [["project-name", key, ...(name === null ? ["--undo"] : [name])]], "anyhost could not rename the project");
  }

  openSettings() {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 460, props: { view: "settings", settleAfterDays: shared(PULSE)?.settleAfterDays ?? null } });
  }

  organize(cx, changes, optimistic = []) {
    const pulse = shared(PULSE);
    const isTagDropped = changes.some((c) => c.op === "dropTag" && pulse?.tags[c.id]);
    const isStageDropped = changes.some((c) => c.op === "defineStages" && (pulse?.stages ?? []).some((s) => !c.stages.some((kept) => kept.id === s.id)));
    const hold = isTagDropped || isStageDropped ? this.holdFor(cx, isTagDropped ? "Deleted the tag" : "Deleted the stage") : null;
    const fields = {};
    for (const [key, changed] of optimistic) fields[key] = { ...fields[key], ...changed };
    this.change(cx, fields, [["organize", JSON.stringify(changes)]], "anyhost could not change it", hold, changes);
    if (this.pending !== undefined) this.redraw(cx);
  }

  deleteOn(r) {
    if (!r.isRemote) return null;
    const on = reachOf(r.machine);
    if (on === null) return void notify({ title: "anyhost could not delete it", body: `${r.machine} holds it, and the Herdr app does not reach ${r.machine}.`, level: "error" });
    return on;
  }

  dispatchDelete(cx, r, on) {
    this.change(cx, { [r.key]: { deleted: true } }, [{ args: ["delete", r.key], timeout: LONG_MS, on: on || null }], "anyhost could not delete it", this.holdFor(cx, `Deleted ${r.title.slice(0, 50)}`));
  }

  confirmDelete(r) {
    const on = this.deleteOn(r);
    if (on === undefined) return;
    this.confirm({ title: `Delete ${r.title}?`, body: "Its files leave every machine. Its backup in R2 stays, so Restore brings it back.", go: "Delete", delete: { row: targetOf(r), on } });
  }


  open(r, cx) {
    const child = r.isChild ? this.model?.byKey.get(r.key) : undefined;
    if (child?.isChild) return this.showSubagent(cx, this.rootOf(child), child);
    const filter = filterOf();
    const worktree = { machine: r.machine, folder: r.checkout };
    if (r.projectKey !== undefined && filter.project !== null && filter.project !== r.projectKey) setFilter({ project: r.projectKey });
    else if (r.checkout && filter.worktree !== null && !sameWorktree(filter.worktree, worktree)) setFilter({ worktree });
    if (r.archived) this.archive(cx, r, false);
    openSession(targetOf(r));
  }

  adopt(r) {
    void hc(["label", r.address, `herdr.space=${r.space}`, `herdr.tab=${r.key.slice(0, 8)}`]);
  }

  parkInto(address, target) {
    if (target) this.moves.set(address, target);
    else this.moves.delete(address);
    save("moves", [...this.moves]);
  }

  peek(r) {
    if (r.address) return run("terminal.peek", { terminal: r.address });
    openSession(targetOf(r), { act: "peek" });
  }

  present(cx, r, shape) {
    if (shape === "tab") {
      closePresented();
      if (r.isChild) this.organize(cx, [{ op: "parentSession", session: r.key, parent: "" }], [[r.key, { parent: "" }]]);
      return this.open({ ...r, isChild: false }, cx);
    }
    if (r.address) return presentTerminal(r, r.address, shape);
    openSession(targetOf(r), { act: "present", shape });
  }

  showHere(r, direction) {
    const at = focused();
    if (!at?.pane) return;
    if (r.address) return run("pane.split", { pane: at.pane, direction, argv: ["sh", "-c", VIEW, "view", r.key, r.address] });
    openSession(targetOf(r), { act: "split", direction, pane: at.pane });
  }

  moveTab({ terminals: addresses, key, worktree, name }) {
    const on = reachOf(worktree.machine);
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
    const pulse = shared(PULSE);
    const newest = (pulse?.workspaces ?? []).filter((w) => w.key === key && w.checkout && reachOf(w.machine) !== null && (machine === null || w.machine === machine)).sort((a, b) => (b.machine === pulse.here) - (a.machine === pulse.here) || b.at - a.at)[0];
    return newest ? { machine: newest.machine, folder: newest.checkout } : null;
  }

  showProject(key, machine = null) {
    const worktree = this.worktreeToShow(key, machine);
    if (worktree === null) return notify({ title: `No machine the Herdr app reaches holds ${shared(PULSE)?.known.find((p) => p.key === key)?.name ?? projectNameOf(key)}`, body: "Add the machine that holds it, and its sessions show here.", level: "warning" });
    setFilter({ project: key, worktree: hasWorktrees(key) ? worktree : null });
    this.showWorkspace(key, worktree);
  }

  showWorkspace(key, worktree) {
    preferEntry("pickedWorktree", key, worktree);
    const on = reachOf(worktree.machine);
    if (on === null) return notify({ title: `The Herdr app does not reach ${worktree.machine}`, body: "Add the machine, and its workspaces show here.", level: "warning" });
    if (layoutOf(on) === "unavailable") return notify({ title: `The Herdr app does not reach ${worktree.machine} now`, body: "Its workspaces open once it answers again.", level: "warning" });
    const id = spaceOf(key, worktree.folder);
    const space = placedSpace(on, id);
    const known = (shared(PULSE)?.workspaces ?? []).find((w) => w.id === space);
    if (spaces().some((sp) => sp.id === space)) return run("space.select", { id: space });
    if (known?.newest && !known.live && !isOpening(known.newest.key)) return openSession(known.newest);
    want({ space, title: known?.newest?.title ?? "a terminal" });
    if (known?.live || (known?.newest && isOpening(known.newest.key))) return;
    enqueue({ run: [{ hc: ["run", "--bg", "--keep", "--no-parent", "--json", ...(on ? ["--on", on] : []), "--cwd", worktree.folder, "--label", `herdr.space=${id}`, "--", "sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'] }], failed: "anyhost could not open a terminal there" });
  }

  fillWorkspace(key, worktree) {
    if (!this.model || this.onOf(worktree.machine) === null) return;
    const id = spaceOf(key, worktree.folder);
    const byAddress = new Map(terminals().map((x) => [x.address, x]));
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    for (const r of this.model.rows.filter((r) => r.space === id && r.machine === worktree.machine && !r.isChild && OPEN_SECTIONS.has(r.section))) {
      if (!r.address || this.moves.has(r.address)) continue;
      const placed = byAddress.get(r.address)?.labels?.["herdr.space"];
      if (!placed && !paned.has(r.address)) this.adopt(r);
    }
  }

  moveTerminal(address, target) {
    this.parkInto(address, target);
    run("terminal.park", { terminal: address });
  }

  startIn(project, { machine = null, folder = null } = {}) {
    const pulse = shared(PULSE);
    const p = project ?? null;
    const machinesWith = p ? Object.keys(p.checkouts ?? {}).filter((m) => (p.checkouts[m] ?? []).length > 0 && (m === pulse.here || pulse.all.machines.find((d) => d.name === m)?.connected)) : [];
    const picked = p ? pickedWorktrees()[p.key] : undefined;
    const chosen = machine ?? (machinesWith.includes(picked?.machine) ? picked.machine : machinesWith.includes(pulse.here) ? pulse.here : machinesWith[0]);
    const where = folder ?? (picked?.machine === chosen ? picked.folder : p?.checkouts?.[chosen]?.[0]);
    if (!chosen || !where) return this.newSession();
    const on = pulse.all.machines.find((m) => m.name === chosen)?.on ?? null;
    const name = p?.name ?? where.split("/").pop();
    startSession(chosen, where, on, `anyhost could not start a session in ${name}`, on === null ? null : placedSpace(on, spaceOf(p?.key ?? NONE, where)), name);
  }

  newSession() {
    const pulse = shared(PULSE);
    if (!pulse) return;
    const at = focused();
    const current = Object.values(pulse.sessions).find((s) => s.address && s.address === at?.terminal)?.projectKey ?? pulse.workspaces.find((w) => w.id === at?.space)?.key ?? null;
    openOverlay({ mod: "anyhost", kind: "dialog", width: 520, props: { view: "new", current, homes: Object.fromEntries(pulse.all.machines.map((m) => [m.name, m.home])) } });
  }


  initInbox(cx) {
    for (const key of RETIRED) if (shared(key) != null) setShared(key, null);
    this.keys = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search" });
    this.found = null;
    this.search.on("change", (_e, cx) => this.searched(cx));
    this.search.on("focus", () => void (this.isSearching = true));
    this.search.on("blur", () => void (this.isSearching = false));
    this.opened = new Set(Object.keys(entriesOf("shelves")));
    this.listScroll = ScrollHandle.new();
    this.departing = new Map();
    this.unfolded = new Set(Object.keys(entriesOf("unfolded")));
    this.shelfShown = {};
    this.frozen = null;
    this.isPointerIn = false;
    this.cursor = null;
    this.hovered = null;
    this.window = idOf();
    this.reported = null;
    this.reportedAt = 0;
    this.moves = new Map(saved("moves", []));
    this.wasOpen = null;
    this.pulsed = "";
    this.reconciledKey = "";
    this.arrived = 0;
    this.initData(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.keys.focus();
        if (command === "filter") this.openFilter();
        if (command === "palette") this.openPalette();
        if (command === "board") this.openBoard(filterOf().project);
        if (command === "search") this.search.focus();
        const [, verb, id] = /^(menu|present-panel|present-popup|present-full)-(.+)$/.exec(command) ?? [];
        const r = id ? this.model?.rows.find((row) => row.key.startsWith(id)) : null;
        if (r && verb?.startsWith("present-")) this.present(cx, r, verb.slice("present-".length));
        if (r && verb === "menu") this.menu(r);
        this.redrawAll(cx);
      }
    });
  }

  reconcileWhenDue(cx, live) {
    if (!this.model || !isLayoutLoaded()) return;
    const key = `${this.signature}|${Math.floor(Date.now() / TICK_MS)}|${shared(CHANGED) ?? 0}|${live.shape}|${wantedOf()?.id ?? ""}`;
    if (key === this.reconciledKey) return;
    this.reconciledKey = key;
    this.reconcile(cx);
  }

  reconcile(cx) {
    const project = filterOf().project;
    if (this.searchedIn !== undefined && project !== this.searchedIn) {
      if (this.search.value() !== "") this.search.set_value("");
      this.found = null;
      this.opened.delete(FOUND_ARCHIVED);
      this.cursor = null;
      this.shelfShown = {};
    }
    this.searchedIn = project;
    const model = this.model;
    const live = this.live;
    if (!model || !live || this.data === null) return;
    const written = JSON.stringify(model.pulse);
    if (written !== this.pulsed) {
      this.pulsed = written;
      setShared(PULSE, model.pulse);
    }
    this.recordTabs(cx, model);
    this.sendOutbox(cx);
    const changed = shared(CHANGED) ?? 0;
    if (changed > this.changedAt) {
      this.changedAt = changed;
      this.refresh(cx);
    }
    this.followScreen(model, live);
    const shownRow = live.shown ? model.rows.find((r) => r.address === live.shown || r.views.includes(live.shown)) : undefined;
    if (shared(STICKY) && shownRow?.key !== shared(STICKY)) setShared(STICKY, null);
    this.reportShown(live);
    this.readBranches(cx, model);
    this.parkLeaving(model, live);
    this.moveIntoWorkspaces(model, live);
    this.fillShownWorkspace(live);
    this.nameTabs(model);
    this.nameSpaces(model);
    this.stepMoves(live);
    for (const key of Object.keys(openingOf())) if (model.byKey.get(key)?.address || !model.byKey.has(key)) markSessionOpening(key, false);
  }

  perform(asked, cx, r) {
    if (asked.action === "startIn") return this.startIn(asked.project, { machine: asked.machine ?? null, folder: asked.folder ?? null });
    if (asked.action === "organize") return this.organize(cx, asked.changes, asked.optimistic ?? []);
    if (asked.action === "readProject") return (asked.project.unread ?? []).filter((u) => !asked.worktree || sameWorktree(asked.worktree, { machine: u.machine, folder: u.checkout })).forEach((u) => this.markRead(cx, u));
    if (asked.action === "removeWorktree") return this.confirm({ title: `Remove the worktree ${asked.folder.split("/").pop()}?`, body: "Its folder leaves this machine. Its branch stays.", go: "Remove", removeWorktree: { machine: asked.machine, folder: asked.folder } });
    if (asked.action === "closeTabs") return this.closeTabs(cx, asked.tabs);
    if (asked.action === "reopen") return this.reopenClosed(cx);
    if (asked.action === "showProject") return this.showProject(asked.key, asked.machine ?? null);
    if (asked.window) {
      const w = asked.window;
      if (asked.action === "newSession") return this.newHere();
      if (asked.action === "newTerminal") return run("tab.new", w.space ? { space: w.space } : {});
      if (asked.action === "split") return run("pane.split", { direction: asked.direction, pane: w.pane });
      if (asked.action === "zoom") return run("pane.zoom", { pane: w.pane });
      if (asked.action === "closePane") return run("pane.close", { pane: w.pane });
      if (asked.action === "rightClicks") return run("terminal.right_click", { terminal: w.terminal, to: asked.to });
      if (asked.action === "park") return run("terminal.park", { terminal: w.terminal });
    }
    if (!r) return;
    if (asked.action === "open") return this.open(r, cx);
    if (asked.action === "present") return this.present(cx, r, asked.shape);
    if (asked.action === "peek") return this.peek(r);
    if (asked.action === "sleep") return r.address && enqueue({ run: [{ hc: ["label", r.address, `${SLEEP_LABEL}=${Date.now()}`] }], failed: "anyhost could not put it to sleep" });
    if (asked.action === "pin") return this.togglePin(cx, r);
    if (asked.action === "settle") return this.toggleSettle(cx, r);
    if (asked.action === "snooze") return this.snooze(cx, r, asked.until ?? null);
    if (asked.action === "archive") return this.archiveAll(cx, [r]);
    if (asked.action === "restore") return this.archive(cx, r, false);
    if (asked.action === "unread") return this.markUnread(cx, r);
    if (asked.action === "read") return this.markRead(cx, r);
    if (asked.action === "confirmDelete") return this.confirmDelete(r);
    if (asked.action === "filterProject") return setFilter({ project: r.projectKey, include: r.kind === "own" || filterOf().include.includes(r.kind) ? filterOf().include : [...filterOf().include, r.kind] });
    if (asked.action === "showHere") return this.showHere(r, asked.direction);
    if (asked.action === "moveToTab") return this.moveToTab(r, asked.tab);
    if (asked.action === "startHere") return this.startIn(shared(PULSE)?.projects.find((p) => p.key === r.projectKey) ?? null, { machine: r.machine, folder: r.checkout });
    if (asked.action === "move") return this.moveTo(r, asked.to);
  }

  async mainCheckoutOf(folder, on) {
    const found = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { on: on || null });
    if (found.code !== 0) throw new Error((found.stderr || found.stdout).trim() || `${folder} is not a git checkout`);
    return found.stdout.trim().replace(/\/\.git$/, "");
  }

  async newWorktree(project, branch, from) {
    const origin = from ?? this.worktreeToShow(project.key, null);
    const on = origin === null ? null : reachOf(origin.machine);
    if (origin === null || on === null) throw new Error(`No machine the Herdr app reaches holds ${project.name}`);
    const main = await this.mainCheckoutOf(origin.folder, on);
    const others = (project.checkouts?.[origin.machine] ?? []).filter((folder) => folder !== main);
    const parent = others.length > 0 ? others[0].split("/").slice(0, -1).join("/") : main.split("/").slice(0, -1).join("/");
    const name = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const folder = `${parent}/${others.length > 0 ? name : `${main.split("/").pop()}-${name}`}`;
    const exists = (await exec("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { on: on || null })).code === 0;
    const added = await exec("git", ["-C", origin.folder, "worktree", "add", ...(exists ? [folder, branch] : ["-b", branch, folder, "HEAD"])], { on: on || null, timeout: LONG_MS });
    if (added.code !== 0) throw new Error((added.stderr || added.stdout).trim());
    const worktree = { machine: origin.machine, folder };
    preferEntry("pickedWorktree", project.key, worktree);
    setFilter({ project: project.key, worktree });
    this.startIn(project, worktree);
  }

  async removeWorktree(machine, folder) {
    const on = reachOf(machine);
    if (on === null) throw new Error(`The Herdr app does not reach ${machine}`);
    const main = await this.mainCheckoutOf(folder, on);
    if (main === folder) throw new Error(`${tildeOf(folder, home())} is the main checkout, which holds the repository.`);
    const removed = await exec("git", ["-C", main, "worktree", "remove", folder], { on: on || null });
    if (removed.code !== 0) throw new Error((removed.stderr || removed.stdout).trim());
    if (sameWorktree(filterOf().worktree, { machine, folder })) setFilter({ worktree: null });
    notify({ title: `Removed the worktree ${folder.split("/").pop()}`, body: "Its branch stays.", level: "success", timeout: 3000 });
  }

  moveTo(r, to) {
    notify({ title: `Moving ${r.title.slice(0, 40)} to ${to}`, body: "It moves once its turn ends.", level: "info", timeout: 3000 });
    enqueue({ run: [{ args: ["move", r.key, to], timeout: LONG_MS }], failed: `anyhost could not move it to ${to}`, toast: { title: `Moved ${r.title.slice(0, 40)} to ${to}`, level: "success" } });
  }

  followScreen(model, live) {
    const at = live.focusedTerminal;
    if (at === this.followed) return;
    const before = this.followedSpace ?? null;
    this.followed = at;
    this.followedSpace = at ? spaceOfTerminal(at) : null;
    if (before !== null && before !== this.followedSpace && !panes().some((p) => p.terminal && spaceOfTerminal(p.terminal) === before)) return;
    const filter = filterOf();
    const labels = at ? live.all.find((x) => x.address === at)?.labels : undefined;
    const r = model.byKey.get(labels?.[SESSION_LABEL] ?? labels?.[VIEW_LABEL] ?? "");
    if (!r) return;
    const worktree = hasWorktrees(r.projectKey) ? { machine: r.machine, folder: r.checkout } : null;
    if (filter.worktree !== null && (worktree === null || !sameWorktree(filter.worktree, worktree))) return setFilter({ project: r.projectKey, worktree });
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

  readBranches(cx, model) {
    if (this.branchesReading) return;
    const isLooking = window()?.active === true;
    const worktrees = new Map(model.rows.filter((r) => !r.deleted && r.kind === "own" && r.projectKey !== NONE && this.onOf(r.machine) !== null).map((r) => [`${r.machine}\0${r.checkout}`, { machine: r.machine, folder: r.checkout }]));
    const isBack = isLooking && !this.wasLooking;
    this.wasLooking = isLooking;
    const due = [...worktrees].filter(([at]) => !this.branches.has(at) || isBack);
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
    const held = heldKeys();
    const isOpen = new Map(model.rows.filter((r) => r.address).map((r) => [r.key, r.isChild || OPEN_SECTIONS.has(r.section) || held.has(r.key)]));
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

  moveIntoWorkspaces(model, live) {
    const stranded = live.all.filter((x) => x.labels?.["herdr.space"] && !isWorkspace(x.labels["herdr.space"]) && !this.moves.has(x.address));
    if (stranded.length === 0) return;
    const folderAt = new Map(panes().map((p) => [p.terminal, p.cwd ?? ""]));
    const shownFrom = [];
    for (const x of stranded) {
      const tab = x.labels["herdr.tab"] || idOf();
      const machine = this.machineAt(x.address);
      const folder = folderAt.get(x.address) ?? "";
      const holder = model.rows.filter((r) => r.kind === "own" && !r.deleted && hasWorktrees(r.projectKey) && r.machine === machine && isUnder(folder, r.checkout)).sort((a, b) => b.checkout.length - a.checkout.length)[0];
      const space = (model.byKey.get(x.labels[SESSION_LABEL] || x.labels[VIEW_LABEL] || "") ?? holder)?.space;
      if (!space) continue;
      if (spaceOfTerminal(x.address) === live.activeSpace) shownFrom.push({ terminal: x.address, space: placedSpace(this.onOf(machine) ?? "", space), title: x.title || "a terminal" });
      this.moveTerminal(x.address, { space, tab });
    }
    const shown = shownFrom.find((moved) => moved.terminal === live.focusedTerminal) ?? shownFrom[0];
    if (shown) want(shown);
  }

  recordTabs(cx, model) {
    const shape = panes().map((p) => `${p.tab}:${p.terminal}`).join(",");
    const order = spaces().map((sp) => `${sp.id}:${sp.tabs.map((x) => x.id).join("/")}`).join(",");
    const key = `${shape}|${order}|${model.rows.map((r) => `${r.key}:${r.address}:${r.section}`).join(",")}`;
    if (key === this.tabsRecorded || this.isRecordingTabs) return;
    this.isRecordingTabs = true;
    cx.spawn(async () => {
      try {
        const doc = await readLayoutDoc();
        const roots = new Map((doc.spaces ?? []).flatMap((space) => space.tabs ?? []).map((tab) => [tab.id, tab.root]));
        const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
        const isOpen = (session) => OPEN_SECTIONS.has(this.model?.byKey.get(session)?.section);
        const inPane = new Set(panes().map((p) => sessionAt.get(p.terminal)).filter(Boolean));
        const isAway = (session) => isOpen(session) && !inPane.has(session);
        const before = windowsNow();
        const held = new Set();
        for (const space of spaces()) {
          space.tabs.forEach((tab, index) => {
            const tree = roots.has(tab.id) ? sessionTree(roots.get(tab.id), sessionAt) : panesOfTab(tab.id, sessionAt);
            const now = tree ? leavesOf(tree) : [];
            const old = before[tab.id]?.panes;
            const left = old ? leavesOf(old).filter((session) => !now.includes(session)) : [];
            const panes = old && now.every((session) => leavesOf(old).includes(session)) && left.length > 0 && left.every(isAway) ? old : tree;
            for (const session of panes ? leavesOf(panes) : []) held.add(session);
            const snapshot = { space: space.id, index, ...(panes ? { panes } : {}) };
            if (Object.entries(snapshot).some(([field, value]) => JSON.stringify(before[tab.id]?.[field]) !== JSON.stringify(value))) changeWindow(tab.id, snapshot);
          });
        }
        const live = liveTabs();
        for (const [id, w] of Object.entries(before)) {
          if (live.has(id)) continue;
          const sessions = w.panes ? leavesOf(w.panes) : [];
          if (!sessions.some(isAway) || sessions.some((session) => held.has(session))) changeWindow(id, null);
        }
        this.tabsRecorded = key;
      } catch (error) {
        console.error(`anyhost could not read the tab layouts: ${messageOf(error)}`);
      } finally {
        this.isRecordingTabs = false;
      }
    });
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

  searched(cx) {
    this.found = this.foundOf(this.model);
    if (this.found === null) this.opened.delete(FOUND_ARCHIVED);
    this.placeParts(cx);
    this.redrawAll(cx);
  }

  foundOf(model) {
    const query = this.search.value().trim().toLowerCase();
    if (query === "" || !model) return null;
    const matches = model.rows.filter((r) => this.searchedOf(r).includes(query));
    return { rows: matches.filter((r) => !r.archived).slice(0, FOUND_MAX), archived: matches.filter((r) => r.archived).slice(0, FOUND_MAX) };
  }

  foundShown() {
    const { rows, archived } = this.found;
    if (archived.length === 0) return rows;
    return [...rows, { key: shelfStop(FOUND_ARCHIVED), shelf: FOUND_ARCHIVED }, ...(this.opened.has(FOUND_ARCHIVED) ? archived : [])];
  }

  renderInbox(t, cx) {
    if (this.shown?.isNarrow) return this.rail(t, this.shown.railed);
    return this.frameOf(t, this.headView ?? this.renderHead(t), this.listView ?? this.renderList(t, cx));
  }

  renderHead(t) {
    const shown = this.shown;
    const filter = shown?.filter ?? filterOf();
    const projectName = shown?.projectName ?? null;
    return v_flex().flex_none().child(this.searchBar(t, filter, projectName)).children(shown === null ? [] : this.filterChips(t, filter, projectName));
  }

  renderList(t, cx) {
    const shown = this.shown;
    if (shown === null || shown.isNarrow) return this.listFrame(t, [this.empty(t, "Reading your sessions…")], []);
    const { model, filter } = shown;
    const isHolding = this.isPointerIn || this.keys.is_focused();
    if (!isHolding || this.frozen?.view !== shown.filterKey) {
      this.frozen = isHolding ? { view: shown.filterKey, sections: shown.sectionKeys } : null;
      this.arrived = 0;
    }
    const held = this.frozen?.sections ?? shown.sectionKeys;
    const rowsOf = (keys) => keys.map((key) => model.byKey.get(key)).filter(Boolean);
    const placed = { pinned: rowsOf(held.pinned), active: rowsOf(held.active) };
    const mounted = new Set();
    const ctx = { t, shown: shown.terminal, model, filter, mounted };
    const shelves = this.shelvesOf(held, shown);
    const found = this.found === null ? null : this.foundShown();
    this.visible = found ?? [...placed.pinned, ...placed.active, ...shelves.visible];
    const body = found !== null ? this.foundRows(ctx, found) : this.listRows(ctx, placed, shelves);
    this.mounted = mounted;
    if (this.isArriving) cx.timer.after(FRAME_MS, (cx) => cx.notify());
    if (this.departing.size > 0) cx.timer.after(UI.motion.duration + FRAME_MS, (cx) => cx.notify());
    return this.listFrame(t, body, found === null && this.arrived > 0 ? [this.arrivals(t, this.arrived)] : []);
  }

  listFrame(t, body, over) {
    const list = v_flex()
      .id("ah-list")
      .flex_1()
      .min_h(0)
      .px(UI.space.sm)
      .pb(UI.space.sm)
      .gap(1)
      .overflow_y_scrollbar()
      .track_scroll(this.listScroll)
      .on_size_change((size, cx) => {
        if (size.height === this.listHeight) return;
        this.listHeight = size.height;
        this.isToggling = true;
        cx.notify();
      })
      .on_hover((on, cx) => {
        this.isPointerIn = on;
        this.redrawList(cx);
      })
      .children(body);
    return v_flex()
      .relative()
      .size_full()
      .min_h(0)
      .child(list)
      .children(over.map((el) => h_flex().absolute().top(UI.space.xs).left(0).right(0).justify_center().child(el)));
  }

  frameOf(t, head, list) {
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
      .child(head)
      .child(v_flex().flex_1().min_h(0).child(list))
      .when(this.pressed?.isMoving === true, (el) => el.child(this.dragCatcher()));
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
      return { key: r.key, r, height: CARD_HEIGHT + (subs.isOpen ? UI.space.xs : 0) + subs.height, el: () => this.cardFor(ctx, r, ctx.mounted) };
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
    const isEmpty = sections.pinned.length + sections.active.length === 0 && shelves.length === 0;
    const drag = this.pressed?.isMoving && this.pressed.sortable ? this.pressed : null;
    const offsets = drag ? drag.offsets() : new Map();
    const motion = this.motionOf(blocks, model);
    const items = [...blocks["ah-active"], ...blocks["ah-shelves"]];
    const placed = [...items.filter((item) => item.key !== drag?.id), ...items.filter((item) => item.key === drag?.id)];
    const rows = placed.map((item) => {
      const at = motion.layout.get(item.key);
      if (item.key === drag?.id) return this.placedAt(item.key, at.y + drag.shift, 1, INSTANT, item.el());
      const isEntering = motion.isMoving && motion.before.get(item.key)?.block !== at.block;
      return this.placedAt(item.key, isEntering ? at.y - Math.min(item.height, MOTION_TRAVEL) : at.y + (offsets.get(item.key) ?? 0), isEntering ? 0 : 1, motion.isMoving ? UI.motion : INSTANT, item.el());
    });
    const gone = [...this.departing].map(([key, was]) => this.placedAt(key, was.y - Math.min(was.height, MOTION_TRAVEL), 0, UI.motion, this.cardFor(ctx, model.byKey.get(key), ctx.mounted)));
    const sizer = div().id("ah-content").flex_none().w_full().h(motion.contentHeight);
    const before = isEmpty ? [this.empty(t, this.emptyLine(ctx.filter))] : [sizer];
    this.childAt = new Map(placed.map((item, at) => [item.key, before.length + at]));
    const revealed = shelves.find((shelf) => shelf.id === this.revealing);
    if (revealed) this.listScroll.scroll_to_item(this.childAt.get(revealed.more > 0 ? `more-${revealed.id}` : (revealed.shown.at(-1)?.key ?? shelfStop(revealed.id))));
    this.revealing = null;
    return [...before, ...rows, ...gone];
  }

  motionOf(blocks, model) {
    const layout = new Map();
    const heights = {};
    for (const [block, items] of Object.entries(blocks)) {
      let top = 0;
      for (const { key, height, r } of items) {
        layout.set(key, { block, top, height, isCard: Boolean(r) });
        top += height + 1;
      }
      heights[block] = Math.max(0, top - 1);
    }
    const inner = Math.max(0, (this.listHeight ?? 0) - UI.space.sm);
    const push = Math.max(UI.space.sm, inner - heights["ah-active"] - heights["ah-shelves"] - 2);
    const shelvesAt = heights["ah-active"] + 1 + push + 1;
    for (const at of layout.values()) at.y = (at.block === "ah-shelves" ? shelvesAt : 0) + at.top;
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
    return { layout, before, isMoving, contentHeight: shelvesAt + heights["ah-shelves"] };
  }

  liftedAt(el, from, area, dx, dy) {
    return v_flex()
      .absolute()
      .left(from.x - area.x + dx)
      .top(from.y - area.y + dy)
      .w(from.width)
      .child(el);
  }

  placedAt(key, top, opacity, policy, el) {
    return div().id(`ah-at-${key}`).absolute().top(top).left(UI.space.sm).right(UI.space.sm).opacity(opacity).transition("top", policy).transition("opacity", policy).child(el);
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
    const ringed = el.border(1).border_color(isSelected && !this.isDark ? t.border : "#00000000");
    if (isDragged) return ringed.bg(t.raised).shadow_md().cursor_grabbing();
    if (isSelected) return ringed.bg(this.isDark ? t.selected : t.raised);
    return ringed.hover((s) => hover(s.bg(t.hover)));
  }

  emptyLine(filter) {
    if (!isFiltered(filter)) return "All caught up";
    if (filter.project === null || isFiltered({ ...filter, project: null, worktree: null })) return "Nothing here matches the filter";
    return `No open sessions in ${projectNameOf(filter.project, this.namesNow())}`;
  }

  sectionHead(t, id, label) {
    return this.item(`ah-head-${id}`).gap(UI.space.sm).text_size(UI.text.caption).font_medium().text_color(t.muted).child(div().flex_none().child(label)).child(div().flex_1().h(1).bg(t.border));
  }

  foundRows(ctx, shown) {
    const { rows, archived } = this.found;
    const before = rows.length === 0 ? [this.empty(ctx.t, archived.length === 0 ? "No sessions found" : "No open sessions found")] : [];
    this.childAt = new Map(shown.map((item, at) => [item.key, before.length + at]));
    return [...before, ...shown.map((item) => (item.shelf ? this.shelf(ctx.t, { id: item.shelf, label: "Archived", count: archived.length, isOpen: this.opened.has(item.shelf) }) : this.cardFor(ctx, item, ctx.mounted)))];
  }

  toggleShelf(id, cx) {
    const isFound = id === FOUND_ARCHIVED;
    if (!this.opened.delete(id)) {
      this.opened.add(id);
      if (!isFound) this.revealing = id;
    }
    if (!isFound) preferEntry("shelves", id, this.opened.has(id) ? true : null);
    this.isToggling = true;
    this.redrawList(cx);
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
          .child(this.searchField(t, this.search, (cx) => this.searched(cx))),
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
      .child(this.iconButton(t, "ah-new", "square-pen", projectName ? `New session in ${projectName}` : "New session", () => this.newHere()));
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

  newHere() {
    const { project, worktree } = filterOf();
    const known = project === null || project === NONE ? null : (this.model?.pulse ?? shared(PULSE))?.projects.find((p) => p.key === project);
    return known ? this.startIn(known, worktree ?? {}) : this.newSession();
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
    if (!hasWorktrees(r.projectKey)) return null;
    if ((this.model?.worktrees.get(`${r.projectKey}\0${r.machine}`)?.size ?? 0) < 2) return null;
    return this.branchOf(r.machine, r.checkout)?.branch ?? r.checkout.split("/").pop();
  }

  row(ctx, r, { withShelf = false } = {}) {
    const { t, shown, model } = ctx;
    const isShown = Boolean(r.address) && (r.address === shown || r.views.includes(shown));
    const isHovered = this.hovered === r.key && this.pressed?.isMoving !== true;
    const isFaded = recedes(r, isShown);
    const opening = isOpening(r.key) && !r.address;
    const status = isHovered ? this.actions(t, r) : opening ? this.spinnerLabel(t, "Opening") : this.status(t, r);
    const frame = this.frame(t, r, isShown);
    const worktree = this.worktreeOf(r);
    const shelfName = r.deleted ? "Deleted" : r.archived ? "Archived" : r.section === "snoozed" ? "Snoozed" : r.section === "settled" ? "Settled" : null;
    const source = r.session.source ? model.byKey.get(r.session.source) : undefined;
    const meta = [withShelf ? shelfName : null, r.projectName, r.isRemote ? this.placeOf(r.machine) : null, r.app, r.isChild ? `subagent of ${model.byKey.get(r.parent)?.title?.slice(0, 30) ?? ""}` : source ? `fork of ${source.title.slice(0, 30)}` : null].filter(Boolean).join(" · ");
    const subs = this.subsOf(r, model);
    const tags = r.tags.map((id) => this.data.tags[id]).filter(Boolean);
    const stage = this.data.stages.find((s) => s.id === r.stage);
    return frame
      .child(
        v_flex()
          .px(UI.space.sm)
          .py(UI.space.xs)
          .opacity(isFaded && !isHovered ? 0.7 : 1)
          .transition("opacity", UI.motion)
          .child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.xs)
              .items_center()
              .child(this.mark(t, r.projectName, false, !hasWorktrees(r.projectKey)))
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
              .child(div().min_w(0).truncate().text_size(UI.text.body).when(r.isUnread, (el) => el.font_semibold()).when(!isFaded && !r.isUnread, (el) => el.font_medium()).text_color(isFaded ? t.muted : t.foreground).child(r.title))
              .child(div().flex_1())
              .when(subs.rows.length > 0, (line) => line.child(this.subagentFold(t, r, subs))),
          )
          .child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.xs)
              .items_center()
              .when(Boolean(stage), (row) => row.child(this.chip(t, stage.name, this.tagColor("gray"), { isOutlined: true })))
              .children(tags.slice(0, 3).map((tag) => this.chip(t, tag.name, this.tagColor(tag.color))))
              .when(tags.length > 3, (row) => row.child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(`+${tags.length - 3}`)))
              .child(div().flex_1().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(r.lastSaid || "No reply yet")),
          ),
      )
      .when(subs.isOpen, (el) => el.pb(UI.space.xs).children(this.subRows(ctx, subs)));
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
    return this.stateChip(t, r.state, r.state === "done" ? r.label : `${r.label} ${ago(r.since)}`);
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
    const pin = this.iconButton(t, `ah-pin-${r.key}`, r.pinned ? "pin-off" : "pin", r.pinned ? "Unpin" : "Pin", () => this.act((cx) => this.togglePin(cx, r)), UI.height.inline);
    const settle = this.iconButton(t, `ah-settle-${r.key}`, "check", "Settle", () => this.act((cx) => this.settle(cx, r)), UI.height.inline);
    return h_flex().flex_none().gap(UI.space.xs).items_center().child(pin).child(settle);
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
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  frame(t, r, isShown) {
    const isReordered = r.section === "pinned" && this.found === null;
    const canDrag = isReordered || Boolean(r.address);
    const isDragged = this.pressed?.isMoving === true && this.pressed.id === r.key;
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
        cx.notify();
      })
      .when(canDrag, (el) =>
        el.on_mouse_down("left", (e) => {
          this.dropped = null;
          this.pressed = new Drag(r.key, e.position, { address: r.address, title: r.title, sortable: isReordered ? this.pinSortable() : null });
        }),
      )
      .on_click(() => {
        if (this.wasDragged(r.key)) return;
        this.act((cx) => this.open(r, cx));
      })
      .on_mouse_down("right", () => this.menu(r));
  }

  subsOf(r, model, root = r) {
    const children = (model.childrenOf.get(r.key) ?? [])
      .filter((c) => (!c.archived || r.archived) && (!c.deleted || r.deleted))
      .sort(byUrgency)
      .map((c) => {
        const subs = this.subsOf(c, model, root);
        return { id: `ah-child-${c.key}`, row: c, subs, height: SUBAGENT_HEIGHT + subs.height, open: (cx) => this.showSubagent(cx, root, c) };
      });
    const kids = r.address
      ? (model.kidsOf.get(r.address) ?? []).map((k) => ({
          id: `ah-kid-${k.address}`,
          kid: { title: k.name || k.template || k.program?.name || k.address, program: k.program, state: model.statusOf.get(k.address)?.status ?? "idle" },
          height: UI.height.row,
          open: () => run(model.statusOf.has(k.address) ? "pane.focus" : "terminal.peek", { terminal: k.address }),
        }))
      : [];
    const rows = [...children, ...kids];
    const isOpen = rows.length > 0 && this.unfolded.has(r.key);
    return { rows, isOpen, height: isOpen ? rows.reduce((sum, row) => sum + row.height, 0) : 0 };
  }

  showSubagent(cx, parent, r) {
    const pane = parent.address ? panes().find((p) => p.terminal === parent.address) : undefined;
    if (pane) this.focusTerminal(parent.address, pane);
    else if (r.address || parent.deleted || parent.archived) this.open(parent, cx);
    if (r.archived) this.archive(cx, r, false);
    this.present(cx, r, "panel");
  }

  rootOf(r) {
    const seen = new Set();
    let root = r;
    while (root.isChild && !seen.has(root.key)) {
      seen.add(root.key);
      root = this.model.byKey.get(root.parent) ?? root;
    }
    return root;
  }

  subagentFold(t, r, subs) {
    const count = subs.rows.length;
    return h_flex()
      .id(`ah-fold-${r.key}`)
      .h(UI.height.inline)
      .gap(UI.space.xs)
      .flex_none()
      .items_center()
      .text_size(UI.text.caption)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!this.unfolded.delete(r.key)) this.unfolded.add(r.key);
        preferEntry("unfolded", r.key, this.unfolded.has(r.key) ? true : null);
        this.act((cx) => this.redrawList(cx));
      })
      .child(count === 1 ? "Subagent" : "Subagents")
      .child(div().font_normal().child(String(count)))
      .child(svg(`${ICON}/chevron-${subs.isOpen ? "down" : "right"}.svg`).size(UI.icon.small).flex_none());
  }

  subRows(ctx, subs, depth = 0) {
    const { t, shown } = ctx;
    return subs.rows.flatMap((s) => {
      const r = s.row;
      const isFaded = r !== undefined && recedes(r, Boolean(r.address) && (r.address === shown || r.views.includes(shown)));
      const lead = r !== undefined ? this.harnessIcon(t, r) : (this.programIcon(s.kid.program, t.dim) ?? div().size(UI.icon.body).flex_none());
      const status = r !== undefined ? this.status(t, r) : s.kid.state === "idle" ? null : this.stateChip(t, s.kid.state, (STATE[s.kid.state] ?? STATE.idle).name);
      const entry = v_flex()
        .id(s.id)
        .h(s.height - (s.subs?.height ?? 0))
        .flex_none()
        .pl(UI.space.sm + depth * UI.space.lg)
        .pr(UI.space.sm)
        .justify_center()
        .rounded(UI.radius.control)
        .cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .opacity(isFaded ? 0.7 : 1)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.act((cx) => s.open(cx));
        })
        .when(r !== undefined, (el) =>
          el.on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            this.menu(r);
          }),
        )
        .child(
          h_flex()
            .h(UI.height.inline)
            .gap(UI.space.sm)
            .items_center()
            .child(lead)
            .child(div().flex_1().min_w(0).truncate().text_size(UI.text.caption).when(r?.isUnread === true, (el) => el.font_semibold()).text_color(isFaded ? t.muted : t.foreground).child(r?.title ?? s.kid.title))
            .when(status !== null, (line) => line.child(status)),
        )
        .when(r !== undefined, (el) =>
          el.child(
            h_flex()
              .h(UI.height.inline)
              .gap(UI.space.sm)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(r.lastSaid || "No reply yet"))
              .when(s.subs.rows.length > 0, (row) => row.child(this.subagentFold(t, r, s.subs))),
          ),
        );
      return s.subs?.isOpen ? [entry, ...this.subRows(ctx, s.subs, depth + 1)] : [entry];
    });
  }

  handOffTerminalMenu(given) {
    closeOverlay(given.overlay);
    const pane = panes().find((p) => p.pane === given.target?.pane);
    if (pane) return this.windowMenu(windowFacts(pane.tab, pane.pane));
    const key = terminals().find((x) => x.address === given.target?.terminal)?.labels?.[SESSION_LABEL];
    const r = key ? shared(PULSE)?.sessions?.[key] : null;
    if (r) this.menu({ key, ...r });
  }

  takeToast(given) {
    closeOverlay(given.overlay);
    const terminal = given.action?.args?.terminal ?? null;
    const key = terminal ? (terminals().find((x) => x.address === terminal)?.labels?.[SESSION_LABEL] ?? null) : null;
    if (key !== null && (wantedOf()?.session === key || Date.now() - ((shared(OPENED) ?? {})[key] ?? 0) < OPEN_QUIET_MS)) return;
    const facts = key === null ? null : (shared(PULSE)?.sessions?.[key] ?? null);
    const toast = {
      id: idOf(),
      at: Date.now(),
      title: given.title,
      body: given.body ?? "",
      level: TOAST_LOOK[given.level] ? given.level : "info",
      icon: given.icon ?? null,
      action: given.action ?? null,
      hold: given.hold ?? null,
      timeout: given.timeout ?? (given.level === "error" ? TOAST_ERROR_MS : TOAST_MS),
      session: facts === null ? null : { title: facts.title, project: facts.projectName ?? "", machine: facts.machine ?? "", tool: facts.tool ?? "claude" },
    };
    setShared(TOASTS, [toast, ...(shared(TOASTS) ?? []).filter((x) => x.title !== toast.title || x.body !== toast.body)].slice(0, TOAST_MOST));
  }

  initToasts(cx) {
    this.hoveredToast = null;
    cx.timer.every(TOAST_TICK_MS, (cx) => {
      const all = shared(TOASTS) ?? [];
      if (all.length === 0) return;
      const now = Date.now();
      const live = all.filter((x) => x.id === this.hoveredToast || now - x.at < x.timeout);
      if (live.length === all.length) return;
      setShared(TOASTS, live);
      cx.notify();
    });
  }

  dismissToast(id) {
    setShared(TOASTS, (shared(TOASTS) ?? []).filter((x) => x.id !== id));
  }

  renderToasts(t) {
    const all = shared(TOASTS) ?? [];
    if (all.length === 0) return div();
    return v_flex()
      .id("ah-toasts")
      .w(TOAST_WIDTH)
      .text_color(t.foreground)
      .children(all.flatMap((x, n) => [...(n > 0 ? [div().h(1).mx(UI.space.md).flex_none().bg(t.border)] : []), this.toastRow(t, x)]));
  }

  toastRow(t, x) {
    const look = TOAST_LOOK[x.level];
    const color = x.level === "error" ? t.ansi1 : x.level === "info" ? t.muted : look.colors[this.isDark ? 1 : 0];
    const where = x.session ? [x.session.project, x.session.machine !== shared(PULSE)?.here ? x.session.machine : ""].filter(Boolean).join(" · ") : "";
    const title = x.session ? x.session.title : x.title;
    const body = x.session ? x.title : x.body;
    const lead = x.session ? this.harnessIcon(t, { key: `toast-${x.id}`, harness: x.session.tool }) : x.icon ? image(x.icon).size(UI.icon.body).flex_none() : svg(iconPath(look.icon)).size(UI.icon.body).flex_none().text_color(color);
    return v_flex()
      .id(`ah-toast-${x.id}`)
      .w_full()
      .when(x.action !== null, (el) => el.cursor_pointer())
      .on_hover((on, cx) => {
        if (on) this.hoveredToast = x.id;
        else if (this.hoveredToast === x.id) {
          this.hoveredToast = null;
          setShared(TOASTS, (shared(TOASTS) ?? []).map((each) => (each.id === x.id ? { ...each, at: Date.now() } : each)));
        }
        cx.notify();
      })
      .on_click(() => {
        if (x.hold) undoHeld(x.hold);
        else if (x.action?.name) run(x.action.name, x.action.args ?? {});
        this.dismissToast(x.id);
      })
      .child(
        h_flex()
          .w_full()
          .px(UI.space.md)
          .py(UI.space.sm)
          .gap(UI.space.sm)
          .items_start()
          .child(div().h(UI.height.inline).flex().flex_none().items_center().child(lead))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(UI.space.xs)
              .child(div().min_h(UI.height.inline).flex().items_center().child(div().truncate().text_size(UI.text.body).font_semibold().child(title)))
              .when(body !== "", (el) => el.child(div().text_size(UI.text.caption).text_color(t.muted).child(body)))
              .when(where !== "", (el) => el.child(div().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(where))),
          )
          .child(this.iconButton(t, `ah-toast-close-${x.id}`, "x", "Dismiss", () => this.dismissToast(x.id), UI.height.inline)),
      );
  }

  windowMenu(window) {
    const pulse = shared(PULSE);
    const r = window.session ? (pulse?.sessions?.[window.session] ?? null) : null;
    this.menu(r === null ? null : { key: window.session, ...r }, window);
  }

  menu(r, window = null) {
    const pulse = shared(PULSE);
    const shown = { view: "menu", window, canReopen: (pulse?.closed ?? []).length > 0, key: null, ...(r === null ? {} : this.sessionMenuOf(r.session ? this.factsOf(r) : r)) };
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: MENU_WIDTH * 2 + UI.space.sm, height: menuSizeOf(this.sessionMenuGroups(shown)), props: shown });
  }

  sessionMenuOf(f) {
    const pulse = shared(PULSE);
    const at = focused();
    const tabs = at?.space ? (spaces().find((sp) => sp.id === at.space)?.tabs ?? []).filter((x) => !panes().some((p) => p.tab === x.id && p.terminal === f.address)).map((x) => ({ id: x.id, name: x.name })) : [];
    return {
      key: f.key,
      title: f.title,
      row: f,
      isChild: Boolean(f.isChild),
      hasTerminal: Boolean(f.address),
      canSleep: Boolean(f.address) && f.tool === "claude",
      isLocal: Boolean(f.address) && !f.address.includes("/"),
      canShowHere: Boolean(at?.pane) && f.tool === "claude" && !f.archived && !f.deleted && at?.terminal !== f.address && !(f.views ?? []).includes(at?.terminal),
      pinned: f.pinned,
      settled: f.section === "settled",
      snoozed: f.section === "snoozed",
      archived: f.archived,
      deleted: f.deleted,
      state: f.state,
      isUnread: f.isUnread,
      isFiltered: filterOf().project === f.projectKey,
      projectName: f.projectName,
      canStartHere: f.projectKey !== TEMPORARY,
      cwd: f.cwd,
      tabs,
      targets: f.tool === "claude" && !f.isRemote && !f.archived && !f.deleted ? (pulse?.targets ?? []) : [],
      tags: this.data?.tags ?? pulse?.tags ?? {},
      tagged: f.tags ?? [],
      stages: this.data?.stages ?? pulse?.stages ?? [],
      stage: f.stage ?? "",
    };
  }

  key(e, cx) {
    if (e.key === "escape" && this.search.value() !== "") {
      this.search.set_value("");
      return this.searched(cx);
    }
    if (this.visible === undefined || this.isSearching) return;
    const at = this.visible.findIndex((r) => r.key === this.cursor);
    const r = this.visible[at] ?? null;
    const step = reorderStepOf(e);
    if (step) return r?.section === "pinned" && this.found === null ? this.movePin(cx, r, step) : undefined;
    const roved = rovedTo(e, at, this.visible.length, { letters: true });
    if (roved !== null) return this.moveCursor(cx, this.visible[roved].key);
    if (e.key === "/") return this.search.focus();
    if (e.key === "escape") return this.moveCursor(cx, null);
    const target = r ?? this.model?.rows.find((row) => row.address && (row.address === this.live?.shown || row.views.includes(this.live?.shown)));
    if (r?.shelf && (e.key === "enter" || e.key === "space")) return this.toggleShelf(r.shelf, cx);
    if (e.keystroke === "cmd-shift-s" && target?.session && !target.archived && !target.deleted) return this.toggleSettle(cx, target);
    if (!r?.session) return;
    if (e.key === "enter") return this.act((cx) => this.open(r, cx));
    if (e.key === "space") return this.peek(r);
    if (e.key === "u") return r.isUnread ? this.markRead(cx, r) : this.markUnread(cx, r);
    if (e.key === "e") return r.archived ? this.archive(cx, r, false) : this.archiveAll(cx, [r]);
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
        this.redrawList(cx);
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
        this.redrawList(cx);
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
            .child(this.mark(t, r.projectName, false, !hasWorktrees(r.projectKey)))
            .child(svg(iconPath(STATE[r.state].icon)).size(UI.icon.small).text_color(this.stateColor(r.state))),
        ),
      );
  }

  programIcon(program, color) {
    if (!program?.icon) return null;
    return program.tint ? svg(program.icon).size(UI.icon.body).flex_none().text_color(color) : image(program.icon).size(UI.icon.body).flex_none();
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
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(iconPath(icon)).size(size === UI.height.inline ? UI.icon.small : UI.icon.body));
  }

  hueFor(name) {
    return hueOf(name || "~")[this.isDark ? 1 : 0];
  }

  mark(t, name, dim = false, isFolder = false) {
    if (isFolder) return div().size(UI.icon.lead).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg(`${ICON}/folder.svg`).size(UI.icon.body));
    const hue = this.hueFor(name);
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
    this.listView = cx.new(Part, { owner: this, key: LIST_PART });
    this.liftedView = cx.new(Part, { owner: this, key: LIFTED_PART });
    this.refreshProjects();
    this.placeParts(cx);
    this.runActs(cx, (cx) => this.syncProjects(cx));
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
    this.redrawChanged(cx, this.placeParts(cx));
  }

  refreshProjects() {
    const pulse = shared(PULSE);
    const filter = filterOf();
    const isHolding = this.isPointerIn || this.keys.is_focused();
    const isNarrow = narrow();
    const outbox = JSON.stringify(outboxOf());
    const key = `${JSON.stringify(pulse)}|${JSON.stringify(filter)}|${isHolding}|${isNarrow}|${this.order?.join("\0")}|${outbox}`;
    if (key === this.projectsKey) return false;
    this.projectsKey = key;
    if (!pulse) return false;
    const order = orderIn("order", pulse.projectOrder);
    const shown = [...pulse.projects].sort((a, b) => placeIn(order, a.key) - placeIn(order, b.key));
    if (!isHolding || this.order === null) this.order = shown.map((p) => p.key);
    const byKey = new Map(pulse.projects.map((p) => [p.key, p]));
    const projects = [...this.order.map((key) => byKey.get(key)).filter(Boolean), ...pulse.projects.filter((p) => !this.order.includes(p.key))];
    this.entries = projects.flatMap((p) => [{ id: p.key, project: p, worktree: null }, ...(p.worktrees.length > 1 ? this.worktreesShown(p) : []).map((w) => ({ id: `${p.key}\0${worktreeIdOf(w)}`, project: p, worktree: w }))]);
    this.projectsView = { pulse, filter, projects, isNarrow, byId: new Map(this.entries.map((entry) => [entry.id, entry])) };
    return true;
  }

  worktreesShown(p) {
    const ids = orderIn(`worktrees:${p.key}`, p.worktrees.map(worktreeIdOf));
    const byId = new Map(p.worktrees.map((w) => [worktreeIdOf(w), w]));
    return [...ids.map((id) => byId.get(id)).filter(Boolean), ...p.worktrees.filter((w) => !ids.includes(worktreeIdOf(w)))];
  }

  renderProjects(t) {
    if (this.projectsView === null) return v_flex().size_full().bg(t.chrome).child(this.empty(t, "Reading your projects…"));
    const { pulse, filter, projects, isNarrow } = this.projectsView;
    if (isNarrow) return this.projectsRail(t, projects, filter);
    const drag = this.pressed?.isMoving ? this.pressed : null;
    return v_flex()
      .id("anyhost-projects")
      .relative()
      .track_focus(this.keys)
      .on_key_down((e, cx) => this.projectKey(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .on_mouse_move((e, cx) => {
        this.paneAt = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        const drag = this.pressed;
        if (!drag) return;
        if (drag.moveTo(e.position)) {
          this.dragKeys.focus();
          return this.redrawDragStart(cx, drag.project === undefined ? drag.id : `${drag.project}\0${drag.id}`);
        }
        if (drag.isMoving) this.redrawDrag(cx);
      })
      .on_hover((on, cx) => {
        if (!on) this.leaveDrag(cx, false);
      })
      .on_mouse_up("left", (_e, cx) => this.dropProject(cx))
      .child(div().px(UI.space.sm).pt(UI.space.sm).flex_none().child(this.allCard(t, pulse, filter.project === null)))
      .child(v_flex().flex_1().min_h(0).child(this.listView))
      .when(drag !== null, (el) => el.child(this.liftedView).child(this.dragCatcher()));
  }

  isLiftedEntry(drag, entry) {
    return drag !== null && (drag.project === undefined ? entry.project.key === drag.id : entry.project.key === drag.project && worktreeIdOf(entry.worktree ?? {}) === drag.id);
  }

  renderProjectList(t) {
    if (this.projectsView === null) return div();
    const mounted = new Set();
    this.mounted = mounted;
    const drag = this.pressed?.isMoving ? this.pressed : null;
    const offsets = drag?.sortable ? drag.offsets() : null;
    const offsetOf = (entry) => (offsets === null ? 0 : drag.project === undefined ? offsets.get(entry.project.key) : entry.project.key === drag.project && entry.worktree ? offsets.get(worktreeIdOf(entry.worktree)) : 0) ?? 0;
    const isHidden = (entry) => Boolean(drag?.bounds && this.paneAt) && this.isLiftedEntry(drag, entry);
    this.childAt = new Map(this.entries.map((entry, at) => [entry.id, at]));
    return v_flex()
      .id("ah-projects")
      .size_full()
      .min_h(0)
      .px(UI.space.sm)
      .pb(UI.space.sm)
      .gap(1)
      .overflow_y_scrollbar()
      .track_scroll(this.projectsScroll)
      .on_hover((on) => {
        this.isPointerIn = on;
        this.act(() => undefined);
      })
      .children(this.entries.map((entry) => this.slide(v_flex().id(`ah-at-${entry.id}`).flex_none().opacity(isHidden(entry) ? 0 : 1).child(this.partFor(entry.id, mounted, () => this.entryElement(t, entry))), "y", offsetOf(entry), drag !== null)));
  }

  slide(el, axis, offset, isSliding) {
    const edge = axis === "x" ? "left" : "top";
    const moved = el.relative()[edge](offset);
    return isSliding ? moved.transition(edge, UI.motion) : moved;
  }

  entryElement(t, entry, isGhost = false) {
    const { pulse, filter } = this.projectsView;
    if (entry.worktree) return this.worktreeRow(t, entry, pulse, filter, isGhost);
    return this.projectCard(t, entry.project, pulse, filter.project === entry.project.key && (filter.worktree === null || entry.project.worktrees.length < 2), isGhost);
  }

  projectSortable() {
    const ids = this.entries.filter((entry) => !entry.worktree).map((entry) => entry.id);
    const heightOf = (key) => this.entries.filter((entry) => entry.project.key === key).reduce((sum, entry, at) => sum + (at > 0 ? 1 : 0) + (entry.worktree ? UI.height.control : UI.height.row), 0);
    return { ids, sizes: ids.map(heightOf), gap: 1, axis: "y" };
  }

  worktreeSortable(p) {
    const ids = this.worktreesShown(p).map(worktreeIdOf);
    return { ids, sizes: ids.map(() => UI.height.control), gap: 1, axis: "y" };
  }

  reorderProjects(order, project) {
    this.order = order;
    const before = order.slice(order.indexOf(project) + 1).find((key) => key !== NONE) ?? null;
    queueMove("order", orderIn("order", this.projectsView?.pulse.projectOrder ?? []), [project], before, { op: "moveProjects", projects: [project], before });
  }

  reorderWorktrees(key, order, id) {
    const p = this.projectsView?.pulse.projects.find((each) => each.key === key);
    const before = neighbourAfter(order, id);
    if (p) queueMove(`worktrees:${key}`, orderIn(`worktrees:${key}`, p.worktrees.map(worktreeIdOf)), [id], before, { op: "moveWorktrees", project: key, worktrees: [worktreeOf(id)], before: before === null ? null : worktreeOf(before) });
  }

  moveEntry(cx, entry, step) {
    const ids = entry.worktree ? this.worktreesShown(entry.project).map(worktreeIdOf) : this.entries.filter((each) => !each.worktree).map((each) => each.id);
    const at = ids.indexOf(entry.worktree ? worktreeIdOf(entry.worktree) : entry.id);
    if (at < 0 || entry.id === NONE || ids[at + step] === undefined || ids[at + step] === NONE) return;
    if (entry.worktree) this.reorderWorktrees(entry.project.key, movedTo(ids, at, at + step), ids[at]);
    else this.reorderProjects(movedTo(ids, at, at + step), ids[at]);
    this.refreshProjects();
    this.placeParts(cx);
    const shown = this.entries.findIndex((each) => each.id === entry.id);
    if (shown >= 0) this.projectsScroll.scroll_to_item(shown);
  }

  projectKey(e, cx) {
    const at = this.entries.findIndex((entry) => entry.id === this.cursor);
    const step = reorderStepOf(e);
    if (step) {
      if (at >= 0) this.moveEntry(cx, this.entries[at], step);
      return this.redrawAll(cx);
    }
    const roved = rovedTo(e, this.cursor === ALL ? 0 : at < 0 ? -1 : at + 1, this.entries.length + 1, { letters: true });
    if (roved !== null) {
      if (roved > 0) this.projectsScroll.scroll_to_item(roved - 1);
      return this.moveCursor(cx, roved === 0 ? ALL : this.entries[roved - 1].id);
    }
    const entry = this.entries[at] ?? null;
    if (e.key === "enter" && entry) this.pickEntry(entry);
    if (e.key === "enter" && !entry) setFilter({ project: null });
    if (e.key === "n" && entry) this.startIn(entry.project, entry.worktree ?? {});
    if (e.key === "escape") run("pane.go", { direction: "right" });
    this.redrawAll(cx);
  }

  pickEntry(entry) {
    return entry.worktree ? this.pickWorktree(entry.project, entry.worktree) : this.pickProject(entry.project);
  }

  counts(t, counts) {
    const count = (state) =>
      h_flex()
        .id(`ah-count-${state}`)
        .flex_none()
        .gap(UI.space.xs)
        .items_center()
        .text_size(UI.text.caption)
        .font_medium()
        .text_color(this.stateColor(state))
        .tooltip(STATE[state].name)
        .child(svg(iconPath(STATE[state].icon)).size(UI.icon.small).flex_none())
        .child(String(counts[state]));
    return h_flex().flex_none().gap(UI.space.sm).items_center().children(Object.keys(STATE).filter((state) => counts[state] > 0).map(count));
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
    return this.item("ah-project-all")
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected }))
      .relative()
      .when(this.isCursorOn(ALL), (el) => el.child(this.ring(t)))
      .on_click(() => {
        this.cursor = null;
        setFilter({ project: null });
      })
      .child(this.leadIcon("layers").text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().child("All projects"))
      .child(this.counts(t, pulse.all));
  }

  projectCard(t, p, pulse, isSelected, isGhost = false) {
    const id = `project:${p.key}`;
    const hovered = this.hovered === id;
    const canStart = Object.values(p.checkouts ?? {}).some((list) => list.length > 0);
    const isMoving = this.pressed?.isMoving === true;
    return this.item(`ah-${id}`)
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected, isDragged: isGhost }))
      .relative()
      .when(this.isCursorOn(p.key), (el) => el.child(this.ring(t)))
      .on_hover((on, cx) => {
        if (on) this.hovered = id;
        else if (this.hovered === id) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.dropped = null;
        if (p.key !== NONE) this.pressed = new Drag(p.key, e.position, { bounds: e.bounds ?? null, sortable: this.projectSortable() });
      })
      .when(Boolean(shared(DRAG_TAB)) && hovered, (el) => el.bg(t.selected).child(this.ring(t)))
      .on_mouse_up("left", () => shared(DRAG_TAB) && this.dropTabOn(p, null))
      .on_click(() => {
        if (this.wasDragged(p.key)) return;
        this.pickProject(p);
      })
      .on_mouse_down("right", () => this.projectMenu(p, pulse))
      .child(this.mark(t, p.name, false, p.key === NONE))
      .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).font_medium().child(p.name))
      .child(shared(DRAG_TAB) && hovered ? this.moveHere(t) : hovered && canStart && p.key !== NONE && !isMoving ? this.iconButton(t, `ah-pen-${id}`, "square-pen", `New session in ${p.name}`, () => this.startIn(p), UI.height.inline) : this.counts(t, p));
  }

  worktreeRow(t, { id, project, worktree }, pulse, filter, isGhost = false) {
    const rowId = `worktree:${hex12(`${worktree.machine}\0${worktree.folder}`)}`;
    const hovered = this.hovered === rowId;
    const isSelected = sameWorktree(filter.worktree, worktree);
    const elsewhere = worktree.machine === pulse.here ? null : pulse.all.machines.find((m) => m.name === worktree.machine)?.place ?? worktree.machine;
    const canStart = worktree.id !== null && !worktree.isGone;
    return this.item(`ah-${rowId}`)
      .h(UI.height.control)
      .pl(UI.space.sm + UI.icon.lead + UI.space.sm)
      .cursor_pointer()
      .map((el) => this.surface(el, t, { isSelected, isDragged: isGhost }))
      .relative()
      .when(this.isCursorOn(id), (el) => el.child(this.ring(t)))
      .when(!this.pressed?.isMoving, (el) => el.tooltip(worktree.isGone ? `${worktree.folder} is gone` : worktree.folder))
      .on_hover((on, cx) => {
        if (on) this.hovered = rowId;
        else if (this.hovered === rowId) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.dropped = null;
        this.pressed = new Drag(worktreeIdOf(worktree), e.position, { project: project.key, bounds: e.bounds ?? null, sortable: this.worktreeSortable(project) });
      })
      .when(Boolean(shared(DRAG_TAB)) && hovered, (el) => el.bg(t.selected).child(this.ring(t)))
      .on_mouse_up("left", () => shared(DRAG_TAB) && this.dropTabOn(project, worktree))
      .on_click(() => {
        if (this.wasDragged(worktreeIdOf(worktree))) return;
        this.pickWorktree(project, worktree);
      })
      .on_mouse_down("right", () => this.projectMenu(project, pulse, worktree))
      .child(svg(`${ICON}/git-branch.svg`).size(UI.icon.small).flex_none().text_color(isSelected ? t.foreground : t.dim))
      .child(div().flex_shrink(1).min_w(0).truncate().text_size(UI.text.body).text_color(isSelected ? t.foreground : worktree.isGone ? t.dim : t.muted).child(worktree.branch))
      .when(elsewhere !== null, (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(elsewhere)))
      .child(div().flex_1())
      .child(shared(DRAG_TAB) && hovered ? this.moveHere(t) : hovered && canStart ? this.iconButton(t, `ah-pen-${rowId}`, "square-pen", `New session in ${worktree.branch}`, () => this.startIn(project, worktree), UI.height.inline) : this.counts(t, worktree));
  }

  projectMenu(p, pulse, worktree = null) {
    const shown = { view: "menu", project: p, worktree, here: pulse.here, homes: Object.fromEntries(pulse.all.machines.map((m) => [m.name, m.home])), machines: pulse.all.machines.filter((m) => m.connected).map((m) => m.name) };
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: MENU_WIDTH * 2 + UI.space.sm, height: menuSizeOf(this.projectMenuGroups(shown)), props: shown });
  }

  moveHere(t) {
    return div().flex_none().text_size(UI.text.caption).font_medium().text_color(t.accent).child("Move here");
  }

  dropTabOn(p, worktree) {
    const drag = endTabDrag(true);
    if (!drag) return;
    const target = worktree ?? firstWorktreeOf(p.key);
    if (target === null) return notify({ title: `No checkout of ${p.name} is open here`, body: "Open one of its worktrees, then drop the tab on it.", level: "warning" });
    this.moveTab({ terminals: drag.terminals, key: p.key, worktree: { machine: target.machine, folder: target.folder }, name: worktree ? `${p.name} · ${worktree.branch}` : p.name });
  }

  dropProject(cx) {
    const drag = this.pressed;
    this.pressed = null;
    if (!drag?.isMoving) return;
    this.dropped = drag.id;
    if (drag.target !== drag.from) {
      if (drag.project === undefined) this.reorderProjects(drag.sorted(), drag.id);
      else this.reorderWorktrees(drag.project, drag.sorted(), drag.id);
      this.refreshProjects();
      this.placeParts(cx);
    }
    this.redrawAll(cx);
  }

  pickProject(p) {
    this.cursor = null;
    this.showProject(p.key);
  }

  pickWorktree(p, w) {
    const worktree = { machine: w.machine, folder: w.folder };
    this.cursor = null;
    setFilter({ project: p.key, worktree });
    this.showWorkspace(p.key, worktree);
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
      .child(row("ah-footer-settings", "settings", "Settings", () => this.openSettings(), isUpdateReady ? this.dot(t.accent) : null));
  }

  dot(color) {
    return div().size(UI.dot).flex_none().rounded(UI.dot / 2).bg(color);
  }


  initBoard(cx) {
    this.over = null;
    this.hovered = null;
    this.renaming = null;
    this.board = null;
    this.liftedView = cx.new(Part, { owner: this, key: LIFTED_PART });
    this.groupBy = preference("groupBy", "stage");
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

  renderLoading(t, w, cx) {
    cx.timer.after(1000, (cx) => cx.notify());
    const facts = w.session ? shared(PULSE)?.sessions?.[w.session] : null;
    const machine = shared(PULSE)?.all.machines.find((m) => m.name === (w.machine ?? facts?.machine));
    const where = [w.project ?? facts?.projectName, machine && machine.name !== shared(PULSE)?.here ? machine.place : null, w.folder ? tildeOf(w.folder, machine?.home ?? home()) : null].filter(Boolean).join(" · ");
    const step = w.starting ? "Starting Claude Code" : w.session ? (facts?.tool === "codex" ? "Resuming Codex" : "Resuming Claude Code") : "Opening a terminal";
    const waited = Math.floor((Date.now() - w.at) / 1000);
    return v_flex()
      .id("ah-loading")
      .size_full()
      .items_center()
      .justify_center()
      .gap(UI.space.lg)
      .bg(t.background)
      .text_color(t.foreground)
      .child(
        v_flex()
          .max_w(START_WIDTH)
          .px(UI.space.lg)
          .gap(UI.space.sm)
          .items_center()
          .child(div().size(UI.space.xl * 2).flex().items_center().justify_center().rounded(UI.radius.panel).bg(t.raised).child(svg(`${ICON}/spinner.svg`).size(UI.icon.lead).text_color(this.stateColor("working")).spin(900)))
          .child(div().max_w_full().truncate().text_size(UI.text.title).font_semibold().child(w.starting ? "New session" : w.title))
          .when(where !== "", (el) => el.child(div().max_w_full().truncate().text_size(UI.text.caption).text_color(t.muted).child(where)))
          .child(div().text_size(UI.text.caption).text_color(t.dim).child(waited >= LOADING_SLOW_S ? `${step}… ${waited}s` : `${step}…`)),
      )
      .child(this.textButton(t, "ah-loading-back", "Back", () => cancelWant()));
  }

  renderStart(t, board) {
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
              .child(this.choice(t, "ah-start-new", "New session", false, () => this.newHere())),
          )
          .child(div().text_size(UI.text.caption).text_color(t.dim).child(recent.length === 0 ? "No sessions yet. Start one to see it here." : "No session is open. Pick one to continue it."))
          .children(
            recent.map((r) =>
              this.item(`ah-start-${r.key}`)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.act((cx) => this.present(cx, r, "tab")))
                .child(this.harnessIcon(t, r))
                .child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).child(r.title))
                .child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(since(r.since)))
                .child(this.isAskedOpen(r) ? this.spinnerLabel(t, "Opening") : this.status(t, r)),
            ),
          ),
      );
  }

  isAskedOpen(r) {
    return !r.address && isOpening(r.key);
  }

  boardReconcile(cx) {
    const changed = shared(CHANGED) ?? 0;
    const isShown = this.isBoardShown();
    const isStale = isShown && !this.wasShown;
    this.wasShown = isShown;
    if (changed <= this.changedAt && !isStale) return;
    this.changedAt = Math.max(this.changedAt, changed);
    this.refresh(cx);
  }

  renderBoard(t, cx) {
    const board = this.board;
    if (board === null) return v_flex().size_full().bg(t.background).child(this.empty(t, "Reading your sessions…"));
    if (board.loading !== null) return this.renderLoading(t, board.loading, cx);
    if (board.isStart) return this.renderStart(t, board);
    const { model, cards } = board;
    const columns = board[this.groupBy];
    const projectName = board.name;
    const mounted = new Set();
    this.mounted = mounted;
    const drag = this.pressed?.isMoving ? this.pressed : null;
    return v_flex()
      .id("ah-board")
      .relative()
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .on_mouse_move((e, cx) => {
        this.paneAt = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        const drag = this.pressed;
        if (!drag) return;
        if (this.isPressGone()) return this.cancelDrag(cx);
        if (drag.moveTo(e.position)) {
          this.dragKeys.focus();
          return this.redrawDragStart(cx, drag.id);
        }
        if (drag.isMoving) this.redrawDrag(cx);
      })
      .on_hover((on, cx) => {
        if (!on) this.leaveDrag(cx, false);
      })
      .on_mouse_up("left", (_e, cx) => this.dropOnStage(cx))
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
              prefer("groupBy", id);
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
      )
      .when(drag !== null, (el) => el.child(this.liftedView).child(this.dragCatcher()));
  }

  dropOnStage(cx) {
    const drag = this.pressed;
    const over = this.over;
    this.pressed = null;
    this.over = null;
    if (!drag?.isMoving) return;
    this.dropped = drag.id;
    const r = this.board?.model.byKey.get(drag.id);
    if (r && over !== null && r.stage !== over && this.data.stages.some((stage) => stage.id === over)) this.organize(cx, [{ op: "stageSession", session: drag.id, stage: over }], [[drag.id, { stage: over }]]);
    this.redrawAll(cx);
  }

  searchField(t, state, cleared) {
    const clear = div()
      .id("ah-search-clear")
      .size(UI.height.inline)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(UI.radius.pill)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Clear the search")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        state.set_value("");
        state.focus();
        cleared(cx);
      })
      .child(svg(iconPath(`${OWN}/circle-x`)).size(UI.icon.body));
    return h_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .gap(UI.space.sm)
      .items_center()
      .text_color(t.dim)
      .child(svg(`${ICON}/search.svg`).size(UI.icon.body).flex_none())
      .child(Input.new(state).flex_1().h_full().text_size(UI.text.body).text_color(t.foreground))
      .when(state.value() !== "", (el) => el.child(clear));
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
    const isOver = this.pressed?.isMoving === true && this.over === column.id && column.isStage;
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
        if (on && this.pressed?.isMoving) this.over = column.id;
        if (!on && this.over === column.id) this.over = null;
        cx.notify();
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
          .when(column.cards.length === 0 && column.isStage, (el) => el.child(this.empty(t, this.pressed?.isMoving ? "Drop it here" : "Drag a card here"))),
      );
  }

  boardCard(t, r, isDraggable, isGhost = false) {
    const tags = r.tags.map((id) => this.data.tags[id]).filter(Boolean);
    const isDragged = !isGhost && this.pressed?.isMoving === true && this.pressed.id === r.key;
    return v_flex()
      .id(`ah-card-${r.key}`)
      .p(UI.space.md)
      .gap(UI.space.sm)
      .flex_none()
      .rounded(UI.radius.panel)
      .bg(t.background)
      .border_1()
      .border_color(isGhost ? t.accent : t.border)
      .when(isGhost, (el) => el.shadow_lg().cursor_grabbing())
      .opacity(isDragged ? 0.4 : 1)
      .cursor_pointer()
      .hover((s) => s.border_color(t.input))
      .on_mouse_down("left", (e) => {
        this.dropped = null;
        if (isDraggable) this.pressed = new Drag(r.key, e.position, { bounds: e.bounds ?? null });
      })
      .on_click(() =>
        this.act((cx) => {
          if (this.wasDragged(r.key)) return;
          this.present(cx, r, "panel");
        }),
      )
      .on_mouse_down("right", () => this.menu(r))
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
    this.subScroll = ScrollHandle.new();
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
    const isRepository = hasWorktrees(project.key);
    const w = p.worktree ?? (project.worktrees.length === 1 ? project.worktrees[0] : null);
    const at = w === null ? null : { machine: w.machine, folder: w.folder };
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
        ...(isRepository ? [{ id: "board", icon: `${OWN}/kanban`, label: "Board", board: project.key }] : []),
        ...(!p.worktree && project.machines.length > 1 ? [{ id: "show-on", icon: "server", label: "Show it on", sub: project.machines.filter((m) => p.machines.includes(m)).map((m) => ({ id: `on-${m}`, icon: "server", label: m, ask: { action: "showProject", key: project.key, machine: m } })) }] : []),
        { id: "read-all", icon: "circle-check", label: "Mark all read", ask: { action: "readProject", project, worktree: p.worktree ? at : null } },
      ],
      copies.length > 0 ? [{ id: "copy", icon: `${OWN}/copy`, label: "Copy", sub: copies }] : [],
    ];
  }

  sessionMenuGroups(p) {
    const w = p.window;
    const rename = { id: "rename", icon: `${OWN}/pencil`, label: "Rename…", open: "renameWindow" };
    const windowItems = w
      ? [
          [rename, { id: "new-session", icon: "square-pen", label: "New session", detail: keyFor("anyhost.new"), ask: { action: "newSession" } }, { id: "new-terminal", icon: "terminal", label: "New terminal", detail: keyFor("tab.new"), ask: { action: "newTerminal" } }],
          w.pane
            ? [
                { id: "split-right", icon: `${OWN}/columns-2`, label: "Split right", ask: { action: "split", direction: "right" } },
                { id: "split-down", icon: `${OWN}/rows-2`, label: "Split down", ask: { action: "split", direction: "down" } },
                { id: "zoom", icon: `${OWN}/maximize-2`, label: w.zoomed ? "Show every pane" : "Zoom", detail: keyFor("anyhost.zoom"), ask: { action: "zoom" } },
              ]
            : [],
        ]
      : [[rename]];
    const paneItems =
      w?.isPane && w.terminal
        ? [
            w.toProgram ? { id: "right-menu", icon: `${OWN}/list-filter`, label: "Use this menu on right-click", ask: { action: "rightClicks", to: "menu" } } : { id: "right-program", icon: "terminal", label: "Send right-clicks to the program", ask: { action: "rightClicks", to: "program" } },
            ...(w.parent ? [{ id: "park", icon: `${OWN}/archive-restore`, label: `Send back to ${w.parent.name}`, ask: { action: "park" } }] : []),
          ]
        : [];
    const closeItems = w
      ? [
          ...(w.isPane ? [{ id: "close-pane", icon: "x", label: "Close pane", ask: { action: "closePane" } }] : []),
          { id: "close-tab", icon: "x", label: "Close tab", detail: keyFor("anyhost.close-tab"), disabled: Boolean(p.pinned), reason: "Unpin it to close it", ask: { action: "closeTabs", tabs: [w.tab] } },
          { id: "close-others", icon: "x", label: "Close other tabs", disabled: w.others.length === 0, reason: "No other tab is open", ask: { action: "closeTabs", tabs: w.others } },
          { id: "close-right", icon: "x", label: "Close tabs to the right", disabled: w.right.length === 0, reason: "No tab is to its right", ask: { action: "closeTabs", tabs: w.right } },
          { id: "reopen", icon: `${OWN}/archive-restore`, label: "Reopen closed tab", detail: keyFor("anyhost.reopen"), disabled: !p.canReopen, reason: "No closed tab to reopen", ask: { action: "reopen" } },
        ]
      : [];
    if (p.key === null) return [...windowItems, paneItems, closeItems];
    const tagged = this.tagged ?? p.tagged;
    const tagItems = [...Object.entries(p.tags).map(([id, tag]) => ({ id: `tag-${id}`, icon: tagged.includes(id) ? "check" : `${OWN}/tag`, label: tag.name, toggle: id })), { id: "tags-edit", icon: "plus", label: "New tag…", open: "tags" }];
    const stageItems = [{ id: "stage-none", icon: p.stage === "" ? "check" : "minus", label: "No stage", ask: { action: "organize", changes: [{ op: "stageSession", session: p.key, stage: "" }], optimistic: [[p.key, { stage: "" }]] } }, ...p.stages.map((s) => ({ id: `stage-${s.id}`, icon: p.stage === s.id ? "check" : "square", label: s.name, ask: { action: "organize", changes: [{ op: "stageSession", session: p.key, stage: s.id }], optimistic: [[p.key, { stage: s.id }]] } })), { id: "stages-edit", icon: "plus", label: "New stage…", open: "stages" }];
    const snoozeItems = [...snoozesAt(new Date()).map((snooze) => ({ id: `snooze-${snooze.id}`, label: snooze.label, detail: snooze.detail, snooze })), { id: "snooze-custom", label: "Custom…", open: "snooze", separatorBefore: true }];
    return [
      ...windowItems,
      [
        ...(p.isChild ? [{ id: "promote", icon: `${OWN}/app-window`, label: "Make it an agent", ask: { action: "present", shape: "tab" } }] : []),
        { id: "peek", icon: `${OWN}/eye`, label: "Peek", ask: { action: "peek" } },
        ...(p.canSleep ? [{ id: "sleep", icon: `${OWN}/moon`, label: "Sleep", ask: { action: "sleep" } }] : []),
        ...(!w && p.canStartHere ? [{ id: "start-here", icon: "square-pen", label: "New session in its folder", ask: { action: "startHere" } }] : []),
      ],
      p.archived || p.deleted
        ? []
        : [
            { id: "pin", icon: p.pinned ? "pin-off" : "pin", label: p.pinned ? "Unpin" : "Pin", ask: { action: "pin" } },
            { id: "settle", icon: "circle-check", label: p.settled ? "Unsettle" : "Settle", ask: { action: "settle" } },
            p.snoozed ? { id: "wake", icon: `${OWN}/alarm-clock-off`, label: "Wake now", ask: { action: "snooze", until: null } } : { id: "snooze", icon: "clock", label: "Snooze", sub: snoozeItems },
          ],
      [
        { id: "tags", icon: `${OWN}/tag`, label: "Tags", sub: tagItems },
        { id: "stage", icon: `${OWN}/kanban`, label: "Stage", sub: stageItems },
      ],
      [
        ...(!p.archived && !p.deleted ? [p.isUnread ? { id: "read", icon: "circle-check", label: "Mark read", ask: { action: "read" } } : { id: "unread", icon: `${OWN}/mail-open`, label: "Mark unread", ask: { action: "unread" } }] : []),
        p.isFiltered ? { id: "all", icon: "layers", label: "Show all projects", filter: null } : { id: "only", icon: `${OWN}/list-filter`, label: `Filter by ${p.projectName}`, ask: { action: "filterProject" } },
      ],
      [
        ...(!p.deleted ? [{ id: "open-in", icon: `${OWN}/panel-right`, label: "Open in", sub: SHAPES.map(([shape, label, icon]) => ({ id: `open-${shape}`, icon, label, ask: { action: "present", shape } })) }] : []),
        ...(!w && p.canShowHere
          ? [
              { id: "here-right", icon: `${OWN}/columns-2`, label: "Show beside this pane", ask: { action: "showHere", direction: "right" } },
              { id: "here-down", icon: `${OWN}/rows-2`, label: "Show below this pane", ask: { action: "showHere", direction: "down" } },
            ]
          : []),
        ...(p.isLocal && p.tabs.length > 0 ? [{ id: "to-tab", icon: "files", label: "Move to tab", sub: p.tabs.map((x) => ({ id: `tab-${x.id}`, icon: "terminal", label: x.name, ask: { action: "moveToTab", tab: x.id } })) }] : []),
        ...(p.targets.length > 0 ? [{ id: "move", icon: "server", label: "Move to machine", sub: p.targets.map((to) => ({ id: `move-${to}`, icon: "server", label: to, ask: { action: "move", to } })) }] : []),
      ],
      [{ id: "copy", icon: `${OWN}/copy`, label: "Copy", sub: [...(p.cwd ? [{ id: "copy-path", icon: "folder", label: "Folder path", copy: p.cwd }] : []), { id: "copy-id", icon: `${OWN}/hash`, label: "Session ID", copy: p.key }] }],
      paneItems,
      closeItems,
      [
        ...(p.deleted ? [{ id: "undelete", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "open" } }] : p.archived ? [{ id: "restore", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "restore" } }] : [{ id: "archive", icon: "archive", label: "Archive", ask: { action: "archive" }, disabled: p.pinned, reason: "Unpin it to archive it" }]),
        ...(!p.deleted ? [{ id: "delete", icon: `${OWN}/trash`, label: "Delete…", ask: { action: "confirmDelete" }, isDestructive: true }] : []),
      ],
    ];
  }

  choose(item, cx) {
    const p = props();
    if (item.toggle !== undefined) {
      const tagged = this.tagged ?? p.tagged;
      const isOn = !tagged.includes(item.toggle);
      this.tagged = isOn ? [...tagged, item.toggle] : tagged.filter((x) => x !== item.toggle);
      this.organize(cx, [{ op: "tagSession", session: p.key, tag: item.toggle, on: isOn }], [[p.key, { tags: this.tagged }]]);
      return cx.notify();
    }
    closeOverlay(p.overlay);
    if (item.copy !== undefined) return cx.write_to_clipboard(item.copy);
    if (item.filter !== undefined) return setFilter({ project: item.filter });
    if (item.open === "worktree") return openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "worktree", project: p.project, from: item.from ?? null, fromBranch: p.worktree?.branch ?? (p.project.worktrees.length === 1 ? p.project.worktrees[0].branch : null) } });
    if (item.open === "tags") return openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: 360, props: { view: "tags", key: p.key, tagged: p.tagged, tags: p.tags } });
    if (item.open === "stages") return openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: 260, height: 360, props: { view: "tags", isStage: true, key: p.key, stage: p.stage, stages: p.stages } });
    if (item.open === "snooze") return openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "snooze", key: p.key, title: p.title } });
    if (item.open === "rename") return this.openRename({ project: p.project });
    if (item.snooze !== undefined) {
      const until = item.snooze.preset.after !== undefined ? snoozeOf(item.snooze.preset, new Date()).until : isFuture(item.snooze.until) ? item.snooze.until : null;
      if (until === null) return notify({ title: "anyhost could not snooze it", body: "That snooze time has passed. Choose another time.", level: "warning" });
      return this.snooze(cx, p.row, until);
    }
    if (item.open === "renameWindow") return this.openRename(p.key !== null ? { session: { key: p.key, title: p.title } } : { tab: { id: p.window.tab, name: p.window.name } });
    if (item.board !== undefined) return this.openBoard(item.board);
    if (item.ask) this.perform({ key: p.key, window: p.window, ...item.ask }, cx, p.row);
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
      .when(opened !== null, (el) =>
        el.child(
          panel()
            .mt(subTopOf(groups, opened))
            .child(
              v_flex()
                .id(`ah-menu-sub-${opened.id}`)
                .h(subBodyOf(opened.sub))
                .overflow_y_scrollbar()
                .track_scroll(this.subScroll)
                .children(opened.sub.flatMap((item) => [...(item.separatorBefore ? [this.divider(t)] : []), entry(item, hoverSub(item), this.subAt === item.id)])),
            ),
        ),
      );
  }

  menuKey(e, cx, items, opened) {
    const inSub = opened !== null && this.subAt != null;
    const list = (inSub ? opened.sub : items).filter((item) => !item.disabled);
    const at = list.findIndex((item) => item.id === (inSub ? this.subAt : this.at));
    const typed = e.key_char && e.key_char.trim() !== "" && !e.modifiers.control && !e.modifiers.platform ? e.key_char.toLowerCase() : null;
    const roved = typed === null ? rovedTo(e, at, list.length, { loop: true }) : [...list.slice(at + 1), ...list.slice(0, at + 1)].findIndex((item) => item.label.toLowerCase().startsWith(typed));
    const next = typed === null ? list[roved ?? -1] : [...list.slice(at + 1), ...list.slice(0, at + 1)][roved];
    if (next) {
      if (inSub) this.subAt = next.id;
      else this.at = next.id;
    }
    if (inSub && next) this.subScroll.scroll_to_item(opened.sub.flatMap((item) => [...(item.separatorBefore ? [null] : []), item]).indexOf(next));
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
            this.showProject(project.key);
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
    this.archived = null;
    this.pending = new Map();
    this.data = null;
    this.dataVersion = 0;
    this.pendingVersion = 0;
    cx.spawn(async (cx) => {
      try {
        this.apply(await anyhost(["list", "--json", "--brief"]), Date.now(), Date.now());
        const { list } = this.cardsNow();
        const byKey = new Map(list.map((c) => [c.key, c]));
        const isChild = (c) => byKey.has(c.parent);
        this.archived = list.filter((c) => c.archived && !c.deleted && !isChild(c)).sort(byRecent).map((c) => ({ ...targetOf(c), harness: c.harness, at: c.at, projectKey: c.projectKey, projectName: c.projectName, place: c.isRemote ? this.placeOf(c.machine) : "", state: "idle" }));
      } catch (error) {
        notify({ title: "anyhost could not read the archived sessions", body: messageOf(error), level: "error" });
        this.archived = [];
      }
      cx.notify();
    });
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
      .child(this.archived === null ? div().text_size(UI.text.caption).text_color(t.dim).child("Reading the archived sessions…") : this.archivedList(t, this.archived.filter((a) => !this.restored.has(a.key))))
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
        .child(div().flex_none().text_size(UI.text.caption).text_color(t.dim).child(a.place ? `${a.place} · ${ago(a.at)}` : ago(a.at)))
        .child(
          this.iconButton(t, `ah-archived-restore-${a.key}`, `${OWN}/archive-restore`, "Restore", (cx) => {
            this.restored.add(a.key);
            this.restore(cx, a);
            cx.notify();
          }, UI.height.inline),
        )
        .child(this.iconButton(t, `ah-archived-delete-${a.key}`, `${OWN}/trash`, "Delete…", () => this.confirmDelete(a), UI.height.inline));
    const head = (group) =>
      this.item(`ah-archived-head-${group.key}`)
        .text_size(UI.text.caption)
        .font_medium()
        .text_color(t.muted)
        .child(this.mark(t, group.name, false, !hasWorktrees(group.key)))
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
    cx.timer.after(0, () => this.day.focus());
  }

  submitSnooze(cx) {
    const p = props();
    const until = customSnoozeOf({ mode: this.mode, day: this.day.value().trim(), time: this.clock.value().trim(), amount: this.amount.value().trim(), unit: this.unit }, new Date());
    if (until === null) {
      this.error = this.mode === "date" ? "Choose a valid date and time in the future." : "Enter a positive duration.";
      return cx.notify();
    }
    closeOverlay(p.overlay);
    this.snooze(cx, { key: p.key, title: p.title }, until);
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

  openRename(subject) {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "rename", ...subject } });
  }

  renamed() {
    const { project, session, tab } = props();
    if (project) return { title: "Rename project", hint: "Every machine shows this name.", name: project.name, placeholder: project.defaultName, detail: `Repository: ${project.key}`, reset: project.isNamed ? `Reset to ${project.defaultName}` : null };
    if (session) return { title: "Rename session", hint: "Claude Code names the session, so every machine and its /resume list show the new name.", name: session.title, placeholder: session.title, detail: null, reset: null };
    return { title: "Rename tab", hint: "Herdr shows this name on the tab.", name: tab.name, placeholder: tab.name, detail: null, reset: tab.name !== "" ? "Number it again" : null };
  }

  initRename(cx) {
    const shown = this.renamed();
    this.name = InputState.new({ placeholder: shown.placeholder });
    this.name.set_value(shown.name);
    this.name.on("submit", () => this.saveName(this.name.value()));
    cx.timer.after(0, () => this.name.focus());
  }

  saveName(text) {
    const { project, session, tab, overlay } = props();
    const name = text === null ? null : text.replace(/\s+/g, " ").trim();
    closeOverlay(overlay);
    if (project) return name === project.name ? undefined : this.nameProject(null, project.key, name === "" || name === project.defaultName ? null : name);
    if (session) return name === null || name === "" || name === session.title ? undefined : enqueue({ run: [{ args: ["tell", session.key, `/rename ${name}`] }], failed: `anyhost could not rename ${session.title.slice(0, 40)}` });
    run("tab.rename", { id: tab.id, name: name ?? "" });
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
              if (shape !== p.shape) this.present(null, p.row, shape);
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
          .on_click(() => closePresented())
          .child(svg(`${ICON}/x.svg`).size(UI.icon.small)),
      );
  }

  renderRename(t) {
    const p = props();
    const shown = this.renamed();
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
      .child(div().text_size(UI.text.title).font_semibold().child(shown.title))
      .child(div().text_size(UI.text.body).text_color(t.muted).child(shown.hint))
      .child(v_flex().gap(UI.space.xs).child(this.input(t, this.name)).when(shown.detail !== null, (el) => el.child(div().text_size(UI.text.caption).text_color(t.dim).truncate().child(shown.detail))))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .when(shown.reset !== null, (el) => el.child(this.button(t, "ah-rename-reset", shown.reset, false, () => this.saveName(null))))
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
      return this.organize(null, [{ op: "stageSession", session: p.key, stage }], [[p.key, { stage }]]);
    }
    this.tagged = isOn ? [...this.tagged, id] : this.tagged.filter((x) => x !== id);
    this.organize(null, [{ op: "tagSession", session: p.key, tag: id, on: isOn }], [[p.key, { tags: this.tagged }]]);
  }

  createTag(name) {
    const p = props();
    const id = idOf();
    if (this.isStage) {
      this.catalog[id] = { name };
      this.tagged = [id];
      return this.organize(null, [{ op: "defineStages", stages: this.stagesListed() }, { op: "stageSession", session: p.key, stage: id }], [[p.key, { stage: id }]]);
    }
    const colors = Object.keys(TAG_COLORS);
    const color = colors[Object.keys(this.catalog).length % colors.length];
    this.catalog[id] = { name, color };
    this.tagged = [...this.tagged, id];
    this.organize(null, [{ op: "defineTag", id, name, color }, { op: "tagSession", session: p.key, tag: id, on: true }], [[p.key, { tags: this.tagged }]]);
  }

  saveTag(id, change) {
    const tag = this.catalog[id];
    if (!tag || (change.name !== undefined && change.name === "")) return;
    this.catalog[id] = { ...tag, ...change };
    this.organize(null, [this.isStage ? { op: "defineStages", stages: this.stagesListed() } : { op: "defineTag", id, ...this.catalog[id] }]);
  }

  dropTag(id) {
    const p = props();
    delete this.catalog[id];
    this.tagged = this.tagged.filter((x) => x !== id);
    this.editing = null;
    if (this.isStage) return this.organize(null, [{ op: "defineStages", stages: this.stagesListed() }], [[p.key, { stage: this.tagged[0] ?? "" }]]);
    this.organize(null, [{ op: "dropTag", id }], [[p.key, { tags: this.tagged }]]);
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
    this.machine = shared(PULSE)?.here ?? "";
    this.cursorAt = 0;
    this.newScroll = ScrollHandle.new();
    this.listing = null;
    this.where = InputState.new({ placeholder: "Search projects, or type a folder: ~/Developer/app" });
    this.where.on("change", (_e, cx) => this.whereChanged(cx));
    this.where.on("submit", () => {
      const choice = this.newChoices()[this.cursorAt];
      if (choice) this.startChosen(choice);
    });
    cx.timer.after(0, () => this.where.focus());
  }

  typedFolder() {
    const typed = this.where.value().trim();
    if (!/^[~/]/.test(typed)) return null;
    const path = typed.replace(/^~(?=\/|$)/, props().homes?.[this.machine] || home());
    const cut = path.lastIndexOf("/");
    return { path, dir: path.slice(0, cut) || "/", start: path.slice(cut + 1) };
  }

  whereChanged(cx) {
    this.cursorAt = 0;
    this.newScroll.scroll_to_item(0);
    const typed = this.typedFolder();
    if (typed && (this.listing?.dir !== typed.dir || this.listing.machine !== this.machine)) this.listFolders(cx, this.machine, typed.dir);
    cx.notify();
  }

  listFolders(cx, machine, dir) {
    this.listing = { machine, dir, names: [], failed: null };
    const on = shared(PULSE)?.all.machines.find((m) => m.name === machine)?.on || null;
    cx.spawn(async (cx) => {
      const listed = await exec("find", ["-L", dir, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], { on, timeout: 10_000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      if (this.listing?.dir !== dir || this.listing.machine !== machine) return;
      const names = listed.stdout.split("\n").filter(Boolean).map((found) => found.slice(found.lastIndexOf("/") + 1));
      this.listing = { machine, dir, names: names.sort((a, b) => a.localeCompare(b)), failed: names.length === 0 && listed.code !== 0 ? `${machine} can't read ${dir}` : null };
      cx.notify();
    });
  }

  newChoices() {
    const typed = this.typedFolder();
    if (typed) {
      const start = typed.start.toLowerCase();
      const listed = this.listing?.dir === typed.dir && this.listing.machine === this.machine ? this.listing.names : [];
      const inside = listed.filter((name) => name.toLowerCase().startsWith(start) && (start.startsWith(".") || !name.startsWith("."))).map((name) => ({ folder: `${typed.dir === "/" ? "" : typed.dir}/${name}` }));
      const exact = inside.find((choice) => choice.folder === typed.path);
      const typedItself = start === "" ? [{ folder: typed.dir }] : !exact && inside.length === 0 ? [{ folder: typed.path }] : [];
      return [...typedItself, ...(exact ? [exact] : []), ...inside.filter((choice) => choice !== exact)];
    }
    const text = this.where.value().trim().toLowerCase();
    const homeFolder = props().homes?.[this.machine] ?? "";
    const list = (shared(PULSE)?.projects ?? []).filter((project) => (project.checkouts?.[this.machine] ?? []).length > 0 && project.key !== NONE);
    const current = list.find((project) => project.key === props().current);
    const ordered = [...(current ? [current] : []), ...list.filter((project) => project !== current).sort((a, b) => b.newest - a.newest)];
    return ordered
      .flatMap((project) => (project.checkouts[this.machine] ?? []).map((folder) => ({ project, folder, isCurrent: project === current })))
      .filter((choice) => text === "" || choice.project.name.toLowerCase().includes(text) || tildeOf(choice.folder, homeFolder).toLowerCase().includes(text))
      .map((choice, n, shown) => ({ ...choice, isFirst: n === 0 || shown[n - 1].project !== choice.project }));
  }

  startChosen({ project = null, folder }) {
    const holder = project ?? (shared(PULSE)?.projects ?? []).find((p) => p.key !== NONE && (p.checkouts?.[this.machine] ?? []).includes(folder));
    if (holder) this.startIn(holder, { machine: this.machine, folder });
    else startSession(this.machine, folder, shared(PULSE)?.all.machines.find((m) => m.name === this.machine)?.on ?? null, `anyhost could not start a session in ${folder.split("/").pop()}`);
    closeOverlay(props().overlay);
  }

  renderNew(t) {
    const p = props();
    const pulse = shared(PULSE);
    const choices = this.newChoices();
    this.cursorAt = Math.min(this.cursorAt, Math.max(0, choices.length - 1));
    const homeFolder = p.homes?.[this.machine] ?? "";
    const typed = this.typedFolder();
    const machinesList = (pulse?.all.machines ?? []).filter((m) => m.connected);
    const emptyLine = typed ? (this.listing?.failed ?? "No folder matches") : this.where.value().trim() !== "" ? "No project matches. Type a folder, as ~/Developer/app" : "No project has a checkout on this machine yet";
    return v_flex()
      .id("ah-new")
      .on_key_down((e, cx) => {
        const roved = rovedTo(e, this.cursorAt, choices.length);
        if (roved !== null) {
          this.cursorAt = roved;
          this.newScroll.scroll_to_item(roved);
        }
        if (e.key === "escape") closeOverlay(p.overlay);
        cx.notify();
      })
      .w_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .h(UI.height.row + UI.space.lg)
          .px(UI.space.lg)
          .gap(UI.space.sm)
          .flex_none()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(this.searchField(t, this.where, (cx) => this.whereChanged(cx))),
      )
      .child(
        v_flex()
          .id("ah-new-list")
          .h(PICKER_HEIGHT)
          .p(UI.space.sm)
          .gap(1)
          .overflow_y_scrollbar()
          .track_scroll(this.newScroll)
          .when(choices.length === 0, (el) => el.child(this.empty(t, emptyLine)))
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
                .on_click(() => this.startChosen(choice))
                .when(!choice.project, (el) => el.child(this.leadIcon("folder").text_color(t.dim)).child(div().flex_1().min_w(0).truncate().text_size(UI.text.body).child(tildeOf(choice.folder, homeFolder))))
                .when(Boolean(choice.project), (el) =>
                  el
                    .child(choice.isFirst ? this.mark(t, choice.project.name) : this.leadIcon("git-branch").text_color(t.dim))
                    .when(choice.isFirst, (row) => row.child(div().flex_none().text_size(UI.text.body).text_color(t.foreground).child(choice.project.name)))
                    .child(div().flex_1().min_w(0).truncate().text_size(UI.text.caption).text_color(t.dim).child(tildeOf(choice.folder, homeFolder)))
                    .when(choice.isCurrent && choice.isFirst, (row) => row.child(div().flex_none().text_size(UI.text.caption).text_color(t.muted).child("Current"))),
                ),
            ),
          ),
      )
      .child(
        h_flex()
          .px(UI.space.lg)
          .py(UI.space.sm)
          .gap(UI.space.xs)
          .flex_none()
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .when(machinesList.length > 1, (el) =>
            el.child(div().pr(UI.space.xs).text_size(UI.text.caption).text_color(t.dim).child("Runs on")).children(
              machinesList.map((m) =>
                this.choice(t, `ah-m-${m.name}`, m.place, m.name === this.machine, (cx) => {
                  this.machine = m.name;
                  this.whereChanged(cx);
                }, "server"),
              ),
            ),
          )
          .child(div().flex_1())
          .when(this.machine === pulse?.here, (el) =>
            el.child(
              this.choice(t, "ah-new-pick", "Choose folder…", false, (cx) =>
                cx.spawn(async () => {
                  const folder = await pickFolder({ prompt: "Start session" });
                  if (folder) this.startChosen({ folder });
                }), "folder"),
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
    this.branch.on("submit", (_e, cx) => this.createWorktree(cx));
    this.creating = false;
    this.failure = null;
    cx.timer.after(0, () => this.branch.focus());
  }

  createWorktree(cx) {
    const p = props();
    const branch = this.branch.value().trim();
    if (branch === "" || this.creating) return;
    this.creating = true;
    this.failure = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.newWorktree(p.project, branch, p.from);
        closeOverlay(p.overlay);
      } catch (error) {
        this.creating = false;
        this.failure = messageOf(error);
        cx.notify();
      }
    });
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
      .when(this.failure !== null, (el) => el.child(div().text_size(UI.text.caption).text_color(t.ansi1).child(this.failure)))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-worktree-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
          .child(this.button(t, "ah-worktree-go", this.creating ? "Creating…" : "Create", true, (cx) => this.createWorktree(cx))),
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
      .when(Boolean(this.failure), (el) => el.child(div().text_size(UI.text.caption).text_color(t.ansi1).child(this.failure)))
      .child(
        h_flex()
          .gap(UI.space.sm)
          .justify_end()
          .child(this.button(t, "ah-confirm-keep", "Keep it", true, () => closeOverlay(p.overlay)))
          .child(
            this.button(t, "ah-confirm-go", this.isGoing ? `${p.go}…` : p.go, false, (cx) => {
              if (p.removeWorktree) return this.removeConfirmed(cx, p);
              closeOverlay(p.overlay);
              if (p.archive) return void this.archiveAll(cx, p.archive.rows, { ...p.archive, isConfirmed: true });
              this.dispatchDelete(cx, p.delete.row, p.delete.on);
            }),
          ),
      );
  }

  removeConfirmed(cx, p) {
    if (this.isGoing) return;
    this.isGoing = true;
    this.failure = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.removeWorktree(p.removeWorktree.machine, p.removeWorktree.folder);
        closeOverlay(p.overlay);
      } catch (error) {
        this.isGoing = false;
        this.failure = messageOf(error);
        cx.notify();
      }
    });
  }

  initPalette(cx) {
    this.cursorAt = 0;
    this.paletteScroll = ScrollHandle.new();
    this.palette = props();
    this.query = InputState.new({ placeholder: "Search sessions, projects and actions" });
    this.groups = this.paletteGroups();
    this.query.on("change", (_e, cx) => this.paletteSearched(cx));
    this.query.on("submit", () => this.groups.flatMap(([, rows]) => rows)[this.cursorAt]?.run());
    cx.timer.after(0, () => this.query.focus());
  }

  paletteSearched(cx) {
    this.cursorAt = 0;
    this.groups = this.paletteGroups();
    cx.notify();
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
      { id: "new", icon: "square-pen", title: current ? `New session in ${current.name}` : "New session", run: close(() => this.newHere()) },
      { id: "tab", icon: "plus", title: "New tab", run: close(() => run("tab.new")) },
      { id: "board", icon: `${OWN}/kanban`, title: `Board · ${current ? current.name : "All projects"}`, run: close(() => this.openBoard(p.current)) },
    ].filter((a) => has(a.title));
    const shownProjects = projects
      .filter((project) => has(project.name))
      .sort((a, b) => b.newest - a.newest)
      .map((project) => ({
        id: `p-${project.key}`,
        project,
        title: project.name,
        run: close(() => this.showProject(project.key)),
      }));
    const item = (s) => ({ id: `s-${s.key}`, session: s, title: s.title, run: close(() => this.open(s, null)) });
    const sessions = p.sessions
      .filter((s) => !s.archived && (text === "" ? s.kind === "own" : has(s.title, s.projectName)))
      .slice(0, text === "" ? 12 : 40)
      .map(item);
    const archived = text === "" ? [] : p.sessions.filter((s) => s.archived && has(s.title, s.projectName)).slice(0, 40).map(item);
    return [
      ["Actions", actions],
      ["Projects", shownProjects],
      [text === "" ? "Recent sessions" : "Sessions", sessions],
      ["Archived", archived],
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
      .map((r) => ({ ...targetOf(r), harness: r.harness, state: r.state, label: r.label, at: r.at, since: r.since, isOffline: r.isOffline, seenAt: r.seenAt, section: r.section, snoozedUntil: r.snoozedUntil, settledAt: r.settledAt, kind: r.kind, projectKey: r.projectKey, projectName: r.projectName }));
  }

  initTabs(cx) {
    this.pressed = null;
    this.hovered = null;
    this.picked = null;
    this.tabScroll = ScrollHandle.new();
    this.width = 0;
    this.height = 0;
    this.pointerY = 0;
    this.barBounds = null;
    this.widths = new Map();
    this.closing = new Set();
    this.leaving = new Set();
    this.recent = saved("recent", []);
    this.shownTab = null;
    this.walk = null;
    this.wantedId = null;
    this.wantedLive = false;
    this.adoptedFor = null;
    this.layoutPlaced = new Set();
    this.tabsKey = "";
    this.tabsInputs = "";
    this.placing = new Map();
    this.panelShown = null;
    this.focusTarget = null;
    this.shownIndex = -1;
    this.tabsView = null;
    this.tabsSignature = "";
    this.listView = cx.new(Part, { owner: this, key: LIST_PART });
    this.liftedView = cx.new(Part, { owner: this, key: LIFTED_PART });
    this.runActs(cx, () => undefined);
    this.refreshTabs(this.workNow());
    this.placeParts(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.windowCommand(command, cx);
        cx.notify();
      }
    });
  }

  windowCommand(command, cx) {
    this.noteShown(cx);
    const work = this.workNow();
    const [, verb, direction] = /^(go|move)-(left|right|up|down)$/.exec(command) ?? [];
    const [, mode] = /^view-(\w+)$/.exec(command) ?? [];
    const [, held] = /^undo-(.+)$/.exec(command) ?? [];
    if (verb === "go" || command === "next" || command === "prev") cancelWant();
    if (verb === "go") return this.go(work, direction);
    if (verb === "move") return this.move(work, direction);
    if (command === "next" || command === "prev") return run(command === "next" ? "tab.next" : "tab.prev");
    if (command === "recent" || command === "recent-back") return this.walkRecent(cx, command === "recent" ? 1 : -1);
    if (command === "new") return this.newHere();
    if (command === "close") return this.closeShownSession(cx);
    if (command === "close-tab") return this.closeShownWindow(cx);
    if (command === "reopen") return this.reopenClosed(cx);
    if (held) return undoHeld(held);
    if (command === "zoom") return this.zoom(work);
    if (command === "promote") return this.promote(work);
    if (command === "mode") return this.setMode(work, CYCLED[(CYCLED.indexOf(work.layoutMode) + 1) % CYCLED.length]);
    if (command === "grow" || command === "shrink") return this.resize(work, command === "grow" ? RATIO_STEP : -RATIO_STEP);
    if (command === "scroll-left" || command === "scroll-right") return this.scroll(work, command === "scroll-left" ? -1 : 1);
    if (mode && MODES.some(([each]) => each === mode)) this.setMode(work, mode);
  }

  workNow() {
    const { workspace, space } = workPlace();
    const tab = space?.tabs.find((x) => x.active) ?? null;
    const paned = tab ? panes().filter((p) => p.tab === tab.id && p.terminal) : [];
    const inTab = paned.map((p) => p.terminal);
    const settings = windowLayoutOf(tab?.id);
    const terminals = inOrder(settings.order, inTab);
    const boardId = space?.id ?? workspace?.id ?? ALL_WORK;
    const isBoard = workspaceOf(boardId).mode === "board";
    const canTile = Boolean(find(layout(), "tiles")) && terminals.length > 0;
    const mode = loadingOf() !== null ? "opening" : space === null ? (isBoard ? "board" : "start") : isBoard ? "board" : TILED.has(settings.mode) && canTile ? settings.mode : "tabs";
    const at = focused()?.terminal ?? null;
    const isFocused = terminals.includes(at);
    const shown = tab === null || ON_BOARD.has(mode) ? null : { tab: tab.id, terminal: isFocused ? at : (paned.find((p) => p.focused)?.terminal ?? null) };
    return { workspace, space, id: space?.id ?? null, boardId, tab: tab?.id ?? null, terminals, mode, layoutMode: settings.mode, settings, focused: isFocused ? at : null, shown };
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

  tabInputsOf() {
    const w = window();
    const at = focused();
    return JSON.stringify([
      spaces(),
      panes().map((p) => [p.pane, p.tab, p.terminal, p.mod, p.focused, p.zoomed, p.program?.icon, p.program?.tint, p.program?.agent]),
      terminals().map((x) => [x.address, x.state, x.labels?.[SESSION_LABEL]]),
      layout(),
      machines(),
      [w?.platform, w?.titlebar, w?.fullscreen, w?.buttons, at?.space, at?.tab, at?.pane, at?.terminal],
      [shared(PULSE), filterOf(), preference("workspaces", {}), windowsNow(), outboxOf(), shared(DRAG_TAB), wantedOf(), shared(SPLIT), openingOf(), shared("layout"), presentedOf(), w?.active],
      [this.width, this.focusTarget, [...this.closing], this.pressed?.isMoving === true, this.picked],
    ]);
  }

  syncTabs(cx) {
    const inputs = this.tabInputsOf();
    if (inputs === this.tabsInputs) return;
    this.tabsInputs = inputs;
    const work = this.workNow();
    stepSplit();
    this.noteShown(cx);
    this.stepWanted(cx);
    const drag = shared(DRAG_TAB);
    if (drag?.from === "inbox" && !drag.overlay && work.mode === "tabs") this.openDrop(drag, false, cx);
    if (this.pressed?.isMoving && this.tabsView?.pills.some((pill) => pill.tab.id === this.pressed.id) && !shared(DRAG_TAB)) {
      this.pressed = null;
      cx.notify();
    }
    if (this.isPressGone()) this.cancelDrag(cx);
    const live = new Set(terminals().filter((x) => x.state === "live").map((x) => x.address));
    if (drag && (drag.tab ? spaceOfTab(drag.tab) === null : drag.terminals.every((address) => !live.has(address)))) endTabDrag(false);
    const tree = layout();
    const width = this.tilesWidth();
    const key = `${work.mode}|${work.id}|${work.terminals.join(",")}|${JSON.stringify(work.settings)}|${scrollShown(width)}:${Math.floor(width / TILE_WIDTH)}|${find(tree, "views")?.active}|${tileTerminals(tree).join(",")}|${this.focusTarget ?? ""}|${work.tab ?? ""}|${spaces().reduce((sum, sp) => sum + sp.tabs.length, 0)}|${panes().length}|${isLayoutLoaded()}|${(shared(PULSE)?.pinned ?? []).map((p) => `${p.key}:${p.state}`).join(",")}|${pinsInOrder().join(",")}|${(work.space?.tabs ?? []).map((tab) => tab.id).join(",")}|${JSON.stringify(presentedOf())}|${find(tree, "present-terminal")?.content?.terminal ?? ""}`;
    if (key !== this.tabsKey) {
      this.tabsKey = key;
      this.tabsReconcile(cx);
    }
    if (this.refreshTabs(work)) this.redrawChanged(cx, this.placeParts(cx));
  }

  refreshTabs(work) {
    const root = layout();
    const tabIds = new Set(spaces().flatMap((sp) => sp.tabs.map((x) => x.id)));
    const archived = new Map(queued().flatMap(([, entry]) => Object.entries(entry.changes).filter(([, fields]) => "archived" in fields || fields.deleted === true).map(([key, fields]) => [key, fields.archived ?? fields.deleted])));
    const archiving = new Set([...archived].filter(([, isArchived]) => isArchived).map(([key]) => key));
    const ps = panes();
    const sessionAt = new Map(terminals().map((x) => [x.address, x.labels?.[SESSION_LABEL]]));
    const known = shared(PULSE)?.sessions ?? {};
    const isAll = filterOf().project === null;
    const groups = isAll ? this.spacesInOrder() : [work.space].filter(Boolean);
    const pills = groups.flatMap((space) =>
      space.tabs.map((tab) => {
        const inTab = ps.filter((p) => p.tab === tab.id);
        const sessions = [...new Set(inTab.map((p) => sessionAt.get(p.terminal)).filter(Boolean))];
        const states = sessions.map((key) => known[key]?.state);
        const ofSessions = Object.keys(STATE).find((state) => states.includes(state));
        return {
          tab,
          space: space.id,
          program: inTab.find((p) => p.program?.agent)?.program ?? inTab[0]?.program,
          sessions,
          isPinned: sessions.some((key) => known[key]?.pinned),
          state: ofSessions ?? (tab.status === "blocked" || tab.status === "working" || tab.status === "done" ? tab.status : null),
          isShown: tab.id === work.shown?.tab,
        };
      }),
    );
    const tabbed = new Set(pills.flatMap((pill) => pill.sessions));
    if (this.picked !== null && this.walk === null && (!isOpening(this.picked) || tabbed.has(this.picked))) this.picked = null;
    const pinnedAway = (shared(PULSE)?.pinned ?? []).filter((p) => !tabbed.has(p.key) && (isAll || p.space === work.id)).map((p) => ({ ...p, after: "", isPinned: true }));
    const away = new Set(pinnedAway.map((p) => p.key));
    const asleep = sleptWindows().filter((w) => groups.some((space) => space.id === w.space));
    const discarded = [...pinnedAway, ...asleep.filter((session) => !away.has(session.key) && !tabbed.has(session.key))].map((session) => ({ ...session, isLoading: isOpening(session.key), isPicked: session.key === this.picked }));
    for (const pill of pills) if (pill.sessions.some((key) => archiving.has(key))) this.closing.delete(pill.tab.id);
    for (const id of this.closing) if (!tabIds.has(id)) this.closing.delete(id);
    const isLeaving = (pill) => this.closing.has(pill.tab.id) || (pill.sessions.length > 0 && pill.sessions.every((key) => archiving.has(key)));
    this.leaving = new Set(pills.filter(isLeaving).map((pill) => pill.tab.id));
    const slots = this.slotsOf(pills.filter((pill) => !isLeaving(pill)), discarded);
    const at = slots.findIndex((slot) => slot.pill?.isShown);
    const active = at < 0 || !isAll ? at : at + slots.slice(0, at + 1).filter((slot, i) => this.startsGroup(slots, i)).length;
    if (active >= 0 && active !== this.shownIndex) this.tabScroll.scroll_to_item(active);
    this.shownIndex = active;
    const w = window();
    const sidebar = find(root, "sidebar");
    const panel = find(root, "panel");
    const isLoaded = isLayoutLoaded();
    this.tabsView = {
      isLoaded,
      work,
      pills,
      discarded,
      slots: isLoaded ? slots : [],
      slotById: new Map((isLoaded ? slots : []).map((slot) => [slot.id, slot])),
      lights: w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights ? Math.max(UI.space.sm, root.traffic_lights[0] + 64 - (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0))) : UI.space.sm,
      hasViews: Boolean(find(root, "views")),
      hasButtons: Boolean(w?.buttons),
      project: isAll ? null : (work.workspace?.name ?? (work.workspace?.key ? (shared(PULSE)?.known.find((p) => p.key === work.workspace.key)?.name ?? projectNameOf(work.workspace.key)) : null)),
      isAll,
      labels: isAll ? Object.fromEntries(groups.map((space) => [space.id, this.groupName(space)])) : {},
      openPanel: panel && !panel.hidden ? (find(root, "panel-body")?.active ?? null) : null,
    };
    const signature = JSON.stringify([this.tabsView.isLoaded, [...this.leaving], pills.map((pill) => [pill.tab.id, pill.space, pill.tab.name, pill.tab.index, pill.program?.icon ?? null, pill.program?.tint ?? null, pill.sessions, pill.state, pill.isPinned, pill.isShown]), discarded, work.mode, work.id, work.settings, work.focused, work.terminals, this.tabsView.lights, this.tabsView.hasViews, this.tabsView.hasButtons, this.tabsView.project, this.tabsView.labels, this.tabsView.openPanel, pinsInOrder()]);
    if (signature === this.tabsSignature) return false;
    this.tabsSignature = signature;
    return true;
  }

  spacesInOrder() {
    const rank = new Map((shared(PULSE)?.projects ?? []).flatMap((p) => p.worktrees.map((w) => w.id)).map((id, i) => [id, i]));
    return spaces()
      .filter((space) => space.tabs.length > 0)
      .sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size));
  }

  groupName(space) {
    const project = (shared(PULSE)?.projects ?? []).find((p) => p.worktrees.some((w) => w.id === space.id));
    if (!project) return space.name;
    const branch = project.worktrees.find((w) => w.id === space.id)?.branch;
    return project.worktrees.length > 1 && branch ? `${project.name} · ${branch}` : project.name;
  }

  startsGroup(slots, i) {
    return !slots[i].isPinned && slots[i].lane !== slots[i - 1]?.lane;
  }

  tabsReconcile(cx) {
    if (!find(layout(), "views") || !isLayoutLoaded()) return;
    const work = this.workNow();
    if (this.focusTarget !== null && !panes().some((p) => p.terminal === this.focusTarget)) this.focusTarget = null;
    if (this.focusTarget !== null && TILED.has(work.mode) && work.terminals.includes(this.focusTarget) && !tileTerminals().includes(this.focusTarget) && this.bringIntoView(work, this.focusTarget)) return;
    const node = work.mode === "tabs" ? VIEW_NODE.tabs : ON_BOARD.has(work.mode) ? VIEW_NODE.board : VIEW_NODE.tiles;
    const shown = () => {
      if (find(layout(), "views")?.active !== node) run("layout.select", { stack: "views", child: node });
      if (this.focusTarget !== null && work.terminals.includes(this.focusTarget) && (!TILED.has(work.mode) || tileTerminals().includes(this.focusTarget))) {
        run("pane.focus", { terminal: this.focusTarget });
        this.focusTarget = null;
      }
    };
    if (TILED.has(work.mode)) this.placeNode(cx, "tiles", this.tilesFor(work), null, shown);
    else shown();
    for (const tab of spaces().flatMap((sp) => sp.tabs)) {
      const inTab = panes().filter((p) => p.tab === tab.id);
      if (inTab.length > 0 && inTab.every((p) => p.mod === "anyhost")) run("tab.close", { id: tab.id, confirmed: true });
    }
    this.placePresented(cx);
    this.pinTabsFirst(work);
    cx.notify();
  }

  pinTabsFirst(work) {
    const pinned = pinsInOrder();
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
    changeWindowLayout(work.tab, change);
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

  placeNode(cx, id, node, parent, then = () => undefined) {
    const wanted = JSON.stringify(node);
    if (this.placing.get(id) === wanted) return;
    this.placing.set(id, wanted);
    const path = `${appHome()}/layouts/${shared("layout")}.json`;
    cx.spawn(async () => {
      try {
        for (let tries = 1; ; tries++) {
          const text = await readTextFile(path);
          const root = text === null ? null : JSON.parse(text);
          const next = placedIn(root, id, node, parent);
          if (next === null) break;
          try {
            await writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`, text);
            break;
          } catch (error) {
            if (tries >= PLACE_TRIES) throw error;
          }
        }
      } finally {
        this.placing.delete(id);
      }
      then();
    });
  }

  placePresented(cx) {
    const presented = presentedOf();
    const isPanel = presented?.shape === "panel";
    this.placeNode(cx, "present", isPanel ? presentedLayout(presented, "panel") : null, "panel-body");
    const shown = isPanel ? JSON.stringify([presented.key, presented.address]) : null;
    if (shown === this.panelShown || (isPanel && find(layout(), "present-terminal")?.content?.terminal !== presented.address)) return;
    this.panelShown = shown;
    if (!isPanel) return;
    run("layout.select", { stack: "panel-body", child: "present" });
    run("layout.show", { id: "panel" });
  }

  focusTile(work, terminal) {
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
    if (work.focused === null) return this.focusTile(work, work.terminals[0]);
    const isBack = direction === "left" || direction === "up";
    if (work.mode === "stack" || work.settings.zoomed) return this.stepTile(work, isBack ? -1 : 1);
    const next = neighbourOf(rectsOf(find(layout(), "tiles")), work.focused, direction);
    if (next) return this.focusTile(work, next);
    if (work.mode === "scroll" && (direction === "left" || direction === "right")) this.stepTile(work, isBack ? -1 : 1);
  }

  stepTile(work, by) {
    if (work.terminals.length === 0) return;
    const at = work.terminals.indexOf(work.focused);
    this.focusTile(work, work.terminals[(Math.max(0, at) + (at < 0 ? 0 : by) + work.terminals.length) % work.terminals.length]);
  }

  move(work, direction) {
    if (!TILED.has(work.mode)) return run("pane.swap", { direction });
    const at = work.terminals.indexOf(work.focused);
    const to = at + (direction === "left" || direction === "up" ? -1 : 1);
    if (at < 0 || to < 0 || to >= work.terminals.length) return;
    changeWindowLayout(work.tab, { order: movedTo(work.terminals, at, to) });
    this.focusTarget = work.focused;
  }

  promote(work) {
    if (work.focused === null || work.terminals.length < 2) return;
    const other = work.terminals[0] === work.focused ? work.terminals[1] : work.terminals[0];
    if (!TILED.has(work.mode)) {
      const paneOf = (terminal) => panes().find((p) => p.terminal === terminal)?.pane;
      return run("pane.swap", { pane: paneOf(work.focused), target: paneOf(other) });
    }
    const master = work.terminals[0] === work.focused ? other : work.focused;
    changeWindowLayout(work.tab, { order: [master, ...work.terminals.filter((x) => x !== master)] });
    this.focusTarget = work.focused;
  }

  zoom(work) {
    if (!TILED.has(work.mode)) return run("pane.zoom");
    if (work.focused === null && !work.settings.zoomed) return;
    changeWindowLayout(work.tab, { zoomed: work.settings.zoomed ? null : work.focused });
    this.focusTarget = work.settings.zoomed ?? work.focused;
  }

  resize(work, step) {
    if (work.mode !== "master") return;
    changeWindowLayout(work.tab, { ratio: Math.round(Math.max(RATIO_LEAST, Math.min(RATIO_MOST, work.settings.ratio + step)) * 100) / 100 });
  }

  scroll(work, step) {
    if (work.mode !== "scroll") return;
    const shown = scrollShown(this.tilesWidth());
    const offset = offsetIn(offsetIn(work.settings.offset, work.terminals.length, shown) + step, work.terminals.length, shown);
    changeWindowLayout(work.tab, { offset });
    const at = work.terminals.indexOf(work.focused);
    if (at >= 0 && (at < offset || at >= offset + shown)) this.focusTarget = work.terminals[at < offset ? offset : offset + shown - 1];
  }

  setMode(work, mode) {
    if (mode === "board") return changeWorkspace(work.boardId, { mode: "board" });
    if (work.mode === "board") changeWorkspace(work.boardId, { mode: "tabs" });
    changeWindowLayout(work.tab, { mode, zoomed: null });
    this.focusTarget = work.focused;
  }

  noteShown(cx) {
    if (!isLayoutLoaded()) return;
    const tab = spaces().find((sp) => sp.active)?.tabs.find((x) => x.active)?.id ?? null;
    if (tab === this.shownTab) return;
    const was = this.shownTab;
    this.shownTab = tab;
    if (was !== null && spaceOfTab(was) === null) this.leftWindow(was);
    if (tab !== null) cx.timer.after(RECENT_MS, () => this.commitRecent(tab));
  }

  commitRecent(tab) {
    if (this.shownTab !== tab || shownView() === "board" || spaceOfTab(tab) === null) return;
    const entry = { tab, space: spaceOfTab(tab), sessions: sessionsOfTab(tab) };
    const isSame = (e) => e.tab === tab || e.sessions.some((key) => entry.sessions.includes(key));
    this.recent = [entry, ...this.recent.filter((e) => !isSame(e))].slice(0, RECENT_MOST);
    save("recent", this.recent);
  }

  windowOf(e) {
    const space = spaceOfTab(e.tab);
    if (space !== null) return { tab: e.tab, space };
    const live = terminals().filter((x) => x.state === "live");
    for (const key of e.sessions) {
      const tab = live.filter((x) => x.labels?.[SESSION_LABEL] === key).map((x) => tabOfTerminal(x.address)).find(Boolean);
      if (tab) return { tab, space: spaceOfTab(tab) };
    }
    for (const key of e.sessions) {
      const slept = sleptSessionOf(key);
      if (slept) return { slept };
    }
    return null;
  }

  recentWindows() {
    const seen = new Set();
    const list = [];
    const add = (w) => {
      const id = w?.tab ?? w?.slept?.key;
      if (!id || seen.has(id)) return;
      seen.add(id);
      list.push(w);
    };
    if (this.shownTab !== null) add({ tab: this.shownTab, space: spaceOfTab(this.shownTab) });
    for (const e of this.recent) add(this.windowOf(e));
    for (const space of this.spacesInOrder()) for (const tab of space.tabs) add({ tab: tab.id, space: space.id });
    return list;
  }

  showWindow({ tab, space }) {
    cancelWant();
    if (space && space !== spaces().find((sp) => sp.active)?.id) run("space.select", { id: space });
    if (space && workspaceOf(space).mode === "board") changeWorkspace(space, { mode: "tabs" });
    run("tab.select", { id: tab });
  }

  nextWindow(closed) {
    const open = this.spacesInOrder().flatMap((space) => space.tabs.map((tab) => ({ tab: tab.id, space: space.id })));
    return [...this.recent.map((e) => this.windowOf(e)), ...open].find((w) => w?.tab && w.tab !== closed && !this.closing.has(w.tab) && isInFilter(w.space)) ?? null;
  }

  leftWindow(closed) {
    if (wantedOf() !== null || this.walk !== null) return;
    const next = this.nextWindow(closed);
    if (next && next.tab !== this.shownTab) this.showWindow(next);
  }

  walkRecent(cx, step) {
    const now = Date.now();
    if (this.walk === null || now > this.walk.until) this.walk = { list: this.recentWindows(), at: 0, until: 0 };
    const walk = this.walk;
    if (walk.list.length < 2) {
      this.walk = null;
      return;
    }
    walk.at = (walk.at + step + walk.list.length) % walk.list.length;
    walk.until = now + RECENT_MS;
    const target = walk.list[walk.at];
    this.picked = target.slept ? target.slept.key : null;
    if (target.tab) this.showWindow(target);
    cx.timer.after(RECENT_MS, (cx) => {
      if (this.walk !== walk || Date.now() < walk.until) return;
      this.walk = null;
      if (target.slept && this.picked === target.slept.key) this.open(shared(PULSE)?.sessions?.[target.slept.key] ?? target.slept, cx);
      else this.picked = null;
      cx.notify();
    });
  }

  closeShownWindow(cx) {
    const pill = this.tabsView?.pills.find((each) => each.isShown);
    if (pill) this.closeNow(cx, pill);
  }

  stepWanted(cx) {
    const w = wantedOf();
    if (w === null || !isLayoutLoaded()) return;
    if (w.id !== this.wantedId) {
      this.wantedId = w.id;
      this.wantedLive = false;
      this.layoutPlaced = new Set();
    }
    const done = () => {
      if (wantedOf()?.id === w.id) setShared(WANTED, null);
    };
    if (Date.now() - w.at > LONG_MS) return done();
    if (!w.session && !w.terminal) {
      if (w.starting || !spaces().some((sp) => sp.id === w.space)) return;
      run("space.select", { id: w.space });
      return done();
    }
    const labelled = terminals().filter((x) => x.state === "live" && (w.terminal ? x.address === w.terminal : x.labels?.[SESSION_LABEL] === w.session));
    const x = labelled.find((each) => !each.program?.shell) ?? labelled[0];
    if (!x) {
      if (this.wantedLive) {
        notify({ title: `${w.title.slice(0, 40)} ended before Herdr showed it`, level: "error" });
        return done();
      }
      if (!isOpening(w.session) && Date.now() - w.at > OPEN_GRACE_MS) return done();
      return cx.timer.after(OPEN_GRACE_MS, (cx) => this.resync(cx));
    }
    this.wantedLive = true;
    if (w.act === "peek") {
      run("terminal.peek", { terminal: x.address });
      return done();
    }
    if (w.act === "present") {
      presentTerminal(shared(PULSE)?.sessions?.[w.session] ?? { key: w.session, title: w.title }, x.address, w.shape);
      return done();
    }
    if (w.act === "split") {
      run("pane.split", { pane: w.pane, direction: w.direction, argv: ["sh", "-c", VIEW, "view", w.session, x.address] });
      return done();
    }
    const pane = panes().find((p) => p.terminal === x.address && (!w.terminal || spaceOfTab(p.tab) === w.space));
    if (!pane) {
      if (w.session && !x.labels?.["herdr.space"] && w.space && this.adoptedFor !== w.id) {
        this.adoptedFor = w.id;
        void hc(["label", x.address, `herdr.space=${w.space.split("/").pop()}`, `herdr.tab=${w.session.slice(0, 8)}`]);
      }
      return;
    }
    if ((w.layout?.steps.length ?? 0) > 0) return this.stepLayout(cx, w);
    if (w.layout?.from && w.layout.from !== pane.tab) this.renameWindow(w.layout.from, pane.tab);
    this.focusTerminal(x.address, pane);
    done();
  }

  resync(cx) {
    this.tabsInputs = "";
    this.syncSoon(cx);
  }

  stepLayout(cx, w) {
    if (shared(SPLIT)) return;
    const ps = panes();
    const addressOf = (session) => terminals().find((x) => x.labels?.[SESSION_LABEL] === session && x.state === "live" && !String(x.address).includes("/"))?.address;
    const paneOf = (address) => (address ? ps.find((p) => p.terminal === address) : undefined);
    const isPlaced = (s) => Boolean(paneOf(addressOf(s.anchor)) && paneOf(addressOf(s.session)));
    const isLost = (s) => [s.anchor, s.session].some((key) => !addressOf(key) && !isOpening(key));
    const steps = w.layout.steps.filter((s) => !isLost(s));
    const ready = steps.find((s) => isPlaced(s) && this.layoutPlaced.has(JSON.stringify(s)));
    this.layoutPlaced = new Set(steps.filter(isPlaced).map((s) => JSON.stringify(s)));
    const rest = ready ? steps.filter((s) => s !== ready) : steps;
    if (rest.length !== w.layout.steps.length) setShared(WANTED, { ...w, layout: { ...w.layout, steps: rest } });
    if (ready) {
      const anchor = paneOf(addressOf(ready.anchor));
      const placed = paneOf(addressOf(ready.session));
      if (anchor.tab !== placed.tab) splitInto([placed.terminal], ready.side, anchor.pane);
    }
    cx.timer.after(RECENT_MS, (cx) => this.resync(cx));
  }

  renameWindow(from, to) {
    const { layout, zoomed } = windowsNow()[from] ?? {};
    if (layout === undefined) return;
    changeWindow(to, { layout, zoomed: zoomed ?? null });
    changeWindow(from, null);
  }

  focusTerminal(address, pane) {
    const space = spaceOfTab(pane.tab);
    if (space && space !== spaces().find((sp) => sp.active)?.id) run("space.select", { id: space });
    if (space && workspaceOf(space).mode === "board") changeWorkspace(space, { mode: "tabs" });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { terminal: address });
    if (TILED.has(windowLayoutOf(pane.tab).mode)) this.focusTarget = address;
    const other = panes().find((p) => p.tab === pane.tab && p.zoomed && p.pane !== pane.pane);
    if (other) run("pane.zoom", { pane: other.pane });
  }

  renderTabs(t) {
    const { isLoaded, work, lights, hasViews, hasButtons, project, openPanel } = this.tabsView;
    const drag = this.pressed?.isMoving ? this.pressed : null;
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
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        this.pointerY = e.local_position.y;
        this.barBounds = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y, width: e.bounds.width, height: e.bounds.height };
        const drag = this.pressed;
        if (!drag) return;
        if (this.isPressGone()) return this.cancelDrag(cx);
        if (drag.moveTo(e.position)) return this.startDrag(cx, drag);
        if (drag.isMoving) this.redrawDrag(cx);
      })
      .on_hover((on, cx) => {
        if (on) return;
        if (this.pressed?.isMoving && this.pointerY > this.height / 2) this.liftOut(cx);
        this.leaveDrag(cx, Boolean(shared(DRAG_TAB)));
      })
      .on_mouse_up("left", (_e, cx) => this.releaseTab(cx))
      .child(h_flex().flex_1().min_w(0).h_full().child(this.listView))
      .when(drag !== null, (el) => el.child(this.liftedView).child(this.dragCatcher()))
      .child(
        h_flex()
          .id("ah-tab-tools")
          .flex_none()
          .gap(UI.space.xs)
          .items_center()
          .when(isLoaded, (el) =>
            el.child(this.iconButton(t, "ah-tab-new", "plus", project && work.workspace?.key !== NONE ? `New session in ${project}` : "New session", () => this.newHere())).children(PANELS.map(([id, label, icon]) => this.panelButton(t, id, label, icon, openPanel === id))),
          )
          .when(isLoaded && hasViews, (el) => el.child(h_flex().id("ah-modes").flex_none().gap(1).items_center().children(MODES.map(([mode, label, icon]) => this.modeButton(t, mode, label, icon, work)))))
          .when(hasButtons, (el) => el.child(this.iconButton(t, "ah-window-min", "minus", "Minimize", () => run("window.minimize"))).child(this.iconButton(t, "ah-window-max", "square", "Maximize", () => run("window.maximize"))).child(this.iconButton(t, "ah-window-close", "x", "Close", () => run("window.close")))),
      );
  }

  slotsOf(pills, discarded) {
    const order = pinsInOrder();
    const rankOf = (keys) => Math.min(...keys.map((key) => order.indexOf(key)).filter((at) => at >= 0));
    const pinned = [
      ...pills.filter((pill) => pill.isPinned).map((pill) => ({ id: pill.tab.id, pill, isPinned: true, lane: "pinned", rank: rankOf(pill.sessions) })),
      ...discarded.filter((session) => session.isPinned).map((session) => ({ id: session.key, discarded: session, isPinned: true, lane: "pinned", rank: rankOf([session.key]) })),
    ].sort((a, b) => a.rank - b.rank);
    const rest = pills.filter((pill) => !pill.isPinned);
    const asleep = discarded.filter((session) => !session.isPinned);
    const lanes = [...new Set([...rest.map((pill) => pill.space), ...asleep.map((session) => session.space)])];
    const grouped = lanes.flatMap((lane) =>
      stripOf(
        rest.filter((pill) => pill.space === lane),
        asleep.filter((session) => session.space === lane),
      ).map((slot) => ({ ...slot, id: slot.pill ? slot.pill.tab.id : slot.discarded.key, isPinned: false, lane })),
    );
    return [...pinned, ...grouped];
  }

  renderTabList(t) {
    const { isLoaded, isAll, labels, project, slots } = this.tabsView;
    const drag = this.pressed?.isMoving ? this.pressed : null;
    const offsets = drag?.sortable ? drag.offsets() : new Map();
    const mounted = new Set();
    this.mounted = mounted;
    return h_flex()
      .id("ah-tab-list")
      .size_full()
      .min_w(0)
      .gap(UI.space.xs)
      .items_center()
      .overflow_x_scroll()
      .track_scroll(this.tabScroll)
      .when(isLoaded && slots.length === 0, (el) => el.child(div().px(UI.space.sm).text_size(UI.text.caption).text_color(t.dim).child(project ? `No open sessions in ${project}` : "No open sessions")))
      .children(slots.flatMap((slot, i) => [...(isAll && this.startsGroup(slots, i) ? [this.chip(t, labels[slot.lane] ?? "", this.hueFor(labels[slot.lane]))] : []), this.slide(this.tabSized(div().id(`ah-slot-${slot.id}`)).child(this.partFor(slot.id, mounted, () => this.slotElement(t, slot))), "x", offsets.get(slot.id) ?? 0, drag !== null)]));
  }

  renderLifted(t) {
    const drag = this.pressed?.isMoving && this.pressed.bounds ? this.pressed : null;
    if (drag !== null && this.kind === "tabs" && this.barBounds) {
      const slot = this.tabsView.slotById.get(drag.id);
      if (slot) return this.liftedAt(this.tabSized(div()).child(this.slotElement(t, slot, true)), drag.bounds, this.barBounds, drag.shift, 0);
    }
    if (drag !== null && this.kind === "board" && this.paneAt) {
      const r = this.board?.model.byKey.get(drag.id);
      if (r) return this.liftedAt(this.boardCard(t, r, false, true), drag.bounds, this.paneAt, drag.at.x - drag.down.x, drag.at.y - drag.down.y);
    }
    if (drag !== null && this.kind === "projects" && this.paneAt) {
      const lifted = this.entries.filter((entry) => this.isLiftedEntry(drag, entry));
      if (lifted.length > 0) return this.liftedAt(lifted.length === 1 ? this.entryElement(t, lifted[0], true) : v_flex().gap(1).rounded(UI.radius.control).bg(t.raised).shadow_md().cursor_grabbing().children(lifted.map((entry) => this.entryElement(t, entry))), drag.bounds, this.paneAt, 0, drag.shift);
    }
    return div().absolute();
  }

  slotElement(t, slot, isGhost = false) {
    return slot.pill ? this.tabPill(t, slot, isGhost) : this.sessionPill(t, slot, isGhost);
  }


  startDrag(cx, drag) {
    const slots = this.tabsView.slots;
    const slot = slots.find((each) => each.id === drag.id);
    if (!slot) return;
    const lane = slots.filter((each) => each.lane === slot.lane);
    drag.sortable = { ids: lane.map((each) => each.id), sizes: lane.map((each) => this.widths.get(each.id) ?? TAB_LEAST), gap: UI.space.xs, axis: "x" };
    this.dragKeys.focus();
    if (slot.pill) setShared(DRAG_TAB, { tab: slot.id, title: slot.pill.tab.name, space: slot.pill.space, terminals: panes().filter((x) => x.tab === slot.id && x.terminal).map((x) => x.terminal), overlay: null, lifted: false });
    this.redrawDragStart(cx, slot.id);
  }

  liftOut(cx) {
    const { work, pills } = this.tabsView;
    const drag = shared(DRAG_TAB);
    if (!drag || drag.overlay || this.barBounds === null || (work.mode !== "tabs" && work.mode !== "start")) return;
    const here = pills.filter((pill) => pill.space === work.id);
    const at = here.findIndex((x) => x.tab.id === drag.tab);
    const neighbour = here[at + 1] ?? here[at - 1];
    if (at >= 0 && !neighbour) return;
    const lifted = at >= 0 && here[at].tab.active;
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

  releaseTab(cx) {
    const { slots } = this.tabsView;
    const drag = this.pressed;
    this.pressed = null;
    if (!drag?.isMoving) return;
    this.dropped = drag.id;
    endTabDrag(true);
    const moved = slots.find((slot) => slot.id === drag.id);
    if (moved && drag.sortable && drag.target !== drag.from) {
      const order = drag.sorted().map((id) => slots.find((slot) => slot.id === id));
      const pinned = new Set(pinsInOrder());
      const sessionsOf = (slot) => (slot.pill ? slot.pill.sessions.filter((key) => pinned.has(key)) : [slot.discarded.key]);
      const sessions = sessionsOf(moved);
      const before = order.slice(order.indexOf(moved) + 1).flatMap(sessionsOf)[0] ?? null;
      if (moved.isPinned) queueMove("pins", orderIn("pins", shared(PULSE)?.pinOrder ?? []), sessions, before, { op: "movePins", sessions, before });
      else if (moved.pill) run("tab.move", { id: moved.id, index: order.filter((slot) => slot.pill?.space === moved.pill.space).indexOf(moved) + 1 });
      this.refreshTabs(this.workNow());
      this.placeParts(cx);
    }
    this.redrawAll(cx);
  }

  closeNow(cx, pill) {
    const { tab } = pill;
    if (pill.isPinned) return;
    if (this.closeTabs(cx, [tab.id], pill.isShown ? { tab: tab.id, space: pill.space } : null)) return;
    this.closing.add(tab.id);
    const next = this.nextWindow(tab.id);
    if (pill.isShown && next) this.showWindow(next);
    cx.notify();
  }

  closeShownSession(cx) {
    const work = this.workNow();
    const terminal = work.shown?.terminal ?? null;
    if (terminal === null || work.terminals.length < 2) return this.closeShownWindow(cx);
    const key = terminals().find((x) => x.address === terminal)?.labels?.[SESSION_LABEL];
    const r = key ? this.sessionRowOf(key) : undefined;
    if (!r) return run("pane.close", { pane: panes().find((p) => p.terminal === terminal)?.pane });
    this.archiveAll(cx, [r], { isClosed: true });
  }

  openSlept(cx, session) {
    const r = shared(PULSE)?.sessions?.[session.key] ?? sleptSessionOf(session.key);
    if (!r || isOpening(session.key)) return;
    this.picked = session.key;
    this.open(r, cx);
    cx.notify();
    const shown = this.tabsView.slots.find((slot) => slot.pill?.isShown);
    for (const key of [session.key, shown?.id]) {
      const view = key === undefined ? undefined : this.partViews.get(key);
      if (view) cx.notify(view);
    }
  }

  archiveSlept(cx, session) {
    const r = shared(PULSE)?.sessions?.[session.key] ?? sleptSessionOf(session.key);
    if (r) this.archiveAll(cx, [{ ...r, pinned: session.isPinned, state: session.state ?? r.state ?? "idle" }]);
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
    const isChosen = (work.mode === "start" || work.mode === "opening" ? work.layoutMode : work.mode) === mode;
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
        if (mode === "master" && isChosen) changeWindowLayout(work.tab, { side: nextSide });
        else this.setMode(work, mode);
        cx.notify();
      })
      .child(svg(iconPath(icon)).size(UI.icon.body));
  }

  tabSized(el) {
    return el.flex_none().max_w(TAB_MOST).h(UI.height.control).overflow_hidden();
  }

  sessionPill(t, slot, isGhost = false) {
    const session = slot.discarded;
    const id = `discarded-${session.key}`;
    const isHovered = this.hovered === id;
    const isDragged = this.pressed?.isMoving === true && this.pressed.id === slot.id;
    const isLoading = isOpening(session.key);
    const isPicked = isLoading && this.picked === session.key;
    return h_flex()
      .id(`ah-tab-${id}`)
      .h_full()
      .max_w_full()
      .on_size_change((size) => this.widths.set(slot.id, size.width))
      .px(UI.space.sm)
      .gap(UI.space.sm)
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.body)
      .text_color(isDragged || isPicked ? t.foreground : session.isPinned ? t.muted : t.dim)
      .cursor_pointer()
      .when(!this.pressed?.isMoving, (el) => el.tooltip(session.isPinned ? `${session.title} · pinned` : `${session.title} · asleep, click to continue`))
      .map((el) => this.surface(el, t, { isSelected: isPicked, isDragged, hover: (s) => s.text_color(t.foreground) }))
      .when(isDragged && !isGhost, (el) => el.opacity(0))
      .on_hover((on, cx) => {
        if (on) this.hovered = id;
        else if (this.hovered === id) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.dropped = null;
        if (slot.isPinned) this.pressed = new Drag(slot.id, e.position, { bounds: e.bounds ?? null });
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.wasDragged(slot.id)) return;
        this.pressed = null;
        this.openSlept(cx, session);
      })
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        this.archiveSlept(cx, session);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        const row = shared(PULSE)?.sessions?.[session.key];
        if (row) this.menu(row);
      })
      .child(isLoading ? this.loadingLead() : (this.stateLead(session.state) ?? this.harnessIcon(t, session)))
      .child(div().min_w(0).truncate().child(session.title))
      .child(this.tabEnd(t, id, session.isPinned, isHovered && !isDragged, "Archive", (cx) => this.archiveSlept(cx, session)));
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

  stateLead(state) {
    if (!state || state === "idle" || !STATE[state]) return null;
    return svg(iconPath(STATE[state].icon)).size(UI.icon.body).flex_none().text_color(this.stateColor(state));
  }

  loadingLead() {
    return svg(`${ICON}/spinner.svg`).size(UI.icon.body).flex_none().text_color(this.stateColor("working")).spin(900);
  }

  tabPill(t, slot, isGhost = false) {
    const { tab, program, sessions, state } = slot.pill;
    const isShown = slot.pill.isShown && this.picked === null;
    const isHovered = this.hovered === tab.id;
    const isDragged = this.pressed?.isMoving === true && this.pressed.id === tab.id;
    const lead = this.stateLead(state) ?? this.programIcon(program, t.muted);
    return h_flex()
      .id(`ah-tab-${tab.id}`)
      .h_full()
      .max_w_full()
      .on_size_change((size) => this.widths.set(slot.id, size.width))
      .px(UI.space.sm)
      .gap(UI.space.sm)
      .items_center()
      .rounded(UI.radius.control)
      .text_size(UI.text.body)
      .cursor_pointer()
      .when(!this.pressed?.isMoving, (el) => el.tooltip(tab.name))
      .text_color(isDragged || isShown ? t.foreground : t.muted)
      .map((el) => this.surface(el, t, { isSelected: isShown, isDragged, hover: (s) => s.text_color(t.foreground) }))
      .when(isDragged && !isGhost, (el) => el.opacity(0))
      .on_hover((on, cx) => {
        if (on) this.hovered = tab.id;
        else if (this.hovered === tab.id) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.dropped = null;
        this.pressed = new Drag(tab.id, e.position, { bounds: e.bounds ?? null });
        if (e.click_count === 2) run("tab.rename", { id: tab.id });
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.wasDragged(tab.id)) return;
        this.pressed = null;
        this.showWindow({ tab: tab.id, space: slot.pill.space });
        cx.notify();
      })
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        this.closeNow(cx, slot.pill);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.windowMenu(windowFacts(tab.id));
      })
      .when(lead !== null, (el) => el.child(lead))
      .child(div().min_w(0).truncate().child(tab.name))
      .child(this.tabEnd(t, tab.id, slot.pill.isPinned, (isShown || isHovered) && !isDragged, sessions.length > 0 ? "Close and archive · Reopen closed tab brings it back" : "Close the tab", (cx) => this.closeNow(cx, slot.pill)));
  }

  renderPane(t) {
    const { pane } = props();
    const p = panes().find((x) => x.pane === pane);
    if (!p) return div();
    const session = terminals().find((x) => x.address === p.terminal)?.labels?.[SESSION_LABEL];
    const name = shared(PULSE)?.sessions?.[session]?.title ?? (((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell");
    const icon = this.programIcon(p.program, t.dim);
    const button = (id, glyph, label, command, args) => this.iconButton(t, `ah-pane-${id}-${pane}`, `mods/pane/${glyph}`, label, () => run(command, args), UI.height.inline);
    return h_flex()
      .id(`ah-pane-head-${pane}`)
      .size_full()
      .px(UI.space.sm)
      .gap(UI.space.sm)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(UI.text.caption)
      .on_hover((on, cx) => {
        this.isPaneHovered = on;
        cx.notify();
      })
      .on_click(() => run("pane.focus", { pane }))
      .when(icon !== null, (el) => el.child(icon))
      .child(div().flex_none().truncate().font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(tildeOf(p.cwd ?? "", home())))
      .when(this.isPaneHovered === true, (el) =>
        el
          .child(button("right", "split-right", "Split right", "pane.split", { direction: "right", pane }))
          .child(button("down", "split-down", "Split down", "pane.split", { direction: "down", pane }))
          .child(button("zoom", p.zoomed ? "unzoom" : "zoom", p.zoomed ? "Show every pane" : "Zoom this pane", "pane.zoom", { pane })),
      );
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
          .child(this.chip(t, `Split ${side}`, t.foreground, { icon: `mods/anyhost/icons/${SPLIT_ICON[side]}` })),
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
            .when(Boolean(choice.project), (el) => el.child(this.counts(t, choice.project)));
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
        const roved = rovedTo(e, this.cursorAt, count);
        if (roved !== null) {
          this.cursorAt = roved;
          this.paletteScroll.scroll_to_item(paletteChildOf(groups, roved));
        }
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
          .child(this.searchField(t, this.query, (cx) => this.paletteSearched(cx))),
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
