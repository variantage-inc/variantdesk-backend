-- Split roles onto two axes.
--   BusinessRole: who you are inside one business
--   PlatformRole: Variantage staff against everyone else, above tenancy
--
-- Written by hand rather than generated. Prisma's generated version drops and
-- recreates the role column, because it cannot tell that OWNER means the same
-- thing in both enums. Converting in place keeps every existing row.

CREATE TYPE "BusinessRole" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "PlatformRole" AS ENUM ('SUPERADMIN', 'CUSTOMER');

ALTER TABLE "user" ALTER COLUMN "role" DROP DEFAULT;

-- OWNER carries over. ACCOUNTANT and STAFF collapse into MEMBER, which is what
-- they were in practice.
ALTER TABLE "user"
  ALTER COLUMN "role" TYPE "BusinessRole"
  USING (CASE "role"::text WHEN 'OWNER' THEN 'OWNER' ELSE 'MEMBER' END)::"BusinessRole";

ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'OWNER';

ALTER TABLE "user"
  ADD COLUMN "platform_role" "PlatformRole" NOT NULL DEFAULT 'CUSTOMER';

DROP TYPE "UserRole";
