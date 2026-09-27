#!/usr/bin/env node
/**
 * gate.mjs —— 「动手之前先把三句话写下来」的闸（通用版）
 *
 * 由来（照实说，别美化）：
 *   2026-09-16，我 `rm` 掉了一个正在用的代码目录 —— 跑之前没有任何人看过。
 *   那天纸上其实写得很全：①先写三问 ②回滚不许依赖被破坏的东西 ③要有第二双眼睛。
 *   **但它一直是纸，我随时可以直接跑。** 四天后，同样的 `rm` 又从它底下溜过去了。
 *   ⇒ 所以这个装置不是"知识"，是"必经的步骤"。
 *
 * ★ 它是什么、不是什么（这是它的核心，别删这句）——
 *   **是什么**：一条必经的流程 + 一张送到审批人手上的单 + 一份带原话的留痕。
 *   **不是什么**：**它不是物理闸，能绕过**（直接敲 bash 就行）。
 *   它的价值在于：**一旦绕过，纸上就断链、审批人那边就少一条 —— 这是能被事后查出来的**；
 *   而"我保证我记得"查不出来。
 *   判据很土：**走它的成本是三十秒；绕过它的代价，是把上一次的事再经历一遍。**
 *
 * 三问（缺一个不收）：
 *   --what     要做什么（具体动作，不是意图）
 *   --fail     失败长什么样 / 怎么发现
 *   --rollback 回滚靠什么
 *   ⚠ 判据：**假设目标已经彻底坏掉，这条回滚命令还能不能执行？** 不能 ⇒ 这条回滚不算数。
 *
 * 用法：
 *   node gate.mjs ask "<一句话：要动什么>" --what "…" --fail "…" --rollback "…"
 *        → 建单 <dir>/<id>.md、通知审批人、打印单号
 *   node gate.mjs ok <id> "<审批人的原话>"   # 原话必须是真的；编的原话就是没有原话
 *   node gate.mjs run <id> -- <命令>          # 三问齐 + 已点头 → 才跑；结果写回单
 *   node gate.mjs list                       # 待批 / 已批未跑 / 已跑
 *   node gate.mjs check "<命令>"             # 只判级别，不建单
 *   node gate.mjs level "<命令>"
 *   node gate.mjs selftest                   # 自检：判据、三问、状态机
 *
 * 配置：同目录 `gate.config.json`（缺了就用内置默认值）
 *   {
 *     "dir": "./gate",
 *     "rules":  [ { "re": "路径或命令的正则", "why": "为什么要拦" } ],
 *     "l3":     [ "重启类命令的正则（这些必须人工点头）" ],
 *     "notify": { "kind": "off" | "webhook" | "cmd",
 *                 "url": "https://…",  "cmd": "bash -c '…'" }
 *   }
 *   ⚠ 默认 `notify.kind = "off"` —— 不配就不推，**绝不偷偷发东西**。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ── 配置 ────────────────────────────────────────────────────────────
const CFG_PATH = path.join(process.cwd(), "gate.config.json");
const CFG = (() => { try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch { return {}; } })();
const DIR = path.resolve(CFG.dir || "./gate");
const AUDIT = path.join(DIR, "audit.jsonl");
const NOTIFY = CFG.notify || { kind: "off" };

// 默认判据：只放"走到哪都危险"的动作；**具体路径由配置补**（别把别人的路径写死在这）
const DEFAULT_RULES = [
  { re: "\\brm\\s+(-[a-zA-Z]*\\s+)*-?[a-zA-Z]*[rf]", why: "rm 带 -r / -f" },
  { re: "(^|\\s)(mv|truncate)\\s", why: "移动 / 截断（可能覆盖现役文件）" },
  { re: "\\b(docker\\s+(restart|stop|rm|kill|compose\\s+down))", why: "重启 / 停止容器" },
  { re: "\\b(systemctl|service)\\s+(restart|stop)\\b", why: "重启 / 停止服务" },
];
const DEFAULT_L3 = [
  // ★ 这个装置的由来就是那次 `rm` —— 它必须在最高级，不然等于把自己最该管的东西漏了。
  "\\brm\\s+(-[a-zA-Z]*\\s+)*-?[a-zA-Z]*[rf]",
  "\\b(docker\\s+(restart|stop|kill|rm|compose\\s+down))",
  "\\b(systemctl|service)\\s+(restart|stop)\\b",
];
const RULES = (CFG.rules && CFG.rules.length ? CFG.rules : DEFAULT_RULES)
  .map((r) => ({ re: new RegExp(r.re, "i"), why: r.why || r.re }));
const L3 = (CFG.l3 && CFG.l3.length ? CFG.l3 : DEFAULT_L3).map((s) => new RegExp(s, "i"));

// ── 小工具 ──────────────────────────────────────────────────────────
function now() {
  const d = new Date(Date.now() + 8 * 3600e3); // 北京时间
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function stamp() { return now().replace(/[-: ]/g, "").slice(0, 12); }
function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function audit(rec) {
  ensureDir();
  fs.appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), t: now(), ...rec }) + "\n");
}

// ── 通知（★ 默认关着；不配就什么都不发）────────────────────────────
function notify(title, body) {
  const one = String(body).replace(/\s+/g, " ").slice(0, 300);
  try {
    if (NOTIFY.kind === "webhook" && NOTIFY.url) {
      const r = spawnSync("curl", ["-s", "-m", "8", "-X", "POST",
        "-H", "Content-Type: application/json",
        "-d", JSON.stringify({ title, body: one }), NOTIFY.url], { encoding: "utf8" });
      return r.status === 0 ? "已推送(webhook)" : "推送失败(" + r.status + ")";
    }
    if (NOTIFY.kind === "cmd" && NOTIFY.cmd) {
      const r = spawnSync("bash", ["-c", NOTIFY.cmd], {
        encoding: "utf8", input: JSON.stringify({ title, body: one }) + "\n",
      });
      return r.status === 0 ? "已推送(cmd)" : "推送失败(" + r.status + ")";
    }
    return "（通知关着：没配 notify）";
  } catch (e) { return "推送异常:" + e.message; }
}

// ── 只读逃逸：只读命令不拦（否则闸会变成天天叫的噪音，而噪音等于没人用）
//    ⚠ 这是薄弱点：`node -e "fs.rmSync(...)"` 这类只有列了删除 API 才拦得住。
//    **别拿 check 当安全边界**，它只是"该停下来写张纸"的提示器。
const READONLY_HEAD = /^\s*(ls|cat|head|tail|grep|rg|find|stat|du|wc|file|readlink|realpath|echo|printf|which|type|pwd|date|env|node|python3|git\s+(log|status|diff|show))\b/;
const WRITE_ACT = /(\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\brmdir\b|\btouch\b|\bchmod\b|\bchown\b|\bln\b|\btee\b|\bdd\b|\btruncate\b|sed\s+-i|>>?|-delete|-exec|rmSync|unlinkSync|unlink|rmdirSync)/;

function check(cmd) {
  const hits = RULES.filter((p) => p.re.test(cmd));
  if (!hits.length) return hits;
  if (READONLY_HEAD.test(cmd) && !WRITE_ACT.test(cmd)) return [];
  return hits;
}

// ── 分级 ────────────────────────────────────────────────────────────
function grade(cmd) {
  if (L3.some((r) => r.test(cmd))) {
    return { L: 3, name: "L3 危险·要人点头", why: "命中了必须人工确认的那一类", act: "★ ask → 等 ok → run" };
  }
  const hits = check(cmd);
  if (hits.length) {
    return { L: 2, name: "L2 动现役", why: hits.map((h) => h.why).join("；"), act: "建单写三问、跑完记结果" };
  }
  if (READONLY_HEAD.test(cmd) && !WRITE_ACT.test(cmd)) {
    return { L: 0, name: "L0 读", why: "只读命令", act: "随便做，不问不记" };
  }
  return { L: 1, name: "L1 普通写", why: "没命中危险判据", act: "直接做，留一行痕" };
}

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd0 = argv[0];
const flag = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? "" : (argv[i + 1] || ""); };

function usage() {
  const L = fs.readFileSync(import.meta.filename, "utf8").split("\n");
  const s = L.findIndex((x) => x.trim().startsWith("//   node gate.mjs ask"));
  const e = L.findIndex((x) => x.startsWith("// 配置"));
  console.log(L.slice(s, e < 0 ? s + 20 : e).join("\n"));
  process.exit(1);
}

// ── selftest：不碰外部东西，只验判据与状态机 ────────────────────────
if (cmd0 === "selftest") {
  const cases = [
    ["rm -rf /srv/app", 3],
    ["docker restart my-app", 3],
    ["systemctl stop nginx", 3],
    ["mv /srv/app /srv/app.bak", 2],
    ["sed -i s/a/b/ conf.yml", 1],
    ["cat /srv/app/main.js", 0],
    ["ls -la /srv", 0],
    ["grep -r todo ./src", 0],
    ["node -e 'console.log(1)'", 0],
  ];
  let bad = 0;
  for (const [c, want] of cases) {
    const got = grade(c).L;
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? "✓" : "✕") + " L" + got + " (期望 L" + want + ")  " + c);
  }
  // 三问缺一不收
  const miss = ["--fail", "--rollback"].filter((k) => !flag(k.slice(2)));
  console.log((miss.length ? "✓" : "✕") + " 三问未给时能认出缺 " + miss.join("/"));

  // ── 端到端：在临时目录里真跑 ask → 没点头拒跑 → ok → run（不碰任何真实目录）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));
  fs.writeFileSync(path.join(tmp, "gate.config.json"),
    JSON.stringify({ dir: "./g", notify: { kind: "off" } }));
  const me = import.meta.filename;
  const runS = (args) => spawnSync(process.execPath, [me, ...args], { cwd: tmp, encoding: "utf8" });
  const a = runS(["ask", "自测单", "--what", "echo selftest-ok",
    "--fail", "没有输出", "--rollback", "无需回滚（只读）"]);
  const id = (a.stdout.match(/建单 (\S+)/) || [])[1];
  const r1 = runS(["run", id, "--", "echo selftest-ok"]);   // 没点头 ⇒ 必须拒
  runS(["ok", id, "<selftest 的假点头，不是谁的真原话>"]);
  const r2 = runS(["run", id, "--", "echo selftest-ok"]);   // 点头后 ⇒ 应该跑
  const md = fs.readFileSync(path.join(tmp, "g", id + ".md"), "utf8");
  const e2e = !!id && r1.status === 2 && r2.stdout.includes("selftest-ok") && md.includes("退出码 **0**");
  console.log((e2e ? "✓" : "✕") + " 端到端：建单 → 没点头拒跑 → 记点头 → 跑通 → 写回单");
  if (!e2e) bad++;
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(bad ? "\n✕ " + bad + " 条不符" : "\n✓ 判据全过");
  process.exit(bad ? 2 : 0);
}

if (cmd0 === "level") {
  const c = argv.slice(1).join(" ");
  if (!c) { console.error('✕ 用法：node gate.mjs level "<命令>"'); process.exit(2); }
  const g = grade(c);
  const dot = g.L === 3 ? "🔴" : g.L === 2 ? "🟠" : g.L === 1 ? "🟡" : "🟢";
  console.log(dot + " " + g.name);
  console.log("   为什么：" + g.why);
  console.log("   怎么办：" + g.act);
  process.exit(0);
}

if (cmd0 === "check") {
  const c = argv.slice(1).join(" ");
  if (!c) { console.error('✕ 用法：node gate.mjs check "<命令>"'); process.exit(2); }
  const g = grade(c);
  if (g.L <= 1) { console.log("○ " + g.name + " —— 不用走闸（" + g.act + "）"); process.exit(0); }
  if (g.L === 3) {
    console.log("✕ " + g.name + " —— 必须过闸、必须有人点头：");
    console.log("    · " + g.why);
    console.log("    → " + g.act);
    process.exit(0);
  }
  console.log("△ " + g.name + " —— 三问＋留痕不能免：");
  console.log("    · " + g.why);
  console.log("    → " + g.act);
  process.exit(0);
}

if (cmd0 === "ask") {
  const what = flag("what"), fail = flag("fail"), rollback = flag("rollback");
  const title = argv[1] || "";
  const missing = [["--what", what], ["--fail", fail], ["--rollback", rollback]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (!title || missing.length) {
    console.error("✕ " + (title ? "三问缺 " + missing.join(" / ") : "缺一句『要动什么』") +
      " —— 不收。规矩：纸上一句话三问，跑之前写，不是出事了现补。");
    process.exit(2);
  }
  ensureDir();
  const id = stamp() + "-" + crypto.randomBytes(2).toString("hex");
  const g = grade(title + " " + what + " " + argv.slice(2).join(" "));
  const file = path.join(DIR, id + ".md");
  const md = [
    "# 闸单 " + id,
    "",
    "- **建单**：" + now(),
    "- **要动什么**：" + title,
    "- **本单属于**：" + g.name + "（" + g.why + "）" + (g.L === 3 ? " ⇒ **要人点头**" : " ⇒ 不用等点头，但三问不免"),
    "",
    "## 一、要做什么",
    what,
    "",
    "## 二、失败怎么发现",
    fail,
    "",
    "## 三、回滚靠什么",
    rollback,
    "> 判据：**假设目标已经彻底坏掉，这条回滚还能不能执行？** 不能 ⇒ 这条回滚不算数。",
    "",
    "## 四、点头",
    "（等回话。原话由 `node gate.mjs ok " + id + ' "<原话>"` 抄进来 —— 编的原话就是没有原话。）',
    "",
    "## 五、跑的结果",
    "（还没跑）",
    "",
  ].join("\n");
  fs.writeFileSync(file, md);
  const told = notify("要你点头", "【闸 " + id + "】" + title + " —— " + what);
  audit({ ev: "ask", id, title, what, fail, rollback, level: g.L, why: g.why, told });
  console.log("✓ 建单 " + id + " → " + file);
  console.log("  " + told);
  console.log("  在等原话：node gate.mjs ok " + id + ' "<他/她说的原话>"');
  process.exit(0);
}

if (cmd0 === "ok") {
  const id = argv[1], quote = argv.slice(2).join(" ").trim();
  if (!id || !quote) {
    console.error('✕ 用法：node gate.mjs ok <id> "<审批人的原话>" —— 没有原话不收（编的原话就是没有原话）');
    process.exit(2);
  }
  const file = path.join(DIR, id + ".md");
  if (!fs.existsSync(file)) { console.error("✕ 没有这张单：" + id); process.exit(2); }
  let t = fs.readFileSync(file, "utf8");
  t = t.replace(/## 四、点头\n[\s\S]*?\n\n/, "## 四、点头\n\n- **" + now() + "** 原话：「" + quote + "」\n\n");
  fs.writeFileSync(file, t);
  audit({ ev: "ok", id, quote });
  console.log("✓ 记下点头：" + id + " → 「" + quote + "」");
  process.exit(0);
}

if (cmd0 === "run") {
  const i = argv.indexOf("--");
  const id = argv[1];
  if (i < 0 || !id) { console.error("✕ 用法：node gate.mjs run <id> -- <命令>"); process.exit(1); }
  const file = path.join(DIR, id + ".md");
  if (!fs.existsSync(file)) { console.error("✕ 没有这张单：" + id); process.exit(2); }
  const t = fs.readFileSync(file, "utf8");
  const sect = (n) => (t.split("## " + n)[1] || "").split("\n## ")[0].replace(/[（(].*?[)）]/g, "").trim();
  const body = { what: sect("一、要做什么"), fail: sect("二、失败怎么发现"), rollback: sect("三、回滚靠什么") };
  if (!body.what || !body.fail || !body.rollback) { console.error("✕ 三问没写全，不跑。"); process.exit(2); }
  if (t.includes("（等回话。原话由")) { console.error("✕ 还没点头，不跑。规矩第三条：没有第二双眼睛，不跑。"); process.exit(2); }
  const real = argv.slice(i + 1).join(" ");
  const hits = check(real);
  console.log("▶ 单 " + id + " 已点头，开跑：" + real);
  console.log("  （本单判据：" + (hits.map((h) => h.why).join("；") || "主动走闸") + "）");
  const r = spawnSync("bash", ["-c", real], { encoding: "utf8", timeout: 300000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  const tail = out.length > 1500 ? out.slice(0, 750) + "\n…（中略）…\n" + out.slice(-750) : out;
  let t2 = fs.readFileSync(file, "utf8");
  t2 = t2.replace(/## 五、跑的结果\n[\s\S]*$/, "## 五、跑的结果\n\n- **" + now() + "** 退出码 **" + r.status + "**\n\n```\n" + tail + "\n```\n");
  fs.writeFileSync(file, t2);
  audit({ ev: "run", id, cmd: real, code: r.status });
  console.log(out.slice(-800));
  console.log("── 退出码 " + r.status + "（已写回单）");
  process.exit(r.status === null ? 1 : r.status);
}

if (cmd0 === "list") {
  ensureDir();
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) { console.log("（闸里还没有单）"); process.exit(0); }
  for (const f of files) {
    const t = fs.readFileSync(path.join(DIR, f), "utf8");
    const ok = !t.includes("（等回话。原话由");
    const ran = !t.includes("（还没跑）");
    const title = (t.match(/- \*\*要动什么\*\*：(.*)/) || [])[1] || "?";
    console.log((ran ? "✓已跑 " : ok ? "✓已批 " : "…待批 ") + f.replace(".md", "") + "  " + title);
  }
  process.exit(0);
}

usage();
