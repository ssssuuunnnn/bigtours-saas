-- 梯次的航班與時間，供員工選梯次時比較。沒有搭機的行程可留空航班。
-- 時間是當地時間，不做時區換算。
ALTER TABLE event_sessions
  ADD COLUMN outbound_flight_no  text,
  ADD COLUMN return_flight_no    text,
  ADD COLUMN departure_time      time,
  ADD COLUMN return_arrival_time time;
