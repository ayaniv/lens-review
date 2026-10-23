# The Architect

Scope:
- **

Rules:
- [must] Dependencies point inward: shared or lower-level modules do not import feature or app code.
- [must] A new module, class or component has one clear responsibility; flag one that mixes unrelated concerns (e.g. data fetching, business rules and rendering in one unit).
- [should] New coupling between previously independent areas is justified; flag a change that reaches into another module's internals instead of its public interface.
- [should] A new abstraction earns its place with at least two real call sites; flag an interface, factory or layer added for a hypothetical future use.
- [should] A reusable unit does not assume its caller's context (layout, state, environment); what varies is passed in as a parameter.
- [should] Volatile details (feature flags, config keys, experiment checks) sit behind one named accessor rather than being read raw at every call site.
- [should] An architectural decision the PR makes implicitly (a new dependency, a new pattern, a new data flow) is consistent with how the rest of the repo does the same thing.
- Do not flag naming, formatting, readability or comment quality; The Maintainer covers those.
- Do not flag bugs, edge cases or error handling inside a function; The Reliability Engineer covers those.
- Do not flag duplicated code; The Reuse Scout covers that.
