"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const post = (u, b) => fetch(u, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b||{})})
  .then(r => r.json()).then(j => { if (!j.ok) alert(j.error || "エラー"); return j; });

function fmt(ms, min = true) {
  if (ms == null) return "";
  const neg = ms < 0 ? "-" : ""; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000), t = ms % 1000;
  return neg + (min ? `${m}:${String(s).padStart(2,"0")}` : `${m*60+s}`) + "." + String(t).padStart(3, "0");
}
const gapText = r => r.gap_laps ? `+${r.gap_laps}周` : (r.gap_ms != null ? "+" + fmt(r.gap_ms, false) : "");

let S = null;          // 最新の状態
let regDirty = false;  // 登録表の編集中は再描画しない
let tab = "live";

// ---- タブ ----
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  tab = t;
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelectorAll("main > section").forEach(s => s.hidden = s.id !== "tab-" + t);
  render(true);
}

// ---- 状態取得 ----
async function poll() {
  try { S = await (await fetch("/api/state")).json(); render(false); }
  catch (e) { $("#status").textContent = "サーバー未接続"; }
  setTimeout(poll, 500);
}

function render(force) {
  if (!S) return;
  const ss = S.session;
  $("#status").textContent = ss.state === "running" ? "● 計測中" : ss.state === "stopped" ? "停止" : "待機";
  $("#status").className = "status" + (ss.state === "running" ? " run" : "");
  $("#startstop").textContent = ss.state === "running" ? "計測停止 [Enter]" : "計測開始 [Enter]";
  $("#startstop").disabled = ss.state === "stopped";
  if (tab === "live") renderLive(force);
  else if (tab === "reg") { if (force || !regDirty) renderReg(); }
  else if (tab === "fix") renderFix(force);
  else if (tab === "res") renderRes();
  else if (tab === "set" && force) renderSet();
}

// ---- 計測画面 ----
function fillSelect(sel, items, cur) {
  const html = items.map(v => `<option>${esc(v)}</option>`).join("");
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; }
  if (cur != null) sel.value = cur;
}
let liveInit = false;
function renderLive(force) {
  const ss = S.session;
  if (!liveInit || force) {
    fillSelect($("#cls"), ["(クラス未選択)", ...S.settings.classes]);
    if (!liveInit) { $("#kind").value = ss.kind; $("#cls").value = ss.class_name || "(クラス未選択)"; $("#title").value = ss.title; }
    liveInit = true;
  }
  $("#clock").textContent = (ss.title ? ss.title + "  " : "") + (ss.class_name ? "[" + ss.class_name + "]  " : "")
    + (ss.elapsed_ms != null ? "経過 " + fmt(ss.elapsed_ms) : "");
  const race = ss.kind === "race";
  let h = `<tr><th class="n">Po</th><th>CarNo</th><th>選手</th><th class="n">周回</th><th class="n">Best Time</th>`
        + `<th class="n">Last</th>` + (race ? `<th class="n">Total</th>` : "") + `<th class="n">差</th></tr>`;
  S.ranking.forEach(r => {
    h += `<tr><td class="n">${r.pos}</td><td><b>${esc(r.bib)}</b></td><td>${esc(r.name)}</td><td class="n">${r.laps}</td>`
      + `<td class="n">${fmt(r.best_ms)}${r.best_lap ? ` <small>(${r.best_lap})</small>` : ""}</td><td class="n">${fmt(r.last_ms)}</td>`
      + (race ? `<td class="n">${fmt(r.total_ms)}${r.penalty_ms ? ` <small>(+${r.penalty_ms/1000}s)</small>` : ""}</td>` : "")
      + `<td class="n">${gapText(r)}</td></tr>`;
  });
  $("#rank").innerHTML = h;
  let p = `<tr><th>#</th><th>CarNo</th><th class="n">周</th><th class="n">ラップ</th></tr>`;
  S.recent.forEach(r => { p += `<tr class="${r.ok ? "" : "rej"}"><td>${r.seq}</td><td>${esc(r.bib)}</td><td class="n">${r.lap_no ?? ""}</td><td class="n">${fmt(r.lap_ms)}</td></tr>`; });
  $("#recent").innerHTML = p;
}
$("#fs").onchange = e => document.documentElement.style.setProperty("--fs", e.target.value);
$("#new").onclick = async () => {
  if (S.total_passings && S.session.state !== "stopped" && !confirm("現在の計測データを破棄して新規セッションを作ります。よろしいですか？")) return;
  const cls = $("#cls").value;
  await post("/api/session/new", {kind: $("#kind").value, title: $("#title").value, class_name: cls.startsWith("(") ? "" : cls});
};
$("#startstop").onclick = () => post(S.session.state === "running" ? "/api/session/stop" : "/api/session/start");
$("#reset").onclick = () => { if (confirm("計測をやり直します(今回のデータは消えます)。よろしいですか？")) post("/api/session/reset"); };
document.addEventListener("keydown", e => {
  if (tab !== "live" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === "Enter") { e.preventDefault(); $("#startstop").click(); }
  if (e.key === " ") { e.preventDefault(); $("#reset").click(); }
});

