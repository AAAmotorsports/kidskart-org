# Cloudflare 側の準備手順 (管理画面での操作)

既存の aone とは**別の Worker / D1 / R2** を作ります。aone の既存リソースは触りません。
画面の名称は Cloudflare の更新で多少変わることがあります。迷ったら画面の名前を教えてください。

## 1. D1 データベースを作る
1. https://dash.cloudflare.com にログイン → 左メニュー **ストレージとデータベース (Storage & databases) → D1 SQL データベース**
2. **データベースを作成** → 名前 `aone-photo`、場所は「自動」のままでよい → 作成
3. 作成後の画面に出る **データベース ID** (`xxxxxxxx-xxxx-...`) を控える → 私に伝えるか `app/wrangler.jsonc` の `REPLACE_WITH_D1_ID` に貼る (ID は秘密ではありません)
4. 同じ画面の **コンソール** タブを開き、`photo-sales/app/migrations/0001_init.sql` の中身を**全部貼り付けて実行**
   * 失敗するときは PC の端末で: `cd photo-sales/app && npx wrangler login && npx wrangler d1 migrations apply aone-photo --remote`
5. 最初のスタッフ (管理者) を登録: コンソールで次を実行 (メールアドレスは小文字で)
   ```sql
   INSERT INTO staff_users(email, name, role) VALUES ('あなたのメール@example.com', '管理者', 'admin');
   ```
   以降のスタッフは、ログイン後の「スタッフ」画面から追加できます。

## 2. R2 バケットを作る (3 つ)
1. 左メニュー **R2 オブジェクト ストレージ** (初回はクレジットカード登録を求められます。無料枠内なら請求は 0 円。既に登録済みなら不要)
2. **バケットを作成** を 3 回: `aone-photo-originals` / `aone-photo-previews` / `aone-photo-backups`
   * 場所は「自動」、ストレージクラスは「Standard」
   * **公開アクセスは有効にしない** (「パブリック アクセス」「r2.dev サブドメイン」はオフのまま)

## 3. Worker を作ってデプロイ (GitHub 連携)
1. **コンピューティング (Workers & Pages) → 作成 → Workers → Git を使ってインポート (Import a repository)**
2. GitHub の `aaamotorsports/kidskart-org` を選択 → プロジェクト名 `aone-photo`
3. ビルド設定:
   | 項目 | 値 |
   |---|---|
   | ルートディレクトリ | `photo-sales/app` |
   | ビルドコマンド | `npm ci && npm run build` |
   | デプロイコマンド | `npx wrangler deploy` |
   | 本番ブランチ | 動作確認のあいだは `claude/a-one-circuit-photo-sales-8w5cgu` (マージ後に `main` へ) |
4. 保存してデプロイ → 完了すると `https://aone-photo.<あなたのサブドメイン>.workers.dev` ができます
   * これは aone の Worker (別プロジェクト) には影響しません。`photo-sales/` 以外の変更では再ビルドされないよう、ビルドの監視パスも `photo-sales/**` にしてください

## 4. 変数とシークレット (Worker → 設定 → 変数とシークレット)
| 種類 | 名前 | 値 |
|---|---|---|
| シークレット | `RESEND_API_KEY` | Resend で新しく作る API キー (送信権限のみ)。aone のキーは使い回さない |
| 変数 | `MAIL_FROM_ADDRESS` | Resend で認証済みドメインのアドレス (例 `photo@rk-a1.com`) |
| 変数 | `MAIL_FROM_NAME` | `A-ONE CIRCUIT フォト` |
* ★ 無料プランの Resend は **1 日 100 通** (aone と共有)。ログインメールは少量なので問題ありません
* ★ `wrangler.jsonc` の `vars` に値を書いた場合、デプロイのたびにダッシュボードの値が上書きされます。**変数はファイル側に書く**か、ダッシュボードだけで管理するかのどちらかに統一してください (aone で起きた事故と同じ)

## 5. 動作確認
1. `https://aone-photo.<サブドメイン>.workers.dev/api/health` が `{"ok":true,...}` を返す
2. `/admin/login` を iPhone の Safari で開き、メールアドレスを入力 → 届いたメールのリンクを開く → 「ログインする」
3. 以降は `docs/DEVICE_CHECK.md` のチェックリストへ

## 6. S1: 無料枠の CPU 10ms の実測 (最初にやる)
1. 上の 5-2 のあと、団体を登録 → 写真を 20 枚アップロード → お客様ページ・テレビ・管理画面を一通り開く
2. Worker → **メトリクス (Metrics)** の **CPU 時間 (CPU Time)** で p50 / p99 を確認
   * `エラー` 欄に **「Exceeded CPU Limit」(エラー 1102)** が出ていないこと
   * 全ページの p99 CPU が 10ms 未満なら無料枠で運用可
3. 超えるものがあれば、**有料プランに変える前に** 処理の見直し (キャッシュ・クエリ・レンダリング削減) を行い、結果を報告します。
   有料プランへの変更は、費用と理由を報告してご承認いただくまで行いません。
