import type { CheckFn } from "./index";

/*
 * A reply in the right language (the lang check) that still contains a sentence in the other one:
 * English in a reply to Russian input, or Russian in a reply to any other input.
 *
 * A "foreign run" is a stretch of consecutive words in the other script (numbers and punctuation keep
 * it going, a home-script word ends it); URLs and email addresses are removed first. A run is a
 * sentence when it has at least MIN_WORDS words and one of the language's function words. Names,
 * titles, product names and company names ("Senior Product Manager, AI", "head of product", "proof of
 * concept", "American University of Armenia, 2013 to 2017") have no such word, so they pass. The
 * English list holds only articles, pronouns and auxiliaries: prepositions and conjunctions ("for",
 * "on", "in", "by", "with", "to", "of", "and") appear in titles, product phrases and date ranges
 * ("Senior Technical Product Manager for vRealize Operations", "analytics on AWS Bedrock").
 */
const MIN_WORDS = 4;
const EN = new Set(["a", "an", "the", "i", "we", "you", "he", "she", "they", "his", "him", "her", "it", "its", "is", "are", "was", "were", "be", "that", "this", "does", "did", "not", "has", "have", "had", "because", "which"]);
const RU = new Set(["и", "в", "во", "на", "не", "что", "он", "его", "это", "с", "по", "для", "о", "об", "был", "была", "было", "как", "но", "а", "из", "к", "у"]);
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const URL_OR_EMAIL = /https?:\/\/\S+|\S+@\S+/g;

/** A question with any Cyrillic word (and no Armenian letter) needs a Russian reply; any other an English one. */
export const wantsRussian = (question: string): boolean =>
  !/\p{Script=Armenian}/u.test(question) && /\p{Script=Cyrillic}{2,}/u.test(question);

function hasForeignSentence(reply: string, foreign: RegExp, home: RegExp, functionWords: Set<string>): boolean {
  let words = 0;
  let functional = false;
  for (const token of reply.replace(URL_OR_EMAIL, " ").split(/\s+/)) {
    if (home.test(token)) {
      words = 0;
      functional = false;
    } else if (foreign.test(token)) {
      words++;
      functional ||= functionWords.has(token.toLowerCase().replace(/[^\p{L}]/gu, ""));
      if (words >= MIN_WORDS && functional) return true;
    }
  }
  return false;
}

export const mixedLanguage: CheckFn = ({ question, reply }) => {
  const ru = wantsRussian(question);
  const mixed = ru ? hasForeignSentence(reply, LATIN, CYRILLIC, EN) : hasForeignSentence(reply, CYRILLIC, LATIN, RU);
  return [{ name: "mixed-language", pass: !mixed, reason: ru ? "Russian reply contains an English sentence" : "reply contains a Russian sentence" }];
};
