BEGIN;

LOCK TABLE employees, pingan_staff, pingan_orders, pingan_collection_runs IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE pingan_employee_identity_migration ON COMMIT DROP AS
  SELECT id AS employee_id, pingan_id FROM employees WHERE pingan_id IS NOT NULL
  UNION
  SELECT id, pingan_login_user_id FROM employees WHERE pingan_login_user_id IS NOT NULL
  UNION
  SELECT employee_id, pingan_staff_id FROM pingan_staff WHERE employee_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pingan_employee_identity_migration WHERE pingan_id !~ '^[0-9]{1,40}$') THEN
    RAISE EXCEPTION 'Invalid PingAn IDs in existing employee mappings';
  END IF;
  IF EXISTS (SELECT 1 FROM pingan_employee_identity_migration GROUP BY employee_id HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM pingan_employee_identity_migration GROUP BY pingan_id HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'Conflicting PingAn employee mappings must be resolved before merging';
  END IF;
END $$;

UPDATE employees AS e
SET pingan_id = m.pingan_id
FROM pingan_employee_identity_migration AS m
WHERE e.id = m.employee_id AND e.pingan_id IS DISTINCT FROM m.pingan_id;

UPDATE pingan_collection_runs AS r
SET collector_display_name = e.pingan_login_display_name
FROM employees AS e
WHERE r.pingan_user_id = e.pingan_login_user_id AND r.collector_display_name IS NULL
  AND e.pingan_login_display_name IS NOT NULL;

UPDATE pingan_orders AS o
SET collector_display_name = e.pingan_login_display_name
FROM employees AS e
WHERE o.pingan_user_id = e.pingan_login_user_id AND o.collector_display_name IS NULL
  AND e.pingan_login_display_name IS NOT NULL;

UPDATE pingan_orders AS o
SET handler_name = s.display_name
FROM pingan_staff AS s
WHERE o.handler_user_id = s.pingan_staff_id AND o.handler_name IS NULL AND s.display_name IS NOT NULL;

UPDATE pingan_orders AS o
SET employee_id = m.employee_id
FROM (
  SELECT DISTINCT h.handler_user_id, e.id AS employee_id
  FROM pingan_orders AS h
  LEFT JOIN employees AS e ON e.pingan_id = h.handler_user_id
  WHERE h.handler_user_id IS NOT NULL
) AS m
WHERE o.handler_user_id = m.handler_user_id AND o.employee_id IS DISTINCT FROM m.employee_id;

ALTER TABLE pingan_orders DROP CONSTRAINT pingan_orders_handler_user_id_fkey;
DROP TABLE pingan_staff;
ALTER TABLE employees DROP COLUMN pingan_login_user_id, DROP COLUMN pingan_login_display_name;

-- Apply employee ID maintenance to orders that were ingested before the handler was mapped.
CREATE FUNCTION sync_pingan_order_employee_id() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.pingan_id IS NOT DISTINCT FROM OLD.pingan_id THEN
      RETURN NEW;
    END IF;
    IF OLD.pingan_id IS NOT NULL THEN
      UPDATE pingan_orders SET employee_id = NULL
      WHERE handler_user_id = OLD.pingan_id AND employee_id IS NOT NULL;
    END IF;
  END IF;
  IF NEW.pingan_id IS NOT NULL THEN
    UPDATE pingan_orders SET employee_id = NEW.id
    WHERE handler_user_id = NEW.pingan_id AND employee_id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER employees_sync_pingan_order_employee
AFTER INSERT OR UPDATE OF pingan_id ON employees
FOR EACH ROW EXECUTE FUNCTION sync_pingan_order_employee_id();

COMMIT;
