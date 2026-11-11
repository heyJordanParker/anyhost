import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, focused, hc, home, layout, notify, openOverlay, panes, props, run, setAgentOrder, terminals, theme } from "herdr";

const REFRESH_MS = 30_000;
const LONG_MS = 900_000;
const SETTLED_PAGE = 10;
const ACTIVE_PAGE = 20;
const FOUND_MAX = 40;
const ICON = "mods/workspace-chrome";
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
const SETTLE_AFTER = [1, 3, 7, 14, 30, null];
const SHOWN_LABEL = "anyhost.shown.";

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
const titleOf = (s) => s.title || s.firstPrompt || s.id.slice(0, 8);
const projectOf = (s) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-1)[0] : s.cwd.split("/").slice(-1)[0] || "~");
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
const SAID = { working: "working", waiting: "blocked", idle: "idle" };

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

export default class Anyhost extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === "new") return this.initNew(cx);
    if (view === "add") return this.initAdd(cx);
    if (view === "settle") return;
    this.here = null;
    this.devices = [];
    this.candidates = [];
    this.sessions = [];
    this.settleAfterDays = 7;
    this.lastMachine = "";
    this.error = null;
    this.moving = {};
    this.picking = null;
    this.hovered = null;
    this.settledShown = SETTLED_PAGE;
    this.activeShown = ACTIVE_PAGE;
    this.folded = new Set(saved("folded", ["working", "settled"]));
    this.unfolded = new Set(saved("unfolded", []));
    this.marked = new Set();
    this.focusing = null;
    this.cards = [];
    this.found = null;
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => {
      const query = this.search.value().trim().toLowerCase();
      this.found = query === "" ? null : this.cards.filter((card) => card.searched.includes(query)).slice(0, FOUND_MAX);
      cx.notify();
    });
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const [machines, listed] = await Promise.all([anyhost(["machines", "--json"]), anyhost(["list", "--json", "--brief"])]);
        const { here, machines: devices, candidates = [] } = JSON.parse(machines);
        const { agents: sessions, settleAfterDays, lastMachine } = JSON.parse(listed);
        const hereName = devices.find((d) => d.id === here)?.name ?? "";
        const cards = sessions.map((s) => {
          const project = projectOf(s);
          const title = titleOf(s);
          const machine = s.holder || s.machine;
          return { key: s.id, session: s, address: null, status: SAID[s.status] ?? "idle", pinned: false, project, title, machine, isRemote: machine !== hereName, at: s.lastActivity, settled: s.settled, searched: `${title} ${project} ${machine} ${s.cwd}`.toLowerCase() };
        });
        const byKey = new Map(cards.map((card) => [card.key, card]));
        const isChild = (card) => byKey.has(card.session.parent);
        const childrenOf = new Map();
        for (const card of cards.filter(isChild)) childrenOf.set(card.session.parent, [...(childrenOf.get(card.session.parent) ?? []), card]);
        const parents = cards.filter((card) => !isChild(card));
        Object.assign(this, { here, devices, candidates, sessions, settleAfterDays, lastMachine, cards, byKey, childrenOf, unsettled: parents.filter((c) => !c.settled), settledCards: parents.filter((c) => c.settled), error: null });
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    save("folded", [...this.folded]);
    cx.notify();
  }

  deviceOf(name) {
    return this.devices.find((d) => d.name === name) ?? null;
  }

  hereName() {
    return this.devices.find((d) => d.id === this.here)?.name ?? "";
  }

  open(item, cx) {
    if (item.address) return run("pane.focus", { terminal: item.address });
    const s = item.session;
    const holder = this.deviceOf(s.holder || s.machine);
    const isElsewhere = holder !== null && holder.id !== this.here && holder.connected;
    if (s.tool !== "claude") return run("space.new", { tab: titleOf(s).slice(0, 30), argv: anyhostArgv("resume", s.id, ...(isElsewhere ? [] : ["--take"])) });
    if (isElsewhere && !holder.herdr) return this.act(cx, s.id, this.hereName(), ["tell", s.id, `/move ${this.hereName()}`], `${holder.name} moves ${titleOf(s).slice(0, 30)} here once its turn ends`);
    const on = isElsewhere ? holder.herdr : null;
    this.moving[s.id] = "Opening";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { terminal } = JSON.parse(await anyhost(["open", s.id, "--json"], LONG_MS, on));
        this.focusing = on ? `${on}/${terminal}` : terminal;
      } catch (error) {
        notify({ title: "anyhost could not open it", body: String(error.message ?? error), level: "error" });
      }
      delete this.moving[s.id];
      this.refresh(cx);
    });
  }

  focusWhenShown() {
    if (!this.focusing || !panes().some((pane) => pane.terminal === this.focusing)) return;
    run("pane.focus", { terminal: this.focusing });
    this.focusing = null;
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

  act(cx, id, to, args, title) {
    this.moving[id] = to;
    this.picking = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await anyhost(args, LONG_MS);
        notify({ title, level: "info" });
      } catch (error) {
        notify({ title: "anyhost could not do it", body: String(error.message ?? error), level: "error" });
      }
      delete this.moving[id];
      this.refresh(cx);
    });
  }

  settle(cx, s, settled) {
    this.byKey.get(s.id).settled = settled;
    this.unsettled = this.cards.filter((c) => !c.settled);
    this.settledCards = this.cards.filter((c) => c.settled);
    cx.notify();
    cx.spawn(async (cx) => {
      await anyhost(["settle", s.id, ...(settled ? [] : ["--undo"])]).catch((error) => notify({ title: "anyhost could not settle it", body: String(error.message ?? error), level: "error" }));
      this.refresh(cx);
    });
  }

  newSession() {
    const seen = new Set();
    const projects = this.sessions
      .filter((s) => (s.holder || s.machine) === this.hereName() && s.cwd)
      .filter((s) => !seen.has(s.cwd) && seen.add(s.cwd))
      .slice(0, 8)
      .map((s) => ({ name: projectOf(s), folder: s.cwd }));
    const machines = this.devices.filter((d) => d.connected || d.id === this.here).map((d) => d.name);
    const pick = machines.includes(this.lastMachine) ? this.lastMachine : this.hereName();
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
      if (agent && card) live.set(session, { ...card, address: terminal.address, status: agent.status, pinned: Boolean(agent.pinned), settled: false });
    }
    const known = new Set([...live.values()].map((card) => card.address));
    const here = this.hereName();
    const now = new Date().toISOString();
    const others = listed
      .filter((a) => !known.has(a.address) && !kids.has(a.address))
      .map((a) => ({ key: a.address, session: null, address: a.address, status: a.status, pinned: Boolean(a.pinned), project: a.space_name || "", title: a.title || a.program?.name || a.address, machine: a.address.includes("/") ? a.address.split("/")[0] : here, isRemote: a.address.includes("/"), at: now, settled: false }));
    return { live, others, all, statusOf };
  }

  render(cx) {
    const view = props()?.view;
    const t = theme();
    if (view === "new") return this.renderNew(t);
    if (view === "add") return this.renderAdd(t);
    if (view === "settle") return this.renderSettle(t);
    this.isDark = cx.theme().is_dark;
    this.markShown();
    this.focusWhenShown();
    const { live, others, all, statusOf } = this.liveCards();
    const shown = focused()?.terminal ?? null;
    const withLive = (card) => live.get(card.key) ?? card;
    const near = (cards, count) => cards.slice(0, count + live.size).map(withLive);
    const running = [...[...live.values()].filter((card) => !this.byKey?.has(card.session?.parent)), ...others];
    const listedWorking = (this.unsettled ?? []).filter((c) => c.status === "working" && !live.has(c.key));
    const pinned = running.filter((i) => i.pinned);
    const working = [...running.filter((i) => !i.pinned && i.status === "working"), ...listedWorking];
    const resting = [...others.filter((i) => !i.pinned && i.status !== "working"), ...near(this.unsettled ?? [], this.activeShown).filter((i) => !i.pinned && i.status !== "working")];
    const active = [...resting.filter((i) => RANK[i.status] >= 3), ...resting.filter((i) => !(RANK[i.status] >= 3))];
    const activeCount = (this.unsettled ?? []).length - listedWorking.length + others.length;
    const settledCount = (this.settledCards ?? []).filter((c) => !live.has(c.key)).length;
    const settled = (this.settledCards ?? []).slice(0, this.settledShown + live.size).filter((c) => !live.has(c.key)).slice(0, this.settledShown);
    const items = { length: running.length + (this.cards?.length ?? 0) };
    setAgentOrder([...pinned, ...active, ...working].map((i) => i.address).filter(Boolean));
    const kidsOf = (address) => (address ? all.filter((x) => x.parent === address) : []);
    const card = (i) => this.card(t, i, shown, kidsOf(i.address), (this.childrenOf?.get(i.key) ?? []).map(withLive), statusOf);
    if (narrow()) return this.rail(t, [...pinned, ...active, ...working].filter((i) => i.address));
    const empty = (text) => div().px(12).py(24).text_size(12).text_color(t.dim).text_center().child(text);
    const found = this.found === null ? null : this.found.map(withLive);
    return v_flex()
      .id("anyhost")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .child(
        h_flex()
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
          .child(this.iconButton(t, "ah-add", "server", "Add a machine", () => this.addMachine()))
          .child(this.iconButton(t, "ah-new", "square-pen", "New session", () => this.newSession())),
      )
      .when(this.error !== null, (el) => el.child(div().px(14).pb(6).text_size(12).text_color(t.blocked).child(this.error ?? "")))
      .child(
        v_flex()
          .id("ah-list")
          .flex_1()
          .min_h(0)
          .px(8)
          .pb(8)
          .gap(1)
          .overflow_y_scrollbar()
          .when(found !== null, (el) => el.children(found.map((i) => this.slim(t, i, shown))).when(found.length === 0, (el) => el.child(empty("No sessions found"))))
          .when(found === null, (el) =>
            el
              .when(this.here === null && this.error === null, (el) => el.child(empty("Reading your sessions…")))
              .when(this.here !== null && items.length === 0, (el) => el.child(empty("No sessions yet")))
              .children(pinned.map(card))
              .children(active.slice(0, this.activeShown).map(card))
              .when(activeCount > this.activeShown, (el) => el.child(this.more(t, "ah-more-active", Math.min(ACTIVE_PAGE, activeCount - this.activeShown), () => (this.activeShown += ACTIVE_PAGE))))
              .child(div().flex_1())
              .when(working.length > 0, (el) => el.child(this.shelf(t, "working", "Working", working.length)))
              .when(!this.folded.has("working"), (el) => el.children(working.map(card)))
              .when(settledCount > 0, (el) => el.child(this.shelf(t, "settled", "Settled", settledCount,this.iconButton(t, "ah-settle-after", "clock", this.settleAfterDays === null ? "Never settles by itself" : `Settles after ${this.settleAfterDays} idle days`, () => openOverlay({ mod: "anyhost", kind: "popup", width: 200, height: 260, props: { view: "settle", days: this.settleAfterDays } })))))
              .when(!this.folded.has("settled"), (el) => el.children(settled.map((i) => this.slim(t, i, shown))).when(settledCount > this.settledShown, (el) => el.child(this.more(t, "ah-more-settled", Math.min(SETTLED_PAGE * 2.5, settledCount - this.settledShown), () => (this.settledShown += SETTLED_PAGE * 2.5))))),
          ),
      );
  }

  iconButton(t, id, icon, tooltip, onClick) {
    return div()
      .id(id)
      .size(28)
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
      .child(svg(`${ICON}/${icon}.svg`).size(14));
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

  status(t, i) {
    const moving = this.moving[i.key];
    if (moving) return h_flex().gap(4).items_center().text_size(12).text_color(t.working).child(svg(`${ICON}/spinner.svg`).size(12).spin(900)).child(moving);
    if (i.status === "working") return h_flex().gap(4).items_center().text_size(12).text_color(t.working).child(svg(`${ICON}/spinner.svg`).size(12).spin(900)).child("Working");
    if (i.status === "blocked") return div().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).child("Needs you");
    if (i.status === "done") return h_flex().gap(4).items_center().text_size(12).font_medium().text_color(t.done).child(svg(`${ICON}/circle-check.svg`).size(12)).child("Done");
    return div().text_size(12).text_color(t.dim).child(ago(i.at));
  }

  action(t, id, icon, label, onClick) {
    return h_flex()
      .id(id)
      .h(20)
      .px(5)
      .gap(4)
      .items_center()
      .rounded(5)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .when(Boolean(icon), (el) => el.child(svg(`${ICON}/${icon}.svg`).size(12)))
      .when(Boolean(label), (el) => el.child(label));
  }

  targetsOf(i) {
    if (!i.session || i.session.tool !== "claude" || i.isRemote) return [];
    return this.devices.filter((d) => d.id !== this.here && d.connected);
  }

  actions(t, i) {
    const s = i.session;
    return h_flex()
      .gap(1)
      .items_center()
      .when(Boolean(i.address), (el) => el.child(this.action(t, `ah-pin-${i.key}`, i.pinned ? "pin-off" : "pin", null, () => run("terminal.pin", { terminal: i.address, pinned: !i.pinned }))))
      .when(this.targetsOf(i).length > 0, (el) =>
        el.child(
          this.action(t, `ah-mv-${i.key}`, null, "Move", (cx) => {
            this.picking = this.picking === i.key ? null : i.key;
            cx.notify();
          }),
        ),
      )
      .when(Boolean(s), (el) => el.child(this.action(t, `ah-settle-${i.key}`, i.settled ? "chevron-left" : "check", i.settled ? "Bring back" : "Settle", (cx) => this.settle(cx, s, !i.settled))));
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
      .on_click((_e, cx) => this.open(i, cx));
  }

  card(t, i, shown, kids, children, statusOf) {
    const count = kids.length + children.length;
    const isOpen = this.unfolded.has(i.key);
    const statuses = [...kids.map((k) => statusOf.get(k.address)?.status ?? k.status), ...children.map((c) => c.status)];
    const recede = (i.status === "idle" || i.status === "working") && i.address !== shown;
    const machineIcon = i.isRemote ? div().id(`ah-on-${i.key}`).flex_none().text_color(t.dim).tooltip(`On ${i.machine}`).child(svg(`${ICON}/server.svg`).size(12)) : null;
    return this.frame(t, i, shown)
      .opacity(i.status === "working" && this.hovered !== i.key ? 0.7 : 1)
      .child(
        v_flex()
          .px(10)
          .py(8)
          .gap(3)
          .child(
            h_flex()
              .h(20)
              .gap(6)
              .items_center()
              .child(this.mark(t, i.project))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(i.project))
              .child(this.hovered === i.key ? this.actions(t, i) : this.status(t, i)),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(14).when(!recede, (el) => el.font_medium()).text_color(recede ? t.muted : t.foreground).child(i.title))
              .when(machineIcon !== null, (el) => el.child(machineIcon)),
          ),
      )
      .when(count > 0, (el) => el.child(this.childToggle(t, i.key, count, statuses, isOpen)))
      .when(count > 0 && isOpen, (el) =>
        el
          .children(children.map((c) => this.kid(t, `ah-child-${c.key}`, c.title, c.status, (cx) => this.open(c, cx))))
          .children(kids.map((k) => this.kid(t, `ah-kid-${k.address}`, k.name || k.template || k.program?.name || k.address, statusOf.get(k.address)?.status ?? k.status, () => run(statusOf.has(k.address) ? "pane.focus" : "terminal.peek", { terminal: k.address })))),
      )
      .when(this.picking === i.key, (el) => el.child(this.targets(t, i)));
  }

  childToggle(t, key, count, statuses, isOpen) {
    return h_flex()
      .id(`ah-fold-${key}`)
      .h(24)
      .pl(32)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(6)
      .text_size(12)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.unfolded.has(key) ? this.unfolded.delete(key) : this.unfolded.add(key);
        save("unfolded", [...this.unfolded]);
        cx.notify();
      })
      .child(svg(`${ICON}/chevron-${isOpen ? "down" : "right"}.svg`).size(12))
      .child(div().flex_1().min_w(0).child(`${count} ${count === 1 ? "subagent" : "subagents"}`))
      .when(statuses.includes("blocked"), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)))
      .when(!statuses.includes("blocked") && statuses.includes("working"), (el) => el.child(svg(`${ICON}/spinner.svg`).size(11).text_color(t.working).spin(900)));
  }

  kid(t, id, title, status, onClick) {
    return h_flex()
      .id(id)
      .h(24)
      .pl(50)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(title))
      .when(status === "working", (el) => el.child(svg(`${ICON}/spinner.svg`).size(11).text_color(t.working).spin(900)))
      .when(status === "blocked", (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
  }

  targets(t, i) {
    return h_flex()
      .gap(6)
      .px(10)
      .pb(8)
      .children(
        this.targetsOf(i).map((d) =>
          div()
            .id(`ah-to-${i.key}-${d.id}`)
            .px(8)
            .h(22)
            .flex()
            .items_center()
            .rounded(6)
            .bg(t.solid)
            .text_color(t.solid_foreground)
            .text_size(12)
            .cursor_pointer()
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.act(cx, i.key, d.name, ["move", i.key, d.name], `Moved ${i.title.slice(0, 40)} to ${d.name}`);
            })
            .child(d.name),
        ),
      );
  }

  slim(t, i, shown) {
    return this.frame(t, i, shown).child(
      h_flex()
        .h(36)
        .px(10)
        .gap(10)
        .items_center()
        .child(this.mark(t, i.project, this.hovered !== i.key))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(this.hovered === i.key ? t.foreground : t.muted).child(i.title))
        .child(this.hovered === i.key && i.session ? this.actions(t, i) : div().flex_none().text_size(12).text_color(t.dim).child(ago(i.at))),
    );
  }

  more(t, id, count, showMore) {
    return h_flex()
      .id(id)
      .h(36)
      .px(10)
      .gap(10)
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

  shelf(t, id, label, count, accessory = null) {
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
      .when(accessory !== null, (el) => el.child(accessory))
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
      .child(div().text_size(15).font_semibold().child("New session"))
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
      .child(div().text_size(15).font_semibold().child("Add a machine"))
      .child(div().text_size(12.5).text_color(t.muted).child("anyhost installs itself there over ssh and joins it to your machines."))
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

  renderSettle(t) {
    const p = props();
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Settle by itself after"))
      .children(
        SETTLE_AFTER.map((days) =>
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
              anyhost(["settle", "--after", days === null ? "never" : String(days)]).catch((error) => notify({ title: "anyhost kept the setting", body: String(error.message ?? error), level: "error" }));
            })
            .child(div().flex_1().child(days === null ? "Never" : `${days} idle day${days === 1 ? "" : "s"}`))
            .when(days === p.days, (el) => el.child(svg(`${ICON}/check.svg`).size(14).text_color(t.foreground))),
        ),
      );
  }
}
