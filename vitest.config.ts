import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Test secrets — CI runs with no real secrets so fork PRs pass.
              KAPSO_WEBHOOK_SECRET: "test-kapso-secret",
              SMSGATE_SIGNING_KEY: "test-smsgate-key",
              ADMIN_TOKEN: "test-admin-token",
              MOD_TOKEN: "test-mod-token",
              RESPONDER_TOKEN: "test-responder-token",
              ORG_TOKENS: "CruzRoja:test-org-token",
              LLM_API_KEY: "test",
              GITHUB_TOKEN: "test-gh-token",
              GITHUB_REPO: "test-org/test-repo",
              ALLOW_OPEN_INTAKE: "1",
              CEDULA_PEPPER: "test-cedula-pepper",
            },
          },
        },
      },
    },
  };
});
