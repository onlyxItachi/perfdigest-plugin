// Single source of truth for semantic validation of `perfdigest.hpc-eval-contract.v1`.
// Imported by both `bench/validate.mjs` (runs before `npm run build`) and
// `scripts/evaluate-hpc-workloads.mjs` so validation rules never drift.
import { hpcEvalContractSchema } from './formats.mjs';

export const LOCAL_PATH_LEAK_PATTERNS = [
  /\/home\/[a-zA-Z0-9._-]+/,
  /\/Users\/[a-zA-Z0-9._-]+/,
  /\/root\/[a-zA-Z0-9._-]+/,
  /\/var\/folders\/[a-zA-Z0-9._/-]+/,
  /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[a-zA-Z0-9._-]+/,
  /\/tmp\/[a-zA-Z0-9._-]+/,
];

export const NOOP_VERIFIER_PATTERN = /(?:^|[\s;&|])(?:\/usr)?\/bin\/true(?:\s|$)|^\s*true\s*$/;

/**
 * Validates an already-parsed `perfdigest.hpc-eval-contract.v1` document against both
 * the Zod schema (including per-operator `oracleCheck` refinement) and all semantic
 * integrity invariants:
 *  - Exact 100 criteria (75 grounded + 25 reserved in `task_4_unselected`)
 *  - Exact 5x5 category taxonomy per task, unique studyIds/slots/criterion IDs
 *  - Zero unsanitized local user/root/temp paths
 *  - Zero `/bin/true` no-op verifiers
 *  - Every automated `oracleCheck.field` addresses ONLY fields/metric keys explicitly
 *    exposed in the task's answer-neutral `agentPrompt` (or an external verifier receipt)
 *  - Zero oracle leakage in `agentPrompt` (taskBrief, workspaceInstructions, outputSchema
 *    keys & descriptions, requiredOutputFields, and neutralMetricKeys)
 *  - Snapshot strategies exclude `.git` on every confirmed task
 *  - Verifier `targetTree` aligns with `appliesInModes` (`read_only_diagnosis` vs `autonomous_patch_and_verify`)
 *
 * @param {unknown} doc
 * @returns {{ valid: boolean; problems: string[] }}
 */
