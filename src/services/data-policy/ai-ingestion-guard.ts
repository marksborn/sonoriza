import {
  lineageFromOrigins,
  policyDecisionForLineage,
  type DataLineage,
  type PolicyDecision,
  type PolicyUse,
} from "./provenance";

/**
 * SPOTIFY-COMPLIANCE-01 / Gate 3
 *
 * Hard boundary for AI/LLM/Tião Brain ingestion. Gate 3 intentionally has no
 * AI provider adapter and no policy override. It only enforces the Gate 2
 * lineage decision before any future AI-side effect can run.
 */
export const AI_INGESTION_POLICY_USE = "AI" as const satisfies PolicyUse;

export type BlockedAiIngestionDecision = Exclude<PolicyDecision, "ALLOW">;

const aiIngestionAuthorizationBrand = Symbol("AiIngestionAuthorization");

/**
 * Nominal authorization token. Future AI adapters should require this token
 * rather than raw lineage so the policy boundary cannot be skipped by accident.
 * Only this module can construct the branded value without an unsafe cast.
 */
export type AiIngestionAuthorization = Readonly<{
  [aiIngestionAuthorizationBrand]: true;
  use: typeof AI_INGESTION_POLICY_USE;
  lineage: DataLineage;
  decision: "ALLOW";
}>;

export type AiIngestionEvaluation = Readonly<{
  use: typeof AI_INGESTION_POLICY_USE;
  lineage: DataLineage;
  decision: PolicyDecision;
}>;

export class AiIngestionPolicyError extends Error {
  readonly name = "AiIngestionPolicyError";
  readonly code = "DATA_POLICY_AI_INGESTION_BLOCKED";

  constructor(
    readonly decision: BlockedAiIngestionDecision,
    readonly lineage: DataLineage,
  ) {
    super(
      `AI ingestion blocked: decision=${decision} origins=${lineage.origins.join(",")}`,
    );
  }
}

/**
 * Pure/read-only evaluation. Empty lineage is normalized by Gate 2 to UNKNOWN,
 * which is fail-closed for AI.
 */
export function evaluateAiIngestion(lineage: DataLineage): AiIngestionEvaluation {
  const normalizedLineage = lineageFromOrigins(lineage.origins);

  return Object.freeze({
    use: AI_INGESTION_POLICY_USE,
    lineage: normalizedLineage,
    decision: policyDecisionForLineage(normalizedLineage, AI_INGESTION_POLICY_USE),
  });
}

/**
 * Hard guard: both DENY and REVIEW_REQUIRED are blocking outcomes. A caller
 * receives a nominal authorization token only when Gate 2 returns ALLOW.
 */
export function authorizeAiIngestion(lineage: DataLineage): AiIngestionAuthorization {
  const evaluation = evaluateAiIngestion(lineage);

  if (evaluation.decision !== "ALLOW") {
    throw new AiIngestionPolicyError(evaluation.decision, evaluation.lineage);
  }

  return Object.freeze({
    [aiIngestionAuthorizationBrand]: true as const,
    use: AI_INGESTION_POLICY_USE,
    lineage: evaluation.lineage,
    decision: "ALLOW" as const,
  });
}

/**
 * Side-effect boundary helper. The operation is not invoked unless a valid
 * AiIngestionAuthorization has first been created.
 *
 * T may itself be a Promise; no separate async variant is required.
 */
export function runAiIngestion<T>(
  lineage: DataLineage,
  operation: (authorization: AiIngestionAuthorization) => T,
): T {
  const authorization = authorizeAiIngestion(lineage);
  return operation(authorization);
}
