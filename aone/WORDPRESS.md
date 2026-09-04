# rk-a1.com (WordPress) との連携

予約システムの URL は **`https://reserve.rk-a1.com`**。
`https://aone-booking.kidskart1177.workers.dev` も同じものを指し続けるので、
すでに配ったメールの専用 URL は切れません。

## 役割分担

| WordPress (rk-a1.com) | A-ONE 予約システム (Cloudflare) |
|---|---|
| トップページ・施設紹介 | 予約データベース |
| 料金・コース説明 | 「今日走れる？」の判定 |
| レース情報・写真・会社情報 | スポーツ走行 / RP / 貸切 / ナイターの予約 |
| SEO | 顧客管理・メール |
| **予約への入口** | 電話予約・営業管理 |
| 今日の簡易表示 (ウィジェット) | |
| 月間予定表示 (ウィジェット) | |

**WordPress = ホームページ、Cloudflare = 業務システム。**
この分離を保つと、将来 WordPress を作り直しても予約システムはそのまま使えます。

スタッフは WordPress を触りません。管理画面 (`/admin`) に

* 電話予約を登録
* レース・イベントを登録
* 貸切・臨時休業を登録
* 営業状況・路面状況を変更

を入れるだけで、

```
管理画面 → 受付可否 → 「今日走れる？」 → 月間スケジュール → Web 予約枠
```

が全部自動で変わります。同じ予定を二度入力しません。

---

## 表示するものは iframe を使いません

WordPress に予約アプリを丸ごと iframe で埋めると、スマホで高さが崩れる・戻るボタンが
おかしくなる・サイトの中に別サイトがある状態になる、といった問題が出ます。

「今日走れる？」「月間スケジュール」は **JSON API + 貼り付けウィジェット**にしています。
WordPress のページに実際の HTML として描画されるので、見た目はホームページのまま、
データだけ予約システムと同期します。

## 予約フォームだけは iframe (2026-09 追加)

フォームは例外です。入力欄・空き状況の取り込み・エラー表示まで書き写すと、本体を
直したときに片方だけ古くなります。**本体をそのまま枠で読み込む**ほうが安全なので、
フォームだけ iframe にしています。iframe の欠点は次のように潰してあります。

| iframe の困りごと | どう潰したか |
|---|---|
| 枠の中にスクロールバーが出る (二重スクロール) | 中身が自分の高さを `postMessage` で親に送り、枠が伸びる。日付を選ぶ・エラーが出るなど中身が伸びたときも追従する |
| サイトのヘッダーが二重に出る | `?embed=1` でヘッダー・フッター・「予約メニューに戻る」を出さない |
| 見出しが二重に出る | 埋め込み先のページに見出しがある前提で、既定では `h1` を出さない。必要なら `data-title="show"` |
| 予約完了後の専用 URL がアドレスバーに出ない (お客様が控えを保存できない) | 完了時に `postMessage` で親に知らせ、**ホームページごと**完了ページへ移動する |
| 検索結果に同じ内容が二重に出る | `?embed=1` のときは `noindex` |

```html
<div data-aone="reserve" data-kind="sport">
  <a href="https://<予約システム>/reserve/sport">スポーツ走行のご予約へ進む</a>
</div>
<script src="https://<予約システム>/embed/aone.js" async></script>
```

中の `a` は、script が読み込めなかったときの逃げ道です (読み込めれば枠に置き換わる)。
`data-kind` は `sport` / `rp` / `charter` / `night` / `event` / `menu`。

> **貼り付けスクリプトを使わず自分で `<iframe>` を書くこともできますが、その場合は
> 高さが自動で伸びません。** 高さの受け取りと完了時の移動は `embed/aone.js` が
> やっています。

<<<<<<< HEAD
### `data-kind` で選べるもの

| `data-kind` | 中身 |
|---|---|
| `sport` | スポーツ走行のご予約 |
| `rp` | レースパック (エンジョイレースパック) のご予約 |
| `charter` | 貸切のお申し込み |
| `night` | ナイター走行のご相談 |
| `event` | イベント参加申込 |
| `menu` | 予約メニュー (上の 5 つへの入口) |

### 枠の中でリンクを押したとき

