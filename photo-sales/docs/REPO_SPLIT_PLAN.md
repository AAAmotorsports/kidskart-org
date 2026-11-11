# リポジトリ分離 調査報告と移行計画 (承認前・何も変更していません)

調査日: 2026-11-11 / 対象: `AAAmotorsports/kidskart-org`
調査は**読み取りのみ**。既存システムのコード・GitHub Actions・Cloudflare/Supabase/Vercel/GitHub の設定は変更していません。
凡例: ✅ リポジトリ内のファイルで確認 / ❓ 各ダッシュボードでの確認が必要 (私からは見えない)

---

## 1. 現在の GitHub リポジトリと各システムの配置

`AAAmotorsports` には 7 リポジトリがあり、すべて **public**。うち本件に関係するのは `kidskart-org` のみ
(他は `invoice-system` `invoice-system-v1.1` `jobs-aaa-ms` `events-aaa-ms` `aaa-ms.com` `arataendo`)。

`kidskart-org` (main) の中身:

| 場所 | システム | 技術 | 本番 | ファイル数 |
|---|---|---|---|---|
| ルート直下 + `stories/` `images/` ほか | キッズカート公式サイト | 静的 HTML | `kidskart.org` | 約 200 |
| `asms/` | ASMS (キッズカートアカデミー予約・安全管理) | Astro + Cloudflare Worker `kidskart-asms` | `reserve.kidskart.org` | 114 |
| `aone/` | A-ONE 予約システム | Astro + Cloudflare Worker `aone-booking` | `reserve.rk-a1.com` | 113 |
| `photo-sales/` | 写真販売 (開発中) | Astro + Worker + D1 + R2 | 未デプロイ | 72 |
| `.github/workflows/` | ASMS/A-ONE の手動実行・バックアップ | GitHub Actions | — | 7 |

* `photo-sales/` は**作業ブランチ `claude/a-one-circuit-photo-sales-8w5cgu` にだけ**あり、main には入っていません。このブランチの変更は `photo-sales/` 以外に**ありません** (main との差分で確認済み)。
* 各システムは**互いのコードを import していません** (`../aone` `../asms` などの参照は 0 件)。分離しやすい構造です。
* 共有されているのは、リポジトリそのもの・`.github/workflows/`・GitHub Actions の Secrets・(ルートの GitHub Pages 公開) の 4 つだけです。

## 2. Cloudflare / Supabase / Vercel / GitHub Actions との接続関係

| システム | 公開の仕組み | デプロイ | DB | その他 |
|---|---|---|---|---|
| 公式サイト | ✅ **GitHub Pages** (`CNAME`=kidskart.org、`.nojekyll`、DNS の A レコード 185.199.108-111.153 / `www`→`aaamotorsports.github.io` と `asms/CLAUDE.md` に記載) | main への push で公開 ❓ (Settings → Pages のソース設定を要確認) | なし | |
| ASMS | ✅ Worker `kidskart-asms` + Custom Domain `reserve.kidskart.org` | ✅ Cloudflare **Workers Builds** (ルート `asms/app`。`wrangler.jsonc` と README に記載) ❓ 接続リポジトリ・ブランチ・監視パスを要確認 | ✅ Supabase (専用プロジェクト) | R2 `kidskartasmsbuckup` / Cron 4 本 / Resend |
| A-ONE 予約 | ✅ Worker `aone-booking` + Custom Domain `reserve.rk-a1.com` | ❓ README は手動 `wrangler deploy`。Workers Builds 接続の有無を要確認 | ✅ Supabase (ASMS とは別プロジェクト) | Cron 毎時 / WordPress 埋め込み (`reserve.rk-a1.com/embed/aone.js`) |
| 写真販売 | 未デプロイ (Worker は未作成) | これから | Cloudflare D1 `aone-photo` (作成済み・SQL 未実行) | R2 は未作成 |

