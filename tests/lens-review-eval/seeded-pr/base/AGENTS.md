# Agent rules — shop-demo

## Design system (`src/ds/`)
- UI buttons use `Button` from `src/ds`; never render a raw `<button>` in app code.
- Colors come from the tokens in `src/ds/tokens.ts`; never hardcode a hex or rgb color in a component.

## Data access
- All SQL goes through `db.query(sql, params)` with bound parameters.
