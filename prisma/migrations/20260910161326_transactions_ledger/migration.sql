-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE', 'DRAWING');

-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('ADD', 'INCLUSIVE', 'NONE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'E_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'PRE_AUTHORISED', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('ENTRY', 'REVERSAL');

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "kind" "LedgerKind" NOT NULL DEFAULT 'ENTRY',
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "category_id" TEXT,
    "vendor_id" TEXT,
    "client_id" TEXT,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "tax_mode" "TaxMode" NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "tax_label" TEXT NOT NULL,
    "payment_method" "PaymentMethod",
    "reference" TEXT,
    "purpose" TEXT,
    "reverses_id" TEXT,
    "replaces_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_business_id_idx" ON "client"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_business_id_name_key" ON "client"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_reverses_id_key" ON "transaction"("reverses_id");

-- CreateIndex
CREATE INDEX "transaction_business_id_date_idx" ON "transaction"("business_id", "date");

-- CreateIndex
CREATE INDEX "transaction_business_id_type_date_idx" ON "transaction"("business_id", "type", "date");

-- CreateIndex
CREATE INDEX "transaction_category_id_idx" ON "transaction"("category_id");

-- CreateIndex
CREATE INDEX "transaction_vendor_id_idx" ON "transaction"("vendor_id");

-- CreateIndex
CREATE INDEX "transaction_client_id_idx" ON "transaction"("client_id");

-- CreateIndex
CREATE INDEX "idempotency_key_created_at_idx" ON "idempotency_key"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_business_id_key_key" ON "idempotency_key"("business_id", "key");

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
