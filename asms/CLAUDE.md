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
   - **Site URL**: `https://kidskart-asms.kidskart1177.workers.dev`（本番ドメイン移行後は差し替え）
   - **Redirect URLs** に追加: `https://kidskart-asms.kidskart1177.workers.dev/auth/callback`
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

### Cloudflare 設定のバックアップ
Cloudflare Dashboard の Secret を誤って全削除するとメール送信・書き込み系が即死する。
- Secret 値は 1Password 等の別レイヤに保管
- 削除操作の前に別タブでリストのスクショを撮る

### Turnstile (CAPTCHA) の有効化手順
1. Cloudflare Dashboard → Turnstile → **Add site**
   - Site Name: `kidskart-asms`
   - Hostname: `kidskart-asms.kidskart1177.workers.dev`（本番ドメイン移行後は差し替え）
   - Widget mode: Managed（推奨）
2. 発行された **Site Key** を `wrangler.jsonc` の `PUBLIC_TURNSTILE_SITE_KEY` に貼付 → PR → deploy
3. 発行された **Secret Key** を Cloudflare Dashboard → kidskart-asms → 設定 → 変数とシークレット に **シークレット型** で `TURNSTILE_SECRET_KEY` として登録
4. 現バージョン再展開（シークレット bind）
5. `/reserve/[slotId]` ステップ 8 に CAPTCHA が出現、突破しないと送信不可

**設定してない状態**: wizard に CAPTCHA が表示されず、送信ボタンも即有効。API 側も検証スキップ（graceful degradation）。開発時や運用開始直後はこの状態で OK。
