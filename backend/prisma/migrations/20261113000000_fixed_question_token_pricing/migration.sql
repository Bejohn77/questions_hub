ALTER TABLE "TokenTransaction"
ADD COLUMN "questionId" TEXT;

CREATE UNIQUE INDEX "TokenTransaction_questionId_key" ON "TokenTransaction"("questionId");

ALTER TABLE "TokenTransaction"
ADD CONSTRAINT "TokenTransaction_questionId_fkey"
FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;
