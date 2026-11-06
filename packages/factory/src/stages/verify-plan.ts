import { z } from "zod";

// 검증 에이전트가 내는 확인 방법. 경로 안전 검사는 verify-judge가 다시 한다.
const Reason = z.string().min(1).max(500);
const Index = z.number().int().min(0);

const ProbeCriterion = z.object({
  index: Index,
  method: z.literal("probe"),
  path: z.string().min(1).max(500),
  expectStatus: z.number().int().min(100).max(599).optional(),
  bodyIncludes: z.string().max(200).optional(),
  reason: Reason,
});
const TestCriterion = z.object({
  index: Index,
  method: z.literal("test"),
  testFile: z.string().min(1).max(300),
  testName: z.string().min(1).max(300),
  reason: Reason,
});
const NoneCriterion = z.object({
  index: Index,
  method: z.literal("none"),
  reason: Reason,
});

export const CriterionPlanSchema = z.discriminatedUnion("method", [
  ProbeCriterion,
  TestCriterion,
  NoneCriterion,
]);
export const VerifyPlanSchema = z.object({ criteria: z.array(CriterionPlanSchema).max(50) });

export type CriterionPlan = z.infer<typeof CriterionPlanSchema>;
export type VerifyPlan = z.infer<typeof VerifyPlanSchema>;
