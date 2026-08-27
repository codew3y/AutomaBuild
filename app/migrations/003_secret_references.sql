-- Turn stored secrets into references.
--
-- The column held signing secrets as plaintext. It worked, and it meant that a
-- database backup, a read replica, a support dump or a careless `SELECT *` all
-- carried live credentials — none of which are places anyone decided to put
-- them.
--
-- A stored value is now a reference: `env:NAME`, `file:/path`, or
-- `literal:value`. The application resolves it on read, so the database records
-- *where* a secret lives rather than what it is. That is deliberately not
-- encryption-at-rest with a key in an environment variable, which moves the
-- secret one step and calls it solved — the key sits next to the thing it
-- protects, and a dump that has the row usually has the environment too.
--
-- Existing rows are relabelled rather than rewritten. Their values are already
-- plaintext, and this migration cannot know which environment variable they
-- ought to have come from; inventing one would break every endpoint on the next
-- restart. Marking them `literal:` keeps them working and makes them visible —
-- the application reports a literal secret as "stored in the database in
-- plaintext" wherever it describes an endpoint, which is what turns a silent
-- problem into one somebody fixes.
--
-- To find what still needs moving:
--
--   SELECT endpoint_id FROM endpoints
--    WHERE EXISTS (SELECT 1 FROM unnest(secrets) s WHERE s LIKE 'literal:%');

UPDATE endpoints
   SET secrets = (
     SELECT array_agg(
       CASE
         WHEN entry LIKE 'env:%' OR entry LIKE 'file:%' OR entry LIKE 'literal:%'
           THEN entry
         ELSE 'literal:' || entry
       END
       ORDER BY ordinality
     )
     FROM unnest(secrets) WITH ORDINALITY AS t(entry, ordinality)
   )
 WHERE EXISTS (
   SELECT 1 FROM unnest(secrets) AS entry
    WHERE entry NOT LIKE 'env:%'
      AND entry NOT LIKE 'file:%'
      AND entry NOT LIKE 'literal:%'
 );
