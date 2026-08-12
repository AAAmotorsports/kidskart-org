-- =========================================================================
-- 0022_slots_weather_structured.sql
-- -------------------------------------------------------------------------
-- 0020 で追加した自由記述 weather_note に加えて、集計で使える構造化フィールドを追加。
--
--   weather_condition: 5 択のプルダウン値
--   temperature_c    : 気温 (int, °C)
--
-- これで /admin/sales で「雨の日を除外」フィルタが可能になる。
-- weather_note は自由メモとして残す (「強風あり」「路面ウェット」等)。
-- =========================================================================

alter table slots
  add column if not exists weather_condition text
    check (weather_condition in ('sunny', 'cloudy', 'cloudy_then_rain', 'rain', 'rain_then_cloudy', 'other')),
  add column if not exists temperature_c integer
    check (temperature_c between -20 and 50);

create index if not exists idx_slots_weather_condition
  on slots(weather_condition)
  where weather_condition is not null;

comment on column slots.weather_condition is
  '天候 (5 択): sunny/cloudy/cloudy_then_rain/rain/rain_then_cloudy/other';
comment on column slots.temperature_c is
  '気温 °C (int)';
