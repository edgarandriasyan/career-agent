import { expect, test } from "vitest";
import { generateCareer } from "./generate-career";

test("keeps public, strips tag", () => expect(generateCareer("# A\n<!-- visibility: public -->\nx\n")).toBe("# A\nx\n"));
test("untagged is private", () => expect(generateCareer("# A\nx\n")).toBe(""));
test("untagged child of public is private", () =>
  expect(generateCareer("# A\n<!-- visibility: public -->\nx\n## B\ny\n")).toBe("# A\nx\n"));
test("private child removed", () =>
  expect(generateCareer("# A\n<!-- visibility: public -->\nx\n## B\n<!-- visibility: private -->\ny\n")).toBe("# A\nx\n"));
test("unknown tag throws", () => expect(() => generateCareer("# A\n<!-- visibility: maybe -->\n")).toThrow());
test("public under non-public parent throws", () =>
  expect(() => generateCareer("# A\nx\n## B\n<!-- visibility: public -->\ny\n")).toThrow());
test("text before the first heading is dropped", () => expect(generateCareer("x\n")).toBe(""));
test("headings inside code fences are ignored", () =>
  expect(generateCareer("# A\n<!-- visibility: public -->\n```\n# not a heading\n```\n")).toBe("# A\n```\n# not a heading\n```\n"));
test("public child of public parent is kept", () =>
  expect(generateCareer("# A\n<!-- visibility: public -->\nx\n## B\n<!-- visibility: public -->\ny\n")).toBe("# A\nx\n## B\ny\n"));
test("private section drops its subtree, later sibling kept", () =>
  expect(generateCareer("# A\n<!-- visibility: private -->\n## B\ny\n# C\n<!-- visibility: public -->\nz\n")).toBe("# C\nz\n"));
test("public under private parent throws", () =>
  expect(() => generateCareer("# A\n<!-- visibility: private -->\n## B\n<!-- visibility: public -->\ny\n")).toThrow());
