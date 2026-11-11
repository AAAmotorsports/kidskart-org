# Cloudflare 側の準備手順 (管理画面での操作)

**方針**
* aone (予約システム) とは別の Worker / D1 / R2 を作る。aone の既存リソース・設定は開く必要もありません (触らない)
* **秘密の値 (API キー・トークン) はチャットにも GitHub にも書かない。** Cloudflare の入力欄にだけ貼る
* 有料プランへの変更はしない (必要になったら事前に相談)
* 画面の名称は Cloudflare の更新で多少変わります。迷ったら、見えている画面の名前を教えてください

## 手順の全体
| # | 内容 | 所要 |
|---|---|---|
| 0 | アカウントのプランを確認 | 1 分 |
| 1 | D1 データベース `aone-photo` を作る → ID を私に伝える | 5 分 |
| 2 | テーブルを作る (SQL を貼り付け) と、最初の管理者を登録 | 5 分 |
| 3 | R2 バケットを 3 つ作る | 5 分 |
| 4 | Worker を GitHub 連携でデプロイ | 10 分 |
| 5 | メール送信の設定 (Resend のキーはシークレットに) | 10 分 |
| 6 | 動作確認 (iPhone でログイン) | 5 分 |
| 7 | CPU 使用状況の確認 (S1) | 実機テスト後 |

## 0. プランの確認
1. https://dash.cloudflare.com にログイン (aone と同じアカウント)
2. 左メニュー **コンピューティング (Workers & Pages)** → 概要。ページ内の「プラン」表示 (または **アカウントのホーム → 請求 → サブスクリプション**) で **Workers が Free か Paid か** を確認
   * 無料枠 (1 日 10 万リクエスト・D1・R2) は**アカウント全体で aone と共有**です
   * Paid の場合、CPU 制限が 10ms ではなく 30 秒になるため、S1 の実測は「無料枠で通るか」の判定になりません。その場合は教えてください (測り方を変えます)

## 1. D1 データベースを作る
1. 左メニュー **ストレージとデータベース → D1 SQL データベース** → **データベースを作成**
2. 名前 `aone-photo` (場所は「自動」) → 作成
3. 画面に出る **データベース ID** (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) を私に伝える (ID は秘密ではありません。私が `wrangler.jsonc` に反映します)

## 2. テーブルと最初の管理者
1. 作った `aone-photo` を開く → **コンソール** タブ
2. `photo-sales/app/migrations/0001_init.sql` の中身を**全部コピーして貼り付け → 実行**
   * GitHub のこのファイルを開き、右上の「Raw」→ 全選択コピーが簡単です
   * エラーが出たら画面の文言を教えてください
3. 続けて次を実行 (メールアドレスはログインに使うものを**小文字**で)
   ```sql
   INSERT INTO staff_users(email, name, role) VALUES ('あなたのメール@example.com', '管理者', 'admin');
   ```

## 3. R2 バケット (3 つ)
1. 左メニュー **R2 オブジェクト ストレージ** (初回はクレジットカード登録を求められます。無料枠内なら請求は 0 円。aone で登録済みなら不要)
2. **バケットを作成** を 3 回: `aone-photo-originals` / `aone-photo-previews` / `aone-photo-backups`
   * 場所は「自動」、ストレージクラスは「Standard」
   * **公開アクセスは有効にしない** (「パブリック アクセス」「r2.dev サブドメイン」はオフのまま)

## 4. Worker をデプロイ (GitHub 連携)
1. **コンピューティング (Workers & Pages) → 作成 → Workers → Git を使ってインポート**
2. GitHub の `aaamotorsports/kidskart-org` を選択 → プロジェクト名 `aone-photo`
3. ビルド設定:
   | 項目 | 値 |
   |---|---|
   | ルートディレクトリ | `photo-sales/app` |
   | ビルドコマンド | `npm ci && npm run build` |
   | デプロイコマンド | `npx wrangler deploy` |
   | 本番ブランチ | 動作確認のあいだは `claude/a-one-circuit-photo-sales-8w5cgu` (マージ後に `main`) |
   | ビルド監視パス | `photo-sales/**` |
4. 保存してデプロイ → `https://aone-photo.<あなたのサブドメイン>.workers.dev` ができる
   * aone の Worker とは別プロジェクト。aone 側の設定・ビルドは変わりません
   * この時点では D1 の ID が未反映だと失敗します (手順 1 のあとに私が反映してから行います)

## 5. メール送信 (ログインリンク用)
1. Resend (aone で使っているアカウント) → **API Keys → Create API Key** → 権限は **Sending access のみ**、名前 `aone-photo`
   * 表示されたキーは**その場で Cloudflare に貼る**。チャット・メモ・GitHub には書かない (一度しか表示されません)
2. Cloudflare → Worker `aone-photo` → **設定 → 変数とシークレット → 追加**
   | 種類 | 名前 | 値 |
   |---|---|---|
   | **シークレット** | `RESEND_API_KEY` | (Resend のキー) |
   | **シークレット** | `MAIL_FROM_ADDRESS` | Resend で認証済みのドメインのアドレス (例 `photo@rk-a1.com`) |
3. 保存 → デプロイ (再デプロイ) を実行
* Resend 無料プランは 1 日 100 通 (aone と共有)。ログインメールは少量なので問題ありません
* ★ シークレット型にしておくと、デプロイしても消えません

## 6. 動作確認
1. `https://aone-photo.<サブドメイン>.workers.dev/api/health` が `{"ok":true,...}` を返す
2. iPhone の Safari で `/admin/login` → 手順 2 のメールアドレスを入力 → 届いたメールのリンクをタップ → 「ログインする」
3. `docs/DEVICE_CHECK.md` のチェックリストへ

## 7. S1: 無料枠の CPU 10ms の実測 (実機テストのあとに)
1. 実機テスト (団体登録 → 写真アップロード → お客様ページ・テレビ・管理画面) のあと、Worker `aone-photo` → **メトリクス (Metrics)** を開く
2. **CPU 時間 (CPU Time)** の p50 / p99 と、**エラー** に「Exceeded CPU Limit (1102)」が無いかを確認 → 数値かスクリーンショットを私に見せてください
3. p99 が 10ms 未満ならそのまま無料枠で運用。超える場合は**有料プランの前に処理の見直し**を行い、費用と理由を報告してから相談します
