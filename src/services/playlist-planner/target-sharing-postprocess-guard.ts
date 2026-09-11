import type { PlanRunResult } from "./plan-run";
import type { EffectiveSharingPolicy } from "./target-sharing-shadow";
import {
  findTargetSharingViolations,
  type TargetSharingReservationMap,
  type TargetSharingViolation,
} from "./target-sharing-runtime";

export type TargetSharingPostprocessGuardResult = {
  plan: PlanRunResult;
  abstained: boolean;
  baselineViolations: TargetSharingViolation[];
  candidateViolations: TargetSharingViolation[];
};

export function guardTargetSharingPostprocess(input: {
  baseline: PlanRunResult;
  candidate: PlanRunResult;
  sharingPolicyByTargetId: ReadonlyMap<string, EffectiveSharingPolicy>;
  externalReservationsByUri?: TargetSharingReservationMap;
}): TargetSharingPostprocessGuardResult {
  const candidateViolations = violationsForPlan(
    input.candidate,
    input.sharingPolicyByTargetId,
    input.externalReservationsByUri,
  );

  if (candidateViolations.length === 0) {
    return {
      plan: input.candidate,
      abstained: false,
      baselineViolations: [],
      candidateViolations,
    };
  }

  const baselineViolations = violationsForPlan(
    input.baseline,
    input.sharingPolicyByTargetId,
    input.externalReservationsByUri,
  );

  // O pós-processador é opcional. Se o baseline era válido e somente a
  // transformação posterior introduziu colisões, conserva o baseline.
  if (baselineViolations.length === 0) {
    return {
      plan: input.baseline,
      abstained: true,
      baselineViolations,
      candidateViolations,
    };
  }

  // Não mascara um problema que já existia no plano autoritativo.
  // A validação final continua responsável por bloqueá-lo.
  return {
    plan: input.candidate,
    abstained: false,
    baselineViolations,
    candidateViolations,
  };
}

function violationsForPlan(
  plan: PlanRunResult,
  sharingPolicyByTargetId: ReadonlyMap<string, EffectiveSharingPolicy>,
  externalReservationsByUri?: TargetSharingReservationMap,
): TargetSharingViolation[] {
  return findTargetSharingViolations({
    targets: plan.targets.map((planned) => ({
      targetPlaylistId: planned.targetPlaylistId,
      name: planned.name,
      uris: planned.result.items.map((item) => item.uri),
    })),
    sharingPolicyByTargetId,
    externalReservationsByUri,
  });
}
