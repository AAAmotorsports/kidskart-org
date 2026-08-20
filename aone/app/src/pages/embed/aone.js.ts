import type { APIRoute } from 'astro';

export const prerender = false;

// GET /embed/aone.js
//
// rk-a1.com (WordPress) に貼り付けるウィジェット。
//
//   <div data-aone="today"></div>
//   <script src="https://<予約システム>/embed/aone.js" async></script>
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
    '.aone-wx{display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:.85em;',
    '  padding:4px 12px;border-radius:99px;background:var(--aone-green-bg);color:#14724a;',
    '  border:1px solid #b9e3cf}',
    '.aone-wx.warn{background:#fff5e2;color:#8a5a06;border-color:#f2d69b}',
    '.aone-wx.ng{background:#fdeef0;color:#a81a2d;border-color:#f2bcc4}',
    '.aone-msg{margin:0 0 10px;padding:8px 12px;border-radius:8px;font-size:.9em;',
    '  background:#fff5e2;border:1px solid #f2d69b;color:#8a5a06}',
    '.aone-msg.ng{background:#fdeef0;border-color:#f2bcc4;color:#a81a2d}',
    '.aone-sess+.aone-sess{margin-top:12px;padding-top:12px;border-top:1px dashed var(--aone-line)}',
    '.aone-sess-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;font-size:.9em}',
    '.aone-sess-h b{font-size:1.05em}',
    '.aone-sess-h span{color:var(--aone-ink3)}',
    '.aone-cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px}',
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
    '.aone-cal{width:100%;border-collapse:collapse;font-size:.82em;table-layout:fixed}',
    '.aone-cal th{background:#12233a;color:#fff;padding:4px 0;font-size:.9em;font-weight:700;',
    '  text-align:center}',
    '.aone-cal th.sun{color:#ffb3bd}.aone-cal th.sat{color:#b7d8ff}',
    '.aone-cal td{border:1px solid var(--aone-line);vertical-align:top;height:74px;padding:3px;',
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
    '.aone-d{font-weight:800}',
    '.aone-cal td.sun .aone-d,.aone-cal td.holiday .aone-d{color:var(--aone-red)}',
    '.aone-cal td.sat .aone-d{color:#2f6fb5}',
    '.aone-e{background:#e8f1fb;color:#1d5386;border-radius:4px;padding:0 3px;font-weight:700;',
    '  font-size:.92em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aone-wxs{color:#8a5a06;font-weight:700;font-size:.92em}',
    '.aone-bk{font-size:.92em;font-weight:700;line-height:1.3;border-left:3px solid var(--aone-red);',
    '  padding-left:3px;color:#a81a2d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aone-bk.charter{border-left-color:#7c6fdb;color:#5646b8}',
    '.aone-ss{font-size:.92em;color:var(--aone-ink3);margin-top:2px;line-height:1.35}',
    '.aone-ss .y{color:#14724a}.aone-ss .n{color:#a8b8c5}',
    '.aone-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}',
    '.aone-nav button{border:1px solid var(--aone-line);background:#fff;border-radius:99px;',
    '  padding:5px 14px;font-weight:700;cursor:pointer;font-size:.9em;font-family:inherit;',
    '  color:var(--aone-ink)}',
    '.aone-nav b{font-size:1.05em}',
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
    '  .aone-ss{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:0}',
    '  .aone-e,.aone-bk{white-space:normal}}'
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

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- 「今日走れる？」 ----------------------------------------------------
  function renderToday(el, d) {
    var wxClass = d.weather.status === 'cancelled' ? 'ng'
      : (d.weather.status === 'normal' ? '' : 'warn');

    var html = '<div class="aone-card">';
    html += '<div class="aone-head"><p class="aone-date">' + esc(d.label) + ' の走行状況</p>';
    html += '<span class="aone-wx ' + wxClass + '">' + esc(d.weather.label) + '</span></div>';

    if (d.weather.message) {
      html += '<p class="aone-msg ' + (wxClass === 'ng' ? 'ng' : '') + '">'
        + esc(d.weather.message) + '</p>';
    }

    if (d.weather.open) {
      d.sessions.forEach(function (s) {
        html += '<div class="aone-sess"><div class="aone-sess-h"><b>' + esc(s.label) + '</b>'
          + '<span>' + esc(s.time) + '</span>'
          + '<span>' + s.used_classes + ' / ' + s.max_classes + ' クラス</span></div>';
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

      html += '<div class="aone-rp"><b>レースパック (RP)</b>' + esc(d.rp.summary)
        + '<span class="aone-note"> ／ ' + d.rp.min_party + ' 名以上・30 分刻み</span></div>';
    }

    if (d.blocks && d.blocks.length) {
      html += '<div class="aone-ev">本日の予定: ';
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
  function sessionLine(label, cats, fallbackOpen) {
    if (!cats || !cats.length) {
      return fallbackOpen ? '' : '<div class="n">' + label + ' 受付停止</div>';
    }
    var booked = cats.filter(function (c) { return c.running; })
      .map(function (c) { return c.short_name; });
    if (booked.length) {
      return '<div class="y">' + label + ' ' + esc(booked.join('・')) + '</div>';
    }
    var open = cats.some(function (c) {
      return c.status === 'open' && (!c.requires_reservation || c.running);
    });
    // 空いている枠は ○、止まっている枠は理由が分かるように「受付停止」
    return open
      ? '<div class="y">' + label + ' ○</div>'
      : '<div class="n">' + label + ' 受付停止</div>';
  }

  /** その日に何か予約が入っているか */
  function hasBookings(day) {
    if ((day.bookings || []).length) return true;
    return []
      .concat(day.am_categories || [], day.pm_categories || [])
      .some(function (c) { return c.running; });
  }

  function renderMonth(el, d) {
    // 月曜はじまり (公開スケジュール・管理カレンダーと揃える)
    var WD = ['月', '火', '水', '木', '金', '土', '日'];
    // getUTCDay() 順 (日=0)。スマホの縦長表示で日付の横に出す
    var WDOW = ['日', '月', '火', '水', '木', '金', '土'];
    var html = '<div class="aone-nav">'
      + '<button type="button" data-mv="prev">← 前の月</button>'
      + '<b>' + d.year + '年' + d.month + '月</b>'
      + '<button type="button" data-mv="next">次の月 →</button></div>';

    html += '<table class="aone-cal"><thead><tr>';
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
      if (day.weather === 'cancelled') cls.push('closed');
      if (day.date < d.today) cls.push('past');

      var linkable = day.date >= d.today && day.weather !== 'cancelled';
      html += '<td class="' + cls.join(' ') + (linkable ? ' linkable' : '') + '">';
      if (linkable) {
        html += '<a class="aone-cell" href="' + d.links.reserve + '?date=' + day.date +
          '" title="この日のご予約へ">';
      } else {
        html += '<div class="aone-cell">';
      }
      html += '<div class="aone-d">' + day.day +
        '<span class="aone-dow"> (' + WDOW[day.dow] + ')</span></div><div class="aone-body">';
      if (day.weather_label) html += '<div class="aone-wxs">' + esc(day.weather_label) + '</div>';
      day.events.forEach(function (e) {
        html += '<div class="aone-e" title="' + esc(e.label) + '">' + esc(e.label) + '</div>';
      });
      // すでに入っている RP・貸切 (旧スケジュールページの「RP ○○様」に相当)
      (day.date < d.today ? [] : (day.bookings || [])).forEach(function (b) {
        var label = b.kind === 'rp'
          ? b.time + ' RP'
          : '貸切 ' + b.time + (b.end_time ? '〜' + b.end_time : '');
        if (b.name) label += ' ' + b.name;
        html += '<div class="aone-bk ' + b.kind + '" title="' + esc(label) + '">' + esc(label) + '</div>';
      });
      if (day.weather !== 'cancelled' && day.date >= d.today) {
        html += '<div class="aone-ss">'
          + sessionLine('AM', day.am_categories, day.am_open)
          + sessionLine('PM', day.pm_categories, day.pm_open)
          + '</div>';
      }
      html += '</div>' + (linkable ? '</a></td>' : '</div></td>');
      col++;
    });
    while (col < 7 && col > 0) { html += '<td class="pad"></td>'; col++; }
    html += '</tr></tbody></table>';
    html += '<p class="aone-note"><strong>日付をクリックするとご予約に進めます。</strong>'
      + '○ = 受付可、クラス名が出ている枠はすでにご予約が入っています。'
      + '<a href="' + d.links.reserve + '" style="font-weight:800">ご予約はこちら →</a></p>';

    el.innerHTML = html;

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

  function boot() {
    injectCss();
    Array.prototype.forEach.call(document.querySelectorAll('[data-aone]'), function (el) {
      if (el.getAttribute('data-aone-ready')) return;
      el.setAttribute('data-aone-ready', '1');
      el.className = (el.className ? el.className + ' ' : '') + 'aone-w';
      var kind = el.getAttribute('data-aone');

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
