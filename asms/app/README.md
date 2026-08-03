# ASMS App

Astro (SSR) + Cloudflare Pages + Supabase の予約・安全管理システム本体。

## ローカル開発

```bash
cd asms/app
npm install
cp ../.env.example .env.local
# .env.local に Supabase の URL / anon / service キーを入れる
npm run dev
```

→ http://localhost:4321 で起動。

## デプロイ（Cloudflare Pages）

このリポジトリを Cloudflare Pages に接続すれば自動デプロイ。

- **Framework preset**: Astro
- **Build command**: `npm install && npm run build`
- **Build output directory**: `dist`
- **Root directory (advanced)**: `asms/app`
- **Environment variables**: `../.env.example` の必須項目を全て設定

## ページ

- `/` — 起動確認用ランディング（Supabase 疎通チェック表示）
- `/reserve/` — 予約フロー（Step 1: 開催日一覧）※ Phase 1 実装中

## 次にやること

計画書 v0.2.2 の Phase 1 実装リスト参照 → https://claude.ai/code/artifact/e21e8b91-d167-4d6d-ada8-c32804a645c1
