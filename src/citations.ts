/** The heading text of the section that contains `index` in career.md, or "" before any heading. */
export function sectionForChar(career: string, index: number): string {
  let section = "";
  for (const m of career.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    if (m.index > index) break;
    section = m[1].trim();
  }
  return section;
}
