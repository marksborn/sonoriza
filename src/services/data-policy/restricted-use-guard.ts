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
 * Hard boundary for uses that can move Sonoriza-derived data outside the
 * product trust boundary. Gate 3 intentionally has no provider/LLM adapter and
 * no policy override. It only enforces the Gate 2 decision.
 */
export const RESTRICTED_POLICY_USES = ["AI", "EXTERNAL_EXPORT"] as const satisfies readonly PolicyUse[];

export type RestrictedPolicyUse = (typeof RESTRICTED_POLICY_USES)[number];
export type BlockedRestrictedUseDecision = Exclude<PolicyDecision, "ALLOW">;

const restrictedUseAuthorizationBrand = Symbol("RestrictedUseAuthorization");

/**
 * Nominal authorization token. Future AI/export adapters should accept this
 * token rather than raw lineage so authorization cannot be skipped by accident.
 * Only this module can construct a branded value without an unsafe cast.
 */
export type RestrictedUseAuthorization = Readonly<{
  [restrictedUseAuthorizationBrand]: true;
  use: RestrictedPolicyUse;
  lineage: DataLineage;
  decision: "ALLOW";
}>;

export type RestrictedUseEvaluation = Readonly<{
  use: RestrictedPolicyUse;
  lineage: DataLineage;
  decision: PolicyDecision;
}>;

export class RestrictedUsePolicyError extends Error {
  readonly name = "RestrictedUsePolicyError";
  readonly code = "DATA_POLICY_RESTRICTED_USE_BLOCKED";

  constructor(
    readonly use: RestrictedPolicyUse,
    readonly decision: BlockedRestrictedUseDecision,
    readonly lineage: DataLineage,
  ) {
    super(
      `Restricted data use blocked: use=${use} decision=${decision} origins=${lineage.origins.join(",")}`,
    );
  }
}

/**
 * Pure/read-only evaluation. Empty lineage is normalized by Gate 2 to UNKNOWN,
 * which is fail-closed for AI/export.
 */
export function evaluateRestrictedUse(
  lineage: DataLineage,
  use: RestrictedPolicyUse,
): RestrictedUseEvaluation {
  const normalizedLineage = lineageFromOrigins(lineage.origins);

  return Object.freeze({
    use,
    lineage: normalizedLineage,
    decision: policyDecisionForLineage(normalizedLineage, use),
  });
}

/**
 * Hard guard: both DENY and REVIEW_REQUIRED are blocking outcomes. A caller
 * receives a nominal authorization token only when Gate 2 returns ALLOW.
 */
export function authorizeRestrictedUse(
  lineage: DataLineage,
  use: RestrictedPolicyUse,
): RestrictedUseAuthorization {
  const evaluation = evaluateRestrictedUse(lineage, use);

  if (evaluation.decision !== "ALLOW") {
    throw new RestrictedUsePolicyError(
      evaluation.use,
      evaluation.decision,
      evaluation.lineage,
    );
  }

  return Object.freeze({
    [restrictedUseAuthorizationBrand]: true as const,
    use: evaluation.use,
    lineage: evaluation.lineage,
    decision: "ALLOW" as const,
  });
}

/**
 * Side-effect boundary helper. The operation is not invoked unless a valid
 * RestrictedUseAuthorization has first been created.
 *
 * T may itself be a Promise; this helper deliberately does not need a separate
 * async variant.
 */
export function runRestrictedUse<T>(
  lineage: DataLineage,
  use: RestrictedPolicyUse,
  operation: (authorization: RestrictedUseAuthorization) => T,
): T {
  const authorization = authorizeRestrictedUse(lineage, use);
  return operation(authorization);
}
