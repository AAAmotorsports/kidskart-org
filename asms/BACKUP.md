# ASMS Database Backup / Restore Runbook

Supabase を Free プランで運用しているあいだ、公式の自動バックアップは
実質使えないので、GitHub Actions cron で毎日 `pg_dump` を取って
**Cloudflare R2** にオフサイト保存する運用にしている。

**この文書の目的**: 何かあったときに (a) バックアップが取れているか、
(b) どうやって復元するか、を迷わず実行できるようにすること。

---

## 全体構成

```
Supabase (本番 DB)
   │
   │ 毎日 03:00 JST に pg_dump
   │
   ▼
GitHub Actions: .github/workflows/asms-db-backup.yml
   │
   │ AWS CLI で S3 互換 API 経由
   │
   ▼
Cloudflare R2 バケット: kidskartasmsbuckup
   ├── daily/asms-YYYYMMDD.dump      ← 90 日で lifecycle 自動削除
   └── monthly/asms-YYYY-MM.dump     ← 月初 (day=01) にコピー、無期限保存
```

---

## 初回セットアップ (1 回だけ)

### 1. Cloudflare R2 バケット作成

Cloudflare Dashboard → R2 → **Create bucket**:
- 名前: `kidskartasmsbuckup` (現行バケット名。ハイフンなし、`buckup` の
  綴りも意図せずそのまま定着したもの。新規プロジェクトなら
  `kidskart-asms-backup` 等のわかりやすい名前を推奨)
- Location: `Automatic` or `Asia-Pacific`
- **公開しない** (Public URL は絶対に発行しない、機密データなので)

### 2. R2 API トークン発行

Cloudflare Dashboard → R2 → **Manage R2 API Tokens** → Create API Token:
- 名前: `asms-backup-writer`
- Permissions: **Object Read & Write**
- Specify bucket: `kidskartasmsbuckup` のみ
- TTL: `Forever` (定期ローテするなら 1 年でも可)

発行された `Access Key ID`, `Secret Access Key`, `Endpoint` (URL) をメモ。
**このシークレットは 1 回しか表示されない**ので、必ず 1Password などに保管。

### 3. Lifecycle Rules 設定 (daily の 90 日自動削除)

Cloudflare Dashboard → R2 → バケット → Settings → **Object lifecycle rules**:
- Rule name: `expire-daily-after-90d`
- Prefix: `daily/`
- Action: `Delete objects after`
- Days: `90`

`monthly/` プレフィックスにはルールを付けない (無期限保存)。

### 4. Supabase 直接接続 URL 取得

Supabase Dashboard → プロジェクト → **Settings → Database**:
- **Connection string** タブ → **URI**
- **Session mode (pooler)** ではなく **Direct connection** を選ぶ
  (pg_dump は pooler と相性が悪いため)
- URL は `postgres://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres` 形式

### 5. GitHub Actions Secrets 登録

GitHub → repo → Settings → Secrets and variables → **Actions** → **New repository secret**:

