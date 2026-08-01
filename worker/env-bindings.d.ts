/**
 * Runtime-only Worker secrets. Wrangler intentionally omits secrets from its
 * generated configuration declaration, so this small augmentation keeps that
 * generated file reproducible while making every secret access nullable.
 */
interface Env {
  RESET_SECRET?: string;
  AWARD_SECRET?: string;
}
