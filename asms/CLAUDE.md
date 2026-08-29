# ASMS — 開発時の恒久指針

このドキュメントは、将来のセッションでも保持したい設計判断・運用ポリシーを記録します。会話履歴がリセットされても、ここを起点に判断してください。

## Phase 進行の基本姿勢

**Phase 1 運用開始後は、実際の予約・受付・当日運用で発生した不便やヒヤリを記録し、Phase 2 の優先順位を実運用ベースで見直す。**

- 机上の優先順位より、実際に起きた問題を優先
- 「バグではないが不便」「ヒヤリハット」も等しく記録
- Phase 2 に着手する前に、記録を集約して並び替える
- 未実装機能でも「実運用で無くて困った」と証明されるまで急がない

## Phase 2 想定優先順位（運用フィードバックで随時見直し）

1. ~~**二重予約防止を DB 側で確実にする**~~ ✅ `create_reservation_atomic` 実装済
2. ~~**予約作成をトランザクション化**~~ ✅ 同上で RPC 化済
3. ~~キャンセル自動メール~~ ✅ 顧客側 / スロット全体 / 管理個別 の 3 系統実装済
4. ~~Turnstile CAPTCHA~~ ✅ graceful degradation で実装済（enable は Dashboard 設定次第）
5. 電子署名画像を R2 upload へ移行（現状 DB TEXT に base64 格納）
6. ~~Supabase Auth Magic Link~~ ✅ `/reserve/signin` + `/auth/callback` + `/api/me/prefill` 実装済
7. ~~コース設定編集画面~~ ✅ `/admin/courses` 実装済
8. ~~会計管理（支払い方法記録 + 月次集計）~~ ✅ `/admin/sales` + slot 詳細に記録 UI 実装済

### Magic Link 有効化手順 (Supabase 側)

1. Supabase Dashboard → **Authentication → URL Configuration**
   - **Site URL**: `https://kidskart-asms.kidskart1177.workers.dev` （切替段階については下記「URL 切替方針」参照）
   - **Redirect URLs** に**両方**追加:
     - `https://kidskart-asms.kidskart1177.workers.dev/auth/callback`
     - `https://reserve.kidskart.org/auth/callback`
2. Authentication → **Providers → Email**
   - Enable Email provider を ON、Confirm email を OFF（Magic Link は直接ログイン扱い）
3. Authentication → **Email Templates → Magic Link**
   - 件名: `【福岡キッズカートアカデミー】サインインリンク`
   - 本文: 日本語化＋「このリンクを他人に転送しないでください」を明記
4. `asms/db/0014_guardian_auth_link.sql` を SQL Editor で実行

## 認証・顧客識別ポリシー

### 決定（オーナー承認済み・2026-08）

3 層の認証・プリフィル戦略。段階的に導入する。

| 段階 | 対象 | 手段 | 実装状況 |
|------|------|------|:---:|
| **1. 同一端末リピーター** | 同じスマホ・同じブラウザで再予約 | **localStorage** に前回入力を保存 → 次回自動プリフィル | ✅ 実装済み |
| **2. 別端末リピーター** | 機種変更・PC↔スマホの持ち替え | **Supabase Auth Magic Link** で本人確認 → 顧客履歴呼び出し | ✅ 実装済 |
| **3. Passkey 化（将来）** | 通常ログイン全般 | WebAuthn / Passkey で Face ID / Touch ID | ⏸ Future |

### やらないこと（明示的な禁則）

- ❌ **電話番号のみをキーとした顧客検索 API を作らない**
  - 電話番号は推測・既知の可能性があり、フル PII 開示に見合わない
  - Reserva 相当の trust level では不十分と判断
- ❌ **予約番号 + 電話番号での呼び出しも作らない**
  - 予約番号がメール・スクショから漏洩し得るため
- ❌ **パスワード認証を導入しない**
  - Magic Link と Passkey で運用する。パスワード管理はユーザーにもオーナーにも負担

### 実装ガイド

