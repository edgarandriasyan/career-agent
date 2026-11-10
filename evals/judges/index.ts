import { J0_RUBRIC } from "./rubric";
import type { JudgeSpec } from "./spec";

/** Every judge spec by id; the id is also its validation/status.json key. E14 adds one per judged mode. */
export const JUDGES: Record<string, JudgeSpec> = { [J0_RUBRIC.id]: J0_RUBRIC };
