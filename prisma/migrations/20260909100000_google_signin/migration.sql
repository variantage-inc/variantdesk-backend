-- Google sign in.
--
-- password_hash becomes nullable because an account created through Google has
-- no password. The two are not exclusive: a Google user can set a password
-- later, and a password user can link Google.
--
-- google_id stores Google's subject id rather than the email. A Google email
-- can change or be reassigned to a different person; the subject id cannot,
-- so matching on email alone would eventually hand one person another
-- person's books.

ALTER TABLE "user" ALTER COLUMN "password_hash" DROP NOT NULL;

ALTER TABLE "user" ADD COLUMN "google_id" TEXT;
ALTER TABLE "user" ADD COLUMN "avatar_url" TEXT;

CREATE UNIQUE INDEX "user_google_id_key" ON "user"("google_id");
