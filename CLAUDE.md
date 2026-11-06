<!-- trb:memory:start -->
## Project rules
<!-- Managed by trb (Memory view). Edit rules there; text outside this block is yours and is never changed. -->
- Before any UI work, read DESIGN.md and use the tokens in design/tokens.css (var(--…) or the styling setup's mapping of them). Do not invent colors, fonts, sizes, spacing, radii or shadows outside it; if something is missing, add it to both files first.
- Run only the test files your change affects (`bun test tests/<name>.test.ts`), and list them in every head's brief. Don't run the whole suite unless the operator asks: a full `bun test` takes about 15 minutes, and on Windows many tests fail for environment reasons before any change, so it can't show what you broke.
<!-- trb:memory:end -->
