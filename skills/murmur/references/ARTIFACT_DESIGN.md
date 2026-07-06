# Murmur artifact design language

The canonical look for any HTML artifact in this environment. Murmur (the live agent-observability pane) defines the palette in `mcp-servers/murmur/web/src/index.css` and `web/tailwind.config.ts`. This file restates that palette as plain CSS custom properties plus copy-paste component recipes, so a standalone artifact (published through the `Artifact` tool, or written to disk) renders in the same dark Catalyst system without depending on Tailwind.

Any skill that emits a styled HTML page should adopt this. Two already do: `pr-reviewer` (the review artifact) and `dialectic` (the final transcript). New artifact surfaces should start from the base block below.

## Principles

- **Dark first.** A near-black zinc base with two soft radial glows, light text. There is no light variant.
- **Surfaces are translucent, not opaque.** Cards and panels are white at 2 to 4 percent over the gradient, with a hairline white border at 5 percent. Depth comes from the border and a blur, not from drop shadows.
- **Semantic colour survives.** When a page already encodes meaning in colour (severity, voices, diff add/remove), keep the meaning. Brighten the hue for contrast against the dark base rather than flattening everything into one accent.
- **Numbers are tabular and quiet.** Big figures use `tabular-nums` and a tight tracking. Labels are small, uppercase, zinc-500.
- **Motion is optional and reduced-motion safe.** Any animation must be wrapped in a `prefers-reduced-motion` guard.

## Tokens

Drop this `:root` block into the artifact's inline `<style>`. Values are the exact HSL triples Murmur uses, expressed as ready-to-use `hsl()` colours.

```css
:root {
  /* base */
  --bg: hsl(240 6% 6%);            /* near zinc-950 page base */
  --fg: hsl(0 0% 98%);             /* primary text */
  --card: hsl(240 5% 9%);          /* solid card fallback (zinc-900-ish) */

  /* translucent surfaces (preferred over --card) */
  --surface-1: hsl(0 0% 100% / 0.02);  /* panel fill */
  --surface-2: hsl(0 0% 100% / 0.03);  /* card / tile fill */
  --surface-3: hsl(0 0% 100% / 0.06);  /* hover fill */
  --hairline: hsl(0 0% 100% / 0.05);   /* borders, dividers */
  --hairline-strong: hsl(0 0% 100% / 0.10);

  /* text ramp (zinc) */
  --muted: hsl(240 5% 65%);        /* zinc-400 secondary text */
  --faint: hsl(240 4% 46%);        /* zinc-500 labels, table heads */

  /* accents */
  --primary: hsl(217 91% 60%);     /* blue-500 links, focus, primary action */
  --danger: hsl(350 89% 60%);      /* rose-500 destructive */
  --good: hsl(160 84% 39%);        /* emerald-500 positive */

  /* status pill fills + rings (fill /15, ring /30) */
  --good-fill: hsl(160 84% 39% / 0.15);  --good-ring: hsl(160 84% 39% / 0.30);  --good-ink: hsl(152 76% 80%);
  --bad-fill: hsl(350 89% 60% / 0.15);   --bad-ring: hsl(350 89% 60% / 0.30);   --bad-ink: hsl(350 100% 88%);
  --neutral-fill: hsl(240 5% 65% / 0.15);--neutral-ring: hsl(240 5% 65% / 0.30);--neutral-ink: hsl(240 5% 84%);

  /* radii (Murmur --radius is 0.75rem) */
  --radius: 0.75rem;               /* cards, panels (rounded-xl) */
  --radius-md: 0.625rem;
  --radius-sm: 0.5rem;             /* pills, inner chips */

  /* type */
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}
```

## Base page

Reproduces Murmur's fixed gradient backdrop and body type. Use it as the artifact's foundation.

```css
*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image:
    radial-gradient(1000px 600px at 100% -20%, hsl(240 30% 14% / 0.6) 0%, transparent 60%),
    radial-gradient(800px 500px at -10% 110%, hsl(220 50% 14% / 0.5) 0%, transparent 55%);
  background-attachment: fixed;
  color: var(--fg);
  font-family: var(--font);
  font-feature-settings: "rlig" 1, "calt" 1;
  -webkit-font-smoothing: antialiased;
  line-height: 1.6;
}

a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }

code, pre { font-family: var(--mono); }
code { background: var(--surface-2); border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 0.1em 0.35em; font-size: 0.9em; }

:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: var(--radius-sm); }
```

## Components

Each recipe maps to a Murmur class so the source of truth is traceable.

### Panel (maps to `.panel` / `.panel-header`)

```css
.panel { border: 1px solid var(--hairline); background: var(--surface-1); border-radius: var(--radius); }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.875rem 1.25rem; border-bottom: 1px solid var(--hairline); }
```

### Card / KPI tile (maps to `.kpi-tile`)