**Vercel**: `README.md` / `DEPLOY.md` は「Vercel 静的配信」と書いていますが、`vercel.json` は**リポジトリに存在せず**、`asms/CLAUDE.md` は公式サイトを GitHub Pages と明記しています。
**現在の実態は GitHub Pages で、Vercel の記述は古い**と判断しています ❓ Vercel に `kidskart-org` に接続されたプロジェクトが残っていないか要確認 (残っていれば、push のたびに無駄なビルドが走ります)。

**GitHub Actions** (✅ 7 本):
* `asms-db-backup.yml` — **毎日 03:00 JST の定時実行**。ASMS の Supabase を `pg_dump` して R2 に保存し、失敗時に Resend でメール。**唯一の本番の定時ジョブ**
* それ以外の 6 本 (`aone-backup` `aone-mails` `asms-followup-mail` `asms-freee-sync-monthly` `asms-reminder-mail` `asms-thankyou-mail`) は**手動実行 (workflow_dispatch) のみ**
* 使用している Secrets (名前のみ。値は見えません): `AONE_API_BASE` `AONE_CRON_SECRET` `ASMS_API_BASE` `ASMS_CRON_SECRET` `SUPABASE_DB_URL` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET` `R2_ENDPOINT` `RESEND_API_KEY` `MAIL_FROM_ADDRESS` `MAIL_ADMIN_TO`

**Supabase**: リポジトリ内に Supabase の GitHub 連携の設定 (`supabase/` ディレクトリ・`config.toml`) は無く、連携していない可能性が高いです ❓ Supabase ダッシュボードの Integrations で要確認。
**DNS**: `kidskart.org` と `rk-a1.com` のゾーンは Cloudflare 側で管理しており、**GitHub リポジトリとは無関係**です (リポジトリを分けても DNS は変わりません)。

### 見つかった注意点
1. **GitHub Pages がルートを公開している場合**、main にあるファイルはすべて `kidskart.org/<パス>` で閲覧できます (`/asms/…` `/aone/…` の SQL・設定ファイルを含む) ❓ 実際の公開は確認できていません (調査環境から kidskart.org に接続できないため)。リポジトリ自体が public なので新たな秘密の漏えいではありませんが、**`photo-sales/` を `kidskart-org` の main にマージすると、設計書や SQL が公式サイトのドメインでも公開されます**。写真販売を別リポジトリに分ける強い理由の 1 つです。
2. 3 システムとも、Supabase の公開キーや管理者ユーザー名が `wrangler.jsonc` に載っています (公開キーは仕様上公開可)。リポジトリを **private** にすれば露出が減ります。ただし GitHub Pages は無料プランでは public リポジトリが必要なので、**公式サイト用は public のまま**になります。

## 3. リポジトリを分ける場合の影響とリスク

| # | リスク | 影響 | 対策 |
|---|---|---|---|
| R1 | Workers Builds の Git 接続は Worker ごと・リポジトリごと | 接続を付け替えるまで自動デプロイが止まる。**稼働中の Worker 自体は止まらない** (デプロイ済みのコードは GitHub に依存しない) | 付け替え前後で同じコミットを再デプロイして同一動作を確認。手動 `wrangler deploy` を保険にする |
| R2 | GitHub Actions の Secrets はリポジトリ単位で、**値をコピーできない** | 新リポジトリで再入力が必要。値が手元に無いものは再発行 (ローテーション) | 事前に Secrets の名前一覧を棚卸し。値は Cloudflare / Supabase / R2 / Resend の各画面で再取得 |
| R3 | `asms-db-backup` (毎日のバックアップ) が途切れる | ASMS の DB バックアップが空く | **新旧を並行稼働** (2 日以上) し、新リポジトリから R2 にダンプが出来たことを確認してから旧を無効化 |
| R4 | スケジュール実行は、リポジトリが 60 日間無活動だと GitHub が停止する | 小さいリポジトリほど起きやすい | 新リポジトリの定時ジョブに稼働監視 (失敗/停止の通知) を追加。現行の aone と同様に Cloudflare Cron へ寄せる案も |
| R5 | ドキュメント・設定のパス (`asms/app` → `app`) | Workers Builds の「ルートディレクトリ」、監視パス、CLAUDE.md、README の書き換え漏れ | 分離と同時に更新し、新リポジトリでビルド・テストが通ることを確認 |
| R6 | コミット履歴・PR・Issue | 履歴は引き継げるが、`(#256)` のような PR 番号は旧リポジトリを指す。PR/Issue 自体は移らない | 旧リポジトリは**削除せず残す** (読み取り用)。重要な未完了の議論は先に整理 |
| R7 | GitHub App (Cloudflare Workers & Pages / Claude) の権限 | 新リポジトリに権限が無いとデプロイ接続・自動作業ができない | 新リポジトリ作成後に各 App のアクセス対象へ追加 |
| R8 | 公式サイトから `aone/` `asms/` を削除すると、Pages 上の `kidskart.org/aone/…` が消える | これらの URL を参照している場所があれば 404 | 参照は `reserve.rk-a1.com` / `reserve.kidskart.org` で、`kidskart.org/aone` を使う箇所は見つかっていません。削除前にサイト内リンクを再確認 |
| R9 | リポジトリ名の変更・公開範囲の変更 | リネームは Pages・Workers Builds・Actions の URL に影響 | **`kidskart-org` はリネームしない** (公式サイトの Pages 設定をそのまま維持) |
| R10 | 履歴に秘密情報が含まれていないか | private 化・複製前に把握が必要 | 複製前に GitHub のシークレットスキャンで履歴を確認 (写真販売の履歴は確認済み: 検出なし) |

## 4. 既存の予約システムを止めない分離手順

**原則**
* **稼働中のものは、新リポジトリで動作確認が済むまで旧リポジトリのコードを消さない** (ロールバック先を残す)
* デプロイ済みの Worker は GitHub と独立して動き続けるので、リポジトリ作業中も予約は止まらない
* 1 システムずつ。**1 つ終えて安定してから次へ**
* 履歴を残すため `git subtree split` (または `git filter-repo`) で複製する。新リポジトリは**ルート直下にそのシステムだけ**を置く

**順序 (リスクが低い順)**
| フェーズ | 内容 | 既存への影響 |
|---|---|---|
| 0 | 棚卸し: §6 の「ダッシュボードで確認していただく項目」を確認。Secrets の値を手元に確保 | なし (見るだけ) |
| **1** | **写真販売 → `aone-photo-sales`** (未稼働) | **なし** |
| 2 | A-ONE 予約 → `aone-booking` (新規 private) | 付け替えの短時間のみデプロイ不可。予約は止まらない |
| 3 | ASMS → `kidskart-asms` (新規 private)。**バックアップの並行稼働が必須** | 同上 |
| 4 | `kidskart-org` から `asms/` `aone/` `photo-sales/` と該当 workflow を削除 (PR)。公式サイト専用に。`README.md`/`DEPLOY.md` を GitHub Pages の実態に直す | Pages の公開内容が減るのみ |

**フェーズ 2・3 の各手順 (稼働中システム)**
1. 新しい private リポジトリを作成 (空)。Cloudflare / Claude の GitHub App に許可
2. 履歴付きで複製 (`git subtree split --prefix=aone -b aone-only` → 新リポジトリの main へ push)
3. 新リポジトリに GitHub Actions の Secrets を再入力 → 手動実行のワークフローを 1 回試す (`aone-backup` など。副作用の無いものから)
4. 新リポジトリでビルド・型チェック・テストが通ることを確認
5. Cloudflare: 該当 Worker → 設定 → ビルド で Git 接続を新リポジトリに付け替え (ルートは `app`)。**変数・シークレットは Worker 側にあるので消えない**
6. 直前と同じコミットを再デプロイ → 新しい Worker バージョンが同一動作することを本番 URL で確認 (予約フォーム・管理画面ログイン・Cron のログ)
7. (ASMS のみ) `asms-db-backup` を新リポジトリで有効化し、旧と**並行で 2 日以上**。R2 に新リポジトリ由来のダンプが出ることを確認 → 旧を無効化
8. 旧リポジトリの該当フォルダは**最低 1 週間残す**。問題がなければフェーズ 4 で削除

**ロールバック**: Worker の Git 接続を旧リポジトリへ戻す (旧フォルダが残っているため可能)。Cloudflare のバージョン履歴から直前のバージョンへ即時復帰もできます。

## 5. 写真販売専用リポジトリ `aone-photo-sales` への移行方法

**ドライラン済み** (調査用の複製で実施。実際のリポジトリは未変更): `git subtree split --prefix=photo-sales` で、
写真販売の 6 コミットの履歴を保ったまま `photo-sales/` の中身がルートに来ることを確認しました
(`app/` `db/` `docs/` `CLAUDE.md` `DESIGN.md` `README.md`、72 ファイル)。履歴・ファイルに秘密の値は検出されませんでした。

**手順 (写真販売は未稼働なので、既存システムへの影響はありません)**
| # | 担当 | 内容 |
|---|---|---|
| 1 | オーナー | GitHub で `AAAmotorsports/aone-photo-sales` を **Private・空** (README/.gitignore/LICENSE を追加しない) で作成 |
| 2 | オーナー | 新リポジトリが Claude と Cloudflare の GitHub App のアクセス対象に入っているか確認 (「All repositories」なら自動) |
| 3 | 私 | 新リポジトリをこのセッションに追加し、subtree で履歴付きに `main` として push |
| 4 | 私 | 新リポジトリ側でパスを更新 (`photo-sales/app` → `app`、`CLOUDFLARE_SETUP.md` のルートディレクトリ `app`・監視パス `app/**`、`README`/`CLAUDE.md`)。`npm ci && npm test && npm run build` が通ることを確認 |
| 5 | 私 | 以後の開発は新リポジトリで行う。`kidskart-org` の作業ブランチは**マージせず**、承認後に削除 |
| 6 | オーナー | Cloudflare の Worker デプロイ (CLOUDFLARE_SETUP ステップ 4) は、新リポジトリができてから実施 (Git 連携の付け替えが不要になる) |
| 7 | 保留 | D1 の SQL 実行は引き続き保留。SQL ファイルの場所は新リポジトリの `app/migrations/0001_init.sql` に変わる |

D1 `aone-photo`・`wrangler.jsonc` のデータベース ID・R2 の計画は**そのまま**使えます (リポジトリの場所に依存しません)。

## 6. 承認いただきたい事項

1. 方針 (4 リポジトリに分離、`kidskart-org` は公式サイト専用で名前・設定を維持) と、フェーズ順 (写真販売 → A-ONE → ASMS → 公式サイトの整理)
2. 新リポジトリ名: `aone-photo-sales` (指定どおり)、`aone-booking`、`kidskart-asms` (仮)
3. 公開範囲: 3 つの新リポジトリは **Private** (推奨)。`kidskart-org` は GitHub Pages のため public のまま
4. 履歴を引き継ぐ (推奨) か、現時点のコードだけにするか
5. フェーズ 1 (写真販売) だけ先に実施してよいか

**ダッシュボードで確認していただく項目** (見るだけです。変更は不要):
* GitHub: `kidskart-org` → Settings → **Pages** (公開元ブランチ/フォルダ、カスタムドメイン)、Settings → **Secrets and variables → Actions** (名前の一覧)、Settings → Integrations (インストール済み App)
* Cloudflare: Worker `aone-booking` と `kidskart-asms` → 設定 → **ビルド** (接続リポジトリ・ブランチ・ルートディレクトリ・ビルドコマンド・監視パス)
* Vercel: `kidskart-org` に接続されたプロジェクトが残っていないか
* Supabase: 各プロジェクトの Integrations に GitHub 連携があるか

## 変更していないもの
`asms/` `aone/` `.github/workflows/` `kidskart-org` の main、Cloudflare・Supabase・Vercel・GitHub の設定、写真販売の D1 (SQL 未実行)。
このファイルの追加のみ (作業ブランチの `photo-sales/docs/`)。
