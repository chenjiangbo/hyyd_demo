---
name: Universal Medical Green-Channel Workbench
colors:
  surface: '#faf9ff'
  surface-dim: '#d9d9e3'
  surface-bright: '#faf9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3fd'
  surface-container: '#ededf7'
  surface-container-high: '#e7e7f1'
  surface-container-highest: '#e1e2eb'
  on-surface: '#191b22'
  on-surface-variant: '#424753'
  inverse-surface: '#2e3037'
  inverse-on-surface: '#eff0fa'
  outline: '#737785'
  outline-variant: '#c2c6d5'
  surface-tint: '#0459c5'
  primary: '#00459d'
  on-primary: '#ffffff'
  primary-container: '#0d5cc8'
  on-primary-container: '#d0dcff'
  inverse-primary: '#afc6ff'
  secondary: '#6b38d4'
  on-secondary: '#ffffff'
  secondary-container: '#8455ef'
  on-secondary-container: '#fffbff'
  tertiary: '#7f3000'
  on-tertiary: '#ffffff'
  tertiary-container: '#a64100'
  on-tertiary-container: '#ffd3c1'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d9e2ff'
  primary-fixed-dim: '#afc6ff'
  on-primary-fixed: '#001a43'
  on-primary-fixed-variant: '#004398'
  secondary-fixed: '#e9ddff'
  secondary-fixed-dim: '#d0bcff'
  on-secondary-fixed: '#23005c'
  on-secondary-fixed-variant: '#5516be'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb695'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#7c2e00'
  background: '#faf9ff'
  on-background: '#191b22'
  surface-variant: '#e1e2eb'
  trust-blue: '#0D5CC8'
  action-green: '#10B981'
  alert-orange: '#F59E0B'
  ai-purple: '#8B5CF6'
  surface-bg: '#F8FAFC'
  border-subtle: '#E2E8F0'
  text-main: '#1E293B'
  text-muted: '#64748B'
typography:
  h1-display:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  h2-header:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  h3-title:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-max: 1440px
  gutter: 16px
  margin-page: 24px
  card-padding: 16px
  swimlane-width: 320px
---

## Brand & Style

The design system is engineered for the **Universal Medical Green-Channel Workbench**, a high-stakes desktop environment where medical service specialists manage complex insurance-backed healthcare logistics. The brand personality is **authoritative, precision-oriented, and technologically empowered**. It must evoke a sense of "calm efficiency" for specialists handling dozens of simultaneous orders, balancing human empathy with AI-driven speed.

The chosen style is **Modern Enterprise SaaS (Corporate Modern)**. It prioritizes high information density without visual noise. The interface utilizes a structured "Cockpit" layout, ensuring that critical data is never more than a click away. Visual cues are used strategically to guide the eye toward action-ready items (AI insights and pending claims) while maintaining a clean, systematic aesthetic that feels reliable to both internal users and external stakeholders.

## Colors

The palette is anchored by **Trust Blue**, a professional medical-grade primary color that establishes authority. 

- **Primary (Trust Blue):** Used for primary actions, navigation states, and brand identity.
- **Secondary/AI (AI Purple):** Reserved exclusively for AI-assisted features, info extraction indicators, and automated data suggestions.
- **Success (Action Green):** Indicates completion, successful claims, and system-validated data.
- **Warning (Alert Orange):** highlights high-priority delays, timeout warnings, or critical missing information.
- **Neutral:** A sophisticated range of cool grays (`#F8FAFC` to `#1E293B`) provides the structural foundation, ensuring text readability and UI depth.

The system defaults to **Light Mode** to maintain a clean, "clinical" feel appropriate for professional medical services, with high contrast for long-duration desktop use.

## Typography

The system uses **Inter** as the primary typeface, chosen for its exceptional legibility in data-dense environments and its neutral, professional character. For Chinese text, Inter pairs seamlessly with system-standard sans-serifs (like PingFang SC).

- **Hierarchy:** We use a tight scale ranging from 12px to 24px. Larger sizes are avoided to maintain high information density.
- **Weight:** Semi-bold (600) is used for headers and critical status labels; Regular (400) for all body and descriptive text.
- **Readability:** Line heights are kept slightly tighter than standard creative sites (1.4x - 1.5x) to accommodate the "Cockpit" density requirement.
- **Data Specialization:** **JetBrains Mono** is used sparingly for order IDs and timestamps to ensure character distinction.

## Layout & Spacing

This design system employs a **Fixed-Fluid Hybrid Grid** optimized for a 1440px desktop breakpoint. 

- **Global Layout:** A persistent top navigation bar (64px height) houses the five primary tabs. 
- **The Kanban View:** Uses a fixed-width swimlane model (320px per lane) with horizontal overflow allowed if lanes exceed the viewport. This ensures card readability is never sacrificed.
- **The Detail View:** A three-column "Cockpit" structure:
    1. **Left/Center (Fluid):** Life-cycle timeline and process data.
    2. **Right (Fixed 400px):** Data entry and AI side-panel.
- **Spacing Rhythm:** Based on a 4px baseline grid. Standard component gaps are 12px or 16px to maintain a compact, professional appearance.

## Elevation & Depth

To maintain a modern SaaS feel, depth is communicated through **Tonal Layering** and **Soft Ambient Shadows**.

- **Level 0 (Background):** `#F8FAFC` — The base canvas.
- **Level 1 (Cards/Panels):** White surface with a 1px border (`#E2E8F0`). Used for standard Kanban cards and side panels.
- **Level 2 (Active/Hover):** White surface with a soft, diffused shadow (Y: 4px, Blur: 12px, 5% opacity). Used when a specialist hovers over an order or drags a card.
- **Level 3 (Modals/Overlays):** White surface with a 15% opacity shadow and a 20% backdrop blur (Glassmorphism) to keep the workbench context visible behind the "Claim" or "Backfill" confirmation dialogs.

## Shapes

The shape language is **Soft (0.25rem/4px)**. 

This minimal rounding maintains a serious, "industrial" feel while avoiding the harshness of 0px corners. 
- **Standard Components:** 4px radius (Buttons, Input fields, Cards).
- **Large Components:** 8px radius (Main dashboard widgets, Modals).
- **Status Tags:** Fully rounded (pill-shaped) to distinguish them from interactive buttons.

## Components

- **Kanban Cards:** Must include a high-contrast top-border or corner-ribbon for "Timeout Warnings" (Alert Orange). AI-ready cards get a subtle purple glow or "AI Pulse" icon.
- **Life-cycle Stepper:** A vertical or horizontal track where completed nodes are filled with Trust Blue. The "Current" node uses a pulsing ring. 
- **Message Blocks:** Chat logs distinguish between "Customer Call Transcripts" (left-aligned, gray) and "Specialist Notes" (right-aligned, light blue).
- **AI Highlight Text:** Within transcripts, text extracted by AI should have a subtle purple highlight (`#8B5CF6` at 10% opacity) with a "Verify" tooltip.
- **Backfill Modal:** A specialized multi-step dialog. Left side shows the "Source" (transcript fragment) and right side shows the "Editable Field" for manual verification.
- **Primary Buttons:** Solid Trust Blue with white text. 
- **Ghost Buttons:** Transparent background with 1px border for secondary actions like "View History."
- **Dashboard Widgets:** Use Sparklines for quick service-trend views and large "Hero Numbers" for total order counts.