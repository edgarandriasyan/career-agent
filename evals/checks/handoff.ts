import type { AgentEvent } from "../../src/types";

/*
 * Handoff detection, shared by the handoff, false-refusal and contacts-out-of-scope checks. A reply
 * hands off when the agent sent a fallback event (the page shows the contact buttons) or the reply
 * text sends the visitor to Edgar or the contact buttons (pointsToEdgar). A bare mention of "contact"
 * in another sense does not count.
 */

const HANDOFF = new RegExp(
  [
    String.raw`ask (edgar|him)`,
    String.raw`(contact|reach|message|email|write to) (out to )?(edgar|him)`,
    String.raw`contact (buttons?|options)`,
    String.raw`get in touch`,
    String.raw`(talk|speak) (to|with) edgar`,
    String.raw`edgar directly`,
    String.raw`directly (with|to) edgar`,
    String.raw`gmail|whatsapp|telegram`,
    "спросит\\S*\\s+(у\\s+)?эдгар",
    "свяж\\S*",
    "напиш\\S*\\s+эдгар",
    "кнопк\\S*\\s+(контакт|связ)",
    "контактн\\S*\\s+кнопк",
    "напрямую\\s+(у|к|с)\\s+эдгар|эдгар\\S*\\s+напрямую",
  ].join("|"),
  "i",
);

/** The reply text sends the visitor to Edgar or the contact buttons. */
export const pointsToEdgar = (reply: string): boolean => HANDOFF.test(reply);

export const handedOff = (reply: string, events: AgentEvent[]): boolean =>
  events.some((e) => e.type === "fallback") || pointsToEdgar(reply);
