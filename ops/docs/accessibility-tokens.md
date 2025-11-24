# Accessibility and Design Tokens

Version: 0.1.0
Status: Draft ready for implementation
Scope: shared tokens and rules that guarantee WCAG AA across Polaris Coach

---

## Principles

* Accessibility is a requirement, not a theme. Tokens enforce contrast and clarity by default.
* Semantic tokens sit on top of brand primitives, which lets us tune brand without breaking AA.
* One focus style across the app. One error style. One success style. Variants derive from tokens, not ad hoc colors.

---

## Brand primitives

These never ship directly to components. Only semantic tokens do.

```css
:root {
  /* Brand palette */
  --brand-primary: #07435E;   /* deep teal */
  --brand-secondary: #042838; /* dark navy teal */
  --brand-accent: #4390BA;    /* bright blue teal */

  /* Neutrals and surfaces */
  --brand-surface: #DBF7FF;   /* very light teal surface */
  --brand-base-dark: #001C29; /* near black with teal hue */
  --brand-text: #000000;      /* pure black for maximum legibility */

  /* Whites and overlays */
  --white: #FFFFFF;
  --black: #000000;
}
```

---

## Semantic tokens

Components pull only from these. Each pair must maintain WCAG AA.

```css
:root {
  /* Text on default app background */
  --fg-default: var(--brand-text);
  --fg-muted: rgba(0, 0, 0, 0.65);
  --fg-subtle: rgba(0, 0, 0, 0.54);
  --fg-inverse: #FFFFFF;

  /* Backgrounds */
  --bg-app: var(--brand-surface);     /* page background */
  --bg-card: #FFFFFF;                 /* cards and sheets */
  --bg-subtle: #F5FBFE;               /* very light tint */

  /* Interactive brand */
  --brand: var(--brand-primary);
  --brand-hover: #063A52;  /* darken 8 to 12 percent */
  --brand-pressed: #052F44; /* darken 16 to 20 percent */
  --on-brand: #FFFFFF;      /* text on brand */

  /* Accent links and charts */
  --accent: var(--brand-accent);
  --accent-hover: #357EA4;
  --on-accent: #FFFFFF;

  /* Borders and dividers */
  --bd-default: rgba(0, 0, 0, 0.12);
  --bd-strong: rgba(0, 0, 0, 0.24);

  /* States */
  --success: #0E8A52;
  --on-success: #FFFFFF;
  --warning: #B85C00;
  --on-warning: #FFFFFF;
  --danger: #B42318;
  --on-danger: #FFFFFF;

  /* Focus and selection */
  --focus-ring: var(--brand);
  --selection-bg: rgba(67, 144, 186, 0.28);
  --selection-fg: var(--fg-default);

  /* Disabled */
  --fg-disabled: rgba(0, 0, 0, 0.38);
  --bg-disabled: rgba(0, 0, 0, 0.06);
  --bd-disabled: rgba(0, 0, 0, 0.18);
}
```

---

## Type and spacing tokens

```css
:root {
  /* Type scale */
  --font-sans: ui-sans-serif, system-ui, "Inter", "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  --size-xs: 12px;
  --size-sm: 14px;
  --size-md: 16px;
  --size-lg: 18px;
  --size-xl: 20px;
  --size-2xl: 24px;
  --size-3xl: 30px;

  --lh-tight: 1.2;
  --lh-normal: 1.5;
  --lh-loose: 1.7;

  /* Spacing scale */
  --space-0: 0px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  /* Radius and elevation */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-2xl: 24px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.10);
  --shadow-lg: 0 10px 24px rgba(0,0,0,0.14);

  /* Motion */
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --dur-slow: 260ms;
  --ease-standard: cubic-bezier(.2,.0,.2,1);
  --ease-emphasized: cubic-bezier(.2,.0,0,.9);
}
```

---

## Contrast rules

* Body text and icons on `--bg-card` or `--bg-app` must be 4.5:1 or higher.
* Large text at 20 px and bold or 24 px regular can pass at 3:1.
* Disabled content may fall below 4.5:1 but must remain legible at 3:1.
* Brand and accent buttons must meet 4.5:1 between background and text.

**Required checks before merge**

* Primary button `--brand` with `--on-brand` is at least 4.5:1 on both `--bg-card` and `--bg-app`.
* Link color `--accent` on `--bg-card` is at least 4.5:1.
* Danger, warning, success pairs meet 4.5:1 with their on colors.

