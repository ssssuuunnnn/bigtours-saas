-- 正式的收費級距（PRD 第 13 章）。之前只由本機示範資料建立，正式環境沒有級距就無法開通額度與試玩活動。
-- 低於 200 人 $500；200～1,000 人 $1,000；之後每 500 人加 $500，最高 5,000 人。
INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount)
SELECT lo, hi, price FROM (
  VALUES (1, 199, 500), (200, 1000, 1000)
  UNION ALL
  SELECT 1001 + 500 * n, 1500 + 500 * n, 1500 + 500 * n FROM generate_series(0, 7) AS n
) AS t(lo, hi, price)
ON CONFLICT (min_travelers, max_travelers) DO NOTHING;
