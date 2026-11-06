import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** 저장소 안의 상대 경로나 glob. 절대 경로와 `..` 구간은 거부한다. */
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p), "절대 경로는 쓸 수 없다")
  .refine((p) => !p.replace(/\\/g, "/").split("/").includes(".."), "`..` 구간은 쓸 수 없다");

const SuiteSchema = z
  .object({ suite: z.string().min(1), filter: z.string().min(1), dir: RelPath })
  .strict();

const DeploymentSchema = z
  .object({
    apiOrigin: z.string().min(1),
    webUrl: z.string().min(1),
    previewWeb: z.string().min(1),
    previewApi: z.string().min(1),
  })
  .strict();

const ProjectSchema = z
  .object({
    name: z.string().min(1),
    deployment: DeploymentSchema.optional(),
    paths: z
      .object({
        skipFiles: z.array(RelPath),
        smokePaths: z.array(RelPath),
        migrationsDir: RelPath.nullable(),
        protected: z.array(RelPath),
      })
      .strict(),
    evidence: z
      .object({
        testFilePatterns: z.array(RelPath),
        suites: z.array(SuiteSchema),
        e2eDir: RelPath.nullable(),
      })
      .strict(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectSchema>;

export const PROJECT_CONFIG_FILE = path.join(".factory", "project.yml");

/**
 * `<dir>/.factory/project.yml`을 읽는다. 형식 오류, 알 수 없는 키, 없는 파일은 모두 예외다.
 * 호출자는 신뢰할 수 있는 기본 브랜치 체크아웃 경로(`projectDir(env)`)만 넘겨야 한다.
 */
export function loadProjectConfig(dir: string): ProjectConfig {
  const file = path.join(dir, PROJECT_CONFIG_FILE);
  return ProjectSchema.parse(parse(readFileSync(file, "utf8")));
}

export interface UrlVars {
  workersSubdomain?: string;
  webUrl?: string;
  pr?: number;
}

/** 프로덕션 주소 템플릿의 `{workersSubdomain}`, `{webUrl}`, `{pr}`를 채운다. 모르는 변수나 빠진 값은 예외다. */
export function renderDeploymentUrl(template: string, vars: UrlVars): string {
  if (vars.pr !== undefined && !(Number.isInteger(vars.pr) && vars.pr > 0))
    throw new Error(`pr은 양의 정수여야 한다: ${vars.pr}`);
  if (
    vars.workersSubdomain !== undefined &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(vars.workersSubdomain)
  )
    throw new Error(`workersSubdomain 형식이 잘못됐다: ${vars.workersSubdomain}`);
  return template.replace(/\{([^{}]*)\}/g, (_m, name: string) => {
    if (name !== "workersSubdomain" && name !== "webUrl" && name !== "pr")
      throw new Error(`알 수 없는 주소 변수: {${name}}`);
    const value = vars[name];
    if (value === undefined) throw new Error(`주소 변수 {${name}} 값이 없다`);
    return String(value);
  });
}
