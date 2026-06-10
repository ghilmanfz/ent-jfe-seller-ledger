-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('OrderCreated', 'PaymentProcessing', 'PaymentConfirmed', 'PaymentFailed', 'FeeCalculated', 'OrderShipped', 'OrderDelivered', 'OrderRefunded', 'SettlementProcessed');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('order_balance', 'order_pending', 'payment_received', 'fees_owed', 'seller_payout');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'bank_transfer', 'wallet');

-- CreateTable
CREATE TABLE "event_log" (
    "id" UUID NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" "EventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL,
    "order_id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "debit" DECIMAL(18,4),
    "credit" DECIMAL(18,4),
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_projection" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "fee_amount" DECIMAL(18,4),
    "payout_amount" DECIMAL(18,4),
    "status" "OrderStatus" NOT NULL,
    "version" INTEGER NOT NULL,
    "stripe_charge_id" TEXT,
    "settlement_id" TEXT,
    "settled_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "order_count" INTEGER NOT NULL,
    "total_gross" DECIMAL(18,4) NOT NULL,
    "total_fees" DECIMAL(18,4) NOT NULL,
    "total_payout" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_log_idempotency_key_key" ON "event_log"("idempotency_key");

-- CreateIndex
CREATE INDEX "event_log_event_type_idx" ON "event_log"("event_type");

-- CreateIndex
CREATE INDEX "event_log_timestamp_idx" ON "event_log"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "event_log_aggregate_id_version_key" ON "event_log"("aggregate_id", "version");

-- CreateIndex
CREATE INDEX "ledger_entry_order_id_timestamp_idx" ON "ledger_entry"("order_id", "timestamp");

-- CreateIndex
CREATE INDEX "ledger_entry_event_id_idx" ON "ledger_entry"("event_id");

-- CreateIndex
CREATE INDEX "ledger_entry_account_idx" ON "ledger_entry"("account");

-- CreateIndex
CREATE INDEX "order_projection_status_idx" ON "order_projection"("status");

-- CreateIndex
CREATE INDEX "order_projection_settlement_id_idx" ON "order_projection"("settlement_id");

-- CreateIndex
CREATE INDEX "order_projection_customer_id_idx" ON "order_projection"("customer_id");

-- CreateIndex
CREATE INDEX "order_projection_paid_at_idx" ON "order_projection"("paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_date_key" ON "settlement"("date");

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order_projection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_projection" ADD CONSTRAINT "order_projection_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Financial integrity constraints (beyond what Prisma can express)
-- ============================================================================

-- Double-entry discipline: every ledger row is EXACTLY one of debit/credit,
-- and the amount on the populated side is strictly positive.
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_debit_xor_credit"
  CHECK (("debit" IS NULL) <> ("credit" IS NULL));
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_debit_positive"
  CHECK ("debit" IS NULL OR "debit" > 0);
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_credit_positive"
  CHECK ("credit" IS NULL OR "credit" > 0);

-- Event versions are 1-based and dense per aggregate.
ALTER TABLE "event_log"
  ADD CONSTRAINT "event_log_version_positive"
  CHECK ("version" >= 1);

-- ============================================================================
-- Append-only enforcement: history can never be rewritten, even by buggy code
-- or an ad-hoc SQL session. (TRUNCATE remains possible for dev/test resets;
-- production roles simply are not granted TRUNCATE.)
-- ============================================================================
CREATE OR REPLACE FUNCTION raise_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_append_only
  BEFORE UPDATE OR DELETE ON "event_log"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
