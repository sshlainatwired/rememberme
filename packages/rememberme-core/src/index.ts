/**
 * @rememberme/core — platform-neutral domain core shared by the web app
 * (Astro) and the Android app (Vite + React + Capacitor).
 *
 * The only shared seam between the two toolchains. Rules:
 * - Platform-safe dependencies only (zod, luxon). No Node, Astro, Hono,
 *   Better Auth, or `fs` imports — anything that touches a server runtime is
 *   deliberately excluded from this package.
 * - Calendar arithmetic is pure civil-date math (`./calendar.ts`) and never
 *   mixes local-calendar arithmetic with UTC instant arithmetic.
 * - Deterministic time-of-day APIs accept the current instant
 *   (`./timezone.ts`) so behavior is testable without a wall clock.
 */

export * from "./calendar";
export * from "./journal";
export * from "./timezone";
export * from "./transfer-timestamp";
export * from "./weekly";
