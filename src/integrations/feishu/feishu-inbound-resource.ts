import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { IncomingChatMessage } from "../../domain/types.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function imageExtension(headers: unknown): string {
  const contentType =
    headers && typeof headers === "object"
      ? String((headers as Record<string, unknown>)["content-type"] ?? "")
      : "";

  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".png";
}

export class FeishuInboundResourceDownloader {
  constructor(
    private readonly client: Lark.Client,
    private readonly inboundDir: string,
    private readonly logger: LoggerLike
  ) {}

  async download(message: IncomingChatMessage): Promise<IncomingChatMessage> {
    if (!message.attachments?.length) {
      return message;
    }

    const messageDir = join(this.inboundDir, safeSegment(message.messageId));
    await mkdir(messageDir, { recursive: true });

    const attachments = [];
    for (const attachment of message.attachments) {
      const resource = await this.client.im.v1.messageResource.get({
        params: { type: attachment.kind },
        path: {
          message_id: message.messageId,
          file_key: attachment.key
        }
      });
      const path = join(
        messageDir,
        `${safeSegment(attachment.key)}${imageExtension(resource.headers)}`
      );
      await resource.writeFile(path);
      attachments.push({ ...attachment, path });
      this.logger.info(
        {
          messageId: message.messageId,
          kind: attachment.kind,
          path
        },
        "飞书入站资源已下载"
      );
    }

    return { ...message, attachments };
  }
}
