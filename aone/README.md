# A-ONE 予約システム v1

A-ONE サーキットの

* スケジュール掲載
* スポーツ走行予約
* RP (レースパック) 予約
* 貸切予約
* 電話・店頭予約
* レース / イベント予定
* 天候による営業変更
* 顧客への連絡

を 1 つにまとめた **サーキット運営システム**です。単なる予約フォームではなく、

> 今日走れるか分かる → 予約する → 来場する → 再来場につなげる

までを扱います。

---

## 構成

```
aone/
├── db/                      Supabase (Postgres) のマイグレーション
│   ├── 0001_initial_schema.sql      テーブル / VIEW / トリガー
│   ├── 0002_seed_holidays.sql       祝日マスタ (2025〜2028)
│   ├── 0003_availability_engine.sql ★受付ルールの本体
│   ├── 0004_reservation_rpcs.sql    予約の作成 / 変更 / キャンセル
│   ├── 0005_grants_and_rls.sql      RLS と権限
│   └── _TEST_rules.sql              ルールエンジンのテスト (ローカル用)
└── app/                     Astro + Cloudflare Workers
    └── src/
        ├── lib/             Supabase クライアント / 文言 / メール / 気象庁
        ├── layouts/Base.astro
        └── pages/
            ├── index.astro              「今日走れる？」
            ├── schedule.astro           公開スケジュール (管理カレンダーから自動生成)
            ├── reserve/                 予約フォーム (走行 / RP / 貸切 / ナイター)
            ├── r/[token].astro          予約者専用ページ (ログイン不要)
            ├── admin/                   管理画面
            └── api/                     JSON API
```

## 受付ルールは SQL が唯一の正

**`db/0003_availability_engine.sql` が受付可否の唯一の判定者**です。
画面も API も `aone_day_state()` / `aone_check_availability()` を呼ぶだけで、
同じルールを TypeScript 側に再実装していません (実装が 2 か所にあると、
カレンダーの表示と実際の受付結果が必ずズレるため)。

| ルール | 実装 |
|---|---|
| 同一カテゴリーは何台でも 1 クラス | `aone_check_availability('sport', ...)` |
| 平日 2 クラス / 土日祝 午前 2・午後 1 | `aone_settings` の 4 列 + `aone_is_holiday()` |
| RP は 3 名以上・30 分刻み | `aone_settings.rp_*` |
| 同一開始時刻は 2 グループまで | `rp_max_groups_per_start` |
| RP が同時 3 組以上ならスポーツ停止 | `aone_rp_peak_groups()` + `rp_groups_block_sport` |
| 17:00 以降の RP は要相談 | `rp_last_start_time` → status `checking` |
| 当日の RP は 17:00 以降不可 | `rp_same_day_last_start` |
| 当日の RP は 2 時間後以降のみ | `rp_same_day_lead_minutes` |
| 貸切はカート 5 台以上から | `charter_min_karts` (レンタルカート付きのみ) |
| コース貸切のみは金額を出さず必ず折り返す | `charter_type = 'course_only'` → status `checking` |
| 貸切は当日不可 (前日まで) | `charter_min_lead_days` |
| 貸切は他予約が無ければ確定、あれば連絡待ち | `aone_check_availability('charter', ...)` |
| 確定した貸切はその時間帯を全停止 | 同上 |
| ナイターは常に要相談 | `aone_check_availability('night', ...)` |
| レース / イベント / 臨時休業 | `aone_blocks` (終日 / 午前 / 午後 / 時間 / 種別 / カテゴリー) |
| 管理者の強制受付 | `forced = true` で全判定をバイパス (監査ログに残る) |

数値ルールは `/admin/settings` から変更できます。コード変更は不要です。

## セットアップ

### 1. Supabase

新規プロジェクト (リージョンは Northeast Asia (Tokyo)) を作り、SQL Editor に
**`db/INSTALL_ALL.sql` の全文**を貼って Run を 1 回。0001〜0005 を結合した
初回インストール用ファイルです。

運用開始後は `INSTALL_ALL.sql` を使わず、`db/000N_*.sql` を連番で追加して
1 本ずつ適用してください (`INSTALL_ALL.sql` は `./build_install_all.sh` で
再生成できます)。

```
0001_initial_schema.sql       テーブル / VIEW / トリガー
0002_seed_holidays.sql        祝日マスタ
0003_availability_engine.sql  受付ルール
0004_reservation_rpcs.sql     予約の作成 / 変更 / キャンセル
0005_grants_and_rls.sql       RLS と権限
```

プロジェクト作成時の Security 設定は
「Enable Data API = ON」「Automatically expose new tables = OFF」
「Enable automatic RLS = ON」を推奨 (必要な権限は 0005 が明示的に付けます)。

### 2. Cloudflare Workers

```bash
cd aone/app
npm install
npm run build      # Astro → dist/_worker.js
npx wrangler deploy
```

`wrangler.jsonc` の `vars` に非機密の設定を入れます (Supabase URL / anon key /
管理画面の Basic 認証 / メール差出人 / 気象庁エリアコード)。

**機密は Cloudflare Dashboard の「シークレット」型**に入れます:

| 名前 | 用途 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 予約の書き込み・管理画面の読み取り |
| `RESEND_API_KEY` | メール送信 |
| `CRON_SECRET` | `/api/cron/mails` を GitHub Actions から叩く共有鍵 |
| `ADMIN_PASSWORD_HASH` | 管理画面のパスワード (SHA-256 hex) |

> ⚠️ `wrangler.jsonc` の `vars` ブロックを空にしたり削除したりすると、
> deploy 時に Dashboard 側の非機密変数が全削除されます (ASMS で 3 回発生)。
> 常に全キー入りで維持してください。

管理画面のパスワードは SHA-256 ダイジェストで持ちます:

