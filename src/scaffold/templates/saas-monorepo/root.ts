/**
 * saas-monorepo: the files only the repository root owns. The apps come from the saas-next and expo-app stacks
 * (see ../../golden.ts). Same rules as the other templates: String.raw, no backticks, no dollar-brace, {{name}}
 * filled in at write time.
 */

/**
 * The workspace root. It holds scripts only; each app owns its dependencies. The fan-out scripts run a script in every
 * workspace that defines it and skip the rest, so CI and `trb ci init` see plain `bun run typecheck`, `lint` and `test`.
 */
export const ROOT_PACKAGE_JSON = String.raw`{
  "name": "{{name}}",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev:web": "bun run --cwd apps/web dev",
    "dev:mobile": "bun run --cwd apps/mobile start",
    "typecheck": "bun run --filter './apps/*' --filter './packages/*' typecheck",
    "lint": "bun run --filter './apps/*' --filter './packages/*' lint",
    "test": "bun run --filter './apps/*' --filter './packages/*' test"
  }
}
`;

/** Metro (Expo's bundler) does not follow bun's isolated links, so one hoisted node_modules sits at the root. */
export const BUNFIG_TOML = String.raw`[install]
linker = "hoisted"
`;

/** The package both apps import as @workspace/shared. It ships source, so there is no build step. */
export const SHARED_PACKAGE_JSON = String.raw`{
  "name": "@workspace/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
`;

export const SHARED_TSCONFIG = String.raw`{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
`;

/** Types both apps need. HealthResponse is what GET /api/health in apps/web returns. */
export const SHARED_INDEX_TS = String.raw`/** The body of GET /api/health in apps/web. The mobile app reads it the same way. */
export interface HealthResponse {
  status: "ok" | "degraded";
  database: "up" | "down";
}
`;
