-- "Keep me signed in" needs somewhere to live.
--
-- Existing sessions were all created with the long lifetime, so true is the
-- correct backfill: it describes what they already are rather than changing
-- anyone's session underneath them.

ALTER TABLE "session" ADD COLUMN "remembered" BOOLEAN NOT NULL DEFAULT true;
