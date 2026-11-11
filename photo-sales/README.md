# photo-sales — A-ONE CIRCUIT 走行写真販売

レンタルカート利用者向けの走行写真オンライン販売システム。既存の予約システム (`aone/`) とは独立。

| ディレクトリ | 内容 |
|---|---|
| `DESIGN.md` | 設計・費用提案書 (v2: オーナー承認条件を反映) |
| `docs/SCREENS.md` | 画面構成・URL 設計 (M0 確定版) |
| `db/archive-supabase/` | 旧案 (Supabase/PostgreSQL)。保守しない |
| `docs/INFRA_D1.md` | 固定費 0 円構成・無料枠・バックアップ・比較・移行 |
| `docs/CLOUDFLARE_SETUP.md` | Cloudflare 管理画面での準備手順 (D1 / R2 / デプロイ / S1 実測) |
| `docs/DEVICE_CHECK.md` | M3 実機確認チェックリスト |
| `app/` | Astro + Cloudflare Workers アプリ |
| `CLAUDE.md` | 恒久指針 |

## 開発環境の立ち上げ
```
cd photo-sales/app
npm install
npm test                       # DB・ロジック・画像処理部品のテスト (20 項目)
npx wrangler d1 migrations apply aone-photo --local   # ローカル D1 にスキーマ適用
npx wrangler d1 execute aone-photo --local --command "INSERT INTO staff_users(email,name,role) VALUES ('you@example.com','管理者','admin')"
npm run build && npx wrangler dev   # ローカルで本番ビルドを動かす (開発時はログインリンクが wrangler のログに出る)
npm run typecheck && npm run build
npm run dev                    # /api/health で疎通確認 (D1/R2 は wrangler のローカルエミュレーション)
```

## 先に用意するもの (オーナー作業・M1 の実機確認から)
1. Cloudflare (既存アカウント) で D1 `aone-photo` と R2 バケット `aone-photo-originals` / `-previews` / `-backups` を作成
2. (M5 以降) Stripe テストモードの API キー