// ---- 発信器登録 ----
const RF = ["bib", "tp", "name", "team", "cls"];
function renderReg() {
  let h = `<tr><th class="n">#</th><th>ゼッケン</th><th>発信器番号</th><th>選手名</th><th>チーム名</th><th>クラス</th><th></th></tr>`;
  S.registry.forEach((e, i) => {
    h += `<tr class="reg"><td class="n">${i + 1}</td>` + RF.map(f => `<td><input data-f="${f}" value="${esc(e[f])}"></td>`).join("")
      + `<td><button data-del="${i}">×</button></td></tr>`;
  });
  $("#reg-table").innerHTML = h;
  regDirty = false;
}
function readReg() {
  return [...document.querySelectorAll("#reg-table tr.reg")].map(tr => Object.fromEntries(
    [...tr.querySelectorAll("input")].map(i => [i.dataset.f, i.value])));
}
$("#reg-table").addEventListener("input", () => regDirty = true);
$("#reg-table").addEventListener("click", e => {
  if (e.target.dataset.del == null) return;
  const rows = readReg(); rows.splice(+e.target.dataset.del, 1); S.registry = rows; regDirty = true; renderReg(); regDirty = true;
});
$("#reg-add").onclick = () => { S.registry = [...readReg(), {bib:"", tp:"", name:"", team:"", cls:""}]; renderReg(); regDirty = true; };
$("#reg-save").onclick = async () => { const j = await post("/api/registry", {entries: readReg()}); if (j.ok) { regDirty = false; alert("保存しました"); } };
$(".file").onclick = () => $("#reg-file").click();
$("#reg-file").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const r = await fetch("/api/registry/import", {method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: await f.arrayBuffer()});
  const j = await r.json(); if (!j.ok) alert(j.error); regDirty = false; e.target.value = "";
};

// ---- 修正 ----
let fixDrv = "";
function renderFix(force) {
  const opts = S.ranking.map(r => `<option value="${esc(r.tp)}">${esc(r.bib)} ${esc(r.name)} (${esc(r.tp)})</option>`).join("");
  const sel = $("#fix-driver");
  if (sel.dataset.h !== opts) { sel.innerHTML = opts; sel.dataset.h = opts; }
  if (S.ranking.some(r => r.tp === fixDrv)) sel.value = fixDrv; else fixDrv = sel.value;
  const extra = S.registry.filter(e => !S.ranking.some(r => r.tp === e.tp))
    .map(e => `<option value="${esc(e.tp)}">${esc(e.bib)} ${esc(e.name)}</option>`).join("");
  const ex = $("#fix-extra"); if (ex.dataset.h !== extra) { ex.innerHTML = extra; ex.dataset.h = extra; }
  const r = S.ranking.find(r => r.tp === fixDrv);
  let h = `<tr><th class="n">周</th><th class="n">ラップ</th><th></th></tr>`;
  (r ? r.laps_detail : []).forEach(l => {
    h += `<tr><td class="n">${l.no}</td><td class="n ${l.invalid ? "inv" : ""}">${fmt(l.ms)}</td><td>`
      + `<button data-lap="${l.no}" data-inv="${l.invalid ? 0 : 1}">${l.invalid ? "復活" : "無効にする"}</button></td></tr>`;
  });
  $("#fix-laps").innerHTML = h;
}
$("#fix-driver").onchange = e => { fixDrv = e.target.value; renderFix(); };
$("#fix-laps").addEventListener("click", e => {
  if (e.target.dataset.lap) post("/api/edit", {op: e.target.dataset.inv === "1" ? "invalidate_lap" : "restore_lap", tp: fixDrv, lap: +e.target.dataset.lap});
});
$("#fix-best").onclick = () => fixDrv && post("/api/edit", {op: "invalidate_best", tp: fixDrv});
$("#fix-pen").onclick = () => fixDrv && post("/api/edit", {op: "penalty", tp: fixDrv, seconds: +$("#pen-s").value});
$("#fix-pen-minus").onclick = () => fixDrv && post("/api/edit", {op: "penalty", tp: fixDrv, seconds: -$("#pen-s").value});
$("#fix-del").onclick = () => fixDrv && confirm("この選手の記録をこのセッションから削除します。よろしいですか？") && post("/api/edit", {op: "remove_driver", tp: fixDrv});
$("#fix-add").onclick = () => $("#fix-extra").value && post("/api/edit", {op: "add_extra", tp: $("#fix-extra").value});

