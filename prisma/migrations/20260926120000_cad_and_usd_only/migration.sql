-- AlterEnum
BEGIN;
CREATE TYPE "Currency_new" AS ENUM ('CAD', 'USD');
ALTER TABLE "public"."business" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "business" ALTER COLUMN "currency" TYPE "Currency_new" USING ("currency"::text::"Currency_new");
ALTER TYPE "Currency" RENAME TO "Currency_old";
ALTER TYPE "Currency_new" RENAME TO "Currency";
DROP TYPE "public"."Currency_old";
ALTER TABLE "business" ALTER COLUMN "currency" SET DEFAULT 'CAD';
COMMIT;

