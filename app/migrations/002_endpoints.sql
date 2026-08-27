-- Webhook endpoints, and what each one belongs to.
--
-- This is the table that makes the application multi-tenant rather than merely
-- claiming to be. The engine has carried tenant_id on every row and every query
-- since its first migration; what was missing was anything at the edge that
-- could decide *which* tenant an arriving request belonged to. There was one
-- endpoint id in an environment variable, so there was one tenant.
--
-- A delivery names its endpoint in the URL. That endpoint decides the tenant,
-- the flow, and the secrets the signature is checked against — so two tenants
-- can be served by one process without either being able to reach the other's
-- runs, because every query downstream is already scoped by tenant_id.

CREATE TABLE IF NOT EXISTS endpoints (
  endpoint_id   uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  flow_id       uuid        NOT NULL,

  -- Which signature scheme this sender uses. Per endpoint, not per install:
  -- one tenant may receive from Stripe and GitHub at once.
  scheme        text        NOT NULL
                            CHECK (scheme IN ('stripe', 'github', 'slack', 'standard')),

  -- Every currently-valid secret, so rotation is a two-element array and not
  -- an outage. Stored as text: this is a development-grade store, and a
  -- production one belongs in a secret manager with the column holding a
  -- reference rather than the value. Said plainly here because a table called
  -- `secrets` that quietly holds plaintext is how that gets forgotten.
  secrets       text[]      NOT NULL CHECK (cardinality(secrets) > 0),

  -- Off rather than deleted, so a compromised endpoint can be stopped without
  -- losing the run history that explains why.
  disabled_at   timestamptz(3),

  created_at    timestamptz(3) NOT NULL DEFAULT now()
);

-- Every delivery does this lookup, and the API lists a tenant's endpoints.
CREATE INDEX IF NOT EXISTS endpoints_by_tenant ON endpoints (tenant_id, created_at DESC);

-- One flow per endpoint is the current shape; this makes the reverse lookup —
-- "which endpoint feeds this flow" — cheap for the API.
CREATE INDEX IF NOT EXISTS endpoints_by_flow ON endpoints (tenant_id, flow_id);