* **同じサイトへのリンク** … ホームページごと移動する (枠の中だけが動くと、
  サイトの中に別のサイトがある状態になるため)
* **別のサイトへのリンク** (kidskart.org など) … 新しいタブで開く

`menu` を貼ると、カードを押した時点で予約システム側へ移動します。
**ホームページの中で予約まで終わらせたいときは、`menu` ではなく
各フォームをそれぞれのページに貼ってください。**

=======
>>>>>>> origin/main
### 対応しているページを増やすとき

`?embed=1` を読んで `<Base embed={embed}>` に渡し、`location.href = ...` を
`window.aoneGo(...)` に変えるだけです。`aoneGo` は `Base.astro` が用意しています
<<<<<<< HEAD
(枠の中なら親に知らせ、そうでなければ普通に移動する)。
=======
(枠の中なら親に知らせ、そうでなければ普通に移動する)。**2026-09 時点で対応済みなのは
`/reserve/sport` だけです。**
>>>>>>> origin/main

---

## 段階 1: `/schedule/` の上部に「今日走れる？」を出す

WordPress の該当ページ (クラシックエディタなら「テキスト」タブ) の**一番上**に
下記を貼るだけです。プラグインは不要です。

```html
<div data-aone="today"></div>
<script src="https://reserve.rk-a1.com/embed/aone.js" async></script>
```

表示されるもの:

* 今日の日付と、**いまの状態** (準備中 / 営業中 / 本日は終了)
  * **18 時 (コースクローズの 30 分後) を過ぎると、翌日に切り替わります。**
    見出しが「明日 8月28日 (金) の走行状況」になります
  * コースオープン前は「**本日は 8:30 コースオープンです**」と 1 行出ます
  * 臨時休業・走行中止の日は、時間帯に関係なく **休業 / 走行中止**が出ます
* 路面状況 (ドライ / ウェット / ウェット→ドライ / ヘビーウェット。設定したときだけ)
* 午前・午後 × カテゴリー別の ○ △ ✕ —
  （カート・ミニバイクは「走れます」、キッズ・その他は「要予約」）
* RP の空き状況
* 「スポーツ走行を予約」「レースパックを予約」「貸切を申し込む」「ナイターを相談」ボタン

既存の手入力スケジュールはそのまま下に残せます。**まずは並行運用**でどうぞ。

## 段階 2: 月間スケジュールを DB 連動にする

手入力の表を消して、下記に置き換えます。

```html
<div data-aone="month"></div>
<script src="https://reserve.rk-a1.com/embed/aone.js" async></script>
```

* 前月・翌月ボタン付きのカレンダー。上下どちらにもボタンがあります
* **見出しの年月はプルダウン**です。押すと 3 か月前 〜 12 か月先から選べます
  (「8 月に 12 月の予定を見る」が 1 回で済みます)
* **スマホで今月を開くと、今日から始まります。**過ぎた日は
  「▼ 8月1日〜26日 も表示する」を押すと出ます (PC は今までどおり 1 日から全部)
* **レンタル / スポーツ走行 / 両方** の切り替えボタン (公開スケジュールと同じ)
  * **選んだモードはブラウザが覚えます。**月を送っても、次に開いたときも同じモードです
  * ページ側で固定したいときは `data-mode="rental"` のように書きます
    (例: レンタルのページには レンタルだけ出す)

> ⚠️ 「スポーツ走行」を選ぶと、レースパック・貸切の予約は表示されません
> (逆も同じ)。覚えているので、**前に「スポーツ走行」で見ていると次に開いても
> そのまま**です。入っているはずの予約が見えないときは「両方」を押してください
> (カレンダーの下にも同じ案内が出ます)。
* 各日を AM / PM の 2 行に分け、予定 (レース / イベント / 臨時休業 …)、
  受付できるカテゴリー、RP・貸切の「時間 + お名前」を出します
* 名前の出し方は `/admin/settings` の「公開する予約者名」で決めます
  (`family` 姓のみ = 既定 / `full` 入力どおり / `hidden` 時間だけ)。
  貸切だけは団体名が分からなくなるため略しません
* **スポーツ走行の予約者は公開面に一切出しません** (走れるカテゴリーだけ出します)

`script` タグはページに 1 つあれば足ります。両方のウィジェットを 1 ページに置く場合も 1 つでOK。

