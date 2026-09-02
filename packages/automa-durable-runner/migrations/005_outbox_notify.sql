-- Wake the relay when work arrives, instead of asking constantly.
--
-- Polling alone forces a bad trade: poll often and most queries find nothing
-- while the database pays for every one; poll rarely and every step waits out
-- the interval, so a five-step run takes five poll intervals to finish.
--
-- LISTEN/NOTIFY removes the trade for the common case. The catch is that
-- NOTIFY is delivered only to sessions connected *at the time*, and is not
-- persisted — a listener that is reconnecting misses it entirely, with nothing
-- anywhere to say so. So the poll stays, as a floor rather than the mechanism.
-- Notify for latency, poll for correctness.
--
-- The payload carries the tenant so a per-tenant worker can ignore other
-- tenants' wakeups. It deliberately does not carry the row: NOTIFY payloads are
-- capped at 8000 bytes, and a relay that trusted the payload would skip the
-- claim, which is where the SKIP LOCKED guarantee lives.

CREATE OR REPLACE FUNCTION notify_outbox() RETURNS trigger AS $$
BEGIN
  -- Only fire for work that is due now. A retry scheduled for ten minutes
  -- hence would otherwise wake every worker immediately, to find nothing.
  IF NEW.available_at <= now() THEN
    PERFORM pg_notify('outbox', COALESCE(NEW.tenant_id::text, ''));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_notify
  AFTER INSERT ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION notify_outbox();

COMMENT ON FUNCTION notify_outbox() IS
  'Wakes listening relays. Notification is a latency optimisation only — NOTIFY is not persisted and is lost on a disconnected listener, so the poll floor is what makes delivery correct.';
