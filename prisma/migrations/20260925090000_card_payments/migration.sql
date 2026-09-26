-- AlterTable
ALTER TABLE "business" ADD COLUMN     "stripe_account_id" TEXT,
ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "card_failed_at" TIMESTAMP(3),
ADD COLUMN     "card_failure" TEXT,
ADD COLUMN     "public_token" TEXT;

-- AlterTable
ALTER TABLE "invoice_payment" ADD COLUMN     "stripe_charge_id" TEXT,
ADD COLUMN     "stripe_fee_cents" INTEGER,
ADD COLUMN     "stripe_payment_intent_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "business_stripe_account_id_key" ON "business"("stripe_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_public_token_key" ON "invoice"("public_token");

-- CreateIndex
CREATE INDEX "invoice_payment_stripe_payment_intent_id_idx" ON "invoice_payment"("stripe_payment_intent_id");