export function validateHpcContractDocument(doc) {
  const parsed = hpcEvalContractSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      valid: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }

  const contract = parsed.data;
  const problems = [];
  const rawText = JSON.stringify(contract);
  for (const pattern of LOCAL_PATH_LEAK_PATTERNS) {
    if (pattern.test(rawText)) {
      problems.push(`unsanitized local path matching ${pattern.toString()} found in contract`);
    }
  }

  const seenStudyIds = new Set();
  const seenSlots = new Set();
  const seenCriterionIds = new Set();
  const supportedFormats = new Set(contract.perfdigestMcpCompatibility.supportedFormats);
  let confirmedCount = 0;
  let unselectedCount = 0;
  let groundedCount = 0;
  let reservedCount = 0;

  for (const task of contract.tasks) {
    if (seenStudyIds.has(task.studyId)) problems.push(`duplicate studyId "${task.studyId}"`);
    seenStudyIds.add(task.studyId);

    if (seenSlots.has(task.slot)) problems.push(`duplicate slot ${task.slot}`);
    seenSlots.add(task.slot);

    const catCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const prefix = `T${task.slot}-`;
    for (const crit of task.criteria) {
      if (!crit.id.startsWith(prefix)) {
        problems.push(`${task.studyId}: criterion "${crit.id}" must start with "${prefix}"`);
      }
      if (seenCriterionIds.has(crit.id)) {
        problems.push(`duplicate criterion id "${crit.id}"`);
      }
      seenCriterionIds.add(crit.id);
      catCounts[crit.category] += 1;
    }
    for (const [cat, count] of Object.entries(catCounts)) {
      if (count !== 5) {
        problems.push(`${task.studyId}: category ${cat} has ${count} criteria, expected 5`);
      }
    }

    if (task.status === 'confirmed') {
      confirmedCount += 1;
      groundedCount += task.criteria.length;

      if (!task.supportedEvaluationModes.includes(task.defaultEvaluationMode)) {
        problems.push(`${task.studyId}: defaultEvaluationMode "${task.defaultEvaluationMode}" is not in supportedEvaluationModes`);
      }

      if (!task.snapshotStrategy.excludedLeakPaths.includes('.git')) {
        problems.push(`${task.studyId}: snapshotStrategy.excludedLeakPaths must include ".git" to prevent git-history leakage`);
      }

      const exposedTopFields = new Set(Object.keys(task.agentPrompt.outputSchema));
      const exposedMetricKeys = new Set(task.agentPrompt.neutralMetricKeys);
      for (const reqField of task.agentPrompt.requiredOutputFields) {
        if (!exposedTopFields.has(reqField)) {
          problems.push(`${task.studyId}: requiredOutputField "${reqField}" is missing from agentPrompt.outputSchema`);
        }
      }

      const verifierById = new Map();
      for (const verifier of task.verifiers) {
        if (verifierById.has(verifier.id)) {
          problems.push(`${task.studyId}: duplicate verifier id "${verifier.id}"`);
        }
        verifierById.set(verifier.id, verifier);
        if (NOOP_VERIFIER_PATTERN.test(verifier.command)) {
          problems.push(`${task.studyId}: verifier "${verifier.id}" uses forbidden no-op command`);
        }
        if (
          verifier.appliesInModes.includes('read_only_diagnosis') &&
          verifier.targetTree !== 'clean_pre_fix_snapshot'
        ) {
          problems.push(
            `${task.studyId}: verifier "${verifier.id}" applies in read_only_diagnosis so targetTree must be "clean_pre_fix_snapshot"`,
          );
        }
        if (
          verifier.targetTree === 'arm_patched_workspace' &&
          !verifier.appliesInModes.every((m) => m === 'autonomous_patch_and_verify')
        ) {
          problems.push(
            `${task.studyId}: verifier "${verifier.id}" targets arm_patched_workspace and must apply only in autonomous_patch_and_verify`,
          );
        }
      }

      for (const art of task.artifactRequirements) {
        if (!supportedFormats.has(art.perfdigestFormat)) {
          problems.push(`${task.studyId}: artifact "${art.artifactId}" uses unsupported perfdigestFormat "${art.perfdigestFormat}"`);
        }
      }

      for (const crit of task.criteria) {
        if (crit.gradingMode === 'deterministic_automated') {
          const check = crit.oracleCheck;
          if (check.verifierId) {
            const verifier = verifierById.get(check.verifierId);
            if (!verifier) {
              problems.push(`${task.studyId}: criterion "${crit.id}" references unknown verifierId "${check.verifierId}"`);
            } else {
              for (const mode of crit.applicableModes) {
                if (!verifier.appliesInModes.includes(mode)) {
                  problems.push(
                    `${task.studyId}: criterion "${crit.id}" applies in "${mode}" but its verifier "${check.verifierId}" only applies in [${verifier.appliesInModes.join(', ')}]`,
                  );
                }
              }
            }
          } else {
            const [topField, subField] = check.field.split('.');
            if (!exposedTopFields.has(topField)) {
              problems.push(
                `${task.studyId}: automated criterion "${crit.id}" references hidden unexposed top-level field "${topField}" (not in agentPrompt.outputSchema)`,
              );
            } else if (topField === 'measured_metrics') {
              if (!subField || !exposedMetricKeys.has(subField)) {
                problems.push(
                  `${task.studyId}: automated criterion "${crit.id}" references hidden metric key "${check.field}" (not in agentPrompt.neutralMetricKeys)`,
                );
              }
            } else if (subField !== undefined) {
              problems.push(
                `${task.studyId}: automated criterion "${crit.id}" references undocumented nested key "${check.field}"`,
              );
            }
          }
        } else {
          for (const targetField of crit.judgeRubric.targetFields) {
            if (!exposedTopFields.has(targetField)) {
              problems.push(
                `${task.studyId}: blind-judge criterion "${crit.id}" references unknown targetField "${targetField}"`,
              );
            }
          }
        }
      }

      // Leak scan covers EVERY string exposed to the agent: brief, instructions, outputSchema
      // keys & descriptions, requiredOutputFields, and neutralMetricKeys.
      const promptCorpus = [
        task.agentPrompt.taskBrief,
        task.agentPrompt.workspaceInstructions,
        ...task.agentPrompt.requiredOutputFields,
        ...Object.keys(task.agentPrompt.outputSchema),
        ...Object.values(task.agentPrompt.outputSchema),
        ...task.agentPrompt.neutralMetricKeys,
      ].join('\n').toLowerCase();
      const forbiddenList = [
        ...task.graderGroundTruth.forbiddenPromptSubstrings,
        ...(task.repository.fixSha ? [task.repository.fixSha, task.repository.fixSha.slice(0, 7)] : []),
      ];
      for (const forbidden of forbiddenList) {
        if (forbidden && promptCorpus.includes(forbidden.toLowerCase())) {
          problems.push(`${task.studyId}: oracle leakage detected in agentPrompt ("${forbidden}")`);
        }
      }
    } else {
      unselectedCount += 1;
      reservedCount += task.criteria.length;
      if (task.slot !== 4 || task.studyId !== 'task_4_unselected' || task.selectedByUser !== false || task.runnable !== false) {
        problems.push('unselected task slot must remain slot 4 ("task_4_unselected") with selectedByUser=false and runnable=false');
      }
    }
  }

  if (confirmedCount !== 3 || unselectedCount !== 1) {
    problems.push(`expected 3 confirmed tasks and 1 unselected task, got ${confirmedCount} confirmed and ${unselectedCount} unselected`);
  }
  if (groundedCount !== 75 || reservedCount !== 25 || seenCriterionIds.size !== 100) {
    problems.push(`criteria accounting mismatch: expected 75 grounded + 25 reserved = 100 unique, got ${groundedCount} + ${reservedCount} (${seenCriterionIds.size} unique)`);
  }

  return { valid: problems.length === 0, problems };
}
