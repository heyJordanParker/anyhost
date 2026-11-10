// Every agent of every machine as an inbox, after t3code's thread sidebar: the agents that came back to you on top as
// cards, then shelves that fold for the ones working, the older ones and your machines.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, machines, notify, run, terminals, theme } from "herdr";

const ACTIVE = 12;
const OLDER = 10;
const REFRESH_MS = 60_000;
const MOVE_MS = 600_000;
const ICON = "mods/workspace-chrome";
const PATH = 'PATH="$HOME/.local/share/cmod/programs:$HOME/.local/bin:$PATH" exec anyhost "$@"';

const anyhost = async (args, on = null, timeout = 30_000) => {
  const r = await exec("sh", ["-c", PATH, "anyhost", ...args], { on, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `anyhost ${args[0]} exited with ${r.code}`);
  return r.stdout;
};

// t3code's compact time: now, 5m, 3h, 2d
const ago = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};

const titleOf = (s) => s.title || s.firstPrompt || s.id.slice(0, 8);
const repoOf = (s) => (s.repo ? s.repo.replace(/\.git$/, "").split(/[/:]/).slice(-1)[0] : s.cwd.split("/").slice(-1)[0] || "~");
const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#f97316"];
const colorOf = (name) => PALETTE[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % PALETTE.length];

const folds = () => {
  try {
    return JSON.parse(localStorage.getItem("folded") ?? '["working","older","machines"]');
  } catch {
    return ["working", "older", "machines"];
  }
};

export default class Anyhost extends View {
  init(_props, cx) {
    this.here = null;
    this.devices = [];
    this.sessions = [];
    this.herdrOf = {};
    this.error = null;
    this.moving = {};
    this.open = null;
    this.hovered = null;
    this.older = OLDER;
    this.folded = new Set(folds());
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const [listed, sessions] = await Promise.all([anyhost(["machines", "--json"]), anyhost(["list", "--json"], null, 60_000)]);
        const { here, machines: devices } = JSON.parse(listed);
        this.here = here;
        this.devices = devices;
        this.sessions = JSON.parse(sessions);
        this.herdrOf = { [here]: null };
        for (const { name } of machines()) {
          if (name === null) continue;
          const there = await anyhost(["machines", "--json"], name).then((text) => JSON.parse(text).here, () => null);
          if (there !== null) this.herdrOf[there] = name;
        }
        this.error = null;
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    try {
      localStorage.setItem("folded", JSON.stringify([...this.folded]));
    } catch {}
    cx.notify();
  }

  holderOf(s) {
    const name = s.holder || s.machine;
    return this.devices.find((d) => d.name === name)?.id ?? null;
  }

