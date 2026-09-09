import * as Lark from "@larksuiteoapi/node-sdk";

import type { Env } from "../../config/env.js";
import type { IncomingCardAction, IncomingChatMessage } from "../../domain/types.js";
import { dirname, join } from "node:path";

import { FeishuInboundResourceDownloader } from "./feishu-inbound-resource.js";
import { createFeishuOpenApiClient, createFeishuWsClient } from "./feishu-openapi-client.js";
import {
  parseFeishuMessageEventResult,
  summarizeFeishuPayload
} from "./parse-feishu-message.js";
import { parseFeishuCardAction } from "./parse-feishu-card-action.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface FeishuWsSubscriberParams {
  env: Env;
  onMessage: (message: IncomingChatMessage) => void;
  onCardAction?: (action: IncomingCardAction) => boolean;
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
      },
      "card.action.trigger": async (data: unknown) => {
        const parsed = parseFeishuCardAction(data);
        if (!parsed.ok) {
          this.params.logger.warn(
            {
              reason: parsed.reason,
              payloadShape: summarizeFeishuPayload(data)
            },
            "忽略无法解析的飞书卡片事件"
          );
          return {
            toast: {
              type: "warning",
              content: "未能识别这次操作，请重新发送“模型”。"
            }
          };
        }

        const accepted = this.params.onCardAction?.(parsed.action) ?? false;
        this.params.logger.info(
          {
            chatId: parsed.action.chatId,
            messageId: parsed.action.messageId,
            operatorOpenId: parsed.action.operatorOpenId,
            actionKind: parsed.action.value.kind,
            accepted
          },
          "收到飞书卡片操作"
        );
        return {
          toast: {
            type: accepted ? "success" : "warning",
            content: accepted ? "已收到，正在切换。" : "操作已过期或无权限，请重新发送“模型”。"
          }
        };
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
