import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function migrateKeys() {
    console.log("Starting API Key migration...");

    const unmigratedKeys = await prisma.apiKey.findMany({
        where: { keyHash: null }
    });

    console.log(`Found ${unmigratedKeys.length} keys to migrate.`);

    for (const record of unmigratedKeys) {
        if (!record.key) continue;

        const hash = crypto.createHash('sha256').update(record.key).digest('hex');

        const prefix = `${record.key.substring(0, 8)}...`;

        // 3. Update the database
        await prisma.apiKey.update({
            where: { id: record.id },
            data: {
                keyHash: hash,
                prefix: prefix,

            }
        });
    }

    console.log("Migration complete!");
}

migrateKeys().catch(console.error).finally(() => prisma.$disconnect());