- Phase 2 の Magic Link 実装時は、**Passkey へ移行できる設計**を維持する
  - Supabase Auth の `auth.users` を素直に使う（独自認証テーブルを増やさない）
  - フロントは Supabase JS の `signInWithOtp` / `signInWithPasskey` を差し替えられる薄いラッパで抽象化
- Magic Link のメール本文には「このリンクを他人に転送しないでください」を明記
- localStorage キーは `asms:lastReservation` で固定（既存実装との互換）

---

## その他の運用ポリシー

### 個人情報の取り扱い
- サーバー側 API から PII をレスポンスとして返すのは**認証済みリクエストのみ**
- 未認証で叩ける公開 API は、`courses` `slots` `terms` の非機微データに限る

### 予約作成時の TOCTOU
- `/api/reserve/create` の空き枠チェックはベストエフォート
- 満席後の確定はレアケースなので admin 手動対応で当面 OK
- 将来 Postgres SP + advisory lock で厳密化予定

### DB マイグレーション
- `asms/db/000N_*.sql` は連番で追加のみ。既存ファイル編集は fresh install の整合性を維持する目的のみ（本番適用済み内容の意味は変えない）
- 各マイグレーションは Supabase SQL Editor で手動実行が前提（自動適用パイプラインはまだ無い）

### 画面のスクロール抑止
- 電子署名エリアなど、指ジェスチャを吸収したい要素には `touch-action: none` **と** `touchstart/touchmove` の `preventDefault({ passive: false })` を**両方**適用する（片方だけだと古い WebView で漏れる）

### 環境変数の source of truth
2 層構造。3 回の wipe 事故（2026-08-11）を経ての最終形:

**wrangler.jsonc の `vars`** — 非機微な設定の source of truth
- 7 変数: PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY / ADMIN_USERNAME / ADMIN_PASSWORD_HASH / MAIL_FROM_ADDRESS / MAIL_FROM_NAME / MAIL_REPLY_TO
- 変更は git 経由（PR + deploy）で
- ANON key・SHA-256 hash 等、漏洩しても致命傷にならないもの

**Cloudflare Dashboard「変数とシークレット」（シークレット型のみ）** — 真の機密
- SUPABASE_SERVICE_ROLE_KEY
- RESEND_API_KEY
- Dashboard 追加後は「デプロイ タブ → 現バージョン再展開」で bind し直す

### 絶対に踏んではいけない地雷
- **`vars: {}` (空オブジェクト)**: deploy 時に Dashboard の非機密変数を全削除する
- **`vars` キーごと省略**: 同上、全削除する（Cloudflare docs と挙動が違う、実測でそう）
- **Dashboard で「変数」タイプの vars を追加してもダメ**: wrangler.jsonc に無ければ deploy で消える。Dashboard の「シークレット」タイプだけが deploy を生き延びる。

したがって、**wrangler.jsonc の `vars` は必ず 7 変数入りで維持する**。空にも消しにもしない。

### Astro での読み方
- `envFrom(locals)` で `locals.runtime.env` から読む
- `import.meta.env` は dev 用フォールバックのみ（本番では runtime env 経由）

### 新しい環境変数を追加するときの手順
- **非機微なら**: wrangler.jsonc `vars` に追加 → env.d.ts の Env 型に追加 → PR → deploy
- **機密なら**: env.d.ts の Env 型に追加（`?` 付き optional） → Dashboard に Secret 追加 → 現バージョン再展開 → コード側で使用開始

### 本番 URL / ドメイン構成 (2026-08-19 DNS 移管以降)

