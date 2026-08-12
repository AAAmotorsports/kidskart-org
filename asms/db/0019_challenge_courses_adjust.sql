-- =========================================================================
-- 0019_challenge_courses_adjust.sql
-- -------------------------------------------------------------------------
-- チャレンジクラスの記載修正:
--   - トヨピー: description の「ミニカートから」→「ミニサーキットから」
--     (実運用の表現に合わせる)
--   - Rotax: default_capacity 8 → 3 (実際は 3 名までしか同時走行しない)
--     description の「定員 8 名」も「定員 3 名」に更新
--
-- 注意: default_capacity 変更は「以降生成される schedule_rules 由来の
-- スロット」にのみ効く。既存の slots 行 (capacity カラムを個別に持つ)
-- は変わらない。既存 Rotax スロットも定員 3 にしたい場合は /admin/slots
-- で個別に変更するか、下記コメント SQL を追加実行する。
-- =========================================================================

begin;

update courses
   set description = $md$本格的なチャレンジコース。
トヨピーカート (レンタル) を使用、ミニサーキットから 1 段階ステップアップした
お子様向け。165 分・定員 8 名。要スタッフ承認。$md$::text
 where code = 'challenge_ts';

update courses
   set default_capacity = 3,
       description = $md$Rotax Micro カート使用のチャレンジコース。
本格的なレーシングカートを体験できます。165 分・定員 3 名。要スタッフ承認。$md$::text
 where code = 'challenge_rx';

-- 必要なら既存 Rotax スロットも 3 に揃える (今はコメントアウト):
-- update slots s
--    set capacity = 3
--   from courses c
--  where s.course_id = c.id
--    and c.code = 'challenge_rx'
--    and s.capacity <> 3;

commit;
