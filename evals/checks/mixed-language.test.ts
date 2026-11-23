import { expect, test } from "vitest";
import { mixedLanguage } from "./mixed-language";

const run = (question: string, reply: string) =>
  mixedLanguage({ c: { id: "x", category: "recruiter", question }, question, reply, events: [], career: "", model: "m", latencyMs: { firstSentence: null, total: 0 } })[0];
const RU_Q = "Какими языками владеет Эдгар?";

test("mixed-language passes the run A reply of rec-16 (Sonnet)", () => {
  expect(run(RU_Q, "Эдгар владеет английским (свободно), русским (свободно) и армянским (родной). Немецким он не владеет.").pass).toBe(true);
});

test("mixed-language fails the run A reply of rec-16 (Haiku)", () => {
  expect(run(RU_Q, "Эдгар владеет английским (свободно), русским (свободно) и армянским (родной). Edgar does not speak German.")).toMatchObject({
    name: "mixed-language", pass: false, reason: "Russian reply contains an English sentence",
  });
});

test("mixed-language borderline: a Russian reply naming a degree, university and dates in English passes (Edgar left run A Sonnet syn-facts-08 unnoted)", () => {
  expect(run(RU_Q, "Образование: BBA, American University of Armenia, 2013 to 2017, с дополнительной специализацией (minor) Politics, Philosophy and Economics.").pass).toBe(true);
});

test("mixed-language allows titles, products and URLs in a Russian reply", () => {
  expect(run(RU_Q, "Эдгар был Senior Product Manager, AI в Moonfare и строил proof of concept на AWS Bedrock: https://example.com/a-demo-of-the-tool-in-use").pass).toBe(true);
});

test("mixed-language fails a Russian sentence in an English reply", () => {
  expect(run("Which languages does Edgar speak?", "Edgar speaks English, Russian and Armenian. Немецким он не владеет и это не указано.").pass).toBe(false);
});

test("mixed-language borderline: English titles and product phrases with for, on or in pass in a Russian reply (review E12 I3)", () => {
  // The title as the bot writes it in the run A Sonnet reply of syn-fit-09.
  expect(run(RU_Q, "В VMware он был Senior Technical Product Manager for vRealize Operations.").pass).toBe(true);
  expect(run(RU_Q, "Он построил self-serve analytics on AWS Bedrock для Moonfare.").pass).toBe(true);
  expect(run(RU_Q, "У него BBA с minor in Politics, Philosophy and Economics.").pass).toBe(true);
});

test("mixed-language still fails a meta line in English inside a Russian reply", () => {
  expect(run(RU_Q, "Visitor wrote in Russian, so I reply in Russian. Эдгар владеет английским.").pass).toBe(false);
});
