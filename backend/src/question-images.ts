import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

type QuestionImageClient = Pick<Prisma.TransactionClient, "questionImage">;

export async function attachOwnedQuestionImages(
  content: unknown,
  ownerId: string,
  questionId: string,
  client: QuestionImageClient = prisma,
) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return;
  const imageContent = content as Record<string, unknown>;
  const imageUrls = [
    ...(typeof imageContent.imageUrl === "string" ? [imageContent.imageUrl] : []),
    ...(Array.isArray(imageContent.imageUrls)
      ? imageContent.imageUrls.filter((url): url is string => typeof url === "string")
      : []),
  ];
  const matches = imageUrls.flatMap((imageUrl) =>
    [...imageUrl.matchAll(/\/api\/uploads\/images\/([a-zA-Z0-9_-]+)/g)]);
  const ids = [...new Set(matches.map((match) => match[1]))];
  if (!ids.length) return;
  const updated = await client.questionImage.updateMany({
    where: { id: { in: ids }, ownerId, OR: [{ questionId: null }, { questionId }] },
    data: { questionId },
  });
  if (updated.count !== ids.length) {
    throw Object.assign(new Error("An attached image is unavailable or belongs to another account"), { status: 400 });
  }
}
