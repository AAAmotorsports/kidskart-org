# AAA Motor Sports Webエコシステム — 全体統括 CLAUDE.md

最終更新: 2026-09-30（統括セッション）
**このリポジトリは public。** 契約金額・給与・個人情報・スポンサー条件はここに書かない。

> ここに書いたことは「2026-09-30 時点でリポジトリとDNSを実地確認した事実」。
> 過去の HANDOFF / プロトタイプHTML / 記憶と食い違ったら **本番リポジトリ > このファイル > それ以外** の順で信じる。
> 個別システムの設計判断は `asms/CLAUDE.md`（キッズ予約）と `aone/CLAUDE.md`（A-ONE予約）が正。

---

## 1. サイト一覧（本番の正）

| サイト | 役割 | リポジトリ (AAAmotorsports/) | ホスティング | DNS | GA4 |
|---|---|---|---|---|---|
| kidskart.org | 親向け集客LP＋旧ブログ `/stories/` | `kidskart-org`（ルート） | GitHub Pages | Cloudflare | G-W3HB0DT0Y3 |
| reserve.kidskart.org | ASMS（キッズ予約・カルテ・会計） | `kidskart-org` `/asms/` | Cloudflare Workers + Supabase | Cloudflare | G-W3HB0DT0Y3（kidskart.orgと同一ストリーム） |
| aaa-ms.com | チーム本体・ハブ・スポンサー営業 | `aaa-ms.com` | GitHub Pages | Xserver | G-7KPHBPVDLW |
| events.aaa-ms.com | 法人イベント営業LP | `events-aaa-ms` | GitHub Pages | Xserver | G-7KPHBPVDLW |
| jobs.aaa-ms.com | 採用 | `jobs-aaa-ms` | GitHub Pages | Xserver | G-7KPHBPVDLW |
| arataendo.com | 遠藤新太 個人サイト | `arataendo` | GitHub Pages | Cloudflare | **なし**（`noindex,nofollow`） |
| reserve.rk-a1.com | A-ONEサーキット予約 | `kidskart-org` `/aone/` | Cloudflare Workers（ASMSとDB別） | Cloudflare | **空**（`PUBLIC_GA4_MEASUREMENT_ID: ""`） |
| rk-a1.com | A-ONEサーキット公式 | —（WordPress） | WordPress | Cloudflare | 未確認 |

- **Vercel は使っていない**（`DEPLOY.md` の Vercel 手順は移行初期の旧記述。実際は `CNAME` による GitHub Pages）。
- 旧予約 RESERVA（reserva.be/kidskart）は撤廃方向。kidskart.org の予約導線はすべて `https://reserve.kidskart.org/reserve/` に切替済み。
- 予約URLの流入元計測: `?ref=xxx`（英数と `_.-`、60文字以内、小文字）→ `reservations.referral_code`。

## 2. 計測（GA4）の現状と方針

- GA4は **2つの測定IDで稼働中**（HANDOFFの「GA4未整備」は古い）。
  - `G-W3HB0DT0Y3`: kidskart.org ＋ reserve.kidskart.org。`cookie_domain: 'kidskart.org'` でLP→予約が1セッションでつながる。
  - `G-7KPHBPVDLW`: aaa-ms.com / events / jobs の3ホストで1ストリーム共有。分析はホスト名で切る。
- kidskart.org は 2026-05-12 の WP→静的移行で GA タグが抜け、**2026-08-25 まで約3.5ヶ月計測空白**。前年比較はこの期間を除外する。
- 実装済みイベント（ASMS）: `booking_complete`（予約完了・最重要CV、承認待ちは送らない、予約ID単位で重複防止）、`repeat_book_click`。
- 未実装: kidskart.org の予約ボタンクリック、aaa/events/jobs の mailto・LINE・応募クリック、arataendo 全般、A-ONE予約全般。
- **方針: 「1プロパティ6ストリーム」への作り直しはしない。** 既存IDを維持し、足りないイベントを足す。ストリームを変えると過去データが切れる。

## 3. Search Console（外部から確認できた範囲・2026-09-30）

| ドメイン | 所有権確認 | sitemap | 備考 |
|---|---|---|---|
| kidskart.org | DNS TXT あり（ドメインプロパティ想定） | 161 URL | Google索引に旧WP URL（`/archives/NNNN`）が残存 |
| aaa-ms.com（events/jobs含む） | DNS TXT あり（Xserver） | 各1 URL | Google索引に旧WP URL（`/30/`, `/racingkart/` 等）が残存。404でリダイレクトなし |
| arataendo.com | なし | なし | noindex。意図的かは要確認 |
| rk-a1.com | なし | 未確認 | |

