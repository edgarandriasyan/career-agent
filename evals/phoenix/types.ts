import type { asEvaluator, runExperiment, RunExperimentParams } from "@arizeai/phoenix-client/experiments";

/* @arizeai/phoenix-client 7.18.2 exports these types only from its unexported src/types; derive them from the exported functions. */
export type { RunExperimentParams };
export type Example = Parameters<RunExperimentParams["task"]>[0];
export type RanExperiment = Awaited<ReturnType<typeof runExperiment>>;
export type ExperimentRun = RanExperiment["runs"][string];
export type Evaluator = ReturnType<typeof asEvaluator>;
export type EvaluationResult = Awaited<ReturnType<Evaluator["evaluate"]>>;
export type Logger = NonNullable<RunExperimentParams["logger"]>;
