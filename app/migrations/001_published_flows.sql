-- Published flow versions.
--
-- Owned by this application, not by either library: the engine stores runs and
-- steps and has no opinion about where a flow definition comes from, and the
-- gate stores deliveries. What a "published flow" is belongs here.
--
-- Every publish inserts a new row rather than updating one. That is the whole
-- point: a run records the flow_version_id it started on, and the worker
-- resolves the definition by that id, so a run already in flight keeps
-- finishing against the version it began with. Updating in place would rewrite
-- history under a run that was still using it.

CREATE TABLE IF NOT EXISTS published_flows (
  -- Matches runs.flow_version_id. Not a foreign key: the two live in
  -- different databases in the default topology, and a constraint that only
  -- sometimes exists is worse than one that never does.
  version_id    uuid        PRIMARY KEY,
  flow_id       uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,

  -- The canvas document, exactly as the editor sent it. Stored rather than the
  -- compiled definition because the editor has to be able to load it back to
  -- show what is live, and recompiling is cheap while decompiling is not
  -- possible.
  graph         jsonb       NOT NULL,

  published_at  timestamptz(3) NOT NULL DEFAULT now(),

  -- Who or what published it. Nullable: the first version is seeded by the
  -- server at startup and has no author.
  published_by  text
);

-- "The current version for this flow" is the newest row, and it is read on
-- every publish and every page load.
CREATE INDEX IF NOT EXISTS published_flows_current
  ON published_flows (tenant_id, flow_id, published_at DESC);
