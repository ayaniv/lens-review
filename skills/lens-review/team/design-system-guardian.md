# The Design System Guardian

Scope:
- **/*.{tsx,jsx,vue,svelte,css,scss,less}
- **/components/**
- **/styles/**

Signals:
- style=\{\{
- !important
- ['"]#[0-9a-fA-F]{6}['"]

Rules:
- Flag visual overrides of design-system components from consuming applications.
- Flag hardcoded values (colors, spacing, font sizes) where design tokens should be used.
- Flag duplicated design-system components, and raw HTML elements used where a design-system component exists.
- Do not flag legitimate layout styling of consuming pages.
- Changes to design-system visual contracts require explicit design approval.
- Do not flag backend code, data access or business logic.
