import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db";

async function main() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? "System administrator";
  if (!email || !password || password.length > 72) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (maximum 72 characters) before seeding");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      WITH admin_bootstrap_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(741852, 1)
      )
      SELECT 1 FROM admin_bootstrap_lock
    `;
    const existingAdmin = await transaction.user.findFirst({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    if (existingAdmin) {
      throw new Error("An administrator already exists; refusing to create or change an administrator");
    }

    const existingUser = await transaction.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      throw new Error("This email already belongs to an account; refusing to promote or change it");
    }

    await transaction.user.create({
      data: { email, name, passwordHash, role: "ADMIN", mustChangePassword: true },
    });
  });
}

main().finally(() => prisma.$disconnect());