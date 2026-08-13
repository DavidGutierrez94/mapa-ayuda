import { applyD1Migrations, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: any[];
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
