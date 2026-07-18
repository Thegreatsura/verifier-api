import { Mistral } from "@mistralai/mistralai";
import fs from "fs";
import { Request, Response } from "express";
import multer from "multer";
import logger from "../utils/logger";
import { verifyTelebirr } from "./verifyTelebirr";
import { verifyCBE } from "./verifyCBE";
import { prisma } from "../utils/prisma";
import dotenv from "dotenv";

dotenv.config();

// ─── Credit refund helper ─────────────────────────────────────────────────────

type ResolvedAccount = { creditHolder: 'workspace'; creditHolderId: string } | undefined;

async function refundCredit(account: ResolvedAccount): Promise<void> {
    if (!account?.creditHolderId) return;
    await prisma.workspace.update({
        where: { id: account.creditHolderId },
        data: { imageCredits: { increment: 1 } },
    });
}

// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({ dest: "uploads/" });

const client = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY!,
});

export const verifyImageHandler = [
    upload.single("file"),

    async (req: Request, res: Response): Promise<void> => {
        // ── Resolve API key identity (set by apiKeyAuth) ──────────────────────
        const apiKeyData = (req as any).apiKeyData as { id: string } | undefined;

        try {
            const autoVerify = req.query.autoVerify === "true";
            const accountSuffix = req.body?.suffix || null;

            // ── 1. File must be present before we consume a credit ────────────
            if (!req.file) {
                logger.warn("No file uploaded");
                res.status(400).json({ error: "No file uploaded" });
                return;
            }

            // ── 2. Atomic credit decrement ────────────────────────────────────
            // Uses updateMany with gt:0 guard so concurrent requests can never
            // overdraft below zero.  If count === 0 the balance was exhausted
            // by a concurrent request since the gate ran — return 402.
            //
            // resolvedAccount is set by verifyImageGate and points at the
            // owning workspace where image credits now live.
            const resolvedAccount = (req as any).resolvedAccount as ResolvedAccount;

            if (resolvedAccount?.creditHolderId) {
                const result = await prisma.workspace.updateMany({
                    where: { id: resolvedAccount.creditHolderId, imageCredits: { gt: 0 } },
                    data: { imageCredits: { decrement: 1 } },
                });
                const decrementCount = result.count;

                if (decrementCount === 0) {
                    if (req.file?.path) fs.unlinkSync(req.file.path);
                    res.status(402).json({
                        error: "Out of image credits. Top up at veritas.et/dashboard/billing",
                        topUp: "https://veritas.et/dashboard/billing",
                    });
                    return;
                }
            }

            // ── 3. Call Mistral Vision ────────────────────────────────────────
            const filePath = req.file.path;
            const imageBuffer = fs.readFileSync(filePath);
            const base64Image = imageBuffer.toString("base64");

            const prompt = `
You are a payment receipt analyzer. Based on the uploaded image, determine:
- If the receipt was issued by Telebirr or the Commercial Bank of Ethiopia (CBE).
- If it's a CBE receipt, extract the transaction ID (usually starts with 'FT').
- If it's a Telebirr receipt, extract the transaction number (usually 10 uppercase alphanumeric characters; CBE Birr receipts also use this format).

Rules:
- CBE receipts usually include a purple header with the title "Commercial Bank of Ethiopia" and a structured table.
- Telebirr receipts are typically green with a large minus sign before the amount.
- CBE receipts may mention Telebirr (as the receiver) but are still CBE receipts.

Return this JSON format exactly, with no extra prose:
{
  "type": "telebirr" | "cbe",
  "transaction_id"?: "FTxxxx" (if CBE),
  "transaction_number"?: "string" (if Telebirr / CBE Birr)
}
            `.trim();

            logger.info("Sending image to Mistral Vision (ministral-14b-2512)...");

            let chatResponse;
            try {
                chatResponse = await client.chat.complete({
                    model: "ministral-14b-2512",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    imageUrl: `data:image/jpeg;base64,${base64Image}`,
                                },
                            ],
                        },
                    ],
                    responseFormat: { type: "json_object" },
                });
            } catch (mistralErr) {
                // Mistral itself is unavailable — refund the credit (not the user's fault)
                logger.error("Mistral API call failed, refunding credit:", mistralErr);
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(503).json({ error: "OCR service temporarily unavailable. Your credit has been refunded." });
                return;
            }

            const rawMessage = chatResponse.choices?.[0]?.message as
                | { content?: string | Array<{ type: string; text?: string }> }
                | undefined;
            const rawContent = rawMessage?.content;

            // The newer Mistral SDK may return content as a string OR as an array
            // of content chunks. Normalize both into a single text string.
            let messageContent: string | null = null;
            if (typeof rawContent === "string") {
                messageContent = rawContent;
            } else if (Array.isArray(rawContent)) {
                messageContent = rawContent
                    .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
                    .map((chunk) => chunk.text as string)
                    .join("\n")
                    .trim();
                if (!messageContent) messageContent = null;
            }

            if (!messageContent) {
                // Unexpected Mistral response — refund (our infrastructure fault)
                logger.error("Invalid Mistral response", { rawContent });
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(500).json({ error: "Invalid OCR response. Your credit has been refunded." });
                return;
            }

            // ── 4. Parse and route result (credit already consumed) ───────────
            const result = JSON.parse(messageContent);
            logger.info("OCR Result", result);

            if (result.type === "telebirr" && result.transaction_number) {
                if (autoVerify) {
                    try {
                        const data = await verifyTelebirr(result.transaction_number);
                        res.json({
                            verified: true,
                            type: "telebirr",
                            reference: result.transaction_number,
                            details: data,
                        });
                    } catch (verifyErr: any) {
                        logger.error("Telebirr verification failed", { verifyErr });
                        if (verifyErr.name === "TelebirrVerificationError") {
                            res.status(502).json({ error: verifyErr.message, details: verifyErr.details });
                        } else {
                            res.status(500).json({ error: "Verification failed for Telebirr" });
                        }
                    }
                } else {
                    res.json({
                        type: "telebirr",
                        reference: result.transaction_number,
                        forward_to: "/verify-telebirr",
                    });
                }
                return;
            }

            if (result.type === "cbe" && result.transaction_id) {
                if (!autoVerify) {
                    res.json({
                        type: "cbe",
                        reference: result.transaction_id,
                        forward_to: "/verify-cbe",
                        accountSuffix: "required_from_user",
                    });
                    return;
                }

                if (!accountSuffix) {
                    res.status(400).json({
                        error: "Account suffix is required for CBE verification in autoVerify mode",
                    });
                    return;
                }

                try {
                    const data = await verifyCBE(result.transaction_id, accountSuffix);
                    res.json({
                        verified: true,
                        type: "cbe",
                        reference: result.transaction_id,
                        details: data,
                    });
                } catch (verifyErr) {
                    logger.error("CBE verification failed", { verifyErr });
                    res.status(500).json({ error: "Verification failed for CBE" });
                }
                return;
            }

            res.status(422).json({ error: "Unknown or unrecognized receipt type" });

        } catch (err) {
            logger.error(
                `Unexpected error in /verify-image: ${err instanceof Error ? err.message : String(err)}`,
                { stack: err instanceof Error ? err.stack : undefined },
            );
            res.status(500).json({ error: "Something went wrong processing the image." });
        } finally {
            if (req.file?.path) {
                try { fs.unlinkSync(req.file.path); } catch { /* already deleted */ }
                logger.debug("Temp file deleted", { path: req.file.path });
            }
        }
    },
];
