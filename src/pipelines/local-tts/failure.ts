/** A former fail() exit: the entry reports it, while breathing keeps its files. */
export class RunnerFailure extends Error {}

/** A check could not execute: abort the run, rather than re-synthesize a take. */
export class TakeCheckError extends RunnerFailure {}
