# kidskart.org

福岡キッズカートアカデミー公式サイト（Vercel 静的配信）

## 構成

- `index.html` — トップページ
- `stories/` — 旧公式ブログ（2013-2019）のアーカイブ。84記事を静的化
- `vercel.json` — Vercel 配信設定
- `DEPLOY.md` — デプロイ・DNS切替手順
- `_backup/` — 元の WordPress エクスポート（**公開対象外**、`.vercelignore` で除外）

## 編集

トップページの本文は `index.html` を直接編集。HTMLとCSS（`<style>` ブロック内）が同居しています。

新しいブログ記事を追加したくなったら、`stories/YYYY/your-slug.html` を作成し、`stories/index.html` のカードリストに追加してください。

## 予約システム

このリポジトリには、静的サイトに加えて 2 つの予約システムが同居しています。

- `asms/` — 福岡キッズカートアカデミーの予約・安全管理システム (ASMS)
- `aone/` — A-ONE サーキットの予約・営業管理システム
  (スポーツ走行 / RP / 貸切 / ナイター / 天候対応 / 顧客フォロー)

それぞれ独立した Supabase プロジェクトと Cloudflare Worker を持ちます。
詳細は各ディレクトリの `README.md` / `CLAUDE.md` を参照してください。

## 関連リンク

- 予約: https://reserva.be/kidskart/reserve
- LINE: @kidskart
- Instagram: @fukuoka_kidskart
- Main Sponsor: 福岡トヨペット株式会社（2016年〜）

## デプロイ

`DEPLOY.md` 参照。
