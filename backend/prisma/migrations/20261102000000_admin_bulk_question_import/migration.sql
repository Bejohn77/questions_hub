CREATE TYPE "AcademicEntryType" AS ENUM ('CLASS', 'GROUP', 'SUBJECT', 'CHAPTER', 'TOPIC', 'DIVISION');

CREATE TABLE "QuestionImage" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "questionId" TEXT,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuestionImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionImport" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "questionType" "QuestionType" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QuestionImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminActivity" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AcademicEntry" (
    "id" TEXT NOT NULL,
    "type" "AcademicEntryType" NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AcademicEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuestionImage_questionId_idx" ON "QuestionImage"("questionId");
CREATE INDEX "QuestionImage_ownerId_createdAt_idx" ON "QuestionImage"("ownerId", "createdAt");
CREATE INDEX "QuestionImport_adminId_createdAt_idx" ON "QuestionImport"("adminId", "createdAt");
CREATE INDEX "QuestionImport_status_createdAt_idx" ON "QuestionImport"("status", "createdAt");
CREATE INDEX "AdminActivity_adminId_createdAt_idx" ON "AdminActivity"("adminId", "createdAt");
CREATE INDEX "AcademicEntry_type_parentId_name_idx" ON "AcademicEntry"("type", "parentId", "name");
CREATE UNIQUE INDEX "AcademicEntry_type_name_parentId_key" ON "AcademicEntry"("type", "name", "parentId");

ALTER TABLE "QuestionImage" ADD CONSTRAINT "QuestionImage_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionImage" ADD CONSTRAINT "QuestionImage_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionImport" ADD CONSTRAINT "QuestionImport_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminActivity" ADD CONSTRAINT "AdminActivity_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademicEntry" ADD CONSTRAINT "AcademicEntry_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "AcademicEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
