# ASMS — 開発時の恒久指針

このドキュメントは、将来のセッションでも保持したい設計判断・運用ポリシーを記録します。会話履歴がリセットされても、ここを起点に判断してください。

## 認証・顧客識別ポリシー

### 決定（オーナー承認済み・2026-08）

3 層の認証・プリフィル戦略。段階的に導入する。

| 段階 | 対象 | 手段 | 実装状況 |
|------|------|------|:---:|
| **1. 同一端末リピーター** | 同じスマホ・同じブラウザで再予約 | **localStorage** に前回入力を保存 → 次回自動プリフィル | ✅ 実装済み |
| **2. 別端末リピーター** | 機種変更・PC↔スマホの持ち替え | **Supabase Auth Magic Link** で本人確認 → 顧客履歴呼び出し | ⏸ Phase 2 |
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
- **Cloudflare Dashboard の「変数とシークレット」が唯一の設定場所**
- `wrangler.jsonc` の `vars` は空 `{}` にしておく（過去に `vars` に書いたら Runtime に届かない事故があった）
- Astro の `envFrom(locals)` で `locals.runtime.env` から読む（`import.meta.env` は dev 用フォールバックのみ）
- 新しい環境変数を追加するときは:
  1. Dashboard の 変数とシークレット に追加（変数 or シークレット）
  2. `env.d.ts` の `Env` 型に追加
  3. **既存のバージョンを再展開 or 新規コミット** で bind し直す（Dashboard 追加だけでは古い version には反映されない）
  4. `wrangler.jsonc` のコメント欄「VARIABLES THAT MUST EXIST IN THE DASHBOARD」に追記

### Cloudflare 設定のバックアップ
Cloudflare Dashboard の変数を誤って全削除するとサイトが即死する。1 人運用でも:
- 追加/変更したら wrangler.jsonc のコメントブロックを更新（値以外の一覧を残す）
- シークレット値は 1Password 等の別レイヤに保管
- 削除操作の前に別タブでリストのスクショを撮る
