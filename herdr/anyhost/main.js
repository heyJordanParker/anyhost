import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, focused, hc, home, layout, nextCommand, notify, openOverlay, panes, props, run, setAgentOrder, setShared, shared, spaces, terminals, theme } from "herdr";

const REFRESH_MS = 30_000;
const LONG_MS = 600_000;
const MOVING = "anyhost.moving";
const ARCHIVE_PAGE = 40;
const ACTIVE_PAGE = 20;
const FOUND_MAX = 40;
const ICON = "mods/workspace-chrome";
const OWN = "mods/anyhost/icons";
const ANYHOST = 'PATH="$HOME/.local/share/cmod/programs:$HOME/.local/bin:$PATH" exec anyhost "$@"';
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
const ARCHIVE_AFTER = [1, 3, 7, 14, 30, null];
const SHOWN_LABEL = "anyhost.shown.";
const FOLDER_INSET = 36;
const MENU_WIDTH = 200;
const MENU_ROW = 31;
const MENU_ASKED = "anyhost.menu";
const MONO = "Menlo";
const SCREEN_LINES = 60;
const SCREEN_COLUMNS = 110;
const READY_MS = 2500;
const APPS = { "t3-code": "T3 Code", "T3 Code": "T3 Code", "claude-vscode": "VS Code", codex_vscode: "VS Code", "claude-desktop": "Claude app" };
const HARNESS = { claude: { icon: "icons/claude.svg", name: "Claude Code", tint: "#d97757" }, codex: { icon: "icons/codex.svg", name: "Codex", tint: null } };
const DAY_MS = 86_400_000;
const PAGES = new Set(["sessions", "archive", "archive:background", "archive:deleted", "machines"]);
const AGES = [
  ["Today", 1],
  ["Yesterday", 2],
  ["This week", 7],
  ["This month", 30],
  ["Older", Infinity],
];