- **本番 URL**: `https://reserve.kidskart.org` （工事中、段階移行中）
- **Cloudflare Worker 名**: `kidskart-asms`
- **workers.dev URL**: `https://kidskart-asms.kidskart1177.workers.dev` （現行案内 URL、段階移行中）
- **DNS 管理**: Cloudflare (ゾーン `kidskart.org`)
  - 2026-08-19 に Xserver から移管
  - ムームードメイン側の NS は `jacob.ns.cloudflare.com` / `tina.ns.cloudflare.com`
  - Worker との接続は **Custom Domain 方式** (`reserve.kidskart.org` → `kidskart-asms`)
    - 移管直後は zone 認識ラグで Route 方式で仮運用したが、2026-08-20 に
      Custom Domain へ切替 (Chrome の断続 `NET::ERR_CERT_COMMON_NAME_INVALID`
      根治のため、hostname 専用の Let's Encrypt 証明書を明示発行させる)
    - DNS レコードは Cloudflare が Custom Domain 追加時に自動生成 (手動追加不要)
- **kidskart.org 本体** (公式サイト・ランディング): GitHub Pages
  - A レコード 4 個 (185.199.108-111.153) + CNAME `www → aaamotorsports.github.io`
  - すべて DNS only (グレー雲) — GitHub Pages が独自 CDN/TLS を持つため
- **メール受信** (@kidskart.org): Xserver
  - MX `sv762.xserver.jp`
- **メール送信通知** (Resend): `send.kidskart.org` サブドメイン
  - MX `feedback-smtp.ap-northeast-1.amazonses.com` + SPF/DKIM

### URL 切替方針 (workers.dev → reserve.kidskart.org)

段階的移行中。オーナー承認済み (2026-08-20)。

| 対象 | 現状 | 切替タイミング |
|------|------|---------------|
| Supabase Auth Redirect URLs | ✅ **両方追加済** (workers.dev + reserve.kidskart.org) | 完了 |
| Supabase Auth Site URL | workers.dev のまま | 保護者告知切替と同時 |
| GitHub Secrets `ASMS_API_BASE` (thankyou-mail cron) | workers.dev のまま | 保護者告知切替と同時 |
| **kidskart.org の予約リンク** | Reserva の旧 URL | **9 月開催スケジュール入力後**、`https://reserve.kidskart.org/reserve/` に差替 |
| 保護者への告知 | 未告知 | 同上のタイミング |

**リンク先仕様**: 案内 URL は必ず `/reserve/` パス付きで案内する (landing の `/` ではなく、
予約カレンダーに直行させる)。例: `https://reserve.kidskart.org/reserve/`

### GA4 (Google Analytics 4)

**目的**: 集客 → 予約完了 の単一ファネルを測る。事業判断の最重要 CV は
「予約完了 (`booking_complete`)」。kidskart.org (静的サイト) と
reserve.kidskart.org (ASMS) を **同一データストリーム** で計測する
(オーナー承認済み・2026-08-20 判断: サブドメイン分けは分析を煩雑にするだけ、
同じ顧客・同じファネルなので統合する)。

**測定 ID**: `G-W3HB0DT0Y3` (プロパティ名「kidskart.org - GA4」)
- `wrangler.jsonc` の `PUBLIC_GA4_MEASUREMENT_ID` に格納
- `Base.astro` が読み、gtag タグを全ページに埋め込む
- 空文字なら計測タグは一切吐かない (dev / preview 用)

**カスタムイベント** (`window.asmsTrack(name, params)` で発火):

| イベント | 発火箇所 | 意図 |
|---------|---------|------|
| `page_view` | GA 自動 | 全ページ流入 |
| `wizard_start` | `/reserve/[slotId]` 初期化 | 予約ウィザード到達 |
| `wizard_step` | ステップ前進時 (params.step = 2〜8) | 各段階の離脱率 |
| `booking_submit` | 送信ボタン押下 | 送信意思 (成否問わず) |
| `booking_complete` | `/reserve/complete/*` ロード | **★ 最重要 CV** |
| `repeat_book_click` | 完了ページのリピート CTA | Upsell 効果 |

**cross-subdomain**: `cookie_domain: 'kidskart.org'` を config に指定。
これで client_id / session_id が kidskart.org と reserve.kidskart.org 間で
継続する。加えて **GA 側で必ず設定**:
1. データストリーム → タグ設定 → クロスドメインの構成:
   `kidskart.org`, `reserve.kidskart.org` を両方登録
2. データストリーム → タグ設定 → 除外する参照のリスト:
   `reserve.kidskart.org` を追加 (self referral の除外)
3. `booking_complete` を「キーイベント」としてマーク

**プライバシー**: PII は params に載せない。GA には slot_id / course_code /
price_tier / participants 人数 / total_amount (¥) のみ送る。保護者名・
メール・電話は絶対送らない。

### サンキューメールの CTA 出し分けポリシー

`/api/cron/thankyou-mail` は毎日 18:00 JST に **Cloudflare Workers Cron
Triggers** から叩かれ、当日参加者の保護者にサンキューメールを送る
(2026-08-29 に GitHub Actions cron から移行、時刻精度が秒〜分レベルに)。
**「毎回同じお願い」で疲弊させないため、CTA は初回参加時のみに絞る**
(オーナー承認済み・2026-08-25 判断)。

| CTA | 表示条件 | 目立たせ方 |
|-----|---------|-----------|
| 次回予約リンク | **毎回** (参加者ごとに skill_level で分岐) | メイン |
| Google 口コミ CTA | **初回参加 & guardians.google_review_asked_at IS NULL** | プロミネント (青ボタン) |
| 内部アンケート (Google Form) | 初回参加のみ (現状) | 従属的な小さいテキストリンク |

**判定ロジック**:
- `isFirstVisit` = その保護者の過去 `thankyou_email_sent_at` 送信済み予約数 == 0
- 送信時に `guardians.google_review_asked_at` を更新し、二度と自動送信しない
  (保護者単位で 1 回だけ)
- 内部アンケートの表示条件は Google 口コミとは**独立**な `showSurveyCta`
  変数で管理。将来「3 回目 / 5 回目 / チャレンジ初回」で別 Form に出し
  分ける拡張が可能な設計

**Google 口コミ URL**: `PUBLIC_GOOGLE_REVIEW_URL` に格納。
現状 `https://g.page/r/CfMucc5k_k0vEBM/review` (エーワンサーキット
の Google Business Profile 短縮 URL)。

**Google ポリシー準拠**: 「満足者だけ Google に、不満は内部に」の振り
分けは絶対にしない。全員に同じ導線を出す (口コミゲート禁止)。

**カラム追加**: `db/0027_guardians_google_review_asked_at.sql` を
Supabase SQL Editor で実行して有効化。

### 自動メール系 cron の設計判断 (2026-08-29 確定)

**cron はどこで動かすか: Cloudflare Workers Cron Triggers**
- 定期実行系は当初 GitHub Actions cron に置いていたが、2026-08-28 に
  11 時間遅延して発火し、翌 5:45 AM に「本日ありがとうございました」
  メールが授業前の実顧客に届く事故が発生した
- GitHub Actions cron は公式仕様として「ベストエフォート、負荷時に
  数分〜数時間遅延する」と明記されている (schedule event, Notes)
- Cloudflare Workers Cron Triggers は Cloudflare 内部スケジューラで発火し、
  実測で秒〜分レベルの精度。ASMS は既に Cloudflare Workers 上なので
  追加インフラなしで移行できる
- 実装: `asms/app/worker-entry.mjs` が Astro worker (fetch) + scheduled
  handler の両方を提供。cron 式 → API endpoint の mapping は
  `CRON_TO_ENDPOINT`
- GitHub Actions ワークフロー (`asms-*-mail.yml`) は `schedule:` を削除し、
  `workflow_dispatch:` のみ残す (緊急時の手動再送用)

**送信ガード: 「授業終了済みのみ送信」 (thankyou)**
- cron が数時間遅延して日をまたぐと、翌日分の予約に「本日ありがとう」を
  授業前に送ってしまう事故が発生し得るため、`isSlotFinishedJst()` で
  slot.end_time (JST) が現在時刻を過ぎたスロットのみを送信対象にする
- end_time が未設定なら start_time + 90 分をフォールバック
- どちらも取れなければ「未終了扱い」で送らない (安全側)
- dateOverride 指定時 (`?date=...` の手動再送) はガードをスキップ

**取りこぼし防止: yesterday もクエリに含める**
- thankyou の cron が万一 1 日 skip されても、翌日 cron が
  `dateList = [yesterday, today]` を見て前日分を catch-up する
- 二重送信は `thankyou_email_sent_at IS NULL` チェックで防止

**送信頻度の設計思想**
| 時刻 | 種類 | 意図 |
|-----|-----|-----|
| 18:30 JST 前日 | リマインド | ノーショー防止・キャンセル判断の窓口 |
| 18:00 JST 当日 | サンキュー | 授業終了後の御礼 + 次回導線 |
| 19:00 JST 30日後 | フォロー | 未再予約者のみ 1 回だけ (しつこくしない) |

サンキュー・リマインド以外の第 4 のメールは追加しない方針。1 予約に
つき最大 5 通 (予約時 + リマインド + 当日 + 30 日フォロー + キャンセル時)
で、これ以上増やすと「またか」で開封率が落ちる。

**監視: cron_runs + /admin パネル**
- `logCronRun(supabase, name, worker)` ヘルパで全 cron が 1 実行 = 1 行 insert
- /admin トップの「🤖 自動メールの動作状況」パネルが直近実行を可視化
- 30 時間動いてなければ黄バッジ、エラーなら赤バッジ
- Cloudflare Logs を開かなくても管理画面から気づける (「無音で死ぬ」を防止)

**運用時の確認ポイント (最初の 2〜3 日)**
- /admin の cron パネルが全部緑になっているか
- Resend Dashboard の送信ログ件数と cron パネルの `sent 件数` が一致するか
- 2〜3 日安定したらほぼ放置運用で OK

### Cloudflare 設定のバックアップ
Cloudflare Dashboard の Secret を誤って全削除するとメール送信・書き込み系が即死する。
- Secret 値は 1Password 等の別レイヤに保管
- 削除操作の前に別タブでリストのスクショを撮る

### データベースのバックアップ
詳細手順は `asms/BACKUP.md` を参照。

- Supabase Free プランのため公式自動バックアップは実質使えない
- GitHub Actions cron (`.github/workflows/asms-db-backup.yml`) が毎日
  03:00 JST に `pg_dump` を取り、Cloudflare R2 バケット `kidskart-asms-backup`
  に保存
- daily/ は 90 日で lifecycle 自動削除、monthly/ は無期限保存
- 失敗時は info@kidskart.org にメール通知
- **四半期に 1 回は BACKUP.md「復元テスト」を実施** (取れてるだけじゃなく
  復元できることを確認する)
- 電子署名 (`consents.signature_data_url`) は現状 DB TEXT の base64 なので
  同じ dump に含まれる。将来 R2 に切り出したら R2 側のバージョニングも別途必要

### Turnstile (CAPTCHA) の有効化手順
1. Cloudflare Dashboard → Turnstile → **Add site**
   - Site Name: `kidskart-asms`
   - Hostname: **`reserve.kidskart.org`** と `kidskart-asms.kidskart1177.workers.dev` を両方追加
     (段階移行中、両ドメインからのアクセスに対応)
   - Widget mode: Managed（推奨）
2. 発行された **Site Key** を `wrangler.jsonc` の `PUBLIC_TURNSTILE_SITE_KEY` に貼付 → PR → deploy
3. 発行された **Secret Key** を Cloudflare Dashboard → kidskart-asms → 設定 → 変数とシークレット に **シークレット型** で `TURNSTILE_SECRET_KEY` として登録
4. 現バージョン再展開（シークレット bind）
5. `/reserve/[slotId]` ステップ 8 に CAPTCHA が出現、突破しないと送信不可

**設定してない状態**: wizard に CAPTCHA が表示されず、送信ボタンも即有効。API 側も検証スキップ（graceful degradation）。開発時や運用開始直後はこの状態で OK。
