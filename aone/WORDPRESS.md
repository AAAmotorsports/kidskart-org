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
* 天候ステータスを変更

を入れるだけで、

```
管理画面 → 受付可否 → 「今日走れる？」 → 月間スケジュール → Web 予約枠
```

が全部自動で変わります。同じ予定を二度入力しません。

---

## iframe は使いません

WordPress に予約アプリを丸ごと iframe で埋めると、スマホで高さが崩れる・戻るボタンが
おかしくなる・サイトの中に別サイトがある状態になる、といった問題が出ます。

代わりに **JSON API + 貼り付けウィジェット**を用意しています。WordPress のページに
実際の HTML として描画されるので、見た目はホームページのまま、データだけ予約システムと
同期します。

---

## 段階 1: `/schedule/` の上部に「今日走れる？」を出す

WordPress の該当ページ (クラシックエディタなら「テキスト」タブ) の**一番上**に
下記を貼るだけです。プラグインは不要です。

```html
<div data-aone="today"></div>
<script src="https://reserve.rk-a1.com/embed/aone.js" async></script>
```

表示されるもの:

* 今日の日付と営業状態 (通常営業 / 雨天注意 / 雨天中止 …)
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

* 前月・翌月ボタン付きのカレンダー
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
  "weather": { "status": "normal", "label": "通常営業", "message": null, "open": true },
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

各日の `am_open` / `pm_open` / `rp_free` / `events` / `weather_label` を返します。

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
    $out .= ' <small>' . esc_html($data['weather']['label']) . '</small></h3>';
    if (!empty($data['weather']['message'])) {
        $out .= '<p>' . esc_html($data['weather']['message']) . '</p>';
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
