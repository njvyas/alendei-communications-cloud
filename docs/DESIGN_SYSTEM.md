# ACC console design system (U15.1)

Implements the U15.1 specification, version 2.2.0 (owner-approved, 06-Nov-2026), in `apps/web`. The decision record and its deviations are in `DECISIONS.md` §1ze.

**Scope.** U15.1 delivers the shared primitives, tokens and theme mechanism, and validates them in isolation. Existing pages are unchanged:
- they keep their current tokens and appearance;
- under the default "system" preference they render as before.

**Out of scope:**
- the app shell, navigation and the placement of the theme control (U15.2);
- the dashboard and customer or reseller screens (U15.3);
- the platform and support screens (U15.4).

## Tokens

- **Single source of truth.** The `--acc-*` custom properties in `apps/web/src/app/globals.css`, under `:root` (light) and `.dark` (dark).
- **Tailwind utilities.** Tailwind maps the tokens to utilities such as `bg-acc-primary`, `text-acc-text-secondary` and `border-acc-border-input`.
- **No colours in TypeScript.** Components never hard-code colour values. A unit test enforces this, and canvas-like consumers must read `getComputedStyle`.
- **Existing tokens kept.** The pre-U15 tokens (`--color-surface`, `--color-ink`, …) are unchanged, for current pages. Their dark values now follow the theme class instead of `prefers-color-scheme`, with identical values.
- **Refinement tokens added in U15.1** (WCAG 2.2 AA; the approved base palette is unchanged):
  - `--acc-border-input`: the boundary for inputs, selects and outline buttons. Light `#7F89A0` (3.51:1 on a card); dark `#5E6D8D`.
  - `--acc-destructive`, `--acc-destructive-hover`: light `#B8354C` / `#9C2B40` with white text; dark `#E85D75` / `#EF7A8E` with dark text.
  - `--acc-on-primary`, `--acc-on-accent`, `--acc-on-destructive`: the specification's per-theme text colour rules, as tokens.
- **Muted text** (`--acc-text-muted`) is for disabled controls only (2.50:1 light, 3.51:1 dark).

## Theme

| Item | Behaviour |
|---|---|
| Preference | Cookie `acc_theme_preference`: `system` (default), `light` or `dark` |
| Resolved theme | Cookie `acc_resolved_theme`: `light` or `dark`. It is cached so the server can render the right class on warm visits. |
| Before first paint | `THEME_PRE_PAINT_SCRIPT` (`src/lib/theme.ts`) runs in `<head>`, authorised by the request's CSP nonce. It applies the `dark` class on `<html>`, so a cold visit in OS dark mode never flashes light. |
| Server | `src/app/layout.tsx` renders the class from the cookies. `suppressHydrationWarning` covers only `<html>` (its class) and the script element (whose nonce attribute browsers hide). |
| Client | `src/lib/theme-store.ts` (`useTheme`, `setThemePreference`). `ThemeSync`, mounted once in the root layout, follows OS changes live while the preference is `system`. |
| Control | `ThemePreferenceControl`: a WAI-ARIA radio group (System / Light / Dark). It is not yet placed in the app shell (U15.2). |

## Content Security Policy

`src/proxy.ts` (the Next.js 16 proxy) generates a 128-bit nonce per request and sets `Content-Security-Policy` on the request (so Next.js applies the nonce to its own scripts) and on the response. The policy is built in `src/lib/csp.ts`:
- `script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `'unsafe-eval'` in development only;
- `style-src 'self' 'unsafe-inline'`, because React `style` props cannot carry a nonce;
- `img-src 'self' data: blob: https:`, for operator-supplied branding logo and favicon URLs;
- `connect-src 'self' <API origin>`;
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.

The nonce requires dynamic rendering, so every route now renders on demand. Before U15.1 the console sent no CSP at all.

## Components (`src/components/ui`, barrel `index.ts`)

| Component | Notes |
|---|---|
| `Button`, `IconButton` | Variants `primary`, `secondary`, `outline`, `ghost`, `destructive`; sizes `sm`, `md`, `lg`, `icon`. Loading sets `disabled` and `aria-busy`. 2px primary focus outline with a 2px offset. |
| `Input`, `PasswordInput`, `SearchInput` | Always labelled. An error sets `aria-invalid`, and the `role="alert"` message is referenced by `aria-describedby`. The password toggle stays in the tab order, with `aria-pressed`. |
| `Select` | APG select-only combobox: arrows, Home/End, Enter/Space, Escape, Tab, type-ahead, groups, disabled options. Rendered in a portal, with flip and clamp collision handling. |
| `Badge`, `StatusBadge` | Text of at least 4.5:1. The status badge pairs a distinct glyph with visible text and a screen-reader prefix. |
| `Card` (+ `CardHeader`, `CardContent`, `CardFooter`), `StatCard` | `StatCard` shows only the value it is given (skeleton, "No data", "Unavailable"). |
| `Breadcrumb`, `breadcrumbsFromPath` | Plain links by default; `renderLink` lets the shell pass a router link. 160px truncation, with the full text in `title`. |
| `Tabs` | WAI-ARIA Tabs with automatic activation, roving tabindex, wrapping arrows, Home/End, and skipping of disabled tabs. |
| `EmptyState`, `Drawer` | The drawer reuses the U10 `useModalDialog` focus management. |
| `DataTable` suite | Server-driven: it renders the rows given and emits sort and paging through `onQueryChange`. It never filters or sorts rows itself; a test enforces this. |
| `AccessibleDialog`, `ToastContainer`, `ActionFeedback` | Existing; re-exported unchanged. |

## Tests

| Suite | Command (from `apps/web`) |
|---|---|
| Unit: tokens and contrast, components, keyboard logic, theme, pre-paint script, CSP | `npm test` |
| Components in Chromium and Firefox (keyboard, ARIA, rendered contrast including hover, focus, screenshots) | `npx playwright test -c e2e/u15/playwright.u15.config.ts --project=components-chromium --project=components-firefox` |
| Theme, hydration and CSP against the real app (starts `next dev` on port 3156) | `npx playwright test -c e2e/u15/playwright.u15.config.ts --project=theme-chromium --project=theme-firefox` |
| The same against a production build | `next build && next start -p 3157`, then the theme command with `U15_BASE_URL=http://localhost:3157` |

**Screenshot baselines** are in `e2e/u15/__screenshots__`, recorded in Chromium on Linux. To refresh them after an intended visual change, add `--update-snapshots`.