const anyhost = async (args, timeout = 60_000, on = null) => {
  const r = await exec("sh", ["-c", ANYHOST, "anyhost", ...args], { timeout, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `anyhost ${args[0]} exited with ${r.code}`);
  return r.stdout;
};
const anyhostArgv = (...args) => ["sh", "-c", ANYHOST, "anyhost", ...args];

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((child) => find(child, id)).find(Boolean) ?? null);
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const ago = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};
const ageOf = (at, offsetMs) => {
  const midnight = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const days = Math.max(1, Math.ceil((midnight - Date.parse(at)) / DAY_MS) + 1);
  return AGES.find(([, upTo]) => days <= upTo)[0];
};
const offsetOf = (zone) => {
  const [, sign, hours, minutes] = /([+-])(\d\d)(\d\d)/.exec(zone) ?? [null, "+", "00", "00"];
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
};
const titleOf = (s) => s.title || s.firstPrompt || s.id.slice(0, 8);
const repoOf = (s) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/").toLowerCase() : "");
const projectOf = (s, home) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-1)[0] : s.cwd === home ? "~" : s.cwd.split("/").slice(-1)[0] || "~");
const isBackground = (entrypoint) => /^sdk/.test(entrypoint) || entrypoint === "codex_exec" || entrypoint === "mcp";
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
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const PILLS = {
  blocked: ["Pending Approval", "#d97706", "#fcd34d", false],
  working: ["Working", "#0284c7", "#7dd3fc", true],
  done: ["Completed", "#059669", "#6ee7b7", false],
};
const SAID = { working: "working", waiting: "blocked", idle: "idle" };
const byRecent = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
const iconPath = (icon) => (icon.includes("/") ? `${icon}.svg` : `${ICON}/${icon}.svg`);
const isAfter = (at, than) => Boolean(at) && Boolean(than) && Date.parse(at) > Date.parse(than);

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

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text" || part.type === "input_text" || part.type === "output_text").map((part) => part.text ?? "").join("\n") : "");
const spokenOf = (line, tool) => {
  try {
    const entry = JSON.parse(line);
    if (tool === "codex") {
      const p = entry.payload ?? {};
      const text = p.type === "message" && (p.role === "user" || p.role === "assistant") ? textOf(p.content) : "";
      return text.trim() === "" || text.trimStart().startsWith("<") ? null : { role: p.role, text };
    }
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    if (entry.isMeta || entry.isSidechain) return null;
    const text = textOf(entry.message?.content);
    return text.trim() === "" || text.trimStart().startsWith("<") ? null : { role: entry.type, text };
  } catch {
    return null;
  }
};
const wrapped = (text, width) => {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  return line === "" ? lines : [...lines, line];
};
const screenLinesOf = (tail, tool) => {
  const lines = [];
  for (const said of tail.split("\n").slice(1).map((line) => spokenOf(line, tool)).filter(Boolean)) {
    if (lines.length > 0) lines.push("");
    const paragraphs = said.text.replace(/\*\*|__|`/g, "").split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    for (const [n, paragraph] of paragraphs.entries()) {
      if (n > 0) lines.push("");
      const prefix = n > 0 ? "  " : said.role === "user" ? "❯ " : "● ";
      for (const [at, line] of paragraph.split("\n").flatMap((row) => wrapped(row, SCREEN_COLUMNS)).entries()) lines.push((at === 0 ? prefix : "  ") + line);
    }
  }
  return lines.slice(-SCREEN_LINES);
};

export default class Anyhost extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === "new") return this.initNew(cx);
    if (view === "add" || view === "remove") return this.initAdd(cx);
    if (view === "archive-after") return;
    if (view === "menu") return this.initMenu(cx);
    if (view === "screen") return this.initScreen(cx);
    this.askedAt = shared(MENU_ASKED)?.at ?? 0;
    this.here = null;
    this.devices = [];
    this.candidates = [];
    this.sessions = [];
    this.archiveAfterDays = 7;
    this.lastMachine = "";
    this.error = null;
    this.moving = {};
    this.hovered = null;
    this.page = null;
    this.archiveShown = ARCHIVE_PAGE;
    this.activeShown = ACTIVE_PAGE;
    this.folded = new Set(saved("folded", ["background"]));
    this.unfolded = new Set(saved("unfolded", []));
    this.marked = new Set();
    this.opening = new Map();
    this.cards = [];
    this.found = null;
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => {
      const query = this.search.value().trim().toLowerCase();
      this.found = query === "" ? null : this.cards.filter((card) => card.searched.includes(query)).slice(0, FOUND_MAX);
      cx.notify();
    });
    this.offsetMs = 0;
    const cached = saved("listed", null);
    if (cached) this.apply(cached.machines, cached.listed);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
    cx.spawn(async (cx) => {
      const zone = await exec("sh", ["-c", "date +%z"]).catch(() => null);
      this.offsetMs = offsetOf(zone?.stdout ?? "");
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (PAGES.has(command)) this.go(command === "sessions" ? null : command, cx);
        const [, verb, id] = /^(open|menu)-(.+)$/.exec(command) ?? [];
        const card = id ? this.cards.find((c) => c.key.startsWith(id)) : null;
        const item = card ? this.withRead(this.liveCards().live.get(card.key) ?? card, focused()?.terminal ?? null) : null;
        if (item && verb === "open") this.open(item, cx);
        if (item && verb === "menu") this.menu(item);
      }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const [machines, listed] = await Promise.all([anyhost(["machines", "--json"]), anyhost(["list", "--json", "--brief"])]);
        this.apply(machines, listed);
        save("listed", { machines, listed });
        this.error = null;
      } catch (error) {
        if (this.error === null) notify({ title: "anyhost could not refresh your sessions", body: `${String(error.message ?? error)}\nThe list shows what it last read, and tries again every 30 seconds.`, level: "error" });
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  apply(machines, listed) {
    const { here, machines: devices, candidates = [] } = JSON.parse(machines);
    const { agents: sessions, archiveAfterDays, lastMachine } = JSON.parse(listed);
    const hereName = devices.find((d) => d.id === here)?.name ?? "";
    const cards = sessions.map((s) => {
      const machine = s.holder || s.machine;
      const project = projectOf(s, devices.find((d) => d.name === machine)?.roots?.home);
      const title = titleOf(s);
      const app = APPS[s.entrypoint] ?? null;
      const stage = s.deleted ? "deleted" : s.archived ? "archived" : "active";
      return { key: s.id, session: s, address: null, status: SAID[s.status] ?? "idle", pinned: false, project, repo: repoOf(s), title, machine, app, harness: s.tool, isBackground: isBackground(s.entrypoint ?? ""), stage, isRemote: machine !== hereName, at: s.lastActivity, searched: `${title} ${project} ${machine} ${app ?? ""} ${s.cwd}`.toLowerCase() };
    });
    const byKey = new Map(cards.map((card) => [card.key, card]));
    const childrenOf = new Map();
    for (const card of cards.filter((c) => byKey.has(c.session.parent))) childrenOf.set(card.session.parent, [...(childrenOf.get(card.session.parent) ?? []), card]);
    Object.assign(this, { here, devices, candidates, sessions, archiveAfterDays, lastMachine, cards, byKey, childrenOf, error: null });
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    save("folded", [...this.folded]);
    cx.notify();
  }

  go(page, cx) {
    this.page = page;
    this.archiveShown = ARCHIVE_PAGE;
    cx.notify();
  }

  deviceOf(name) {
    return this.devices.find((d) => d.name === name) ?? null;
  }

  hereName() {
    return this.devices.find((d) => d.id === this.here)?.name ?? "";
  }

  machineOf(herdr) {
    return herdr ? (this.devices.find((d) => d.herdr === herdr)?.name ?? herdr) : this.hereName();
  }

  placeOf(machine) {
    if (machine !== this.hereName()) return machine;
    return this.deviceOf(machine)?.os === "darwin" ? "This Mac" : "This computer";
  }

  labelOf(i, withProject = true) {
    return [withProject ? i.project : null, i.isRemote ? this.placeOf(i.machine) : null, i.app].filter(Boolean).join(" · ");
  }

  open(item, cx, isHere = false) {
    if (item.address) return run("pane.focus", { terminal: item.address });
    const s = item.session;
    if (!s) return;
    const holder = this.deviceOf(s.holder || s.machine);
    const isElsewhere = holder !== null && holder.id !== this.here && holder.connected;
    if (s.tool !== "claude") return run("space.new", { tab: titleOf(s).slice(0, 30), argv: anyhostArgv("resume", s.id, ...(isElsewhere ? [] : ["--take"])) });
    const on = isElsewhere ? holder.herdr || null : null;
    if (item.stage === "archived") this.archive(cx, s, false);
    const place = isHere ? null : (item.app ?? (s.status ? (isElsewhere ? `another terminal on ${holder.name}` : "another terminal") : null));
    this.showScreen(item, on, place);
    if (place) return;
    if (isElsewhere && !holder.herdr) return this.act(cx, s.id, "Moves here once its turn ends", ["tell", s.id, `/move ${this.hereName()}`], `${holder.name} moves ${titleOf(s).slice(0, 30)} here once its turn ends`);
    this.setMoving(s.id, s.status && s.status !== "idle" ? "Moves here once its turn ends" : "Opening");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { terminal } = JSON.parse(await this.untilOpened(s.id, on));
        const screen = this.opening.get(s.id);
        if (screen) screen.terminal = on ? `${on}/${terminal}` : terminal;
      } catch (error) {
        this.closeScreen(s.id);
        notify({ title: "anyhost could not open it", body: String(error.message ?? error), level: "error" });
      }
      this.setMoving(s.id, null);
      this.refresh(cx);
    });
  }

  async untilOpened(id, on) {
    for (;;) {
      try {
        return await anyhost(["open", id, "--json"], LONG_MS, on);
      } catch (error) {
        if (!String(error.message ?? error).includes("took longer than")) throw error;
      }
    }
  }

  setMoving(id, line) {
    if (line === null) delete this.moving[id];
    else this.moving[id] = line;
    setShared(MOVING, { ...this.moving });
  }

  showScreen(item, on, place = null) {
    const s = item.session;
    const name = item.title.slice(0, 28);
    const existing = this.screenTab(name);
    if (existing) {
      run("space.select", { id: existing.space });
      run("tab.select", { id: existing.tab });
      return;
    }
    const space = spaces().find((sp) => sp.folder === s.cwd && (sp.machine ?? null) === on)?.id ?? null;
    if (space) run("space.select", { id: space });
    run("tab.new", { name, mod: "anyhost", props: { view: "screen", key: s.id, title: item.title, label: this.labelOf(item), app: item.app, place, tool: s.tool, on }, ...(space ? { space } : {}) });
    this.opening.set(s.id, { name, terminal: null, listedAt: null });
  }

  screenTab(name) {
    const modTabs = new Set(panes().filter((p) => p.mod === "anyhost").map((p) => p.tab));
    for (const space of spaces()) {
      const tab = space.tabs.find((t) => t.name === name && modTabs.has(t.id));
      if (tab) return { space: space.id, tab: tab.id };
    }
    return null;
  }

  closeScreen(key) {
    const screen = this.opening.get(key);
    this.opening.delete(key);
    const tab = screen ? this.screenTab(screen.name) : null;
    if (tab) run("tab.close", { id: tab.tab, confirmed: true });
  }

  swapWhenDrawn() {
    for (const [key, screen] of this.opening) {
      if (!screen.terminal) continue;
      if (!panes().some((pane) => pane.terminal === screen.terminal)) continue;
      screen.listedAt ??= Date.now();
      const drawn = agents().some((a) => a.address === screen.terminal);
      if (!drawn && Date.now() - screen.listedAt < READY_MS) continue;
      run("pane.focus", { terminal: screen.terminal });
      this.closeScreen(key);
    }
  }

  markShown() {
    if (!this.here) return;
    const at = focused();
    const tab = panes().filter((pane) => pane.tab === at?.tab && pane.terminal);
    const zoomed = tab.some((pane) => pane.zoomed);
    const onScreen = new Set([...tab.filter((pane) => !zoomed || pane.zoomed).map((pane) => pane.terminal), at?.terminal, at?.shown].filter(Boolean));
    const sessions = new Set(terminals().filter((each) => each.state === "live" && each.labels?.["anyhost.session"] && onScreen.has(each.address)).map((each) => each.address));
    const key = `${SHOWN_LABEL}${this.here}`;
    const now = Date.now();
    const stale = now - (this.markedAt ?? 0) > REFRESH_MS;
    for (const address of sessions) if (stale || !this.marked.has(address)) void hc(["label", address, `${key}=${now}`]);
    for (const address of this.marked) if (!sessions.has(address)) void hc(["label", address, `${key}=`]);
    if (stale) this.markedAt = now;
    this.marked = sessions;
  }

  act(cx, id, line, args, title) {
    this.setMoving(id, line);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await anyhost(args, LONG_MS);
        notify({ title, level: "info" });
      } catch (error) {
        notify({ title: "anyhost could not do it", body: String(error.message ?? error), level: "error" });
      }
      this.setMoving(id, null);
      this.refresh(cx);
    });
  }

  archive(cx, s, archived) {
    const card = this.byKey.get(s.id);
    if (card.stage !== "deleted") card.stage = archived ? "archived" : "active";
    cx.notify();
    cx.spawn(async (cx) => {
      await anyhost(["archive", s.id, ...(archived ? [] : ["--undo"])]).catch((error) => notify({ title: archived ? "anyhost could not archive it" : "anyhost could not restore it", body: String(error.message ?? error), level: "error" }));
      this.refresh(cx);
    });
  }

  isUnread(i, shown) {
    if (i.address && i.address === shown && this.sticky !== i.key) return false;
    if (i.status === "done") return true;
    return i.status === "idle" && Boolean(i.session) && isAfter(i.at, i.session.visitedAt);
  }

  withRead(card, shown) {
    if (card.status === "working" || card.status === "blocked") return card;
    return { ...card, status: this.isUnread(card, shown) ? "done" : "idle" };
  }

  visit(cx, s, at) {
    s.visitedAt = at;
    cx.spawn(async () => {
      await anyhost(["visit", s.id, "--at", at]).catch((error) => notify({ title: "anyhost could not mark it read", body: String(error.message ?? error), level: "error" }));
    });
  }

  visitShown(cx, l, shown) {
    const viewed = shown ? [...l.live.values()].find((c) => c.address === shown) : undefined;
    if (this.sticky && viewed?.key !== this.sticky) this.sticky = null;
    if (!viewed?.session || viewed.key === this.sticky || viewed.status === "working") return;
    if (viewed.session.visitedAt && !isAfter(viewed.at, viewed.session.visitedAt)) return;
    this.visit(cx, viewed.session, new Date(Math.max(Date.now(), Date.parse(viewed.at) || 0)).toISOString());
  }

  markUnread(cx, i) {
    this.sticky = i.key;
    this.visit(cx, i.session, new Date(Date.parse(i.at) - 1).toISOString());
    cx.notify();
  }

  remove(cx, i) {
    const s = i.session;
    const holder = this.deviceOf(s.holder || s.machine);
    const on = holder && holder.id !== this.here ? holder.herdr || null : null;
    const card = this.byKey.get(s.id);
    const was = card.stage;
    card.stage = "deleted";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (holder && holder.id !== this.here && !on) throw new Error(`${holder.name} holds it, and the Herdr app does not reach ${holder.name}.`);
        await anyhost(["delete", s.id], LONG_MS, on);
        notify({ title: `Deleted ${i.title.slice(0, 40)}`, body: "Archived sessions › Deleted keeps it. Opening it brings it back.", level: "info" });
      } catch (error) {
        card.stage = was;
        notify({ title: "anyhost could not delete it", body: String(error.message ?? error), level: "error" });
      }
      this.refresh(cx);
    });
  }

  newSession(machine = null, project = null) {
    const machines = this.devices.filter((d) => d.connected || d.id === this.here).map((d) => d.name);
    const pick = machine ?? (machines.includes(this.lastMachine) ? this.lastMachine : this.hereName());
    const home = this.deviceOf(pick)?.roots?.home;
    const seen = new Set(project ? [project.folder] : []);
    const projects = [
      ...(project ? [project] : []),
      ...this.sessions
        .filter((s) => (s.holder || s.machine) === pick && s.cwd)
        .filter((s) => !seen.has(s.cwd) && seen.add(s.cwd))
        .map((s) => ({ name: projectOf(s, home), folder: s.cwd })),
    ].slice(0, 8);
    openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "new", projects, machines, pick } });
  }

  addMachine() {
    openOverlay({ mod: "anyhost", kind: "dialog", width: 420, props: { view: "add", candidates: this.candidates } });
  }

  liveCards() {
    const listed = agents();
    const statusOf = new Map(listed.map((a) => [a.address, a]));
    const all = terminals().filter((x) => x.state === "live");
    const kids = new Set(all.filter((x) => x.parent).map((x) => x.address));
    const live = new Map();
    for (const terminal of all) {
      const session = terminal.labels?.["anyhost.session"];
      const agent = statusOf.get(terminal.address);
      const card = session ? this.byKey?.get(session) : undefined;
      if (agent && card) live.set(session, { ...card, address: terminal.address, status: agent.status, pinned: Boolean(agent.pinned), stage: "active", app: null });
    }
    const known = new Set([...live.values()].map((card) => card.address));
    const now = new Date().toISOString();
    const others = listed
      .filter((a) => !known.has(a.address) && !kids.has(a.address))
      .map((a) => ({ key: a.address, session: null, address: a.address, status: a.status, pinned: Boolean(a.pinned), project: a.space_name || "", repo: "", title: a.title || a.program?.name || a.address, machine: this.machineOf(a.address.includes("/") ? a.address.split("/")[0] : null), app: null, harness: a.app === "codex" ? "codex" : "claude", isBackground: false, stage: "active", isRemote: a.address.includes("/"), at: now }));
    return { live, others, all, statusOf };
  }

  lists(shown = null) {
    const { live, others, all, statusOf } = this.liveCards();
    const withLive = (card) => this.withRead(live.get(card.key) ?? card, shown);
    const cards = (this.cards ?? []).map(withLive);
    const isChild = (c) => this.byKey?.has(c.session?.parent);
    const isRunning = (c) => Boolean(c.address) || c.status === "working";
    const work = cards.filter((c) => !c.isBackground && !isChild(c));
    const active = [...others, ...work.filter((c) => c.stage === "active")];
    const background = cards.filter((c) => c.isBackground && c.stage !== "deleted");
    return {
      live,
      all,
      statusOf,
      withLive,
      active,
      runningBackground: background.filter((c) => isRunning(c) && !isChild(c)),
      archived: work.filter((c) => c.stage === "archived").sort(byRecent),
      background: background.filter((c) => !isRunning(c)).sort(byRecent),
      deleted: cards.filter((c) => c.stage === "deleted").sort(byRecent),
    };
  }

  render(cx) {
    const view = props()?.view;
    const t = theme();
    if (view === "new") return this.renderNew(t);
    if (view === "add") return this.renderAdd(t);
    if (view === "remove") return this.renderRemove(t);
    if (view === "archive-after") return this.renderArchiveAfter(t);
    if (view === "menu") return this.renderMenu(t);
    if (view === "screen") return this.renderScreen(t);
    const asked = shared(MENU_ASKED);
    if (asked && asked.at > this.askedAt && asked.view === (view ?? "sessions")) {
      this.askedAt = asked.at;
      cx.timer.after(0, (cx) => this.perform(asked, cx));
    }
    this.isDark = cx.theme().is_dark;
    this.markShown();
    this.swapWhenDrawn();
    const shown = focused()?.terminal ?? null;
    const l = this.lists(shown);
    this.visitShown(cx, l, shown);
    const kidsOf = (address) => (address ? l.all.filter((x) => x.parent === address) : []);
    const ctx = { t, shown, kidsOf, l };
    const pinned = l.active.filter((i) => i.pinned);
    const rest = l.active.filter((i) => !i.pinned);
    const attention = [...rest.filter((i) => RANK[i.status] >= 3), ...rest.filter((i) => !(RANK[i.status] >= 3)).sort(byRecent)];
    const background = l.runningBackground;
    setAgentOrder([...pinned, ...attention, ...background].map((i) => i.address).filter(Boolean));
    if (narrow()) return this.rail(t, [...pinned, ...attention, ...background].filter((i) => i.address));
    const found = this.found === null ? null : this.found.map(l.withLive);
    const archivedCount = l.archived.length + l.background.length + l.deleted.length;
    return v_flex()
      .id("anyhost")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .child(this.page === null ? this.searchBar(t) : this.pageHead(t, cx))
      .child(
        v_flex()
          .id(`ah-list-${this.page ?? view ?? "sessions"}`)
          .flex_1()
          .min_h(0)
          .px(8)
          .pb(8)
          .gap(1)
          .overflow_y_scrollbar()
          .when(this.here === null, (el) => el.child(this.empty(t, this.error === null ? "Reading your sessions…" : "anyhost could not read your sessions yet. It tries again every 30 seconds.")))
          .when(this.here !== null, (el) => el.children(this.pageRows(ctx, { view, found, pinned, attention, background }))),
      )
      .when(this.page === null && this.here !== null && found === null, (el) => el.child(this.archiveEntry(t, archivedCount)))
      .when(this.page === "archive" && this.here !== null, (el) => el.child(this.archiveCorners(t, l)));
  }

  pageRows(ctx, { view, found, pinned, attention, background }) {
    const { t, l } = ctx;
    if (found !== null) return found.length === 0 ? [this.empty(t, "No sessions found")] : found.map((i) => this.sessionRow(ctx, i));
    if (this.page === "machines") return this.machineRows(t, l);
    if (this.page === "archive") return this.dated(ctx, l.archived, "Nothing archived yet");
    if (this.page === "archive:background") return this.dated(ctx, l.background, "No background runs");
    if (this.page === "archive:deleted") return this.dated(ctx, l.deleted, "No deleted sessions");
    if (view === "projects") return this.projectRows(ctx, [...pinned, ...attention]);
    const card = (i) => this.sessionRow(ctx, i);
    const hasNone = pinned.length + attention.length + background.length === 0;
    return [
      ...(hasNone ? [this.empty(t, "No active sessions")] : []),
      ...pinned.map(card),
      ...attention.slice(0, this.activeShown).map(card),
      ...(attention.length > this.activeShown ? [this.more(t, "ah-more-active", Math.min(ACTIVE_PAGE, attention.length - this.activeShown), () => (this.activeShown += ACTIVE_PAGE))] : []),
      ...(background.length > 0 ? [this.shelf(t, "background", "Background", background.length)] : []),
      ...(this.folded.has("background") ? [] : background.map(card)),
    ];
  }

  dated(ctx, cards, emptyText) {
    const { t } = ctx;
    if (cards.length === 0) return [this.empty(t, emptyText)];
    const shownCards = cards.slice(0, this.archiveShown);
    const rows = [];
    let group = null;
    for (const card of shownCards) {
      const age = ageOf(card.at, this.offsetMs);
      if (age !== group) {
        group = age;
        rows.push(div().id(`ah-age-${age}`).h(28).px(10).pt(10).flex_none().text_size(12).font_medium().text_color(t.dim).child(age));
      }
      rows.push(this.sessionRow(ctx, card));
    }
    if (cards.length > this.archiveShown) rows.push(this.more(t, "ah-more-archive", Math.min(ARCHIVE_PAGE, cards.length - this.archiveShown), () => (this.archiveShown += ARCHIVE_PAGE)));
    return rows;
  }

  empty(t, text) {
    return div().px(12).py(24).text_size(12).text_color(t.dim).text_center().child(text);
  }

  searchBar(t) {
    return h_flex()
      .px(8)
      .pt(8)
      .pb(4)
      .gap(2)
      .flex_none()
      .items_center()
      .child(
        h_flex()
          .h(30)
          .flex_1()
          .min_w(0)
          .px(8)
          .gap(7)
          .items_center()
          .rounded(6)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover))
          .child(svg(`${ICON}/search.svg`).size(14).flex_none())
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)),
      )
      .child(this.iconButton(t, "ah-machines", "server", "Machines", (cx) => this.go("machines", cx)))
      .child(this.iconButton(t, "ah-new", "square-pen", "New session", () => this.newSession()));
  }

  pageHead(t, cx) {
    const titles = { archive: "Archived sessions", "archive:background": "Background", "archive:deleted": "Deleted", machines: "Machines" };
    const back = this.page.startsWith("archive:") ? "archive" : null;
    const accessory =
      this.page === "archive"
        ? this.iconButton(t, "ah-archive-after", "clock", this.archiveAfterDays === null ? "Never archives by itself" : `Archives after ${this.archiveAfterDays} idle days`, () => openOverlay({ mod: "anyhost", kind: "popup", width: 200, height: 260, props: { view: "archive-after", days: this.archiveAfterDays } }))
        : this.page === "machines"
          ? this.iconButton(t, "ah-add", "plus", "Add a machine", () => this.addMachine())
          : null;
    return h_flex()
      .px(8)
      .pt(8)
      .pb(4)
      .gap(2)
      .flex_none()
      .items_center()
      .child(
        h_flex()
          .id("ah-back")
          .h(30)
          .flex_1()
          .min_w(0)
          .pl(4)
          .pr(8)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.go(back, cx))
          .child(svg(`${ICON}/chevron-left.svg`).size(14).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(titles[this.page] ?? "")),
      )
      .when(accessory !== null, (el) => el.child(accessory));
  }

  archiveEntry(t, count) {
    return v_flex().flex_none().px(8).pt(4).pb(8).border_t(1).border_color(t.border).child(this.footerRow(t, "archive", "archive", "Archived sessions", count));
  }

  footerRow(t, page, icon, label, count) {
    return h_flex()
      .id(`ah-${page}`)
      .h(30)
      .px(10)
      .gap(10)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.go(page, cx))
      .child(svg(`${ICON}/${icon}.svg`).size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(label))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(String(count)));
  }

  archiveCorners(t, l) {
    return v_flex()
      .flex_none()
      .px(8)
      .pt(4)
      .pb(8)
      .gap(1)
      .border_t(1)
      .border_color(t.border)
      .child(this.footerRow(t, "archive:background", "layers", "Background", l.background.length))
      .child(this.footerRow(t, "archive:deleted", "x", "Deleted", l.deleted.length));
  }

  machineRows(t, l) {
    const activeOn = new Map();
    for (const card of l.active) activeOn.set(card.machine, (activeOn.get(card.machine) ?? 0) + 1);
    const here = this.hereName();
    const devices = [...this.devices].sort((a, b) => (a.name === here ? -1 : b.name === here ? 1 : a.name.localeCompare(b.name)));
    return devices.map((d) => {
      const isHere = d.id === this.here;
      const connected = isHere || d.connected;
      const hovered = this.hovered === `machine:${d.id}`;
      const count = activeOn.get(d.name) ?? 0;
      const meta = connected ? `${count} active` : d.seenAt ? `offline ${ago(d.seenAt)}` : "offline";
      return h_flex()
        .id(`ah-machine-${d.id}`)
        .h(36)
        .px(10)
        .gap(10)
        .flex_none()
        .items_center()
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = `machine:${d.id}`;
          else if (this.hovered === `machine:${d.id}`) this.hovered = null;
          cx.notify();
        })
        .child(div().size(7).rounded(4).flex_none().bg(connected ? t.ansi2 : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(connected ? t.foreground : t.muted).child(this.placeOf(d.name)))
        .when(!hovered, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(meta)))
        .when(hovered && connected, (el) => el.child(this.iconButton(t, `ah-new-on-${d.id}`, "square-pen", `New session on ${this.placeOf(d.name)}`, () => this.newSession(d.name), 24)))
        .when(hovered && !isHere, (el) => el.child(this.iconButton(t, `ah-remove-${d.id}`, "x", `Remove ${d.name}`, () => openOverlay({ mod: "anyhost", kind: "dialog", width: 380, props: { view: "remove", name: d.name } }), 24)));
    });
  }

  projectRows(ctx, cards) {
    const { t } = ctx;
    const folders = new Map();
    const folderOf = (key, name) => folders.get(key) ?? folders.set(key, { key, name, at: "", cwd: null, machines: new Set(), cards: [], shells: [] }).get(key);
    for (const card of cards) {
      const isOther = !card.repo && card.session;
      const folder = isOther ? folderOf("other", "Other folders") : folderOf(card.repo || `space:${card.project}`, card.project);
      folder.cards.push(card);
      folder.machines.add(card.machine);
      if (card.at > folder.at) folder.at = card.at;
      if (!isOther) folder.cwd ??= card.session?.cwd ?? null;
      folder.machine ??= card.machine;
    }
    const agentTabs = new Set(agents().map((a) => a.tab));
    const ps = panes();
    for (const space of spaces()) {
      const shellTabs = space.tabs.filter((tab) => !agentTabs.has(tab.id) && !ps.some((p) => p.tab === tab.id && p.mod));
      if (shellTabs.length === 0) continue;
      const machine = this.machineOf(space.machine);
      const folder = [...folders.values()].find((f) => f.key !== "other" && f.name === space.name) ?? folderOf(`space:${space.name}`, space.name);
      folder.machines.add(machine);
      folder.machine ??= machine;
      folder.cwd ??= space.folder || null;
      for (const tab of shellTabs) folder.shells.push({ tab, space, title: tab.named ? tab.name : ps.find((p) => p.tab === tab.id)?.title || `Terminal ${tab.index}` });
    }
    const sorted = [...folders.values()].filter((f) => f.key !== "other").sort(byRecent);
    const other = folders.get("other");
    return [...sorted, ...(other ? [other] : [])].map((folder) => this.folder(ctx, folder));
  }

  folder(ctx, f) {
    const { t } = ctx;
    const id = `project:${f.key}`;
    const open = !this.folded.has(id);
    const hovered = this.hovered === id;
    const statuses = f.cards.map((c) => c.status);
    const dot = open ? null : this.pillColor(["blocked", "done", "working"].find((status) => statuses.includes(status)));
    const cards = [...f.cards.filter((c) => RANK[c.status] >= 3), ...f.cards.filter((c) => !(RANK[c.status] >= 3)).sort(byRecent)];
    const isOther = f.key === "other";
    const isHereOnly = f.machines.size === 1 && f.machines.has(this.hereName());
    const places = isHereOnly ? "" : [...f.machines].map((m) => this.placeOf(m)).join(" · ");
    const head = h_flex()
      .id(`ah-${id}`)
      .h(32)
      .mt(4)
      .px(10)
      .gap(10)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = id;
        else if (this.hovered === id) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.fold(id, cx))
      .child(isOther ? div().size(16).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg(`${ICON}/folder.svg`).size(14)) : this.mark(t, f.name))
      .child(div().flex_none().max_w(160).truncate().text_size(13).font_medium().text_color(t.foreground).child(f.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(isOther ? "" : places))
      .when(dot !== null, (el) => el.child(div().size(6).rounded(3).flex_none().bg(dot)))
      .when(!open && !hovered, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(String(f.cards.length + f.shells.length))))
      .when(hovered && !isOther && f.cwd !== null && Boolean(this.deviceOf(f.machine)), (el) => el.child(this.iconButton(t, `ah-pen-${id}`, "square-pen", `New session in ${f.name}`, () => this.newSession(f.machine, { name: f.name, folder: f.cwd }), 22)))
      .child(svg(`${ICON}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
    return v_flex()
      .flex_none()
      .gap(1)
      .child(head)
      .when(open, (el) => el.children(cards.map((i) => this.sessionRow(ctx, i, { inFolder: true, withProject: isOther }))).children(f.shells.map((s) => this.shell(t, s))));
  }

  harnessIcon(t, i, size = 14) {
    const harness = HARNESS[i.harness] ?? HARNESS.claude;
    return div()
      .id(`ah-harness-${i.key}`)
      .size(size)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .tooltip(harness.name)
      .child(harness.tint ? svg(harness.icon).size(size - 2).text_color(harness.tint) : image(harness.icon).size(size - 2));
  }

  sessionRow(ctx, i, { inFolder = false, withProject = true } = {}) {
    const { t, shown, kidsOf, l } = ctx;
    const isShown = Boolean(i.address) && i.address === shown;
    const isHovered = this.hovered === i.key;
    const recede = i.stage !== "active" || (i.status === "idle" && !isShown);
    const subs = this.subsOf(i, kidsOf(i.address), (l.withLive ? (this.childrenOf?.get(i.key) ?? []).map(l.withLive) : []), l.statusOf);
    return this.frame(t, i, shown)
      .child(
        v_flex()
          .pl(inFolder ? FOLDER_INSET - 12 : 10)
          .pr(10)
          .py(7)
          .gap(2)
          .child(
            h_flex()
              .h(20)
              .gap(8)
              .items_center()
              .child(this.harnessIcon(t, i))
              .child(div().flex_1().min_w(0).truncate().text_size(13).when(!recede, (el) => el.font_medium()).text_color(recede && !isHovered ? t.muted : t.foreground).child(i.title))
              .child(isHovered && i.session ? this.actions(t, i) : this.status(t, i)),
          )
          .child(
            h_flex()
              .h(16)
              .pl(22)
              .gap(6)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.labelOf(i, withProject)))
              .when(subs.rows.length > 0, (el) => el.child(this.subagentFold(t, i, subs))),
          ),
      )
      .when(subs.isOpen, (el) => el.pb(4).children(this.subRows(t, subs, inFolder ? FOLDER_INSET + 8 : 30)));
  }

  iconButton(t, id, icon, tooltip, onClick, size = 28) {
    return div()
      .id(id)
      .size(size)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tooltip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(iconPath(icon)).size(14));
  }

  mark(t, name, dim = false) {
    const hue = hueOf(name || "~")[this.isDark ? 1 : 0];
    return div()
      .size(16)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .opacity(dim ? 0.4 : 1)
      .bg(hue + "24")
      .text_size(8)
      .font_bold()
      .text_color(hue)
      .child(monogramOf(name || "~"));
  }

  pillColor(status) {
    const pill = PILLS[status];
    return pill ? pill[this.isDark ? 2 : 1] : null;
  }

  status(t, i) {
    const moving = this.moving[i.key];
    if (moving) return h_flex().flex_none().gap(4).items_center().text_size(12).text_color(this.pillColor("working")).child(svg(`${ICON}/spinner.svg`).size(12).spin(900)).child(moving);
    const pill = PILLS[i.status];
    if (!pill) return div().flex_none().text_size(12).text_color(t.dim).child(ago(i.at));
    const color = this.pillColor(i.status);
    return h_flex()
      .flex_none()
      .gap(5)
      .items_center()
      .text_size(12)
      .font_medium()
      .text_color(color)
      .child(div().size(6).rounded(3).flex_none().bg(color).when(pill[3], (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200, easing: "ease-in-out" })))
      .child(pill[0]);
  }

  actions(t, i) {
    if (i.stage === "active") return this.iconButton(t, `ah-archive-${i.key}`, "archive", "Archive", (cx) => this.archive(cx, i.session, true), 20);
    const restore = div()
      .id(`ah-restore-${i.key}`)
      .h(20)
      .px(6)
      .flex()
      .flex_none()
      .items_center()
      .rounded(5)
      .text_size(12)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (i.stage === "deleted") this.open(i, cx);
        else this.archive(cx, i.session, false);
      })
      .child("Restore");
    if (i.stage === "deleted") return restore;
    return h_flex()
      .flex_none()
      .gap(2)
      .items_center()
      .child(restore)
      .child(this.iconButton(t, `ah-delete-${i.key}`, `${OWN}/trash`, "Delete", (cx) => this.remove(cx, i), 20));
  }

  targetsOf(i) {
    if (!i.session || i.session.tool !== "claude" || i.isRemote) return [];
    return this.devices.filter((d) => d.id !== this.here && d.connected);
  }

  frame(t, i, shown) {
    return v_flex()
      .id(`ah-${i.key}`)
      .flex_none()
      .rounded(6)
      .cursor_pointer()
      .when(Boolean(i.address) && i.address === shown, (el) => el.bg(t.selected))
      .hover((st) => st.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = i.key;
        else if (this.hovered === i.key) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.open(i, cx))
      .on_mouse_down("right", () => this.menu(i));
  }

  menu(i) {
    const s = i.session;
    const p = { view: "menu", from: props()?.view ?? "sessions", key: i.key, address: i.address, pinned: i.pinned, stage: i.stage, isSession: Boolean(s), isWorking: i.status === "working", canUnread: Boolean(s) && i.status === "idle" && Boolean(i.at), cwd: s?.cwd ?? "", targets: this.targetsOf(i).map((d) => d.name) };
    openOverlay({ mod: "anyhost", kind: "popup", frame: "none", width: MENU_WIDTH * 2 + 8, height: 320, props: p });
  }

  subsOf(i, kids, children, statusOf) {
    const rows = [...children.map((c) => ({ id: `ah-child-${c.key}`, title: c.title, status: c.status, open: (cx) => this.open(c, cx) })), ...kids.map((k) => ({ id: `ah-kid-${k.address}`, title: k.name || k.template || k.program?.name || k.address, status: statusOf.get(k.address)?.status ?? k.status, open: () => run(statusOf.has(k.address) ? "pane.focus" : "terminal.peek", { terminal: k.address }) }))];
    return { rows, isOpen: rows.length > 0 && this.unfolded.has(i.key) };
  }

  subagentFold(t, i, subs) {
    const top = subs.rows.map((s) => s.status).reduce((most, s) => ((RANK[s] ?? 0) > (RANK[most] ?? 0) ? s : most), null);
    return div()
      .id(`ah-fold-${i.key}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .flex_none()
      .items_center()
      .rounded(4)
      .text_size(12)
      .text_color(subs.isOpen ? t.dim : (t[top] ?? t.dim))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${subs.rows.length} ${subs.rows.length === 1 ? "subagent" : "subagents"}`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.unfolded.has(i.key) ? this.unfolded.delete(i.key) : this.unfolded.add(i.key);
        save("unfolded", [...this.unfolded]);
        cx.notify();
      })
      .child(svg(`${ICON}/chevron-${subs.isOpen ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!subs.isOpen, (el) => el.child(String(subs.rows.length)));
  }

  subRows(t, subs, indent) {
    return subs.rows.map((s, n) =>
      h_flex()
        .id(s.id)
        .h(26)
        .pl(indent)
        .pr(10)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          s.open(cx);
        })
        .child(div().self_start().mt(-4).w(9).h(17).mr(6).flex_none().border_l(1.5).border_b(1.5).rounded_bl(6).border_color(t.input).when(n < subs.rows.length - 1, (el) => el.rounded_bl(0)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.title))
        .when(Boolean(PILLS[s.status]), (el) => el.child(div().size(6).rounded(3).flex_none().bg(this.pillColor(s.status)).when(PILLS[s.status]?.[3] === true, (dot) => dot.loop("opacity", { from: 0.3, to: 1, period: 1200, easing: "ease-in-out" })))),
    );
  }

  shell(t, s) {
    const isShown = s.space.active && s.tab.active;
    return h_flex()
      .id(`ah-tab-${s.tab.id}`)
      .h(32)
      .pl(FOLDER_INSET - 22)
      .pr(10)
      .gap(8)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(isShown, (el) => el.bg(t.selected))
      .hover((st) => st.bg(t.hover))
      .on_click(() => {
        run("space.select", { id: s.space.id });
        run("tab.select", { id: s.tab.id });
      })
      .child(div().size(14).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg(`${ICON}/terminal.svg`).size(12)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(isShown ? t.foreground : t.muted).child(s.title));
  }

  perform(asked, cx) {
    const item = this.liveCards().live.get(asked.key) ?? this.byKey?.get(asked.key) ?? { key: asked.key, address: asked.address, session: null };
    if (asked.action === "open") return this.open(item, cx, asked.here === true);
    if (asked.action === "pin") return run("terminal.pin", { terminal: asked.address, pinned: !asked.pinned });
    if (asked.action === "archive") return this.archive(cx, item.session, true);
    if (asked.action === "restore") return this.archive(cx, item.session, false);
    if (asked.action === "unread") return this.markUnread(cx, item);
    if (asked.action === "delete") return this.remove(cx, item);
    if (asked.action === "move") this.act(cx, asked.key, `Moving to ${asked.to}`, ["move", asked.key, asked.to], `Moved ${item.title?.slice(0, 40) ?? asked.key.slice(0, 8)} to ${asked.to}`);
  }

  initMenu(cx) {
    this.at = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(item, cx) {
    const p = props();
    closeOverlay(p.overlay);
    if (item.copy !== undefined) return cx.write_to_clipboard(item.copy);
    setShared(MENU_ASKED, { at: Date.now(), view: p.from, key: p.key, address: p.address ?? null, pinned: p.pinned, ...item.ask });
  }

  renderMenu(t) {
    const p = props();
    const groups = [
      [
        ...(p.address ? [{ id: "pin", icon: p.pinned ? "pin-off" : "pin", label: p.pinned ? "Unpin" : "Pin to the top", ask: { action: "pin" } }] : []),
        ...(p.targets.length > 0 ? [{ id: "move", icon: "server", label: "Move to", sub: p.targets.map((to) => ({ id: `move-${to}`, icon: "server", label: to, ask: { action: "move", to } })) }] : []),
      ],
      [
        ...(p.canUnread ? [{ id: "unread", icon: `${OWN}/mail-open`, label: "Mark unread", ask: { action: "unread" } }] : []),
        ...(p.isSession
          ? [
              {
                id: "copy",
                icon: `${OWN}/copy`,
                label: "Copy",
                sub: [...(p.cwd ? [{ id: "copy-path", icon: "folder", label: "Folder path", copy: p.cwd }] : []), { id: "copy-id", icon: `${OWN}/hash`, label: "Session ID", copy: p.key }],
              },
            ]
          : []),
      ],
      p.isSession
        ? [
            ...(p.stage === "active" ? [{ id: "archive", icon: "archive", label: "Archive", ask: { action: "archive" }, disabled: p.isWorking }] : []),
            ...(p.stage === "archived" ? [{ id: "restore", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "restore" } }] : []),
            ...(p.stage === "deleted" ? [{ id: "undelete", icon: `${OWN}/archive-restore`, label: "Restore", ask: { action: "open" } }] : []),
            ...(p.stage !== "deleted" ? [{ id: "delete", icon: `${OWN}/trash`, label: "Delete", ask: { action: "delete" }, isDestructive: true }] : []),
          ]
        : [],
    ].filter((group) => group.length > 0);
    const items = groups.flat();
    const rowsBefore = (item) => {
      const group = groups.findIndex((g) => g.includes(item));
      return items.indexOf(item) * MENU_ROW + group * 9;
    };
    const opened = items.find((item) => item.id === this.at && item.sub) ?? null;
    const entry = (item, onHover) => {
      const color = item.disabled ? t.dim : item.isDestructive ? t.ansi1 : t.foreground;
      const iconColor = item.disabled ? t.dim : item.isDestructive ? t.ansi1 : t.muted;
      return h_flex()
        .id(`ah-menu-${item.id}`)
        .h(MENU_ROW)
        .px(8)
        .gap(9)
        .flex_none()
        .rounded(7)
        .items_center()
        .text_color(color)
        .when(!item.disabled && this.at === item.id, (el) => el.bg(t.selected))
        .when(!item.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_hover((on, cx) => {
          if (on) onHover(cx);
        })
        .on_click((_e, cx) => {
          if (!item.disabled && (item.ask || item.copy !== undefined)) this.choose(item, cx);
        })
        .child(svg(iconPath(item.icon)).size(14).flex_none().text_color(iconColor))
        .child(div().flex_1().truncate().child(item.label))
        .when(Boolean(item.sub), (el) => el.child(svg(`${ICON}/chevron-right.svg`).size(12).flex_none().text_color(t.dim)));
    };
    const hoverAt = (item) => (cx) => {
      this.at = item.id;
      cx.notify();
    };
    const panel = () => v_flex().w(MENU_WIDTH).p(5).bg(t.popover).rounded(9).border_1().border_color(t.border).shadow_lg().text_size(13);
    return h_flex()
      .id("ah-menu")
      .track_focus(this.handle)
      .size_full()
      .items_start()
      .gap(2)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(p.overlay);
      })
      .child(panel().children(groups.flatMap((group, n) => [...(n > 0 ? [div().h(1).my(4).mx(3).flex_none().bg(t.border)] : []), ...group.map((item) => entry(item, hoverAt(item)))])))
      .when(opened !== null, (el) => el.child(panel().mt(rowsBefore(opened)).children(opened.sub.map((item) => entry(item, () => undefined)))));
  }

  initScreen(cx) {
    const p = props();
    this.lines = [];
    this.shownAt = Date.now();
    const folder = p.tool === "codex" ? '"${CODEX_HOME:-$HOME/.codex}/sessions"' : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"';
    const script = `f=$(find ${folder} -name '*${p.key}.jsonl' -not -path '*/subagents/*' 2>/dev/null | head -1); [ -n "$f" ] && tail -c 524288 "$f"`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", script], { timeout: 10_000, on: p.on ?? null }).catch(() => null);
      this.lines = r && r.code === 0 ? screenLinesOf(r.stdout, p.tool) : [];
      cx.notify();
    });
    cx.timer.after(16, (cx) => {
      this.revealed = true;
      cx.notify();
    });
  }

  screenButton(t, id, label, isPrimary, onClick) {
    return div()
      .id(id)
      .h(30)
      .px(12)
      .flex()
      .flex_none()
      .items_center()
      .rounded(7)
      .text_size(13)
      .font_medium()
      .cursor_pointer()
      .when(isPrimary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!isPrimary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  renderScreen(t) {
    const p = props();
    const isT3 = p.app === "T3 Code";
    const moving = shared(MOVING)?.[p.key] ?? null;
    const isAsking = Boolean(p.place) && moving === null;
    const ask = (action) => setShared(MENU_ASKED, { at: Date.now(), view: "sessions", key: p.key, address: null, ...action });
    const ghost = v_flex()
      .absolute()
      .inset_0()
      .px(20)
      .pb(20)
      .justify_end()
      .overflow_hidden()
      .font_family(MONO)
      .text_size(13)
      .text_color(t.muted)
      .loop("opacity", { from: 0.22, to: 0.42, period: 2400, easing: "ease-in-out" })
      .children(this.lines.map((line, n) => div().id(`ah-line-${n}`).flex_none().whitespace_nowrap().child(line || " ")));
    const handoff = v_flex()
      .w(320)
      .p(20)
      .gap(14)
      .items_center()
      .rounded(12)
      .bg(t.popover)
      .border_1()
      .border_color(t.border)
      .shadow_lg()
      .opacity(this.revealed ? 1 : 0)
      .transition("opacity", { duration: 200, easing: "ease-out" })
      .child(
        v_flex()
          .gap(4)
          .items_center()
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`This session is working in ${p.place}`))
          .child(div().max_w(280).truncate().text_size(12).text_color(t.dim).child(p.title)),
      )
      .child(
        h_flex()
          .gap(8)
          .when(isT3, (el) => el.child(this.screenButton(t, "ah-open-t3", "Open in T3 Code", true, () => exec("sh", ["-c", 'open -a "T3 Code (Beta)" 2>/dev/null || open -a "T3 Code"'], { on: p.on ?? null }))))
          .child(this.screenButton(t, "ah-move-here", "Move it here", !isT3, () => ask({ action: "open", here: true }))),
      );
    const opening = h_flex()
      .absolute()
      .bottom(24)
      .left(0)
      .right(0)
      .justify_center()
      .child(
        h_flex()
          .h(28)
          .px(12)
          .gap(8)
          .items_center()
          .rounded(14)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .text_size(12)
          .text_color(t.muted)
          .opacity(this.revealed ? 1 : 0)
          .transition("opacity", { duration: 200, easing: "ease-out" })
          .child(svg(`${ICON}/spinner.svg`).size(12).text_color(t.working).spin(900))
          .child(moving ?? (p.tool === "codex" ? "Starting Codex" : "Starting Claude Code")),
      );
    return div()
      .id("ah-screen")
      .size_full()
      .relative()
      .overflow_hidden()
      .bg(t.background)
      .child(ghost)
      .when(isAsking, (el) => el.child(h_flex().absolute().inset_0().items_center().justify_center().child(handoff)))
      .when(!isAsking, (el) => el.child(opening));
  }

  more(t, id, count, showMore) {
    return h_flex()
      .id(id)
      .h(32)
      .px(10)
      .gap(10)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(13)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        showMore();
        cx.notify();
      })
      .child(svg(`${ICON}/chevron-down.svg`).size(14))
      .child(`Show ${count} more`);
  }

  shelf(t, id, label, count) {
    const open = !this.folded.has(id);
    return h_flex()
      .id(`ah-shelf-${id}`)
      .h(32)
      .mt(6)
      .px(8)
      .gap(8)
      .flex_none()
      .items_center()
      .text_size(12)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.fold(id, cx))
      .child(label)
      .child(div().flex_1().h(1).bg(t.border))
      .child(div().font_normal().text_color(t.dim).child(String(count)))
      .child(svg(`${ICON}/chevron-${open ? "down" : "right"}.svg`).size(12));
  }

  rail(t, items) {
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .pt(6)
      .children(
        items.map((i, n) =>
          h_flex()
            .id(`ah-rail-${i.key}`)
            .h(26)
            .px(8)
            .gap(4)
            .items_center()
            .hover((s) => s.bg(t.hover))
            .on_click(() => run("pane.focus", { terminal: i.address }))
            .child(div().flex_1().text_right().text_size(12).text_color(t.muted).child(String(n + 1)))
            .child(div().size(7).rounded(4).bg(i.status === "idle" ? t.dim + "00" : (t[i.status] ?? t.dim)).border(1.5).border_color(t[i.status] ?? t.dim)),
        ),
      );
  }

  initNew(cx) {
    const p = props();
    this.machine = p.pick;
    this.starting = false;
    this.failed = null;
    this.folder = InputState.new({ placeholder: "Or a folder: ~/Developer/app" });
    this.folder.on("submit", (_e, cx) => this.start(cx, this.folder.value().trim()));
    cx.timer.after(300, () => this.folder.focus());
  }

  start(cx, folder) {
    if (!folder || this.starting) return;
    this.starting = true;
    this.failed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const said = await anyhost(["new", this.machine, folder.replace(/^~(?=\/|$)/, home())], LONG_MS);
        const started = /started (\w{8})/.exec(said)?.[1];
        for (let tries = 0; started && tries < 20; tries++) {
          const terminal = terminals().find((x) => x.state === "live" && x.labels?.["anyhost.session"]?.startsWith(started));
          if (terminal) {
            run("pane.focus", { terminal: terminal.address });
            break;
          }
          await new Promise((resolve) => cx.timer.after(500, resolve));
        }
        closeOverlay(props().overlay);
      } catch (error) {
        this.failed = String(error.message ?? error);
        this.starting = false;
        cx.notify();
      }
    });
  }

  renderNew(t) {
    const p = props();
    const row = (id, label, sub, onClick) =>
      h_flex()
        .id(id)
        .h(34)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => onClick(cx))
        .child(this.mark(t, label))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub));
    return v_flex()
      .id("ah-new")
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("New session"))
      .child(v_flex().gap(1).children(p.projects.map((project) => row(`ah-p-${project.folder}`, project.name, project.folder, (cx) => this.start(cx, project.folder)))))
      .child(Input.new(this.folder).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .flex_wrap()
          .child(div().text_size(12).text_color(t.dim).child("Runs on"))
          .children(
            p.machines.map((name) =>
              h_flex()
                .id(`ah-m-${name}`)
                .h(24)
                .px(8)
                .gap(5)
                .items_center()
                .rounded(6)
                .text_size(12)
                .cursor_pointer()
                .when(name === this.machine, (el) => el.bg(t.solid).text_color(t.solid_foreground))
                .when(name !== this.machine, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                .on_click((_e, cx) => {
                  this.machine = name;
                  cx.notify();
                })
                .child(svg(`${ICON}/server.svg`).size(11))
                .child(name),
            ),
          ),
      )
      .when(this.starting, (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(`${ICON}/spinner.svg`).size(12).text_color(t.working).spin(900)).child(`Starting on ${this.machine}`)))
      .when(this.failed !== null, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.failed ?? "")));
  }

  initAdd(cx) {
    this.adding = null;
    this.failed = null;
    this.target = InputState.new({ placeholder: "user@host" });
    this.target.on("submit", (_e, cx) => this.add(cx, this.target.value().trim()));
    cx.timer.after(300, () => this.target.focus());
  }

  add(cx, target) {
    if (!target || this.adding) return;
    this.adding = target;
    this.failed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await anyhost(["machines", "--add", target], LONG_MS);
        notify({ title: `Added ${target}`, body: "Its sessions show on every machine.", level: "info" });
        closeOverlay(props().overlay);
      } catch (error) {
        this.failed = String(error.message ?? error);
        this.adding = null;
        cx.notify();
      }
    });
  }

  renderAdd(t) {
    const p = props();
    return v_flex()
      .id("ah-add")
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Add a machine"))
      .child(div().text_size(13).text_color(t.muted).child("anyhost installs itself there over ssh and joins it to your machines."))
      .child(
        v_flex()
          .gap(1)
          .children(
            p.candidates.map((c) =>
              h_flex()
                .id(`ah-c-${c.target}`)
                .h(34)
                .px(10)
                .gap(10)
                .items_center()
                .rounded(7)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.add(cx, c.target))
                .child(svg(`${ICON}/${c.os === "macOS" ? "monitor" : "server"}.svg`).size(14).text_color(t.muted))
                .child(div().flex_1().text_size(13).text_color(c.online ? t.foreground : t.dim).child(c.target))
                .child(this.adding === c.target ? svg(`${ICON}/spinner.svg`).size(12).text_color(t.working).spin(900) : div().text_size(12).text_color(t.dim).child(c.online ? "" : "offline")),
            ),
          ),
      )
      .child(Input.new(this.target).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .when(this.adding !== null, (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(`${ICON}/spinner.svg`).size(12).text_color(t.working).spin(900)).child(`Installing on ${this.adding}`)))
      .when(this.failed !== null, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.failed ?? "")));
  }

  renderRemove(t) {
    const p = props();
    return v_flex()
      .id("ah-remove")
      .w_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child(`Remove ${p.name}?`))
      .child(div().text_size(13).text_color(t.muted).child("It stops backing up. Its sessions stay listed and you can still resume them."))
      .when(this.failed !== null, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.failed ?? "")))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(this.screenButton(t, "ah-remove-keep", "Keep it", true, () => closeOverlay(p.overlay)))
          .child(
            this.screenButton(t, "ah-remove-go", this.adding ? "Removing…" : "Remove", false, (cx) => {
              if (this.adding) return;
              this.adding = p.name;
              cx.notify();
              cx.spawn(async (cx) => {
                try {
                  await anyhost(["machines", "--remove", p.name]);
                  closeOverlay(props().overlay);
                } catch (error) {
                  this.failed = String(error.message ?? error);
                  this.adding = null;
                  cx.notify();
                }
              });
            }),
          ),
      );
  }

  renderArchiveAfter(t) {
    const p = props();
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .child(div().px(8).pt(4).pb(6).text_size(12).text_color(t.dim).child("Archive by itself after"))
      .children(
        ARCHIVE_AFTER.map((days) =>
          h_flex()
            .id(`ah-after-${days}`)
            .h(30)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .hover((el) => el.bg(t.hover))
            .on_click(() => {
              closeOverlay(p.overlay);
              anyhost(["archive", "--after", days === null ? "never" : String(days)]).catch((error) => notify({ title: "anyhost kept the setting", body: String(error.message ?? error), level: "error" }));
            })
            .child(div().flex_1().child(days === null ? "Never" : `${days} idle day${days === 1 ? "" : "s"}`))
            .when(days === p.days, (el) => el.child(svg(`${ICON}/check.svg`).size(14).text_color(t.foreground))),
        ),
      );
  }
}
