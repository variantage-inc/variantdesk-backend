-- CreateEnum
CREATE TYPE "VoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISCARDED', 'FAILED');

-- CreateTable
CREATE TABLE "voice_entry" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "status" "VoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "transcript" TEXT NOT NULL,
    "kind" "TransactionType",
    "amount_cents" INTEGER,
    "tax_mode" "TaxMode",
    "party" TEXT,
    "description" TEXT,
    "entry_date" DATE,
    "purpose" TEXT,
    "category_id" TEXT,
    "vendor_id" TEXT,
    "client_id" TEXT,
    "guesses" JSONB,
    "model" TEXT NOT NULL,
    "transaction_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "voice_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_entry_transaction_id_key" ON "voice_entry"("transaction_id");

-- CreateIndex
CREATE INDEX "voice_entry_business_id_status_idx" ON "voice_entry"("business_id", "status");

-- CreateIndex
CREATE INDEX "voice_entry_business_id_created_at_idx" ON "voice_entry"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_entry" ADD CONSTRAINT "voice_entry_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
