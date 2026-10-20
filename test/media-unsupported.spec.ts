/**
 * 媒体消息处理（test/media-unsupported.spec.ts）。
 *
 * 合规约束（COMPLIANCE.md「媒体处理」）：
 *  - 只转发文本；图片/语音/视频/文件/表情一律不转发，也不下载/解码/逆向下发；
 *  - 不静默丢弃：默认向**源会话**回一条提示；
 *  - 提示里不得包含原始消息内容（媒体消息本来就没有正文，但仍要断言不夹带）；
 *  - 目标会话必须是"零发送"。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { endpoint, fakeGateway, incoming, makeConfig, makeForwarder, matrixOf, route, target } from "./fixtures/harness";

const routes = [
  route({
    id: "wx-private-to-qq",
    group: "self-wx-qq",
    from: endpoint("wechat", "wxid_self"),
    to: [target("qq", "10001")],
  }),
];

const MEDIA_CANARY = "MEDIA-BODY-CANARY-7c1d";

test("kind=image 且 replyNotice=true：只向源会话发一条不含原文的提示，状态 skipped_unsupported_kind", async () => {
  const config = makeConfig(routes);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config) });

  const statuses = await forwarder.handle(
    incoming({
      platform: "wechat",
      conversationId: "wxid_self",
      messageId: "img-1",
      kind: "image",
      // 类型层面媒体消息没有正文；这里显式置 null，模拟真实归一化结果
      text: null,
    }),
  );

  assert.deepEqual(statuses, ["skipped_unsupported_kind"]);
  assert.equal(gateway.sent.length, 1, "replyNotice=true 时应且只应发一条回执");

  const notice = gateway.sent[0];
  assert.ok(notice, "应记录到一次发送");
  assert.equal(notice.platform, "wechat", "回执只允许发回源会话");
  assert.equal(notice.conversationId, "wxid_self");
  assert.ok(
    !gateway.sent.some((request) => request.platform === "qq"),
    "合规要求：不支持的类型绝不能向目标会话发送任何内容",
  );

  const noticeText = notice.segments.map((segment) => segment.text).join("");
  assert.ok(noticeText.includes("image"), "回执应说明被跳过的类型");
  assert.ok(!noticeText.includes(MEDIA_CANARY), "回执不得包含任何原始消息内容");
});

test("kind=image 且 replyNotice=false：不发送任何内容，但仍返回 skipped_unsupported_kind", async () => {
  const config = makeConfig(routes, { compliance: { unsupportedMedia: { replyNotice: false } } });
  const gateway = fakeGateway();
  const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config) });

  const statuses = await forwarder.handle(
    incoming({
      platform: "wechat",
      conversationId: "wxid_self",
      messageId: "img-2",
      kind: "image",
      text: null,
    }),
  );

  assert.deepEqual(statuses, ["skipped_unsupported_kind"]);
  assert.equal(gateway.sent.length, 0, "replyNotice=false 时不得发送任何消息（包括提示）");
});

test("kind=video/voice/file 同样零目标发送（媒体白名单只放行 text）", async () => {
  for (const kind of ["video", "voice", "file", "emoji"] as const) {
    const config = makeConfig(routes);
    const gateway = fakeGateway();
    const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config) });

    const statuses = await forwarder.handle(
      incoming({
        platform: "wechat",
        conversationId: "wxid_self",
        messageId: `media-${kind}`,
        kind,
        text: null,
      }),
    );

    assert.deepEqual(statuses, ["skipped_unsupported_kind"], `kind=${kind} 必须被跳过`);
    assert.ok(
      !gateway.sent.some((request) => request.platform === "qq"),
      `kind=${kind} 不得转发到目标会话（只允许源会话回执）`,
    );
  }
});
