CREATE TYPE "TokenTransactionType" AS ENUM ('CHARGE', 'GRANT');

ALTER TABLE "User"
ADD COLUMN "tokenBalance" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TokenTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "administeredBy" TEXT,
    "paperId" TEXT,
    "type" "TokenTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TokenTransaction_paperId_key" ON "TokenTransaction"("paperId");
CREATE UNIQUE INDEX "TokenTransaction_idempotencyKey_key" ON "TokenTransaction"("idempotencyKey");
CREATE INDEX "TokenTransaction_userId_createdAt_idx" ON "TokenTransaction"("userId", "createdAt");

ALTER TABLE "TokenTransaction"
ADD CONSTRAINT "TokenTransaction_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TokenTransaction"
ADD CONSTRAINT "TokenTransaction_administeredBy_fkey"
FOREIGN KEY ("administeredBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TokenTransaction"
ADD CONSTRAINT "TokenTransaction_paperId_fkey"
FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE SET NULL ON UPDATE CASCADE;
