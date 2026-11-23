import type { CheckFn } from "./index";
import { pointsToEdgar } from "./handoff";

/**
 * On an offTopic case (the question has nothing to do with Edgar) the reply must not point to Edgar or
 * the contact buttons. Only the reply text counts: a fallback shows the buttons on its own and is
 * scored by empty-reply and truncated-reply. Last turn only (LAST_TURN_ONLY): offTopic describes the
 * case's last question.
 */
export const contactsOutOfScope: CheckFn = ({ c, reply }) =>
  c.offTopic ? [{ name: "contacts-out-of-scope", pass: !pointsToEdgar(reply), reason: "points to the contact buttons on an off-topic request" }] : [];
