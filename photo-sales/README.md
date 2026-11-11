# photo-sales — A-ONE CIRCUIT 走行写真販売

レンタルカート利用者向けの走行写真オンライン販売システム。既存の予約システム (`aone/`) とは独立。

| ディレクトリ | 内容 |
|---|---|
| `DESIGN.md` | 設計・費用提案書 (v2: オーナー承認条件を反映) |
| `docs/SCREENS.md` | 画面構成・URL 設計 (M0 確定版) |
| `db/` | Supabase 用 SQL と DB テスト |
| `app/` | Astro + Cloudflare Workers アプリ |
| `CLAUDE.md` | 恒久指針 |

## 開発環境の立ち上げ
```
cd photo-sales/app
npm install
cp .env.example .env.local     # Supabase の値を入れる (新規プロジェクト)
npm run dev                    # http://localhost:4321 /api/health で疎通確認
npm run typecheck && npm run build
```

## 先に用意するもの (オーナー作業)
1. Supabase の新規プロジェクト (無料プラン)。SQL Editor で `db/0001_initial_schema.sql` を実行
2. Cloudflare R2 バケット: `aone-photo-originals` (非公開) / `aone-photo-previews`
3. (M5 以降) Stripe テストモードの API キー