```bash
printf 'あたらしいパスワード' | sha256sum
# → Dashboard の ADMIN_PASSWORD_HASH (シークレット型) に貼る
```

> ⚠️ **このリポジトリは公開 (public)** なので、`ADMIN_PASSWORD_HASH` を
> `wrangler.jsonc` に書かないこと。ハッシュが公開されると、短いパスワードは
> オフラインの総当たりで破られます。シークレット型なら公開されません。

### 3. 自動メールの cron

> curl で手動確認するときは `-H "Content-Type: application/json"` を付けること。
> 付けないと Astro の CSRF 対策 (`security.checkOrigin`) が 403 を返す。
> `AONE_API_BASE` は独自ドメイン (`https://reserve.rk-a1.com`) を設定する。

`.github/workflows/aone-mails.yml` が 1 日 2 回 `/api/cron/mails` を叩きます。
GitHub Secrets に `AONE_API_BASE` と `AONE_CRON_SECRET` を設定してください。

## 本番導入前の通しテスト

`TESTING.md` に、予約 → 変更 → キャンセル → 電話予約 → 天候変更 → メールまでを
一通り触るためのチェックリストがある。運用開始前に 1 回通す。

## ルールエンジンのテスト

ローカルの Postgres があれば、そのまま流せます (本番では実行しないこと)。

```bash
createdb aone_test
psql -d aone_test -c "create role anon; create role authenticated; create role service_role;"
psql -d aone_test -f db/0001_initial_schema.sql \
                  -f db/0002_seed_holidays.sql \
                  -f db/0003_availability_engine.sql \
                  -f db/0004_reservation_rpcs.sql \
                  -f db/0005_grants_and_rls.sql
psql -d aone_test -v ON_ERROR_STOP=1 -f db/_TEST_rules.sql   # → ALL TESTS PASSED
```

テストは 13 グループ (クラス上限 / 土日祝 / RP の同時受付 / RP 飽和による走行停止 /
貸切 / ブロック / 天候 / 変更の再判定 / キャンセルと無断キャンセル / 強制受付 /
顧客の名寄せ / 電話予約の即時反映 / 連絡待ち貸切) を検証し、最後に
`ALL TESTS PASSED` を出して rollback します。

アプリ側:

```bash
cd aone/app
npm run typecheck   # astro check
npm run build
```

## WordPress (rk-a1.com) との連携

`WORDPRESS.md` を参照。iframe ではなく **公開 JSON API + 貼り付けウィジェット**で、
ホームページの見た目のままデータだけ同期する方式にしている。

```html
<div data-aone="today"></div>   <!-- 今日走れる？ -->
<div data-aone="month"></div>   <!-- 月間スケジュール -->
<script src="https://<予約システム>/embed/aone.js" async></script>
```

| URL | 用途 |
|---|---|
| `/api/public/today` | 今日の走行状況 (個人情報なし・CORS 許可) |
| `/api/public/month?ym=YYYY-MM` | 月間スケジュール |
| `/embed/aone.js` | 上記を描画する貼り付けウィジェット |

## 画面一覧

### 利用者向け

| URL | 内容 |
|---|---|
| `/` | **今日走れる？** カテゴリー別 ○△✕— と RP の空き、天候状態 |
| `/schedule` | 公開スケジュール (管理カレンダーから自動生成) |
| `/reserve` | 予約メニュー |
| `/reserve/sport` | スポーツ走行 |
| `/reserve/rp` | レースパック |
| `/reserve/charter` | 貸切申込 |
| `/reserve/night` | ナイター相談 |
| `/r/[token]` | 予約者専用ページ (確認 / 日時・人数変更 / キャンセル、ログイン不要) |

### 管理向け (Basic 認証)

| URL | 内容 |
|---|---|
| `/admin` | 今日のダッシュボード・**天候ワンタップ変更**・要対応一覧・今週 |
| `/admin/sheet` | 本日の受付シート (スマホ / A4 印刷。Web・電話・店頭の全予約) |
| `/admin/calendar` | 月 / 週カレンダー + 予定のまとめて登録 |
| `/admin/day/[date]` | 日別運営画面 (天候・一括連絡・予約操作・代理入力・強制受付・予定登録) |
| `/admin/reservations` | 予約台帳の検索 |
| `/admin/customers` | 顧客一覧・履歴・スタッフメモ |
| `/admin/settings` | 受付ルールの数値設定 |

## 自動メール (仕様 11)

| タイミング | 種類 | 送信元 |
|---|---|---|
| 予約直後 | 予約完了 (専用 URL 入り) | `/api/reserve/create` |
| 前日 | リマインド | cron `type=reminder` |
| 利用当日 | お礼 | cron `type=thanks` |
| 2 週間後 | 再来場のご案内 (再予約リンク) | cron `type=followup` |
| 変更時 | ご予約内容の変更 (お客様) | `/api/reserve/update` / 管理画面 (送信は任意) |
| 変更時 | 変更の通知 (管理者・変更点の差分付き) | `/api/reserve/update` |
| キャンセル時 | キャンセルの通知 (管理者) | `/api/reserve/cancel` |
| 随時 | 天候等の一括連絡 | `/admin/day/[date]` |
| 毎朝 | 折り返し未対応 24 時間超の督促 (管理者宛) | cron `type=callbacks` |
| 毎月 1 日 | 予約台帳・顧客名簿の CSV (管理者宛・添付) | `/api/cron/backup` |

二重送信は `aone_reservations.*_mail_sent_at` で防いでいます。

## v1 でやらないこと

* オンライン決済 (料金は表示のみ・支払いは現地)。
  ただし `amount` / `is_paid` / `payment_method` 列は先に用意してあります。
* 顧客ログイン (予約者専用 URL で足りるため)。