// ---- 結果・印刷 ----
function renderRes() {
  let h = `<tr><th>ID</th><th>タイトル</th><th>種別</th><th>クラス</th><th></th></tr>`;
  S.results.forEach(r => { h += `<tr><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${r.kind === "race" ? "レース" : "タイムトライアル"}</td><td>${esc(r.class_name)}</td><td><button data-load="${esc(r.id)}">読込</button></td></tr>`; });
  const t = $("#res-list"); if (t.dataset.h !== h) { t.innerHTML = h; t.dataset.h = h; }
}
$("#res-list").addEventListener("click", e => { const id = e.target.dataset.load; if (id && confirm("この結果を読み込みます。現在のセッションは置き換わります。よろしいですか？")) post("/api/result/load", {id}); });
$("#res-save").onclick = async () => { const j = await post("/api/result/save"); if (j.ok) alert("保存しました: " + j.id); };
document.querySelectorAll("[data-print]").forEach(b => b.onclick = () => doPrint(b.dataset.print));

function doPrint(what) {
  const ss = S.session, race = ss.kind === "race";
  const head = `<h2 class="pt">${esc(ss.title)} ${esc(ss.class_name)} ${race ? "レース" : "タイムトライアル"} <small>${new Date().toLocaleString("ja-JP")}</small></h2>`;
  let h = head;
  if (what === "rank") {
    h += `<table><tr><th>順位</th><th>ゼッケン</th><th>選手名</th><th>チーム</th><th>周回</th><th>ベスト</th>${race ? "<th>合計</th>" : ""}<th>差</th></tr>`;
    S.ranking.forEach(r => h += `<tr><td>${r.pos}</td><td>${esc(r.bib)}</td><td>${esc(r.name)}</td><td>${esc(r.team)}</td><td>${r.laps}</td><td>${fmt(r.best_ms)}</td>${race ? `<td>${fmt(r.total_ms)}</td>` : ""}<td>${gapText(r)}</td></tr>`);
    h += "</table>";
  } else if (what === "passings") {
    h += `<table><tr><th>#</th><th>ゼッケン</th><th>発信器</th><th>周</th><th>ラップ</th></tr>`;
    S.recent.slice().reverse().forEach(r => h += `<tr><td>${r.seq}</td><td>${esc(r.bib)}</td><td>${esc(r.tp)}</td><td>${r.lap_no ?? ""}</td><td>${fmt(r.lap_ms)}</td></tr>`);
    h += "</table><p><small>※直近30通過</small></p>";
  } else {
    S.ranking.forEach(r => {
      h += `<h3>${esc(r.bib)} ${esc(r.name)}</h3><table><tr><th>周</th><th>ラップ</th></tr>`;
      r.laps_detail.forEach(l => h += `<tr><td>${l.no}</td><td${l.invalid ? ' class="inv"' : ""}>${fmt(l.ms)}</td></tr>`);
      h += `</table>`;
    });
  }
  $("#printarea").innerHTML = h;
  window.print();
}

// ---- 設定 ----
function renderSet() {
  $("#set-min").value = S.settings.min_lap_s;
  $("#set-classes").value = S.settings.classes.join("\n");
}
$("#set-save").onclick = async () => {
  const j = await post("/api/settings", {min_lap_s: +$("#set-min").value, classes: $("#set-classes").value.split("\n")});
  if (j.ok) { liveInit = false; alert("保存しました"); }
};
$("#sim-start").onclick = () => post("/api/sim/start", {speedup: 4});
$("#sim-stop").onclick = () => post("/api/sim/stop");

poll();
