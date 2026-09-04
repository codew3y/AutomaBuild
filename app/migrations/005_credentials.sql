-- Credentials: a tenant's own API keys, stored once and used by every flow.
--
-- The `secret` column holds AES-256-GCM ciphertext, never a key. See
-- src/credentials.ts for the format and for why the encryption key lives in
-- the environment rather than here — the ciphertext and the key have to be
-- stealable separately or the encryption achieves nothing.
--
-- Nothing in this table is safe to log or to return over HTTP except the
-- columns that are not the secret. There is deliberately no endpoint that
-- reads it back.

CREATE TABLE IF NOT EXISTS credentials (
  credential_id uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,

  -- What a person calls it in the picker: "my groq key", "team openai".
  name          text NOT NULL,

  -- Which provider it is for, so a step offers only the credentials that
  -- could possibly work in it. Free text rather than an enum: a provider list
  -- that needs a migration to grow is a provider list that stops growing.
  provider      text NOT NULL,

  -- Ciphertext. `v1:<nonce>:<tag>:<ciphertext>`, base64url.
  secret        text NOT NULL,

  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  last_used_at  timestamptz(3),

  -- Soft delete, so a flow still pointing at it fails with a message naming
  -- the credential rather than with a row that silently disappeared.
  deleted_at    timestamptz(3)
);

-- One name per provider per tenant. Two credentials called "my groq key"
-- would be indistinguishable in a picker, which is the only place a name is
-- ever used.
--
-- Partial, so a deleted name can be used again: someone who removes a
-- credential and adds it back should not be told the name is taken by
-- something they cannot see.
CREATE UNIQUE INDEX IF NOT EXISTS credentials_tenant_provider_name
  ON credentials (tenant_id, provider, lower(name))
  WHERE deleted_at IS NULL;

-- The listing query: every credential a tenant can pick from.
CREATE INDEX IF NOT EXISTS credentials_tenant_live
  ON credentials (tenant_id, provider, name)
  WHERE deleted_at IS NULL;
