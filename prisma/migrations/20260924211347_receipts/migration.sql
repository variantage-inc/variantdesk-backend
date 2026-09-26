-- AlterTable
ALTER TABLE "business" ADD COLUMN     "logo_content_type" TEXT,
ADD COLUMN     "logo_file_name" TEXT,
ADD COLUMN     "logo_size_bytes" INTEGER,
ADD COLUMN     "logo_uploaded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "seller_logo_key" TEXT;

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "transaction_id" TEXT,
    "invoice_id" TEXT,
    "key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_id" TEXT,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- A receipt belongs to exactly one entry or one invoice, never both and never
-- neither. Prisma cannot express this, so it is written here by hand.
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_one_target"
  CHECK (num_nonnulls("transaction_id", "invoice_id") = 1);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_key_key" ON "attachment"("key");

-- CreateIndex
CREATE INDEX "attachment_business_id_deleted_at_idx" ON "attachment"("business_id", "deleted_at");

-- CreateIndex
CREATE INDEX "attachment_transaction_id_idx" ON "attachment"("transaction_id");

-- CreateIndex
CREATE INDEX "attachment_invoice_id_idx" ON "attachment"("invoice_id");

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
