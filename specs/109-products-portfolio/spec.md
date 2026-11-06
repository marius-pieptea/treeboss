# Feature Specification: Products and the portfolio

**Feature**: `109-products-portfolio`
**Status**: Implemented
**Input**: A product is what the operator ships (a SaaS, a mobile app). It is made of one or more workspaces (its web, api, mobile and worker repos). The portfolio shows every product on one screen: status, repos, roadmap progress per repo, the last verify result per repo, and what the agents have cost against a monthly budget.

## User Scenarios & Testing

### User Story 1 - Group my repos into products (Priority: P1)

I create a product, attach the workspaces that make it up, and give each one a role (web, api, mobile, worker, other).

**Why this priority**: every other view in the portfolio depends on knowing which repos belong to which product.

**Independent Test**: `trb product new "Acme Pay"`, then `trb product attach acme-pay -r api` from the api repo. `trb product show acme-pay` lists the api repo with role `api`.

**Acceptance Scenarios**:

1. **Given** no products, **When** I create "Acme Pay", **Then** it gets the slug `acme-pay`, status `idea`, and no budget.
2. **Given** a product with a web repo, **When** I attach the same workspace again with role `api`, **Then** its role changes; it is not listed twice.
3. **Given** a workspace attached to a product, **When** I detach it, **Then** the workspace stays registered and the product no longer lists it.

### User Story 2 - See the whole portfolio on one screen (Priority: P1)

`trb portfolio` and the Portfolio view show one card per product: its status, each repo with its roadmap progress (shipped items of the items in its ROADMAP.md) and its last verify result, and the spend bar against the budget.

**Independent Test**: two products, one with a roadmap of 2 items (1 shipped) and a failed or passed verify run, one with no repos. The portfolio returns both, the first with `progress {items: 2, shipped: 1}` and the repo's `verify.state` set, the second with an empty repo list.

**Acceptance Scenarios**:

1. **Given** a repo with no ROADMAP.md, **When** I open the portfolio, **Then** that repo shows "no roadmap" and the rest of the view still loads.
2. **Given** a product whose month's spend is above its budget, **When** I open the portfolio, **Then** its spend reads "over budget" in words, not only in colour.

### User Story 3 - Know what the agents cost (Priority: P1)

The spend of a product is the sum of the turns of the sessions cut from its workspaces: all time, this month and the last 7 days. A budget in dollars a month is optional; spend above it is flagged.

**Independent Test**: a workspace with one session whose turns cost 1.5 and 2.0 (now) and one whose turn cost 4.0 ten days ago. Spend: all time 7.5, last 7 days 3.5, this month 3.5 or 7.5 depending on the date.

**Acceptance Scenarios**:

1. **Given** a session in a nested project's folder, **When** I read the parent's spend, **Then** the nested project's cost is not in it (same rule as the workspace activity view).
2. **Given** no budget, **When** I read the spend, **Then** it is never flagged over budget.

### User Story 4 - Edit a product in the app (Priority: P2)

The Product detail editor changes name, status, budget and description, adds and removes repos, and deletes the product. Deleting a product never deletes its workspaces.

**Acceptance Scenarios**:

1. **Given** I clear the budget field, **When** I save, **Then** the product has no budget.
2. **Given** I delete a product, **When** I confirm, **Then** its repos are unlinked and the workspaces remain.

### Edge Cases

- A workspace attached to two products: its spend counts toward both (a shared library). `productForWorkspace` returns the older product.
- A workspace removed from the registry is detached from every product.
- Verify runs are read from the latest 500 runs only, so an old repo can show no verify result.
- Time windows are UTC, because SQLite stamps turns in UTC.

## Requirements

### Functional Requirements

- **FR-001**: A product MUST have an id `p_…`, a name, a unique slug, a description, a status (`idea`, `building`, `staging`, `live`, `paused`, `archived`) and an optional monthly budget in USD.
- **FR-002**: A product MUST be attachable to workspaces with a role (`web`, `api`, `mobile`, `worker`, `other`); a workspace is attached at most once per product.
- **FR-003**: The spend of a workspace MUST be the sum of `turns.cost_usd` for sessions whose `base_cwd` the workspace owns (the most specific registered folder wins).
- **FR-004**: The portfolio MUST show per repo the roadmap progress, the last finished verify run, and the all-time cost, and per product the summed progress and the spend against budget.
- **FR-005**: The daemon MUST expose `GET/POST /api/products`, `GET/PATCH/DELETE /api/products/:id`, `POST/DELETE /api/products/:id/repos` and `GET /api/portfolio`. `:id` accepts a product id or slug.
- **FR-006**: The CLI MUST offer `trb product ls|new|show|attach|detach|set-status|budget` and `trb portfolio`.
- **FR-007**: The web UI MUST offer a PortfolioView (one card per product) and a ProductDetail editor, using design tokens only.

### Key Entities

- **Product**: what is shipped. Name, slug, status, budget.
- **Product repo**: a workspace in a product, with a role.
- **Spend**: all-time, this-month and last-7-day totals in USD, the budget, and whether this month is over it.

## Success Criteria

- **SC-001**: `trb portfolio` lists every product with its repos, roadmap progress and spend in one run.
- **SC-002**: The spend figures match the sum of turn costs by hand for a seeded database (tests/products.test.ts).
- **SC-003**: Deleting a product never removes a workspace or its sessions.

## Assumptions

- Costs are whatever the engines report per turn; a turn with no cost counts as nothing.
- One operator, one database. Products are not per-user.
- Budgets are monthly, measured in UTC.
