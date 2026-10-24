// The model and phase mix a run uses, as one named configuration: the A/B of SPEC item 4
// switches it with LENS_REVIEW_VARIANT, and every script that depends on the mix reads it
// here, never the env var itself.
//   a: every reviewer on Haiku, challenge round, no prechecks (the control)
//   b: as a, with the Anthropic-general reviewer on Sonnet
//   c: no challenge round; one Sonnet deep-pass reviewer on the whole diff
//   d: the winner of b and c, plus prechecks (the default)
// TODO: once the A/B picks a winner, fold it into the default and drop the losing variants.
const VARIANTS = {
  a: { generalModel: 'haiku', challengeRound: true, deepPass: false, prechecks: false },
  b: { generalModel: 'sonnet', challengeRound: true, deepPass: false, prechecks: false },
  c: { generalModel: 'haiku', challengeRound: false, deepPass: true, prechecks: false },
  // Provisionally a plus prechecks, until the A/B decides between b and c.
  d: { generalModel: 'haiku', challengeRound: true, deepPass: false, prechecks: true },
}
const DEFAULT_VARIANT = 'd'
export const DEEP_PASS_MODEL = 'sonnet'

export function currentVariant(env = process.env) {
  const name = env.LENS_REVIEW_VARIANT || DEFAULT_VARIANT
  if (!VARIANTS[name]) throw new Error(`LENS_REVIEW_VARIANT "${name}" is not one of ${Object.keys(VARIANTS).join(', ')}`)
  return { name, ...VARIANTS[name] }
}
