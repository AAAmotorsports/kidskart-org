-- =========================================================================
-- 0018_courses_rich_descriptions.sql
-- -------------------------------------------------------------------------
-- 各コースの description を予約前情報として使える内容に拡充。
-- 予約カレンダーの詳細展開でお客様が「何をやるコースか」を判断できる。
-- Reserva の詳細ページに書いてあった内容をベースに整理。
-- =========================================================================

begin;

update courses set description = $md$アクセル・ブレーキ・ハンドル操作の基礎を学びます (保護者同伴)。
広場でスラローム走行→上手にできるようになったらミニサーキットへ。
集合時間は開始 15 分前。$md$::text
 where code = 'taiken';

update courses set description = $md$4 ヒート走行。
サーキット走行に慣れてきた 2 回目以降のお子様向け。
サーキットのルール・マナー・ラインどりを覚えます。$md$::text
 where code = 'repeat_60';

update courses set description = $md$2 ヒート走行。
短時間でしっかり走りたい 2 回目以降のお子様向け。$md$::text
 where code = 'repeat_30';

update courses set description = $md$本格的なチャレンジコース。
トヨピーカート (レンタル) を使用、ミニカートから 1 段階ステップアップした
お子様向け。165 分・定員 8 名。要スタッフ承認。$md$::text
 where code = 'challenge_ts';

update courses set description = $md$Rotax Micro カート使用のチャレンジコース。
本格的なレーシングカートを体験できます。165 分・定員 8 名。要スタッフ承認。$md$::text
 where code = 'challenge_rx';

commit;
