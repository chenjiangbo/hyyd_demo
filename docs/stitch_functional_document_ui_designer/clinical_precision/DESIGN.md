---
name: Clinical Precision
colors:
  surface: '#f7f9fc'
  surface-dim: '#d8dadd'
  surface-bright: '#f7f9fc'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f7'
  surface-container: '#eceef1'
  surface-container-high: '#e6e8eb'
  surface-container-highest: '#e0e3e6'
  on-surface: '#191c1e'
  on-surface-variant: '#434654'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f4'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0353da'
  primary: '#003da6'
  on-primary: '#ffffff'
  primary-container: '#0052d9'
  on-primary-container: '#cbd6ff'
  inverse-primary: '#b4c5ff'
  secondary: '#214ae2'
  on-secondary: '#ffffff'
  secondary-container: '#4365fb'
  on-secondary-container: '#fffbff'
  tertiary: '#5d05bc'
  on-tertiary: '#ffffff'
  tertiary-container: '#7633d5'
  on-tertiary-container: '#e3cfff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#dee1ff'
  secondary-fixed-dim: '#b9c3ff'
  on-secondary-fixed: '#001257'
  on-secondary-fixed-variant: '#0033c2'
  tertiary-fixed: '#ecdcff'
  tertiary-fixed-dim: '#d5baff'
  on-tertiary-fixed: '#270057'
  on-tertiary-fixed-variant: '#5e08bd'
  background: '#f7f9fc'
  on-background: '#191c1e'
  surface-variant: '#e0e3e6'
  status-urgent: '#FAAD14'
  status-info: '#1890FF'
  status-success: '#52C41A'
  status-error: '#FF4D4F'
  wechat-green: '#07C160'
  corp-wechat-blue: '#2B83D2'
  table-header-bg: '#FAFAFA'
  border-subtle: '#E8E8E8'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  headline-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: -0.02em
  label-bold:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
  status-badge:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 12px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  container-margin: 24px
  gutter: 16px
  compact-padding: 8px
  card-gap: 12px
  list-item-height: 48px
---

## Brand & Style

This design system is engineered for high-stakes healthcare CRM environments where data accuracy and processing speed are paramount. The brand personality is **Technical, Utilitarian, and Reliable**, evoking the sterile but efficient atmosphere of a modern medical facility. It prioritizes the "Application-Centric" workflow, ensuring that critical identifiers like Application IDs and CCOD numbers are the primary visual anchors.

The design style follows a **Corporate / Modern** approach with subtle **Minimalist** influences. By utilizing a high-density layout and a restricted color palette, the system reduces cognitive load for operators managing complex multi-order lifecycles. It emphasizes trust through structured information architecture and provides an "unmasked" data view to ensure operational efficiency in mediation tasks.

## Colors

The palette is anchored by **Medical Blue**, a color synonymous with professional healthcare and institutional trust. 

- **Primary & Secondary:** Used for action-oriented elements, primary identifiers, and navigation.
- **Semantic Feedback:** A strict color-coding system for status. **Urgent (Orange)** identifies pending actions that require immediate attention, while **Success (Green)** indicates completed stages of the order lifecycle.
- **Platform Branding:** Specific colors are reserved for integration points; `wechat-green` and `corp-wechat-blue` distinguish communication channels within the Chat UI to provide instant context for the origin of messages.
- **Neutrals:** A range of cool grays is used to create a layered "Workplace Dashboard" effect, separating the background canvas from active content cards and data tables.

## Typography

The system utilizes **Inter** for its exceptional legibility in dense interfaces and **JetBrains Mono** for data-specific strings.

- **Data Identification:** All ID numbers (Application ID, Order No, CCOD) use `data-mono`. The monospaced nature ensures that characters like '0' and 'O' are distinguishable, critical for manual data entry and "tail-8" copy verification.
- **Hierarchy:** Primary identifiers use `headline-lg` in semi-bold to anchor the card or row. Metadata labels use `label-bold` to distinguish the field name from the field value.
- **Scalability:** The system uses a compact scale. Since this is an enterprise workbench, we prioritize information density over large display type.

## Layout & Spacing

The layout is based on a **Fluid Grid** model designed for ultra-wide monitors typical in clinical CRM setups.

- **Split-View Model:** The "Application Details" page utilizes a 2-column split. The left column (Communication Hub) is fixed-width (approx. 400px) to maintain chat readability, while the right Execution Panel is fluid to accommodate complex data tables and AI summaries.
- **Kanban Structure:** A 3-column fixed-gutter layout for "Pending," "In Progress," and "Completed." Columns should utilize background shading (`neutral_color_hex`) to differentiate lanes.
- **Density:** We utilize a "Compact" spacing rhythm. Inner card padding is capped at `8px` to maximize the number of visible records on a single screen without scrolling.

## Elevation & Depth

This system adopts a **Flat Tonal Layering** approach to maintain a "clinical" look.

- **Surfaces:** The primary background uses a subtle gray. Cards and execution panels use pure white to pop against the background.
- **Depth:** Instead of heavy ambient shadows, we use **Low-Contrast Outlines** (1px solid `border-subtle`). 
- **Active State:** The currently selected application or order in a list view is indicated by a 2px primary-colored left border (accent bar) rather than a shadow.
- **Z-Index:** Toasts for "Copy Successful" actions appear at the top-center with a soft, medium-diffused shadow to indicate they are temporary overlays on the functional workspace.

## Shapes

The shape language is **Soft (0.25rem)**, providing a slight modern touch to an otherwise rigid, professional interface.

- **Containers:** Kanban cards and data containers use the standard `0.25rem` radius.
- **Tags & Badges:** Service Type tags (e.g., "Registration") use a slightly more rounded `0.5rem` (rounded-lg) to distinguish them from interactive buttons and structural cards.
- **Chat Bubbles:** WeChat integration bubbles use asymmetric rounding (e.g., 8px on three corners, 2px on the corner pointing to the avatar) to provide clear directional context.

## Components

- **Kanban Cards:** Must display the Application ID at the top in `data-mono`. Include "Quick-Copy" icons next to the ID. Status is shown via a top-edge color strip (Urgent/Info/Success).
- **Data Tables:** Dense configuration. Row height is fixed at `40px`. The first column (Primary ID) is sticky. Every numeric ID field must include a hover-state "Copy" button.
- **Service Tags:** Color-coded by service type. Use high-contrast text on low-saturation background versions of the assigned service color.
- **Chat Interface:**
  - **Me:** Right-aligned, primary blue background, white text.
  - **Them:** Left-aligned, light gray or wechat-green background, dark text.
  - **System Messages:** Centered, small muted text with no bubble.
- **Progress Trackers:** Horizontal steppers for order lifecycles. Use `status-success` for completed nodes and `primary_color_hex` for the active node.
- **Action Buttons:** Primary buttons are solid `primary_color_hex`. Secondary actions (like "Copy") use ghost styles (icon-only or subtle borders) to avoid visual clutter.