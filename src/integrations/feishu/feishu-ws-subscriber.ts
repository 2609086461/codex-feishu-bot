import * as Lark from "@larksuiteoapi/node-sdk";

import type { Env } from "../../config/env.js";
import type { IncomingChatMessage } from "../../domain/types.js";
import { dirname, join } from "node:path";

import { FeishuInboundResourceDownloader } from "./feishu-inbound-resource.js";
import { createFeishuOpenApiClient, createFeishuWsClient } from "./feishu-openapi-client.js";
import {
  parseFeishuMessageEventResult,
  summarizeFeishuPayload
} from "./parse-feishu-message.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface FeishuWsSubscriberParams {
  env: Env;
  onMessage: (message: IncomingChatMessage) => void;
  logger: LoggerLike;
}

export class FeishuWsSubscriber {
  private readonly wsClient;
  private readonly eventDispatcher;
  private readonly resourceDownloader;

  constructor(private readonly params: FeishuWsSubscriberParams) {
    this.wsClient = createFeishuWsClient(params.env);
    this.resourceDownloader = new FeishuInboundResourceDownloader(
      createFeishuOpenApiClient(params.env),
      join(dirname(params.env.RUNTIME_STATE_FILE), "inbound"),
      params.logger
    );
    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const parsed = parseFeishuMessageEventResult(data);
        if (!parsed.ok) {
          this.params.logger.warn(
            {
              failure: parsed.failure,
              payloadShape: summarizeFeishuPayload(data)
            },
            "忽略无法解析的飞书消息事件"
          );
          return;
        }

        let message = parsed.message;
        try {
          message = await this.resourceDownloader.download(message);
        } catch (error) {
          this.params.logger.error(
            {
              messageId: message.messageId,
              messageType: message.messageType,
              error: error instanceof Error ? error.message : String(error)
            },
            "下载飞书入站资源失败"
          );
          message = {
            ...message,
            text: `${message.text}\n\n[图片下载失败，请检查飞书 im:resource 权限和资源接口日志。]`
          };
        }

        this.params.logger.info(
          {
            chatId: message.chatId,
            messageId: message.messageId,
            chatType: message.chatType,
            messageType: message.messageType,
            attachmentCount: message.attachments?.length ?? 0,
            textPreview: message.text.slice(0, 120)
          },
          "收到飞书消息事件"
        );
        this.params.onMessage(message);
      }
    });
  }

  async start(): Promise<void> {
    this.params.logger.info("正在建立飞书 WebSocket 长连接");
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher
    });
    this.params.logger.info("飞书 WebSocket 长连接已启动");
  }

  async close(): Promise<void> {
    this.wsClient.close();
    this.params.logger.info("飞书 WebSocket 长连接已关闭");
  }
}
