/**
 * Cadet's docker image references, derived the same way the cadet CLI
 * derives its own (mycadet cli/src/lib/cloud-releases.ts
 * `resolveImageRefs` + `dockerhubImages`): repos under the `mycadet`
 * dockerhub org, a `-dev` repo suffix on dev builds, tag `v<version>`.
 *
 * The migrated lockfile's containerInfo must point at the images of the
 * cadet that was just installed — never the vellum images the containers
 * ran before (v0.0.10 run feedback: the migrated docker entry kept
 * `vellum-ai-prod/sandbox-images/...` refs, so wake hatched the wrong
 * images). Keep this table in sync with cadet's own resolution.
 */
export interface CadetImageRefs {
  assistant: string;
  gateway: string;
  credentialExecutor: string;
}

export function cadetImageRefs(version: string): CadetImageRefs {
  const suffix = /-dev\./i.test(version) ? "-dev" : "";
  const tag = `v${version.replace(/^v/, "")}`;
  return {
    assistant: `mycadet/mycadet-assistant${suffix}:${tag}`,
    gateway: `mycadet/mycadet-gateway${suffix}:${tag}`,
    credentialExecutor: `mycadet/mycadet-credential-executor${suffix}:${tag}`,
  };
}
