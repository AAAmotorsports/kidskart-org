import type { APIRoute } from 'astro';

export const prerender = false;

// GET /embed/aone.js
//
// rk-a1.com (WordPress) に貼り付けるウィジェット。
//
//   <div data-aone="today"></div>
//   <script src="https://<予約システム>/embed/aone.js" async></script>
//
// 予約フォームを埋め込む場合はこちら (data-kind で種類を選ぶ):
//
//   <div data-aone="reserve" data-kind="sport">
//     <a href="https://<予約システム>/reserve/sport">スポーツ走行のご予約へ進む</a>
//   </div>
//   <script src="https://<予約システム>/embed/aone.js" async></script>
//
// 中の a タグは、script が読み込めなかったときの逃げ道 (読み込めれば消える)。
// フォームだけは枠 (iframe) で貼る。フォームの中身をここに書き写すと、
// 本体を直したときに片方だけ古くなるため。二重スクロールにならないよう、
// 枠の高さは中身の高さに合わせて自動で伸びる (postMessage で受け取る)。
//
// iframe ではなく WordPress ページの DOM を直接描画するので、
//   * スマホで高さが崩れない
//   * 戻るボタンや画面遷移が不自然にならない
//   * ホームページ側の見た目 (フォント) を引き継ぐ
// データは /api/public/today と /api/public/month から取得する。
// 予約者の氏名など個人情報は API に含まれない。
//
// 予約システムの URL が将来 reserve.rk-a1.com に変わっても、この script の
// src を差し替えるだけでリンク先も自動的に切り替わる (script 自身の origin を
// 基準にリンクを組み立てるため)。
const WIDGET_JS = String.raw`
(function () {
  'use strict';

  var me = document.currentScript;
  var ORIGIN = (function () {
    try { return new URL(me.src).origin; } catch (e) { return ''; }
  })();

  var CSS = [
    '.aone-w{--aone-line:#d7e0e8;--aone-ink:#12233a;--aone-ink3:#6d8095;',
    '  --aone-green:#1e9e62;--aone-green-bg:#e6f5ee;--aone-amber:#f5a623;--aone-red:#d7263d;',
    '  color:var(--aone-ink);line-height:1.6;font-size:15px;margin:0 0 1.2em;',
    '  box-sizing:border-box;text-align:left}',
    '.aone-w *{box-sizing:border-box}',
    '.aone-w a{text-decoration:none}',
    '.aone-card{border:1px solid var(--aone-line);border-radius:12px;padding:14px;background:#fff}',
    '.aone-head{display:flex;justify-content:space-between;align-items:center;gap:10px;',
    '  flex-wrap:wrap;margin-bottom:10px}',
    '.aone-date{font-size:1.15em;font-weight:800;margin:0}',
    '.aone-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.aone-wx{display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:.85em;',
    '  padding:4px 12px;border-radius:99px;background:var(--aone-green-bg);color:#14724a;',
    '  border:1px solid #b9e3cf}',
    '.aone-wx.warn{background:#fff5e2;color:#8a5a06;border-color:#f2d69b}',
    '.aone-wx.ng{background:#fdeef0;color:#a81a2d;border-color:#f2bcc4}',
    // 準備中・本日は終了。異常ではないので警告色にはしない
    '.aone-wx.soft{background:#eef2f6;color:#42566b;border-color:#d5dee7}',
    '.aone-open{margin:0 0 10px;font-weight:700;color:#33475f;font-size:.95em}',
    // 路面状況は営業状況と別軸なので、色を持たせず控えめに出す
    '.aone-sf{display:inline-flex;align-items:center;font-weight:700;font-size:.85em;',
    '  padding:4px 12px;border-radius:99px;background:#eef2f6;color:#42566b;',
    '  border:1px solid #d5dee7}',
    '.aone-msg{margin:0 0 10px;padding:8px 12px;border-radius:8px;font-size:.9em;',
    '  background:#fff5e2;border:1px solid #f2d69b;color:#8a5a06}',
    '.aone-msg.ng{background:#fdeef0;border-color:#f2bcc4;color:#a81a2d}',
    '.aone-sess+.aone-sess{margin-top:12px;padding-top:12px;border-top:1px dashed var(--aone-line)}',
    '.aone-sess-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;font-size:.9em}',
    '.aone-sess-h b{font-size:1.05em}',
    '.aone-sess-h span{color:var(--aone-ink3)}',
    // auto-fill にしているのは、PC でカテゴリーが 2 つしかないときに
    // カードが画面幅いっぱいまで伸びてしまわないようにするため
    '.aone-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:6px}',
    '.aone-cat{text-align:center;border:1px solid var(--aone-line);border-radius:9px;padding:7px 3px;',
    '  background:#f7fafc}',
    '.aone-cat.ok{background:var(--aone-green-bg);border-color:#b9e3cf}',
    '.aone-cat-n{font-size:.78em;font-weight:700;color:#33475f}',
    '.aone-mark{font-size:1.4em;font-weight:800;line-height:1.1}',
    '.aone-mark.open{color:var(--aone-green)}.aone-mark.limited{color:var(--aone-amber)}',
    '.aone-mark.closed{color:var(--aone-red)}.aone-mark.off{color:#a8b8c5}',
    '.aone-cat-t{font-size:.72em;color:var(--aone-ink3)}',
    '.aone-cat.ok .aone-cat-t{color:#14724a;font-weight:700}',
    '.aone-rp{margin-top:12px;padding-top:12px;border-top:1px dashed var(--aone-line);font-size:.92em}',
    '.aone-rp b{display:block;margin-bottom:2px}',
    '.aone-ev{margin-top:10px;font-size:.85em}',
    '.aone-ev span{display:inline-block;background:#e8f1fb;color:#1d5386;border-radius:5px;',
    '  padding:1px 8px;margin:2px 4px 2px 0;font-weight:700}',
    '.aone-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}',
    '.aone-btn{display:inline-block;padding:10px 18px;border-radius:99px;font-weight:800;',
    '  font-size:.92em;border:1px solid var(--aone-line);background:#fff;color:var(--aone-ink)}',
    '.aone-btn.primary{background:var(--aone-red);border-color:var(--aone-red);color:#fff}',
    '.aone-note{font-size:.78em;color:var(--aone-ink3);margin-top:8px}',
    // 予約不要のレンタルカート走行
    '.aone-rent{border:1px solid var(--aone-line);border-radius:10px;padding:10px 12px;margin-top:10px}',
    '.aone-rent.ok{border-color:#b9e3cf;background:var(--aone-green-bg)}',
    '.aone-rent-line{font-weight:700;font-size:1.02em;margin-top:4px}',
    '.aone-rent-line .y{color:var(--aone-green);font-size:1.2em;margin-right:4px}',
    '.aone-rent-line .n{color:var(--aone-red);font-size:1.2em;margin-right:4px}',
    '.aone-rent-warn{font-size:.8em;font-weight:700;color:var(--aone-red);margin-top:3px}',
    '.aone-tag{font-size:.72em;font-weight:700;margin-left:6px;padding:1px 6px;border-radius:999px;',
    '  background:#fff;border:1px solid var(--aone-line);color:var(--aone-ink3)}',
    // レンタルのお客様への注記。読み飛ばされると意味がないので枠で囲む
    '.aone-hint{border:1px solid var(--aone-line);border-left:3px solid var(--aone-green);',
    '  border-radius:0 8px 8px 0;padding:8px 10px;background:#f7fbf9;color:var(--aone-ink)}',
    // ご予約不要のレンタルカート走行ができる日
    '.aone-rok{color:var(--aone-green);font-weight:800;font-size:.92em;margin-bottom:2px}',
    '.aone-note a{color:var(--aone-red);font-weight:700;text-decoration:underline}',
    '.aone-cal{width:100%;border-collapse:collapse;font-size:.82em;table-layout:fixed}',
    '.aone-cal th{background:#12233a;color:#fff;padding:4px 0;font-size:.9em;font-weight:700;',
    '  text-align:center}',
    '.aone-cal th.sun{color:#ffb3bd}.aone-cal th.sat{color:#b7d8ff}',
    '.aone-cal td{border:1px solid var(--aone-line);vertical-align:top;height:96px;padding:3px;',
    '  width:14.28%}',
    '.aone-cal td.pad{background:#f7fafc}',
    '.aone-cal td.today{outline:2px solid var(--aone-red);outline-offset:-2px}',
    '.aone-cal td.closed{background:#fdeef0}',
    '.aone-cal td.past{background:#f7fafc}',
    '.aone-cal td.past .aone-d{color:#a8b8c5}',
    '.aone-cell{display:block;height:100%;text-decoration:none;color:inherit}',
    '.aone-body{display:block}',
    '.aone-dow{display:none}',
    '.aone-cal td.linkable:hover{background:#fff8f9;box-shadow:inset 0 0 0 2px var(--aone-red)}',

    // 「AM」「PM」の小さな印。予定名の横と、予約の入口の頭に付ける
    '.aone-stag{display:inline-block;flex:0 0 auto;margin-left:4px;padding:0 4px;',
    '  border-radius:3px;',
    '  background:var(--aone-line);color:var(--aone-ink);font-size:.82em;font-weight:800}',
    '.aone-stag.on{margin:0 4px 0 0;background:var(--aone-red);color:#fff}',
    '.aone-book{display:block;text-align:center;font-weight:800;text-decoration:none;',
    '  border:1px solid var(--aone-red);color:var(--aone-red);border-radius:4px;',
    '  padding:1px 4px;margin-bottom:2px;background:#fff;font-size:.92em}',
    // 参加申込。イベント名のすぐ右に短く置く — 赤い帯が 2 本並ぶと押し間違える
    '.aone-entry{flex:0 0 auto;margin-left:4px;background:var(--aone-red);color:#fff;',
    '  border-radius:3px;',
    '  padding:1px 5px;font-weight:800;font-size:.82em;text-decoration:none;',
    '  white-space:nowrap;line-height:1.3}',
    // 予定を出していない日だけ、これまでどおり 1 本の帯
    '.aone-entry-bar{display:block;margin:2px 0 0;padding:1px 4px;border-radius:4px;',
    '  font-size:.9em;text-align:center;white-space:normal}',
    '.aone-d{font-weight:800}',
    '.aone-cal td.sun .aone-d,.aone-cal td.holiday .aone-d{color:var(--aone-red)}',
    '.aone-cal td.sat .aone-d{color:#2f6fb5}',
    // 2 行まで折り返してから省略する。1 行で切ると名前がほとんど読めない
    '.aone-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;',
    '  overflow:hidden;white-space:normal;overflow-wrap:anywhere}',
    // 1 行目 = 時刻や種別、2 行目 = 名前
    '.aone-l1{display:block;font-weight:700;opacity:.85}',
    '.aone-l2{display:block}',
    // 予定の行だけ、名前は 2 行で切るが右の「参加申込」は切らせない。
    // だから clamp は名前だけに掛け、行そのものは flex にする。
    // ★ .aone-l2 は予約の名前でも使っていて、そちらは clamp のままにしたい
    // 名前だけを 2 行で切り、AM / PM の印と「参加申込」は切らせない。
    // ★ 印を名前と同じ箱に入れると、名前が 2 行になった日は印が 3 行目に落ちて
    //   そのまま消える (clamp の overflow:hidden に食われる)。
    // 下ぞろえにすると、名前が折り返しても印と申込が最後の行の右に並ぶ
    '.aone-e .aone-l2{display:flex;flex-wrap:wrap;align-items:flex-end}',
    // 名前が要るぶんだけ。1 1 にすると行いっぱいに伸びて、
    // AM の印が名前から遠く離れてしまう
    '.aone-side{flex:0 0 auto;display:inline-flex;align-items:center}',
    '.aone-side:empty{display:none}',
    // 名前をここまでは削らない。PC の狭いマスでは、代わりに
    // 印と「参加申込」が次の行に回る (名前が読めないほうが困る)
    '.aone-nm{flex:0 1 auto;min-width:8em}',
    '.aone-e{background:#e8f1fb;color:#1d5386;border-radius:4px;padding:0 3px;font-weight:700;',
    '  font-size:.92em}',
    '.aone-wxs{color:#8a5a06;font-weight:700;font-size:.92em}',
    '.aone-sfs{color:#42566b;font-size:.92em}',
    '.aone-bk{font-size:.92em;font-weight:700;line-height:1.3;border-left:3px solid var(--aone-red);',
    '  padding-left:3px;color:#a81a2d}',
    '.aone-bk.charter{border-left-color:#7c6fdb;color:#5646b8}',
    '.aone-ss{font-size:.92em;color:var(--aone-ink3);margin-top:2px;line-height:1.35}',
    '.aone-ss .y{color:#14724a}.aone-ss .n{color:#a8b8c5}',
    // 月カレンダーのセル内 AM/PM 行。「今日走れる？」の .aone-sess とは別物なので
    // 名前を分けてある (同名にすると後勝ちで今日走れる？の段組みが壊れる)
    '.aone-msess{display:flex;gap:4px;align-items:flex-start}',
    '.aone-msess>b{flex:0 0 1.9em;color:var(--aone-ink3)}',
    '.aone-msess-items{flex:1;min-width:0}',
    '.aone-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}',
    // レンタル / スポーツ走行 / 両方 の切り替え (/schedule と同じ見た目)
    '.aone-modes{display:inline-flex;border:1px solid var(--aone-line);border-radius:99px;',
    '  overflow:hidden;background:#fff;margin-bottom:8px}',
    '.aone-mode{padding:6px 16px;font-size:.9em;font-weight:700;border:0;background:none;',
    '  cursor:pointer;color:var(--aone-ink3);font-family:inherit;line-height:1.4}',
    '.aone-mode+.aone-mode{border-left:1px solid var(--aone-line)}',
    '.aone-mode.on{background:var(--aone-ink);color:#fff}',
    '.aone-nav button{border:1px solid var(--aone-line);background:#fff;border-radius:99px;',
    '  padding:5px 14px;font-weight:700;cursor:pointer;font-size:.9em;font-family:inherit;',
    '  color:var(--aone-ink)}',
    // 見出しの年月をそのまま選べるようにする (前の月・次の月を何度も押さずに飛べる)
    '.aone-ym{font:inherit;font-size:1.05em;font-weight:800;color:var(--aone-ink);',
    '  background:#fff;border:1px solid var(--aone-line);border-radius:8px;',
    '  padding:3px 6px;cursor:pointer;max-width:60%}',
    // 今月を開いたときに 1 日からではなく今日から始める (スマホだけ出す)
    '.aone-past{display:none}',
    '.aone-load{color:var(--aone-ink3);font-size:.9em;padding:10px 0}',
    // スマホでは 7 列だと狭すぎて読めないので、旧スケジュール表と同じ
    // 「1 日 = 1 行、AM / PM は左右」の縦長レイアウトに切り替える
    '@media(max-width:560px){.aone-cats{grid-template-columns:repeat(2,1fr)}',
    '  .aone-cal thead{display:none}',
    '  .aone-cal,.aone-cal tbody,.aone-cal tr,.aone-cal td{display:block;width:auto}',
    '  .aone-cal td{height:auto;border:none;border-bottom:1px solid var(--aone-line);padding:6px 8px}',
    '  .aone-cal td.pad{display:none}',
    '  .aone-cell{display:flex;gap:8px;align-items:flex-start}',
    '  .aone-body{flex:1;min-width:0}',
    '  .aone-d{flex:0 0 3.6em}',
    '  .aone-dow{display:inline;font-size:.86em}',
    '  .aone-ss{margin-top:0}',
    '  .aone-past{display:block;width:100%;margin:0 0 8px;padding:8px;border-radius:8px;',
    '    border:1px solid var(--aone-line);background:#fff;font:inherit;font-size:.85em;',
    '    font-weight:700;color:var(--aone-ink3);cursor:pointer;font-family:inherit}',
    '  .aone-cal.hide-past td.past{display:none}',
    '  .aone-clamp{-webkit-line-clamp:none;display:block}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('aone-widget-css')) return;
    var el = document.createElement('style');
    el.id = 'aone-widget-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** 2200 → 「2,200 円」。予約システム側の表示と揃える */
  function yen(n) {
    return (n == null ? '—' : Number(n).toLocaleString('ja-JP')) + ' 円';
  }

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- 「今日走れる？」 ----------------------------------------------------
  function renderToday(el, d) {
    // 18 時を過ぎると API が翌日を返す。バッジも「準備中 / 営業中 / 本日は終了」
    // に変わる (phase)。古い API のときは今までどおり営業状況だけ出す
    var ph = d.phase || null;
    var wxClass = ph ? (ph.tone === 'ok' ? '' : ph.tone)
                     : (d.business.open ? (d.business.status === 'open' ? '' : 'warn') : 'ng');
    var dayWord = ph ? ph.day_word : '本日';

    var html = '<div class="aone-card">';
    html += '<div class="aone-head"><p class="aone-date">'
      + (ph && ph.is_tomorrow ? '明日 ' : '') + esc(d.label) + ' の走行状況</p>';
    // 営業状況と路面状況はひとまとめにして右端に寄せる。
    // 直接 aone-head の子にすると space-between で真ん中に落ちてしまう
    html += '<div class="aone-tags">';
    html += '<span class="aone-wx ' + wxClass + '">'
      + (ph ? esc(ph.emoji) + ' ' : '') + esc(ph ? ph.label : d.business.label) + '</span>';
    // 路面状況は営業状況とは別軸。出ているときだけ添える
    if (d.surface) html += '<span class="aone-sf">路面 ' + esc(d.surface.label) + '</span>';
    html += '</div></div>';

    // 「本日は 8:30 コースオープンです」
    if (ph && ph.note) html += '<p class="aone-open">' + esc(ph.note) + '</p>';

    if (d.business.message) {
      html += '<p class="aone-msg ' + (wxClass === 'ng' ? 'ng' : '') + '">'
        + esc(d.business.message) + '</p>';
    }

    if (d.business.open) {
      d.sessions.forEach(function (s) {
        // 「0 / 2 クラス」は運営の都合の数字。お客様には意味が伝わらないので出さない
        html += '<div class="aone-sess"><div class="aone-sess-h"><b>' + esc(s.label) + '</b>'
          + '<span>' + esc(s.time) + '</span></div>';
        html += '<div class="aone-cats">';
        s.categories.forEach(function (c) {
          html += '<div class="aone-cat' + (c.walk_in_ok ? ' ok' : '') + '">'
            + '<div class="aone-cat-n">' + esc(c.short_name) + '</div>'
            + '<div class="aone-mark ' + c.status + '">' + esc(c.mark) + '</div>'
            + '<div class="aone-cat-t">' + esc(c.text) + '</div></div>';
        });
        html += '</div></div>';
      });

      var hidden = [];
      d.sessions.forEach(function (s) {
        (s.hidden_categories || []).forEach(function (h) {
          if (hidden.indexOf(h.name) === -1) hidden.push(h.name);
        });
      });
      if (hidden.length) {
        html += '<p class="aone-note">' + esc(hidden.join('・'))
          + ' は事前予約制です（ご予約のある日のみ表示しています）。</p>';
      }

      // 小学生以下はキッズカートアカデミーの受付。スポーツ走行の予約に
      // 飛ばすと別のものを予約させてしまう (2026-08 オーナー指摘)
      html += '<p class="aone-note">小学生以下のお子様は '
        + '<a href="https://kidskart.org/" target="_blank" rel="noopener">'
        + 'キッズカートアカデミー (kidskart.org) →</a> で承っています。</p>';
    }

    // 予約不要のレンタルカート走行。いちばん多いお問い合わせなのに、
    // これまでどこにも出していなかった (2026-09 オーナー指摘)。
    // スポーツ走行の ○✕ と混ざらないよう、独立した枠で出す。
    // 休業・走行中止の日は出さない (上で「お休みです」と伝えているし、
    // 休業日に ✕ を並べると「埋まっている」に見える)
    if (d.rental && (!d.business || d.business.open)) {
      var rt = d.rental;
      html += '<div class="aone-rent' + (rt.available ? ' ok' : '') + '">'
        + '<b>レンタルカート走行</b><span class="aone-tag">ご予約不要</span>'
        + '<div class="aone-rent-line">'
        + (rt.available
            ? '<span class="y">○</span> 走れます'
              + '<span class="aone-note"> — 営業時間内にお越しください</span>'
            : '<span class="n">✕</span> ' + esc(rt.note || 'ご利用いただけません'))
        + '</div>'
        + (rt.available && rt.note
            ? '<div class="aone-rent-warn">※ ' + esc(rt.note) + '</div>' : '')
        + '<div class="aone-note">1 ヒート ' + yen(rt.price) + ' / ' + rt.minutes + ' 分。'
        + 'ヘルメット・グローブは無料でお貸しします。</div>'
        + '</div>';
    }

    // レースパックはレンタルカートの下。予約が要るものより、
    // ふらっと来て走れるものを先に見せる (2026-09 オーナー確認)
    if (d.business.open && d.rp) {
      html += '<div class="aone-rp"><b>レースパック (RP)</b>' + esc(d.rp.summary)
        + '<span class="aone-note"> ／ ' + d.rp.min_party + ' 名以上・30 分刻み</span></div>';
    }

    if (d.blocks && d.blocks.length) {
      html += '<div class="aone-ev">' + esc(dayWord) + 'の予定: ';
      d.blocks.forEach(function (b) { html += '<span>' + esc(b.label) + '</span>'; });
      html += '</div>';
    }

    html += '<div class="aone-btns">'
      + '<a class="aone-btn primary" href="' + d.links.sport + '">スポーツ走行を予約</a>'
      + '<a class="aone-btn" href="' + d.links.rp + '">レースパックを予約</a>'
      + '<a class="aone-btn" href="' + d.links.charter + '">貸切を申し込む</a>'
      + '<a class="aone-btn" href="' + d.links.night + '">ナイターを相談</a></div>';
    html += '<p class="aone-note">○ 走れます（ご予約なしでもお越しいただけます） ／ '
      + '✕ 受付停止</p>';
    html += '</div>';

    el.innerHTML = html;
  }

  // ---- 月間スケジュール ---------------------------------------------------
  // その時間帯に **予約が入っている** クラスを出す。
  // 毎日「カート・ミニバイク」と並べても情報量が無いので、実際に走るクラスが
  // 入っている日だけ出し、空いている日は予約を促す。
  function sessionLine(cats, fallbackOpen) {
    if (!cats || !cats.length) {
      return fallbackOpen ? '<div class="y">○</div>' : '<div class="n">受付停止</div>';
    }
    var booked = cats.filter(function (c) { return c.running; })
      .map(function (c) { return c.short_name; });
    if (booked.length) {
      return '<div class="y">' + esc(booked.join('・')) + '</div>';
    }
    var open = cats.some(function (c) {
      return c.status === 'open' && (!c.requires_reservation || c.running);
    });
    // 空いている枠は ○。止まっているときは**何の受付が止まっているか**を書く。
    // 「不可」だけだと、レンタルカートのお客様まで予約できないと
    // 思ってしまう (2026-09 オーナー指摘)。
    // 理由 (毎週のお休み / レース / 貸切 / 満枠) では書き分けない。
    // 言い方が増えるほど分かりにくい。1 行で出す
    return open ? '<div class="y">○</div>'
      : '<div class="n">スポーツ走行 不可</div>';
  }

  // RP・貸切が AM 枠か PM 枠か (12:00 開始からは PM)
  function isPmBooking(t) { return (t || '') >= '12:00'; }

  /** その日に何か予約が入っているか */
  function hasBookings(day) {
    if ((day.bookings || []).length) return true;
    return []
      .concat(day.am_categories || [], day.pm_categories || [])
      .some(function (c) { return c.running; });
  }

  // 1 つの時間帯 (AM / PM) の中身。予約が先、受付状況が後。
  function sessionBlock(label, cats, fallbackOpen, books, closedDay, mode) {
    // 「13:00 RP」と「株)ふーぷーパートナー 様」を 2 行に分ける。
    // 1 行に続けると、狭いセルではどこまでが時刻でどこからが名前か読みづらい。
    // レンタル (RP・貸切) とスポーツ走行の ○✕ を、モードで出し分ける。
    // 公開スケジュール (/schedule) と同じ切り替え
    var items = (mode === 'sport' ? [] : (books || [])).map(function (b) {
      var head = b.kind === 'rp'
        ? b.time + ' RP'
        : '貸切 ' + b.time + (b.end_time ? '〜' + b.end_time : '');
      var name = b.name || '';
      return '<div class="aone-bk ' + b.kind + '" title="' + esc(name ? head + ' ' + name : head) + '">'
        + '<span class="aone-l1">' + esc(head) + '</span>'
        + (name ? '<span class="aone-l2 aone-clamp">' + esc(name) + '</span>' : '')
        + '</div>';
    });
    if (!closedDay && mode !== 'rental') {
      var mark = sessionLine(cats, fallbackOpen);
      if (mark) items.push(mark);
    }
    if (!items.length) return '';
    return '<div class="aone-msess"><b>' + label + '</b><div class="aone-msess-items">' +
      items.join('') + '</div></div>';
  }

  /** モードごとの予約の入口。/schedule と同じ振り分け */
  function reserveLink(d, mode) {
    if (mode === 'rental') return d.links.rp || (d.links.reserve + '/rp');
    if (mode === 'sport') return d.links.sport || (d.links.reserve + '/sport');
    return d.links.reserve;
  }

  var MODES = [['rental', 'レンタル'], ['sport', 'スポーツ走行'], ['both', '両方']];

  var MODE_KEY = 'aone-cal-mode';

  /**
   * 見ているモード。前に選んだものをブラウザに覚えさせる (2026-08 オーナー確認)。
   *
   * ページ側で data-mode を書いてあればそれが優先。
   * 覚えられない環境 (プライベートウィンドウ等) でも「両方」で普通に動く。
   */
  function readMode(el) {
    var attr = el.getAttribute('data-mode');
    if (attr && MODES.some(function (m) { return m[0] === attr; })) return attr;
    try {
      var v = localStorage.getItem(MODE_KEY);
      if (v && MODES.some(function (m) { return m[0] === v; })) return v;
    } catch (e) { /* 保存が使えなくても既定で動く */ }
    // 既定は「レンタル」。いちばん多いのはレンタルカートで遊びに来るお客様なので、
    // 最初に開いたときはその人たちの見たいものを出す (2026-09 オーナー確認)
    return 'rental';
  }
  function saveMode(v) {
    try { localStorage.setItem(MODE_KEY, v); } catch (e) { /* 保存できなくても続行 */ }
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /**
   * 月のプルダウンに出す選択肢。
   * 「8 月に 12 月の予定を見たい」が前の月・次の月ボタンだけだと 4 回押しになる。
   * 過去 3 か月 〜 先 12 か月を出し、今見ている月がその外なら足す。
   */
  function monthOptions(currentYm, todayIso) {
    var thisYm = String(todayIso || '').slice(0, 7);
    var ty = Number(thisYm.slice(0, 4)), tm = Number(thisYm.slice(5, 7));
    var list = [];
    for (var i = -3; i <= 12; i++) {
      var dt = new Date(Date.UTC(ty, tm - 1 + i, 1));
      list.push(dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1));
    }
    if (/^\d{4}-\d{2}$/.test(currentYm) && list.indexOf(currentYm) < 0) {
      list.push(currentYm);
      list.sort();
    }
    return list.map(function (ym) {
      return {
        ym: ym,
        label: Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月'
          + (ym === thisYm ? ' (今月)' : ''),
      };
    });
  }

  function renderMonth(el, d) {
    var mode = readMode(el);
    // 月曜はじまり (公開スケジュール・管理カレンダーと揃える)
    var WD = ['月', '火', '水', '木', '金', '土', '日'];
    // getUTCDay() 順 (日=0)。スマホの縦長表示で日付の横に出す
    var WDOW = ['日', '月', '火', '水', '木', '金', '土'];
    var ymNow = d.year + '-' + pad2(d.month);
    var html = '<div class="aone-nav">'
      + '<button type="button" data-mv="prev">← 前の月</button>'
      + '<select class="aone-ym" data-ym aria-label="表示する月を選ぶ">'
      + monthOptions(ymNow, d.today).map(function (o) {
          return '<option value="' + o.ym + '"' + (o.ym === ymNow ? ' selected' : '') + '>'
            + esc(o.label) + '</option>';
        }).join('')
      + '</select>'
      + '<button type="button" data-mv="next">次の月 →</button></div>';

    // レンタルで遊ぶ人とマイマシンを持ち込む人ではっきり分かれるので、
    // 見たいほうだけに絞れるようにする (/schedule と同じ)
    html += '<div class="aone-modes">';
    MODES.forEach(function (m) {
      html += '<button type="button" class="aone-mode' + (m[0] === mode ? ' on' : '') + '"'
        + ' data-mode="' + m[0] + '">' + m[1] + '</button>';
    });
    html += '</div>';

    // スマホは 1 日 1 行の縦長なので、今月を開くと過ぎた日を延々スクロールすることになる。
    // 過ぎた日は最初からたたんでおき、今日から始まるようにする (PC の 7 列は変えない)
    var pastCount = String(d.today || '').slice(0, 7) === ymNow
      ? Number(String(d.today).slice(8, 10)) - 1 : 0;
    if (pastCount > 0) {
      html += '<button type="button" class="aone-past" data-past>'
        + '▼ ' + d.month + '月1日〜' + pastCount + '日 も表示する</button>';
    }

    html += '<table class="aone-cal' + (pastCount > 0 ? ' hide-past' : '') + '"><thead><tr>';
    WD.forEach(function (w, i) {
      html += '<th class="' + (i === 6 ? 'sun' : (i === 5 ? 'sat' : '')) + '">' + w + '</th>';
    });
    html += '</tr></thead><tbody><tr>';

    var pad = d.days.length ? (d.days[0].dow + 6) % 7 : 0;
    for (var i = 0; i < pad; i++) html += '<td class="pad"></td>';
    var col = pad;

    d.days.forEach(function (day) {
      if (col === 7) { html += '</tr><tr>'; col = 0; }
      var cls = [];
      if (day.dow === 0) cls.push('sun');
      if (day.dow === 6) cls.push('sat');
      if (day.is_holiday) cls.push('holiday');
      if (day.date === d.today) cls.push('today');
      if (day.business === 'cancelled' || day.business === 'closed') cls.push('closed');
      if (day.date < d.today) cls.push('past');

      // イベントの日でも、空いている時間帯があれば予約したい人がいる。
      // セルごとイベントページに飛ばすと予約にたどり着けない (2026-09 オーナー指摘)。
      // その日は行き先が 2 つあるので、セルはリンクにせず中にボタンを 2 つ置く
      var openDay = day.date >= d.today
        && day.business !== 'cancelled' && day.business !== 'closed';
      var bookHref = reserveLink(d, mode) + '?date=' + day.date;
      // 入口に出す「午前だけ / 午後だけ」の判定。表示モードごとに、そのモードで
      // 予約できるものだけを見る。文言が「レンタルカートの予約」と product を
      // 名指しするので、それが取れない日に出すと嘘になる
      var rAm = day.rental_am != null ? day.rental_am : day.rental_ok;
      var rPm = day.rental_pm != null ? day.rental_pm : day.rental_ok;
      var bAm = mode === 'sport' ? day.am_open
        : mode === 'rental' ? rAm : (rAm || day.am_open);
      var bPm = mode === 'sport' ? day.pm_open
        : mode === 'rental' ? rPm : (rPm || day.pm_open);
      var bookable = openDay && (bAm || bPm);
      var twoWays = !!day.entry_url && bookable;
      var href = twoWays ? null : (day.entry_url || (openDay ? bookHref : null));
      var title = day.entry_url ? 'イベントの詳細・参加申込へ' : 'この日のご予約へ';
      if (day.entry_url) cls.push('entry');
      html += '<td class="' + cls.join(' ') + (href ? ' linkable' : '') + '">';
      if (href) {
        html += '<a class="aone-cell" href="' + esc(href) + '" title="' + title + '">';
      } else {
        html += '<div class="aone-cell">';
      }
      html += '<div class="aone-d">' + day.day +
        '<span class="aone-dow"> (' + WDOW[day.dow] + ')</span></div><div class="aone-body">';
      // 臨時休業を予定として登録した日は「休業」が予定から自動で付く。
      // そのまま両方出すと「休業 / 臨時休業」の二重表示になるので、予定側だけ出す
      var closedEvent = (day.events || []).some(function (e) { return e.kind === 'closed'; });
      if (day.business_label && !closedEvent) {
        html += '<div class="aone-wxs">' + esc(day.business_label) + '</div>';
      }
      if (day.surface_label) html += '<div class="aone-sfs">' + esc(day.surface_label) + '</div>';
      // 参加申込は、そのイベント名のすぐ右に短く付ける。赤い帯を 2 本並べると、
      // どちらを押すのか迷って押し間違える (2026-09 オーナー指摘)
      var entryChip = !day.entry_url ? ''
        : twoWays
          ? '<a class="aone-entry" href="' + esc(day.entry_url) + '">参加申込 →</a>'
          : '<span class="aone-entry">参加申込 →</span>';
      day.events.forEach(function (e, i) {
        // 「イベント」と「８０分耐久レース」を 2 行に分ける。
        // 種別を頭に付けていないもの (臨時休業など) は 1 行のまま
        var name = e.name || e.label;
        var head = e.label !== name ? e.kind_label : '';
        // 午前だけ / 午後だけの予定は、名前の横に AM / PM を出す
        var eTag = e.scope === 'am' ? 'AM' : e.scope === 'pm' ? 'PM' : null;
        html += '<div class="aone-e" title="' + esc(e.label) + '">'
          + (head ? '<span class="aone-l1">' + esc(head) + '</span>' : '')
          + '<span class="aone-l2">'
          + '<span class="aone-nm aone-clamp">' + esc(name) + '</span>'
          // AM の印と「参加申込」は 1 つにまとめる。別々の要素だと、
          // 幅が足りないときに離ればなれに折り返す
          + '<span class="aone-side">'
          + (eTag ? '<span class="aone-stag">' + eTag + '</span>' : '')
          + (i === day.events.length - 1 ? entryChip : '')
          + '</span></span></div>';
      });
      // ご予約不要のレンタルカート走行ができる日は、そう分かるように出す。
      // AM / PM の「受付停止」は持ち込み車両の話なので、これが無いと
      // レンタルのお客様が「来られない日」と読んでしまう (2026-09 オーナー指摘)。
      // ★ 予約ボタンのすぐ上に置く。ボタンの見出しとして読ませたい (2026-09 オーナー依頼)
      if (mode !== 'sport' && day.date >= d.today) {
        // 午前だけレースで埋まっている日があるので、午前 / 午後で分ける
        // (rAm / rPm は入口の判定で作ったものを使い回す)
        var rMark = (rAm && rPm) ? 'レンタルカート ○'
          : rPm ? 'レンタルカート ○ 午後のみ'
          : rAm ? 'レンタルカート ○ 午前のみ' : null;
        if (rMark) html += '<div class="aone-rok">' + rMark + '</div>';
      }
      // 予定を出していない日 (非公開の予定で申込だけ受けている) は付ける先が
      // 無いので、これまでどおり 1 本の帯で出す
      if (day.entry_url && !day.events.length) {
        html += twoWays
          ? '<a class="aone-entry aone-entry-bar" href="' + esc(day.entry_url) + '">'
            + '参加申込 受付中 →</a>'
          : '<div class="aone-entry aone-entry-bar">参加申込 受付中 →</div>';
      }
      if (twoWays) {
        // 何をどの時間帯で予約できるのかを、その場で分かるようにする
        var bTag = (bAm && !bPm) ? 'AM' : (bPm && !bAm) ? 'PM' : null;
        var bLabel = mode === 'rental' ? 'レンタルカートの予約'
          : mode === 'sport' ? 'スポーツ走行の予約' : 'この日のご予約';
        html += '<a class="aone-book" href="' + esc(bookHref) + '">'
          + (bTag ? '<span class="aone-stag on">' + bTag + '</span>' : '')
          + bLabel + ' →</a>';
      }

      if (day.date >= d.today) {
        // AM / PM ごとに「予約 → 受付状況」の順で並べる
        var books = day.bookings || [];
        var closedDay = day.business === 'cancelled' || day.business === 'closed';
        html += '<div class="aone-ss">'
          + sessionBlock('AM', day.am_categories, day.am_open,
              books.filter(function (b) { return !isPmBooking(b.time); }), closedDay, mode)
          + sessionBlock('PM', day.pm_categories, day.pm_open,
              books.filter(function (b) { return isPmBooking(b.time); }), closedDay, mode)
          + '</div>';
      }
      html += '</div>' + (href ? '</a></td>' : '</div></td>');
      col++;
    });
    while (col < 7 && col > 0) { html += '<td class="pad"></td>'; col++; }
    html += '</tr></tbody></table>';
    // 月末まで見たあと上に戻らなくても次の月へ行けるようにする (スマホは縦に長い)
    var nextNo = d.month === 12 ? 1 : d.month + 1;
    html += '<div class="aone-nav" style="margin:8px 0 0">'
      + '<button type="button" data-mv="prev">← 前の月</button>'
      + '<button type="button" data-mv="next">' + nextNo + '月のスケジュール →</button></div>';
    // モードによって出ているものが違うので、注記も合わせる
    // (レンタルでは ○ が出ないのに「○ = 受付可」と書くと通じない)
    // 選んだモードは次に開いたときも覚えている。「スポーツ走行」のまま
    // 開き直すとレースパック・貸切が出ないので、その場で戻り方を書いておく
    var note = mode === 'rental'
      ? 'すでにご予約が入っているレースパック・貸切を出しています。'
        + '「レンタルカート ○」と出ている日は、ご予約不要のレンタル走行ができます。'
      : mode === 'sport'
        ? '○ = 受付可。レースパック・貸切のご予約は「両方」を押すと出ます。'
        : '○ = 受付可、クラス名が出ている枠はすでにご予約が入っています。';
    html += '<p class="aone-note"><strong>日付をクリックするとご予約に進めます。</strong>'
      + note
      + '<a href="' + reserveLink(d, mode) + '" style="font-weight:800">ご予約はこちら →</a></p>';
    // AM / PM の ○・受付停止はスポーツ走行の枠。レンタルのお客様が
    // 「予約できない日」と読み違えないように書き添える
    if (mode !== 'rental') {
      html += '<p class="aone-note aone-hint">'
        + '<strong>AM / PM の ○・不可は、お持ち込み車両 (スポーツ走行) の走行枠です。</strong>'
        + (mode === 'both'
            ? '<strong class="aone-rok" style="display:inline">レンタルカート ○</strong>'
              + ' と出ている日は、<strong>ご予約不要のレンタルカート走行ができます</strong>'
              + ' (1 ヒート走行・レースパック・貸切)。'
            : 'レンタルカートのご利用 (1 ヒート走行・レースパック・貸切) はこの表示とは別で、'
              + '営業日であればご利用いただけます。')
        + '当日の最新状況は <a href="' + d.links.site + '">今日走れる？</a> をご確認ください。</p>';
    }

    el.innerHTML = html;

    Array.prototype.forEach.call(el.querySelectorAll('[data-mode]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-mode');
        saveMode(v);
        el.setAttribute('data-mode', v);
        // データは取得済みなので、そのまま描き直すだけでよい
        renderMonth(el, d);
      });
    });

    var ymSel = el.querySelector('[data-ym]');
    if (ymSel) {
      ymSel.addEventListener('change', function () { loadMonth(el, ymSel.value); });
    }

    var pastBtn = el.querySelector('[data-past]');
    if (pastBtn) {
      var shown = pastBtn.textContent;
      pastBtn.addEventListener('click', function () {
        var tbl = el.querySelector('.aone-cal');
        var hidden = tbl.className.indexOf('hide-past') >= 0;
        tbl.className = hidden ? 'aone-cal' : 'aone-cal hide-past';
        pastBtn.textContent = hidden ? '▲ 過ぎた日を閉じる' : shown;
      });
    }

    Array.prototype.forEach.call(el.querySelectorAll('[data-mv]'), function (b) {
      b.addEventListener('click', function () {
        var y = d.year, m = d.month + (b.getAttribute('data-mv') === 'next' ? 1 : -1);
        if (m === 0) { m = 12; y--; }
        if (m === 13) { m = 1; y++; }
        loadMonth(el, y + '-' + (m < 10 ? '0' + m : m));
      });
    });
  }

  function loadMonth(el, ym) {
    el.innerHTML = '<div class="aone-load">読み込み中…</div>';
    get(ORIGIN + '/api/public/month?ym=' + encodeURIComponent(ym))
      .then(function (d) { renderMonth(el, d); })
      .catch(function () {
        el.innerHTML = '<div class="aone-load">スケジュールを取得できませんでした。'
          + '<a href="' + ORIGIN + '/schedule">こちら</a>でご確認ください。</div>';
      });
  }

  // ---------------------------------------------------------------------------
  // 予約フォームの埋め込み (枠)
  // ---------------------------------------------------------------------------
  var FORM_PATHS = {
    sport: '/reserve/sport',
    rp: '/reserve/rp',
    charter: '/reserve/charter',
    night: '/reserve/night',
    event: '/reserve/event',
    menu: '/reserve'
  };
  var FRAMES = [];
  var listening = false;

  function listen() {
    if (listening) return;
    listening = true;
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || typeof d !== 'object') return;

      if (d.aone === 'height' && d.value > 0) {
        for (var i = 0; i < FRAMES.length; i++) {
          if (FRAMES[i].contentWindow === e.source) FRAMES[i].style.height = d.value + 'px';
        }
      } else if (d.aone === 'navigate' && typeof d.url === 'string'
                 && d.url.indexOf(ORIGIN + '/') === 0) {
        // 予約が終わったら、枠の中ではなくホームページごと完了ページへ移動する。
        // そうしないと控えの URL がアドレスバーに出ず、お客様が保存できない
        window.location.href = d.url;
      }
    });
  }

  function mountForm(el, kind) {

    var path = FORM_PATHS[kind] || FORM_PATHS.sport;
    var f = document.createElement('iframe');
    // ホームページ側に見出しが無いときは data-title="show" で出せる
    f.src = ORIGIN + path + '?embed=1'
      + (el.getAttribute('data-title') === 'show' ? '&title=1' : '');
    f.title = 'A-ONE サーキット ご予約';
    f.setAttribute('scrolling', 'no');
    f.setAttribute('loading', 'eager');
    // 高さは中身に合わせて後から伸びる。最初の値は「だいたいこれくらい」
    f.style.cssText = 'width:100%;border:0;display:block;overflow:hidden;height:780px';
    listen();
    el.innerHTML = '';
    el.appendChild(f);
    FRAMES.push(f);
  }

  function boot() {
    injectCss();
    Array.prototype.forEach.call(document.querySelectorAll('[data-aone]'), function (el) {
      if (el.getAttribute('data-aone-ready')) return;
      el.setAttribute('data-aone-ready', '1');
      el.className = (el.className ? el.className + ' ' : '') + 'aone-w';
      var kind = el.getAttribute('data-aone');

      if (kind === 'reserve') {
        mountForm(el, el.getAttribute('data-kind') || 'sport');
        return;
      }

      if (kind === 'month') {
        loadMonth(el, el.getAttribute('data-ym') || '');
        return;
      }

      el.innerHTML = '<div class="aone-load">読み込み中…</div>';
      get(ORIGIN + '/api/public/today')
        .then(function (d) { renderToday(el, d); })
        .catch(function () {
          el.innerHTML = '<div class="aone-load">走行状況を取得できませんでした。'
            + '<a href="' + ORIGIN + '/">こちら</a>でご確認ください。</div>';
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;

export const GET: APIRoute = () =>
  new Response(WIDGET_JS, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
