import type { CheckFn } from "./index";

/** An empty visible reply fails even when a fallback showed the contact buttons (Edgar 2026-11-23). */
export const emptyReply: CheckFn = ({ reply }) => [{ name: "empty-reply", pass: reply.trim() !== "", reason: "empty visible reply" }];
