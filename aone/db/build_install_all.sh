#!/bin/sh
# INSTALL_ALL.sql を 0001〜0005 から再生成する。
# 新しいマイグレーションを足したら、このスクリプトの FILES に追記して実行する。
set -eu
cd "$(dirname "$0")"
FILES="0001_initial_schema.sql 0002_seed_holidays.sql 0003_availability_engine.sql 0004_reservation_rpcs.sql 0005_grants_and_rls.sql 0006_category_walkin.sql 0007_sport_no_limited.sql 0008_admin_only_category.sql 0009_prices.sql 0010_calendar_colors_and_rp_names.sql 0011_month_categories.sql 0012_rental_bookings_public.sql 0013_night_rental_only.sql 0014_pricing_and_cancel_policy.sql 0015_callback_tracking.sql"

{
  cat <<'HDR'
-- =============================================================================
-- A-ONE 予約システム v1 — 初回インストール用 (連番マイグレーションを結合)
-- =============================================================================
-- ★ 新規 Supabase プロジェクトへの初回適用専用です。
--    Supabase Dashboard → SQL Editor に全文を貼り付けて Run を 1 回押すだけ。
--
-- ★ 2 回目以降 (運用開始後) は、このファイルではなく db/000N_*.sql を
--    連番で追加していってください。
--
-- このファイルは生成物です。中身を直接編集しないこと。再生成:
--   cd aone/db && ./build_install_all.sh
-- =============================================================================

HDR
  for f in $FILES; do
    echo ""
    echo "-- ###########################################################################"
    echo "-- # $f"
    echo "-- ###########################################################################"
    echo ""
    cat "$f"
  done
} > INSTALL_ALL.sql

echo "INSTALL_ALL.sql を再生成しました ($(wc -l < INSTALL_ALL.sql) 行)"