```css
.card { border: 1px solid var(--hairline); background: var(--surface-2); border-radius: var(--radius); padding: 1.25rem; backdrop-filter: blur(4px); }
.card-label { font-size: 0.875rem; font-weight: 500; color: var(--muted); }
.card-number { margin-top: 0.5rem; font-size: 1.875rem; font-weight: 600; letter-spacing: -0.02em; color: hsl(0 0% 98%); font-variant-numeric: tabular-nums; }
```

### Status pill (maps to `.delta-up` / `.delta-down` / `.delta-neutral`)

The pattern is fill at 15 percent, inset ring at 30 percent, bright ink. Swap the three custom properties to recolour.

```css
.pill { display: inline-flex; align-items: center; gap: 0.25rem; border-radius: var(--radius-sm); padding: 0.125rem 0.5rem; font-size: 0.75rem; font-weight: 500; box-shadow: inset 0 0 0 1px var(--_ring); background: var(--_fill); color: var(--_ink); }
.pill.good { --_fill: var(--good-fill); --_ring: var(--good-ring); --_ink: var(--good-ink); }
.pill.bad { --_fill: var(--bad-fill); --_ring: var(--bad-ring); --_ink: var(--bad-ink); }
.pill.neutral { --_fill: var(--neutral-fill); --_ring: var(--neutral-ring); --_ink: var(--neutral-ink); }
```

To brand a pill with any hue, set its three properties inline, for example a blue pill:
`--_fill: hsl(217 91% 60% / 0.15); --_ring: hsl(217 91% 60% / 0.30); --_ink: hsl(213 94% 85%);`

### Table (maps to `.tbl-head` / `.tbl-row`)

```css
.tbl-head { display: flex; align-items: center; gap: 1rem; padding: 0.625rem 1.25rem; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); border-bottom: 1px solid var(--hairline); }
.tbl-row { display: flex; align-items: flex-start; gap: 1rem; padding: 0.75rem 1.25rem; font-size: 0.875rem; border-bottom: 1px solid var(--hairline); }
.tbl-row:last-child { border-bottom: 0; }
.tbl-row:hover { background: var(--surface-1); }
```

### Diff rows (add / remove / context)

For annotated-diff surfaces. Tinted with the good and danger accents at low alpha so they read on the dark base. A left bar carries the colour so the row text stays legible.

```css
.diff { font-family: var(--mono); font-size: 0.8125rem; border: 1px solid var(--hairline); border-radius: var(--radius); overflow: hidden; }
.diff .ln { display: inline-block; width: 3ch; text-align: right; margin-right: 1rem; color: var(--faint); user-select: none; }
.diff-add { background: hsl(160 84% 39% / 0.10); box-shadow: inset 2px 0 0 var(--good); }
.diff-del { background: hsl(350 89% 60% / 0.10); box-shadow: inset 2px 0 0 var(--danger); }
.diff-ctx { color: var(--muted); }
```

## Severity and voice mappings

These keep the meaning the source artifacts already carry, recoloured for the dark base. Use the pill recipe with these triples.

| Role | Hue | fill / ring / ink |
| :-- | :-- | :-- |
| critical (pr-reviewer) | red | `hsl(0 84% 60% / .15)` / `hsl(0 84% 60% / .30)` / `hsl(0 96% 89%)` |
| important (pr-reviewer) | amber | `hsl(38 92% 50% / .15)` / `hsl(38 92% 50% / .30)` / `hsl(48 96% 77%)` |
| suggestion (pr-reviewer) | blue | `hsl(217 91% 60% / .15)` / `hsl(217 91% 60% / .30)` / `hsl(213 94% 85%)` |
| Aria · Builder (dialectic) | amber | accent `hsl(38 92% 55%)`, ink `hsl(48 96% 80%)` |
| Vex · Skeptic (dialectic) | sky | accent `hsl(199 89% 58%)`, ink `hsl(201 94% 82%)` |
| Human (dialectic) | emerald | accent `hsl(160 84% 45%)`, ink `hsl(152 76% 82%)` |

## Motion (optional)

Murmur fades status changes in and disables everything under reduced motion. If an artifact animates, mirror that guard.

```css
@keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
.rise { animation: rise 360ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .rise { animation: none !important; } }
```

## Constraints (artifact sandbox)

Carry these through to any page built for the `Artifact` tool. They are not optional.

- One self-contained file. Inline all CSS and JavaScript. No external scripts, stylesheets, fonts, or images (a strict CSP blocks every external host).
- System fonts only (the `--font` and `--mono` stacks above). Do not link web fonts.
- Render diagrams, charts, and diffs as HTML, CSS, or SVG, never raster images.
- Wide content (tables, diffs, code) scrolls inside its own `overflow-x: auto` container. The page body never scrolls horizontally.
- Use relative units and `max-width: 100%` on any media so the page is responsive.