## 段階 3: 予約導線を寄せる

サイト内の「予約」リンクをすべて予約システムへ向けます。
ウィジェット内のリンクは script 自身の origin を基準に組み立てているので、
将来 URL が変わっても `script` の src を差し替えるだけで追従します。

---

## API (自前で描画したい場合)

ウィジェットを使わず、テーマのテンプレートから直接描画することもできます。

### `GET /api/public/today`

```json
{
  "date": "2026-08-20",
  "label": "2026年8月20日 (木)",
  "business": { "status": "open", "label": "営業中", "message": null, "open": true },
  "surface": { "status": "wet", "label": "ウェット" },
  "sessions": [
    { "key": "am", "label": "午前", "time": "09:00〜12:00",
      "used_classes": 1, "max_classes": 2,
      "categories": [
        { "code": "kart", "short_name": "カート", "status": "open",
          "mark": "○", "text": "走れます", "walk_in_ok": true, "requires_reservation": false }
      ] }
  ],
  "rp": { "min_party": 3, "open_count": 12, "first_open": "14:00", "summary": "14:00〜 空きあり (残り 12 枠)" },
  "blocks": [{ "label": "A-ONE シリーズ第 4 戦", "kind": "race", "kind_label": "レース" }],
  "links": { "sport": "…/reserve/sport", "rp": "…/reserve/rp" }
}
```

### `GET /api/public/month?ym=2026-08`

各日の `am_open` / `pm_open` / `rp_free` / `events` / `business_label` / `surface_label` を返します。

どちらも CORS 許可済み・個人情報なし・60〜300 秒キャッシュです。

### PHP でサーバー側描画する場合 (SEO 重視・任意)

`functions.php` か Code Snippets プラグインに置くと、`[aone_today]` ショートコードが
使えます。JavaScript を待たずに HTML が出るので検索エンジンにも読まれます。

```php
<?php
// [aone_today] : A-ONE 予約システムの「今日走れる？」をサーバー側で描画する
add_shortcode('aone_today', function () {
    $base = 'https://reserve.rk-a1.com';
    $data = get_transient('aone_today');           // 60 秒キャッシュ
    if ($data === false) {
        $res = wp_remote_get($base . '/api/public/today', ['timeout' => 5]);
        if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
            return '<p><a href="' . esc_url($base) . '/">本日の走行状況はこちら</a></p>';
        }
        $data = json_decode(wp_remote_retrieve_body($res), true);
        set_transient('aone_today', $data, 60);
    }

    $out  = '<div class="aone-today">';
    $out .= '<h3>' . esc_html($data['label']) . ' の走行状況';
    $out .= ' <small>' . esc_html($data['business']['label']) . '</small>';
    if (!empty($data['surface'])) {
        $out .= ' <small>路面 ' . esc_html($data['surface']['label']) . '</small>';
    }
    $out .= '</h3>';
    if (!empty($data['business']['message'])) {
        $out .= '<p>' . esc_html($data['business']['message']) . '</p>';
    }
    foreach ($data['sessions'] as $s) {
        $out .= '<p><strong>' . esc_html($s['label']) . '</strong> ' . esc_html($s['time']) . '<br>';
        foreach ($s['categories'] as $c) {
            $out .= esc_html($c['short_name'] . ' ' . $c['mark'] . '(' . $c['text'] . ') ');
        }
        $out .= '</p>';
    }
    $out .= '<p>RP: ' . esc_html($data['rp']['summary']) . '</p>';
    $out .= '<p><a class="button" href="' . esc_url($data['links']['reserve']) . '">予約する</a></p>';
    $out .= '</div>';
    return $out;
});
```

---

## 注意

* ウィジェット内の文字は WordPress テーマのフォントを引き継ぎます。色や余白を変えたい
  場合は、テーマ側の CSS で `.aone-w` 以下を上書きしてください
  (`.aone-w .aone-btn { … }` のように書けば効きます)
* API はキャッシュが 60 秒あるので、予約直後の反映は最大 1 分遅れます
* 予約システムが一時的に落ちても、ウィジェットは「取得できませんでした + 予約システムへの
  リンク」を出すだけで、WordPress のページ自体は壊れません
