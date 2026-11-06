import path from "node:path";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const FACTORY_DIR = path.join(REPO_ROOT, "factory");

/**
 * 프로젝트 설정(`.factory/`)을 읽는 디렉토리. 신뢰할 수 있는 기본 브랜치 체크아웃이어야 하므로
 * PR 코드가 있는 `FACTORY_WORKDIR`가 아니라 `FACTORY_PROJECT_DIR`(기본 `REPO_ROOT`)을 쓴다.
 */
export function projectDir(env: NodeJS.ProcessEnv): string {
  return env.FACTORY_PROJECT_DIR || REPO_ROOT;
}
