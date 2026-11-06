# Plan: Products and the portfolio

## Approach

- **Store** (`src/products/store.ts`): two tables created lazily, as the roadmap store does. `products` and `product_repos` (the foreign keys cascade on delete). Functions: CRUD, attach, detach, and the lookups other slices need (`productForWorkspace`, `productWorkspaces`).
- **Cost** (`src/products/cost.ts`): one query sums `turns.cost_usd` per `sessions.base_cwd`, then each folder maps to its owning workspace with `owningWorkspace` (the rule the workspace activity view uses). Three windows (all time, this UTC month, last 7 days) are computed once per call.
- **Portfolio** (`src/products/portfolio.ts`): reads each product's repos, roadmap progress through `readRoadmap` (a missing or unreadable roadmap is null, never an error), the newest finished verify run per workspace from `verify_runs`, and the spend.
- **Routes** (`src/daemon/routes/products.ts`): a `RouteModule`, mapped like `roadmap.ts`. Registered in `src/daemon/server.ts`.
- **CLI** (`src/cli/commands/product.ts`): `cmdProduct` and `cmdPortfolio`. Registered in `src/cli/main.ts`.
- **Web** (`web/src/features/products/`): `data.ts` (query and mutation hooks), `logic.ts` (pure budget and progress helpers), `PortfolioView.tsx`, `ProductDetail.tsx`.

## Decisions

- A workspace may belong to several products; its spend counts toward each. Shared libraries are real.
- Spend is attributed by `base_cwd`, not `cwd`, so a session running in a worktree bills to the operator's workspace.
- Budget "exceeded" means this month's spend is strictly above the budget.

## Known limits

- `owningWorkspace` matches subfolders by `"<workspace path>/"`. A session whose folder is a subfolder written with backslashes (Windows `path.join`) is not attributed to its workspace. Sessions started at the workspace root are unaffected.
- Verify results are read from the latest 500 runs.

## Wiring (a later step, not in this slice)

- `src/daemon/server.ts`: import `productRoutes` from `./routes/products` and add it to the `modules` array.
- `src/cli/main.ts`: import `cmdProduct, cmdPortfolio` from `./commands/product`, add `case "product": return cmdProduct(rest);` and `case "portfolio": return cmdPortfolio(rest);`, and add both to the usage text.
- Mount `<PortfolioView />` from `@/features/products/PortfolioView` in a shell tab (not in this slice).

## Tests

- `tests/products.test.ts`: store rules, cost windows and nesting, portfolio shape, route contract (called directly).
- `tests/products-logic.test.ts`: budget bar tones and text.
