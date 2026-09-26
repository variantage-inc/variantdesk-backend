-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