  // A connected machine the Herdr app does not reach moves the agent here itself, once its turn ends; one that is gone
  // gives it up to a take.
  openSession(s, cx) {
    const live = this.liveOf.get(s.id);
    if (live) return run("pane.focus", { terminal: live });
    const holder = this.holderOf(s);
    const name = titleOf(s).slice(0, 30);
    if (holder === null || holder === this.here) return run("tab.new", { name, argv: ["anyhost", "resume", s.id] });
    if (holder in this.herdrOf) return run("space.new", { machine: this.herdrOf[holder], argv: ["anyhost", "resume", s.id] });
    if (!this.devices.find((d) => d.id === holder)?.connected) return run("tab.new", { name, argv: ["anyhost", "resume", s.id, "--take"] });
    const here = this.devices.find((d) => d.id === this.here)?.name;
    this.moving[s.id] = here;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await anyhost(["tell", s.id, `/move ${here}`]);
        notify({ title: `${s.holder || s.machine} moves ${titleOf(s).slice(0, 40)} here`, body: "It opens here once its turn ends.", level: "info" });
      } catch (error) {
        notify({ title: `${titleOf(s).slice(0, 40)} stays on ${s.holder || s.machine}`, body: String(error.message ?? error), level: "error" });
      }
      delete this.moving[s.id];
      this.refresh(cx);
    });
  }

  move(s, to, cx) {
    this.open = null;
    this.moving[s.id] = to;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const said = await anyhost(["move", s.id, to], null, MOVE_MS);
        notify({ title: `Moved to ${to}`, body: said.trim().split("\n").slice(-1)[0], level: "info" });
      } catch (error) {
        notify({ title: `${titleOf(s).slice(0, 40)} stays here`, body: String(error.message ?? error), level: "error" });
      }
      delete this.moving[s.id];
      this.refresh(cx);
    });
  }

  addMachine(cx) {
    cx.spawn(async (cx) => {
      try {
        const said = await anyhost(["machines", "--invite"]);
        const command = said.trim().split("\n").slice(-1)[0];
        cx.write_to_clipboard(command);
        notify({ title: "Copied the command that joins a machine", body: `Paste it on that machine within 10 minutes.\n${command}`, level: "info", timeout: 15_000 });
      } catch (error) {
        notify({ title: "anyhost made no invite", body: String(error.message ?? error), level: "error" });
      }
    });
  }

  iconButton(t, id, icon, tooltip, onClick) {
    return div()
      .id(id)
      .size(24)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(5)
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

  // the status slot of a card: what the agent does now, else how long ago it last did something
  status(t, s, status) {
    const moving = this.moving[s.id];
    if (moving) return div().text_size(12).text_color(t.working).child(`→ ${moving}`);
    if (status === "working") return h_flex().gap(4).items_center().text_size(12).text_color(t.working).child(svg(`${ICON}/spinner.svg`).size(12).spin(900)).child("Working");
    if (status === "blocked") return div().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).child("Needs you");
    if (status === "done") return h_flex().gap(4).items_center().text_size(12).font_medium().text_color(t.done).child(svg(`${ICON}/circle-check.svg`).size(12)).child("Done");
    return div().text_size(12).text_color(t.dim).child(ago(s.lastActivity));
  }

  moveButton(t, s) {
    const targets = this.devices.filter((d) => d.id !== this.here && d.connected);
    const holder = this.holderOf(s);
    if (s.tool !== "claude" || targets.length === 0 || (holder !== null && holder !== this.here) || this.moving[s.id]) return null;
    return div()
      .id(`ah-mv-${s.id}`)
      .px(6)
      .h(18)
      .flex()
      .items_center()
      .rounded(5)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.open = this.open === s.id ? null : s.id;
        cx.notify();
      })
      .child("Move");
  }

  moveTargets(t, s) {
    const targets = this.devices.filter((d) => d.id !== this.here && d.connected);
    return h_flex()
      .gap(6)
      .px(10)
      .pb(8)
      .children(
        targets.map((d) =>
          div()
            .id(`ah-to-${s.id}-${d.id}`)
            .px(8)
            .h(22)
            .flex()
            .items_center()
            .rounded(6)
            .bg(t.solid)
            .text_color(t.solid_foreground)
            .text_size(12)
            .cursor_pointer()
            .on_click((_e, cx) => this.move(s, d.name, cx))
            .child(d.name),
        ),
      );
  }

  rowFrame(t, s, focusedOn) {
    const live = this.liveOf.get(s.id);
    return v_flex()
      .id(`ah-s-${s.id}`)
      .flex_none()
      .rounded(6)
      .cursor_pointer()
      .when(live !== undefined && live === focusedOn, (el) => el.bg(t.selected))
      .hover((st) => st.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = s.id;
        else if (this.hovered === s.id) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.openSession(s, cx));
  }

  // t3code's card: the project and the status on top, the title, then the machine that holds the agent
  card(t, s, focusedOn) {
    const status = this.statusOf.get(s.id);
    const repo = repoOf(s);
    const where = s.holder || s.machine;
    const isHere = this.holderOf(s) === null || this.holderOf(s) === this.here;
    const move = this.hovered === s.id ? this.moveButton(t, s) : null;
    return this.rowFrame(t, s, focusedOn)
      .opacity(status === "working" && this.hovered !== s.id ? 0.7 : 1)
      .child(
        v_flex()
          .px(10)
          .py(8)
          .gap(4)
          .child(
            h_flex()
              .h(20)
              .gap(6)
              .items_center()
              .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(4).bg(colorOf(repo)).text_size(10).font_bold().text_color("#ffffff").child(repo.slice(0, 1).toUpperCase()))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(repo))
              .child(move ?? this.status(t, s, status)),
          )
          .child(div().truncate().text_size(14).when(status === "blocked" || status === "done", (el) => el.font_medium()).text_color(status === "working" ? t.muted : t.foreground).child(titleOf(s)))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_size(12)
              .text_color(t.dim)
              .child(svg(`${ICON}/${isHere ? "monitor" : "server"}.svg`).size(12))
              .child(div().truncate().child(where)),
          ),
      )
      .when(this.open === s.id, (el) => el.child(this.moveTargets(t, s)));
  }

  // t3code's slim row, for the older agents
  slim(t, s, focusedOn) {
    const repo = repoOf(s);
    return this.rowFrame(t, s, focusedOn).child(
      h_flex()
        .h(36)
        .px(10)
        .gap(10)
        .items_center()
        .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(4).bg(colorOf(repo) + "66").text_size(10).font_bold().text_color("#ffffff").child(repo.slice(0, 1).toUpperCase()))
        .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(t.muted).child(titleOf(s)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(s.holder || s.machine))
        .child(div().flex_none().min_w(32).text_right().text_size(12).text_color(t.dim).child(ago(s.lastActivity))),
    );
  }

  machineRow(t, d) {
    return h_flex()
      .id(`ah-m-${d.id}`)
      .h(32)
      .px(10)
      .gap(10)
      .items_center()
      .child(div().size(7).flex_none().rounded(4).bg(d.connected ? t.done : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(d.id === this.here ? `${d.name} (here)` : d.name))
      .child(div().text_size(12).text_color(t.dim).child(d.connected ? "connected" : `seen ${ago(d.seenAt)}`));
  }

  // a shelf header: the label, a rule, the count and the chevron, folding what is under it
  shelf(t, id, label, count, action = null) {
    const open = !this.folded.has(id);
    return h_flex()
      .id(`ah-shelf-${id}`)
      .h(32)
      .mt(8)
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
      .child(div().font_normal().child(String(count)))
      .when(action !== null, (el) => el.child(action))
      .child(svg(`${ICON}/chevron-${open ? "down" : "right"}.svg`).size(12));
  }

  render() {
    const t = theme();
    // what the Herdr app sees an agent do, else what the machine that runs it says, where waiting at a prompt is the
    // Herdr app's blocked; a labelled terminal that is no agent is a shell herdr-core kept where the runner was lost
    const statusOf = new Map(agents().map((a) => [a.address, a.status]));
    const SAID = { working: "working", waiting: "blocked", idle: "idle" };
    this.liveOf = new Map();
    this.statusOf = new Map(this.sessions.filter((s) => s.status).map((s) => [s.id, SAID[s.status]]));
    for (const terminal of terminals()) {
      const session = terminal.labels?.["anyhost.session"];
      if (!session || terminal.state !== "live" || !statusOf.has(terminal.address)) continue;
      this.liveOf.set(session, terminal.address);
      this.statusOf.set(session, statusOf.get(terminal.address));
    }
    const focusedOn = focused()?.terminal ?? null;
    const working = this.sessions.filter((s) => this.statusOf.get(s.id) === "working");
    const rest = this.sessions.filter((s) => this.statusOf.get(s.id) !== "working");
    const active = rest.slice(0, ACTIVE);
    const older = rest.slice(ACTIVE);
    const empty = (text) => div().px(12).py(24).text_size(12).text_color(t.dim).text_center().child(text);
    return v_flex()
      .id("anyhost")
      .size_full()
      .bg(t.chrome)
      .text_color(t.foreground)
      .child(
        h_flex()
          .h(36)
          .px(10)
          .gap(4)
          .flex_none()
          .items_center()
          .child(div().flex_1().text_size(13).font_semibold().child("Agents"))
          .child(this.iconButton(t, "ah-new", "square-pen", "New agent here", () => run("tab.new", { argv: ["anyhost", "run", "--", "claude"] })))
          .child(this.iconButton(t, "ah-refresh", "layers", "Refresh", (cx) => this.refresh(cx))),
      )
      .when(this.error !== null, (el) => el.child(div().px(10).pb(6).text_size(12).text_color(t.blocked).child(this.error ?? "")))
      .child(
        v_flex()
          .id("ah-list")
          .flex_1()
          .min_h(0)
          .px(6)
          .gap(1)
          .overflow_y_scrollbar()
          .when(this.here === null && this.error === null, (el) => el.child(empty("Reading your agents…")))
          .when(this.here !== null && this.sessions.length === 0, (el) => el.child(empty("No agents yet")))
          .children(active.map((s) => this.card(t, s, focusedOn)))
          .when(working.length > 0, (el) => el.child(this.shelf(t, "working", "Working", working.length)))
          .when(!this.folded.has("working"), (el) => el.children(working.map((s) => this.card(t, s, focusedOn))))
          .when(older.length > 0, (el) => el.child(this.shelf(t, "older", "Older", older.length)))
          .when(!this.folded.has("older"), (el) =>
            el
              .children(older.slice(0, this.older).map((s) => this.slim(t, s, focusedOn)))
              .when(older.length > this.older, (el) =>
                el.child(
                  div()
                    .id("ah-more")
                    .h(36)
                    .px(10)
                    .flex()
                    .items_center()
                    .text_size(12)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.older += 25;
                      cx.notify();
                    })
                    .child(`Show ${Math.min(25, older.length - this.older)} more`),
                ),
              ),
          )
          .child(this.shelf(t, "machines", "Machines", this.devices.length, this.iconButton(t, "ah-add", "plus", "Add a machine", (cx) => this.addMachine(cx))))
          .when(!this.folded.has("machines"), (el) => el.children(this.devices.map((d) => this.machineRow(t, d)))),
      );
  }
}