---

## Tailwind mapping

Use CSS variables so tokens flow through Tailwind. Extend once in `tailwind.config.ts`.

```ts
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        bg: {
          app: 'var(--bg-app)',
          card: 'var(--bg-card)',
          subtle: 'var(--bg-subtle)'
        },
        fg: {
          DEFAULT: 'var(--fg-default)',
          muted: 'var(--fg-muted)',
          subtle: 'var(--fg-subtle)',
          inverse: 'var(--fg-inverse)'
        },
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          pressed: 'var(--brand-pressed)',
          on: 'var(--on-brand)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          on: 'var(--on-accent)'
        },
        bd: {
          DEFAULT: 'var(--bd-default)',
          strong: 'var(--bd-strong)',
          disabled: 'var(--bd-disabled)'
        },
        state: {
          success: 'var(--success)',
          onSuccess: 'var(--on-success)',
          warning: 'var(--warning)',
          onWarning: 'var(--on-warning)',
          danger: 'var(--danger)',
          onDanger: 'var(--on-danger)'
        }
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        '2xl': 'var(--radius-2xl)'
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)'
      }
    }
  }
};
```

---

## Focus, hover, and pressed

A single visible focus style everywhere.

```css
/* Base focus outline */
:where(button, a, input, textarea, [role="button"], [tabindex]) {
  outline-offset: 2px;
}
:where(button, a, input, textarea, [role="button"], [tabindex]):focus-visible {
  outline: 2px solid var(--focus-ring);
  box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 4px var(--focus-ring);
}

/* Hover and pressed tokens are consumed by components */
.button-brand:hover { background: var(--brand-hover); }
.button-brand:active { background: var(--brand-pressed); }
```

Users who prefer reduced motion get instant transitions.

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

---

## Component recipes

### Primary button

* Background `--brand`, text `--on-brand`.
* Border on hover uses `--bd-strong` for contrast on white.
* Disabled uses `--bg-disabled`, `--fg-disabled`, and `--bd-disabled`.

```html
<button class="px-4 py-2 rounded-2xl font-medium shadow-sm"
        style="background: var(--brand); color: var(--on-brand);">
  Continue
</button>
```

### Link

* Color `--accent` with underline by default.
* On focus, add a 2 px outline using `--focus-ring`.

### Input

* Background `--bg-card`, text `--fg-default`, border `--bd-default`.
* On error, border uses `--danger` and helper text uses `--danger`.

### Alert

* Success uses `--success` background at 8 percent with `--on-success` text for title.
* Warning and danger follow the same pattern.

---

## Data visualization

Use a small set of safe series colors with known contrast on the app background.

```css
:root {
  --series-1: var(--brand);
  --series-2: var(--accent);
  --series-3: #7CAFD1;
  --series-4: #2F6B83;
  --series-5: #94C6DD;
}
```

Rules

* Never use red and green as the only channel.
* Provide patterns or labels for thin color differences.
* Axis text must use `--fg-muted` at minimum 4.5:1.

---

## Internationalization and ESL helpers

* Keep placeholder text readable and do not rely on placeholder alone for meaning.
* Use sentence case on labels.
* Provide pronunciation hints as IPA only when asked by the drill.

---

## Content rules

* Error messages are short, precise, and suggest a next step.
* Labels start with the key noun or verb.
* Buttons are verbs.
* Avoid all caps for long strings.

---

## Testing checklist

Use this list in PRs.

* [ ] All color pairs meet 4.5:1 on `--bg-card` and `--bg-app`.
* [ ] Focus is clearly visible on every interactive element.
* [ ] Text scales to 200 percent without truncation or overlap for core screens.
* [ ] Keyboard flow reaches every control and skips none.
* [ ] Motion honors prefers reduced motion.
* [ ] Alerts convey meaning with both color and text or icons.
* [ ] Links are underlined by default and not only colored.
* [ ] Icons have aria labels where needed.
* [ ] Form fields announce errors with role or aria attributes.

---

## Lint and CI

* Add a small script that checks contrast for the declared pairs and fails the build if any pair drops below 4.5:1.
* Review tokens in design review before merge. Changes to brand primitives require a sweep of series and state pairs.

```bash
# Example script hook
npm run a11y:tokens:check
```

---

## Migration notes

* If you update a primitive color, run the contrast checker and update `--brand-hover` and `--brand-pressed` manually to keep ratios.
* Keep snapshots of tokens per release to debug regression reports.
