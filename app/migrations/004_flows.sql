-- Flows, as things with names.
--
-- A flow existed only as an id repeated across three tables: `published_flows`
-- recorded versions of it, `endpoints` pointed at it, and `runs` recorded which
-- one they belonged to. Nothing said what it *was*, so an editor could not
-- offer a list to choose from and there was in practice exactly one flow, whose
-- id was a constant in the server.
--
-- One webhook endpoint per flow is the shape, enforced below rather than left
-- as a convention: two endpoints feeding one flow would make "which endpoint
-- does this flow receive on" ambiguous, and the editor asks exactly that
-- question every time it shows a trigger.

CREATE TABLE IF NOT EXISTS flows (
  flow_id     uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL,

  -- What a person calls it. Not unique: two flows may reasonably share a name
  -- while someone works out which is which, and refusing the second one would
  -- be a strange place to enforce tidiness.
  name        text        NOT NULL CHECK (length(trim(name)) > 0),

  archived_at timestamptz(3),
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);

-- The editor's flow list, and the only query this table exists to serve.
CREATE INDEX IF NOT EXISTS flows_by_tenant ON flows (tenant_id, created_at);

-- One endpoint per flow. A partial index rather than a plain unique constraint,
-- so a disabled endpoint can be left in place for its history while a
-- replacement takes over.
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_one_per_flow
  ON endpoints (flow_id)
  WHERE disabled_at IS NULL;

-- Adopt whatever already exists.
--
-- Flows were created by publishing, before this table existed, so their ids are
-- in published_flows and endpoints and nowhere else. Naming them "Flow" plus a
-- fragment of the id is deliberately unhelpful-looking: it is a prompt to
-- rename, not an attempt to guess what someone meant.
INSERT INTO flows (flow_id, tenant_id, name)
SELECT DISTINCT ON (flow_id)
       flow_id,
       tenant_id,
       'Flow ' || left(flow_id::text, 8)
  FROM published_flows
 WHERE NOT EXISTS (SELECT 1 FROM flows f WHERE f.flow_id = published_flows.flow_id)
ON CONFLICT (flow_id) DO NOTHING;

INSERT INTO flows (flow_id, tenant_id, name)
SELECT DISTINCT ON (flow_id)
       flow_id,
       tenant_id,
       'Flow ' || left(flow_id::text, 8)
  FROM endpoints
 WHERE NOT EXISTS (SELECT 1 FROM flows f WHERE f.flow_id = endpoints.flow_id)
ON CONFLICT (flow_id) DO NOTHING;
