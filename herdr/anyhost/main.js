// Every session of every machine, after t3code's thread sidebar, in the place of the Herdr app's Agents list: a search
// and a new session on top, then cards of the sessions that came back to you, a Working shelf and a Settled shelf. It
// keeps what the Agents list does: the other agents the Herdr app runs, sub-agents under their parent, pins, and the
// order agent.next follows. The same mod draws its own dialogs, by `props().view`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, focused, home, layout, notify, openOverlay, props, run, setAgentOrder, spaces, terminals, theme } from "herdr";

const REFRESH_MS = 30_000;
const LONG_MS = 900_000;
const SETTLED_PAGE = 10;
const ACTIVE_PAGE = 20;
const FOUND_MAX = 40;
const ICON = "mods/workspace-chrome";
const ANYHOST = 'PATH="$HOME/.local/share/cmod/programs:$HOME/.local/bin:$PATH" exec anyhost "$@"';
// Herdr's space avatars: one strong color per hue, light and dark alike
const MARK = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
const SETTLE_AFTER = [1, 3, 7, 14, 30, null];

const anyhost = async (args, timeout = 60_000) => {
  const r = await exec("sh", ["-c", ANYHOST, "anyhost", ...args], { timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `anyhost ${args[0]} exited with ${r.code}`);
  return r.stdout;
};
// what a terminal of the Herdr app runs to run anyhost, here or on another machine
const anyhostArgv = (...args) => ["sh", "-c", ANYHOST, "anyhost", ...args];

const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((child) => find(child, id)).find(Boolean) ?? null);
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// t3code's compact time: now, 5m, 3h, 2d
const ago = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};
const titleOf = (s) => s.title || s.firstPrompt || s.id.slice(0, 8);
const projectOf = (s) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-1)[0] : s.cwd.split("/").slice(-1)[0] || "~");
const markOf = (name) => MARK[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % MARK.length];
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// what a machine says a session does, as the Herdr app names it
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
        // Every session's card, worked out once a refresh, newest first as the program lists them: a render runs at each
        // change of the Herdr app's live data and gets 50 ms, so it only lays the cards it shows over the live terminals.
        const cards = sessions.map((s) => {
          const project = projectOf(s);
          const title = titleOf(s);
          const machine = s.holder || s.machine;
          return { key: s.id, session: s, address: null, status: SAID[s.status] ?? "idle", pinned: false, project, title, machine, isRemote: machine !== hereName, at: s.lastActivity, settled: s.settled, searched: `${title} ${project} ${machine} ${s.cwd}`.toLowerCase() };
        });
        const byKey = new Map(cards.map((card) => [card.key, card]));
        Object.assign(this, { here, devices, candidates, sessions, settleAfterDays, lastMachine, cards, byKey, unsettled: cards.filter((c) => !c.settled), settledCards: cards.filter((c) => c.settled), error: null });
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

  // The session's terminal when it runs, which a focus wakes, else where it continues: here when this machine or none
  // holds it, on its machine when the Herdr app reaches that machine, else here once its machine moves it here, or
  // here from R2 when its machine is offline. It opens as a tab of its project's space, as the program opens one.
  open(item, cx) {
    if (item.address) return run("pane.focus", { terminal: item.address });
    const s = item.session;
    const holder = this.deviceOf(s.holder || s.machine);
    const name = titleOf(s).slice(0, 30);
    if (holder === null || holder.id === this.here) return this.openIn(null, s.cwd, name, anyhostArgv("resume", s.id));
    if (holder.herdr) return this.openIn(holder.herdr, s.cwd, name, anyhostArgv("resume", s.id));
    // a take restores the session into the folder this machine keeps its checkout in, which its space then follows
    if (!holder.connected) return run("space.new", { tab: name, argv: anyhostArgv("resume", s.id, "--take") });
    this.act(cx, s.id, this.hereName(), ["tell", s.id, `/move ${this.hereName()}`], `${holder.name} moves ${name} here once its turn ends`);
  }

  // A tab in the space that works in `folder` on `machine` (null: this one), else a new space there.
  openIn(machine, folder, name, argv) {
    const space = spaces().find((each) => each.machine === machine && each.folder === folder);
    if (space) return run("tab.new", { space: space.id, name, argv });
    run("space.new", { ...(machine ? { machine } : {}), folder, tab: name, argv });
  }

  // Runs anyhost for a card, showing where its session goes meanwhile, and a toast once it is done.
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

  // The cards that run now: each session with a live terminal, with what the Herdr app sees it do, and each other agent
  // the Herdr app runs, as its Agents list shows it. A sub-agent shows under its parent instead.
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
    const { live, others, all, statusOf } = this.liveCards();
    const shown = focused()?.terminal ?? null;
    const withLive = (card) => live.get(card.key) ?? card;
    // Only the cards a shelf shows, plus the ones running now: the program lists sessions newest first, and an agent
    // that needs you or finished comes first.
    const near = (cards, count) => cards.slice(0, count + live.size).map(withLive);
    const running = [...live.values(), ...others];
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
    const card = (i) => this.card(t, i, shown, kidsOf(i.address), statusOf);
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
    return div()
      .size(16)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .bg(markOf(name || "~") + (dim ? "66" : ""))
      .text_size(10)
      .font_bold()
      .text_color("#ffffff")
      .child((name || "~").slice(0, 1).toUpperCase());
  }

  // The status slot: what the agent does now, else how long ago it last did something. Hovered, the card's actions.
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

  // t3code's card: the project and the status on top, then the title, and the machine when it is another one
  card(t, i, shown, kids, statusOf) {
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
      .when(kids.length > 0, (el) => el.children(kids.map((k) => this.kid(t, k, statusOf))))
      .when(this.picking === i.key, (el) => el.child(this.targets(t, i)));
  }

  kid(t, k, statusOf) {
    const status = statusOf.get(k.address)?.status ?? k.status;
    return h_flex()
      .id(`ah-kid-${k.address}`)
      .h(24)
      .pl(32)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(statusOf.has(k.address) ? "pane.focus" : "terminal.peek", { terminal: k.address });
      })
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
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

  // t3code's slim row, for settled sessions and search results
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

  // t3code's shelf header: its label, a rule, its count and its chevron, folding what is under it
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

  // The sidebar folded to a rail, as the Agents list draws it: the running agents by number, with their status.
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

  // The new session dialog: the project, then the machine it runs on, this one or the last one picked by default.
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

  // The add machine dialog, after the Herdr app's own: the machines of the Tailscale network to pick from, or one typed
  // as ssh reaches it. anyhost installs itself there and joins it, and every machine then shows it.
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

  // When a session settles by itself, shared by every machine.
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