| Secret 名 | 値 |
|-----------|---|
| `SUPABASE_DB_URL` | 上記 4. で取得した URL |
| `R2_ACCESS_KEY_ID` | 上記 2. で発行 |
| `R2_SECRET_ACCESS_KEY` | 上記 2. で発行 |
| `R2_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | `kidskartasmsbuckup` |
| `RESEND_API_KEY` | 既に他 workflow で使ってる値と同じ |
| `MAIL_FROM_ADDRESS` | 既存 (通常 `noreply@kidskart.org`) |
| `MAIL_ADMIN_TO` | 既存 (通常 `info@kidskart.org`) |

### 6. 手動テスト実行

Actions タブ → **ASMS DB Backup** → **Run workflow** → main → **Run**

成功したら R2 のバケットに `daily/asms-YYYYMMDD.dump` ができているか確認。

---

## 日常運用

- 毎日 03:00 JST に自動実行 (GitHub Actions cron の性質上、数時間の遅延あり)
- 失敗するとメール (info@kidskart.org) に通知が飛ぶ
- 通知が来たら Actions ログを見て原因対応 (大抵は Secret 失効か Supabase 側の一時障害)

**日常監視は /admin パネルから**:

管理画面トップに「💾 バックアップの動作状況」パネルを追加済み
(2026-08-30〜)。Cloudflare Workers から R2 バケットを直接 list し、
以下を可視化:

- 最新 dump の取得時刻とサイズ (30h 超で黄、48h 超で赤)
- 直近 daily/ の履歴 (10 件、日付とサイズを一覧)
- monthly/ の最新月

`BACKUP_BUCKET` (R2 binding) が wrangler.jsonc に定義されていれば
自動で表示。Cloudflare Dashboard を開かなくても管理画面から
「取れてる/取れてない」がわかる。

**追加の月次目視 (パネルで足りない部分)**:
- Storage 使用量は 1 GB 未満 (無料枠 10 GB) に収まっているか
  → Cloudflare Dashboard → R2 → バケット詳細で確認

---

## 復元手順 (壊れたときはこれを見る)

### ケース A: ローカル環境 or 別 Supabase プロジェクトに復元

1. **R2 から dump ファイルをダウンロード**
   ```bash
   aws s3 cp \
     s3://kidskartasmsbuckup/daily/asms-YYYYMMDD.dump \
     ./restore.dump \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```
   (認証情報は R2 API トークンから)

2. **復元先の DB を用意**
   - ローカル: `createdb asms_restore`
   - 別 Supabase: 新規プロジェクト作成 → Direct connection URL 取得

3. **pg_restore で復元**
   ```bash
   pg_restore \
     --dbname="$RESTORE_DB_URL" \
     --no-owner \
     --no-acl \
     --clean --if-exists \
     ./restore.dump
   ```

4. **動作確認**: `SELECT count(*) FROM reservations;` などで件数を確認

### ケース B: 本番 Supabase を過去の状態に上書き戻し (超危険)

**原則やらない**。まず必ず「別プロジェクトに復元 → 差分確認 → 本番切替」の
順で作業する。本番に直接 `pg_restore` を叩くと現データ全消しの可能性あり。

やむなくやる場合:
1. **必ず現状の pg_dump を先に取る** (これから壊すかもしれないので)
2. Supabase Dashboard で「Pause project」して書き込みを止める
3. 復元コマンド実行 (`--clean --if-exists` 付き)
4. 動作確認後、Cloudflare Workers 側の DB 接続を維持したまま再開

### ケース C: 電子署名だけ取り出したい (事故対応・保険請求)

`consents` テーブルに base64 で入っている `signature_data_url` が
現時点 (2026-08) の署名保管方法。以下で取り出せる:

```bash
pg_restore --data-only --table=consents ./restore.dump | psql "$LOCAL_DB_URL"
# その後 SELECT で取り出して base64 decode
```

---

## 復元テスト (四半期に 1 回、必ず)

**「取れてる」だけじゃなくて「本当に復元できる」ことを定期的に確認する**。

四半期ごと (例: 3/31, 6/30, 9/30, 12/31):

1. 直近 daily の dump を R2 からダウンロード
2. ローカル PostgreSQL に `pg_restore` で復元
3. 主要テーブル (`reservations`, `guardians`, `customers`, `consents`) の
   件数と最新レコードを目視確認
4. 電子署名 1 件を base64 decode → PNG として画像表示できるか確認
5. **結果を CLAUDE.md のバックアップ運用ログに記録**

---

## 将来の拡張

### Supabase Pro に昇格した場合
- Pro の Daily Backup (7 日保持) が使えるようになるので、日常運用は Pro 側で。
- **ただしオフサイト backup (この R2 運用) は残す**。
  Supabase 障害 (アカウント凍結・データセンター障害) で Pro 側もろとも
  失うリスクをゼロにするため。

### PITR (Point-in-Time Recovery) が欲しくなった場合
- Pro + PITR add-on (約 $100/month)。
- 「昨日の 14:23 の状態に戻したい」レベルの粒度が必要になったら検討。
- キッズカート規模では当面不要。

### 電子署名を R2 に移した場合 (Phase 2 予定)
- `consents.signature_data_url` (base64 TEXT) を廃止して R2 の URL 参照に。
- そのとき、R2 バケット自体にもバージョニング設定を有効化。
- この文書 (BACKUP.md) の「復元」セクションに R2 asset 復元手順を追加。

---

## 変更履歴

- 2026-08-25: 初版。GitHub Actions cron + Cloudflare R2 の運用開始。