- kidskart.org は **ドメインプロパティ（sc-domain:kidskart.org）で登録済み**（オーナー画面で確認）。
  - 直近3ヶ月（〜2026-09-29）: クリック608 / 表示1.12万 / CTR 5.4%。
  - 上位クエリ: 福岡キッズカートアカデミー 109/182、ゴーカート 福岡 22/922、キッズカート 12/168、筑紫野 ゴーカート 11/27、ゴーカート 9/617（クリック/表示）。
  - 課題: 指名検索以外のCTRが低い（「ゴーカート 福岡」2.4%、「ゴーカート」1.5%）。
  - sitemap: `https://kidskart.org/sitemap.xml`（2026-05-14送信、161件、成功）＋旧 `http://` 版（2013送信）が残存。
  - インデックス（2026-09時点）: 登録151 / 未登録151。未登録の内訳＝404: 104（旧WPの `/archives/NNNN`）、noindex: 15（旧URLの誘導用スタブ。意図通り）、リダイレクト: 3、クロール済み未登録: 28、検出未登録: 1。
- GSC登録済みプロパティ: `aaa-ms.com`（ドメイン）、`http://aaa-ms.com/`、`kidskart.org`（ドメイン）、`http://kidskart.org/`。
  - events / jobs は aaa-ms.com ドメインプロパティに含まれる。
  - **`events-aaa-ms.com`（未確認）は誤登録**（正しくは events.aaa-ms.com のサブドメイン）。削除してよい。
  - arataendo.com / rk-a1.com は未登録。
- 旧URL対策: kidskart.org の `404.html` は JS の meta refresh で `/stories/` 等へ誘導（ステータスは404のまま）。GitHub Pages は 301 を返せないので、恒久対応は **Cloudflare のリダイレクトルールで 301**（kidskart.org は Cloudflare DNS なので可能）。aaa-ms.com は Xserver DNS のため同じ手は使えない。

## 4. サイト間リンク（設計）

- ハブは aaa-ms.com。kidskart / events / jobs は相互リンク。
- arataendo.com からは他サイトへ営業リンクを張らない（個人ブランドを守る）。

## 5. ブランド・表記ルール

- AAA系（aaa / events / jobs）: 白＋黄 `#FFF200`＋紺 `#2E3092`（濃紺面 `#1E2166`）。jobs はアクセントに温かいオレンジレッド。
- kidskart.org: 空色＋ライム＋サンイエロー、M PLUS Rounded 1c。
- arataendo.com: 黒＋赤。
- A-ONE: 赤 `#FF002A`（AAA系には使わない）。
- 対外表記の起点は **2013年**。メインスポンサーは **福岡トヨペット様（2016〜）**。教室は「福岡トヨペットカート教室」の冠。
- スクール対象: 4歳〜小学6年生・身長100cm以上・保護者同伴。
- **料金の正は ASMS のコースデータ。** LPやプロトタイプの料金を直接の根拠にしない（プロトタイプHTMLの料金は旧い）。
- A-ONE: 〒筑紫野市大字原田1338 / 092-927-1177 / 9:00〜18:00（最終受付17:30・不定休）。

## 6. セッション（担当）分担

| 担当 | 範囲 | 触らない |
|---|---|---|
| 統括 | 全体方針、計測設計、GSC、サイト間整合、このファイル | 各システムの内部実装 |
| ASMS担当 | `kidskart-org/asms/` | 静的LP |
| A-ONE予約担当 | `kidskart-org/aone/` | ASMS（DBもワーカーも別） |
| LP担当 | kidskart.org トップ・aaa・events・jobs・arataendo の HTML | Workers / DNS |

- 別セッションで作業するときも、**GAの測定ID・予約URL・料金**を勝手に変えない。変えるなら統括経由。
- 2026-09 時点の `/home/.../outputs/*-prototype.html`（base64埋め込み版）は**設計時点の旧版**。本番はリポジトリ側。

## 7. 未決事項（オーナー判断待ち）

1. ~~arataendo.com の noindex~~ → **意図的（制作途中の非公開期間）。勝手に外さない。** 公開判断が出たら noindex 削除＋GSC登録＋GA導入をセットで行う
2. 新kidskart.org（新デザイン）は別の Claude Code セッションで制作中（オーナー確認）。GitHub には未push（2026-09-30時点）。本番反映前に統括が GA タグ・canonical・予約URL・404リダイレクトの引き継ぎを確認すること（5/12移行時にGAが抜けた前例あり）
3. GSC の登録状況（オーナーが画面確認）
4. A-ONE予約（reserve.rk-a1.com）に GA を入れるか、入れるならどのIDか
