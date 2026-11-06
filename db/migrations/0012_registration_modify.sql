-- 修改已送出的報名：保留的是與原報名的差額，所以可能是 0 位；同時記錄已付金額才能顯示差額。
ALTER TABLE seat_holds
  DROP CONSTRAINT seat_holds_quantity_check,
  ADD CONSTRAINT seat_holds_quantity_check CHECK (quantity >= 0),
  ADD COLUMN modifies_registration_id uuid,
  ADD CONSTRAINT seat_holds_modifies_fk FOREIGN KEY (agency_id, modifies_registration_id) REFERENCES registrations(agency_id, id);

ALTER TABLE registrations ADD COLUMN paid_amount int CHECK (paid_amount >= 0);
UPDATE registrations SET paid_amount = self_pay_amount WHERE payment_status = 'paid';
