# Karaoke Search UI design

Implemented design reference, checked against `tokens.css` and `global.css`
on September 18, 2026. These styles began with a Revolut-inspired palette;
the app's CSS is the source for actual component dimensions and behavior.

## 1. Visual theme

The interface uses flat surfaces, pill controls, rounded cards, and clear
contrast. The operating-system color scheme selects the light variant;
the base tokens are dark. It is a search interface, without the large
marketing hero treatments from the original inspiration study.

## 2. Color palette

| Role | Dark | Light |
|---|---|---|
| Background | `#191c1f` | `#ffffff` |
| Card surface | `rgba(244,244,244,0.06)` | `#f4f4f4` |
| Hover surface | `rgba(244,244,244,0.1)` | `#ececef` |
| Foreground | `#f4f4f4` | `#191c1f` |
| Muted text | `#8d969e` | `#505a63` |
| Border | `rgba(244,244,244,0.16)` | `#c9c9cd` |

The palette is expressed through `--rui-*` tokens. The light secondary-pill
background is the app-specific `#dfdfe2`, with black text. It stays distinct
from both resting and hovered card surfaces; using the original inspiration's
`#f4f4f4` here made pills disappear into the card.

## 3. Typography

Display and body use the self-hosted **Pretendard JP** family with system,
Noto Sans JP, and Noto Sans KR fallbacks. Aeonik Pro and Inter from the
inspiration study are not the current font stacks.

| Role | Size | Typical weight / line height / tracking |
|---|---|---|
| Desktop page title | 32px | 500 / 1.19 / -0.32px |
| Mobile page title | 24px | 500 / 1.33 / 0 |
| Navigation token | 20px | Component-specific |
| Large body token | 18px | Component-specific |
| Body | 16px | 400 / 1.5 / 0.24px |
| Semibold controls | 16px | 600 / 1.5 / 0.16px |

Small uppercase labels and compact mobile number badges have explicit local
CSS rules. Their sizes cannot be inferred from the body scale alone.

## 4. Components

- Pills use a 9999px radius; cards use 20px and smaller surfaces 12px.
- Primary pills invert foreground/background with the theme. Secondary pills
  use a distinct filled surface; outlined pills use a 2px strong border.
- The dark elevated surface follows a low-opacity light overlay. Interactive
  hover commonly combines opacity 0.85 with the component's surface rule.
- Desktop secondary pills use 14px × 32px padding. Mobile chips deliberately
  use more compact dimensions; number badges remain copy-to-clipboard buttons.
- Focus uses a `0 0 0 0.125rem` foreground-colored ring. Flat visual treatment
  does not remove keyboard focus feedback.

## 5. Layout and responsive behavior

Spacing follows an 8px-centered scale with component-specific adjustments.
The principal desktop breakpoint is 720px. Mobile tab-bar edge bleed depends
on both increased width and negative inline margin. Some pill rows wrap;
the mobile horizontal rows scroll with their scrollbars hidden.

The sticky tab offset depends on `--header-height`: 6rem for mobile and
6.38rem at 720px and above. These are hand-derived from header padding,
title/subtitle dimensions, and their gap. Changing those dimensions without
updating the token leaves a visible strip during scrolling. The runtime
`ResizeObserver` replacement is still a TODO in `tokens.css`.

## 6. Implementation references

- [tokens.css](apps/web/src/styles/tokens.css): palette, fonts, radii, header offset.
- [global.css](apps/web/src/styles/global.css): component rules and media queries.
- [Project knowledge](docs/PROJECT-KNOWLEDGE.md#frontend--ui-invariants):
  layout regressions, tab state, and test URL behavior.
