/**
 * Type declarations for the legacy CSS contract check (Android, Phase 5
 * Task 1). The implementation is plain dependency-free ESM (`verify-legacy-
 * css.mjs`); tsconfig has no `allowJs`/`checkJs`, so `tsc --noEmit` needs this
 * sibling declaration to type the import used by the vitest fixture suite
 * (`src/test/verify-legacy-css.vitest.ts`) without widening the functions to
 * `any`. Runtime behavior is unaffected — the fixture imports the `.mjs`
 * itself.
 */
export declare const FORBIDDEN_RULES: ReadonlyArray<readonly [RegExp, string]>;

/** Scan stylesheet text for tokens that Chrome/WebView 60 cannot parse. */
export declare function findForbiddenCssTokens(css: string): string[];

/** Report which required semantic selectors are absent from the stylesheet. */
export declare function missingRequiredSelectors(css: string): string[];