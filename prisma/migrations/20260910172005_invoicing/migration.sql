-- CreateEnum
CREATE TYPE "DiscountMode" AS ENUM ('AMOUNT', 'PERCENT');

-- AlterTable
ALTER TABLE "client" ADD COLUMN     "address_line1" TEXT,
ADD COLUMN     "address_line2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "payment_terms_days" INTEGER,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "province" TEXT;

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "number_value" INTEGER NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "seller_name" TEXT NOT NULL,
    "seller_address" TEXT,
    "seller_email" TEXT,
    "seller_phone" TEXT,
    "gst_hst_number" TEXT,
    "bill_to_name" TEXT NOT NULL,
    "bill_to_contact" TEXT,
    "bill_to_address" TEXT,
    "invoice_terms" TEXT,
    "invoice_footer" TEXT,
    "invoice_pay_to" TEXT,
    "subtotal_cents" INTEGER NOT NULL,
    "discount_mode" "DiscountMode" NOT NULL DEFAULT 'AMOUNT',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "charge_tax" BOOLEAN NOT NULL DEFAULT true,
    "tax_rate_bp" INTEGER NOT NULL,
    "tax_label" TEXT NOT NULL,
    "notes" TEXT,
    "sent_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_item" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity_milli" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "line_total_cents" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payment" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "PaymentMethod",
    "reference" TEXT,
    "transaction_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_business_id_issue_date_idx" ON "invoice"("business_id", "issue_date");

-- CreateIndex
CREATE INDEX "invoice_client_id_idx" ON "invoice"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_business_id_number_value_key" ON "invoice"("business_id", "number_value");

-- CreateIndex
CREATE INDEX "invoice_item_invoice_id_idx" ON "invoice_item"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payment_transaction_id_key" ON "invoice_payment"("transaction_id");

-- CreateIndex
CREATE INDEX "invoice_payment_invoice_id_idx" ON "invoice_payment"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_payment_business_id_idx" ON "invoice_payment"("business_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment" ADD CONSTRAINT "invoice_payment_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment" ADD CONSTRAINT "invoice_payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment" ADD CONSTRAINT "invoice_payment_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
