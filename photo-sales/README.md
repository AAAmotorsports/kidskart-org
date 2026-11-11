# photo-sales — A-ONE CIRCUIT 走行写真販売

レンタルカート利用者向けの走行写真オンライン販売システム。既存の予約システム (`aone/`) とは独立。

| ディレクトリ | 内容 |
|---|---|
| `DESIGN.md` | 設計・費用提案書 (v2: オーナー承認条件を反映) |
| `docs/SCREENS.md` | 画面構成・URL 設計 (M0 確定版) |
| `db/archive-supabase/` | 旧案 (Supabase/PostgreSQL)。保守しない |
| `docs/INFRA_D1.md` | 固定費 0 円構成・無料枠・バックアップ・比較・移行 |
| `app/` | Astro + Cloudflare Workers アプリ |
| `CLAUDE.md` | 恒久指針 |

## 開発環境の立ち上げ
```
cd photo-sales/app
npm install
npm test                       # DB・ロジックのテスト (11 項目)
npm run typecheck && npm run build
npm run dev                    # /api/health で疎通確認 (D1/R2 は wrangler のローカルエミュレーション)
```

## 先に用意するもの (オーナー作業・M1 の実機確認から)
1. Cloudflare (既存アカウント) で D1 `aone-photo` と R2 バケット `aone-photo-originals` / `-previews` / `-backups` を作成
2. (M5 以降) Stripe テストモードの API キー
