// Shared password strength policy — used by PasswordStrengthMeter and
// ChangePasswordModal. Mirrored (not imported — frontend is ESM, the
// backend route is CommonJS) in routes/auth.js's own scorePassword();
// keep both in sync if this policy changes.

const COMMON_WEAK = /^(password|12345678|123456789|qwerty|letmein|admin123|iloveyou|welcome1|passw0rd)/i;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MIN_CLASSES = 3;

export const SCORE_LABELS = ["Very Weak", "Weak", "Fair", "Strong", "Very Strong"];

export function scorePassword(pw) {
  const pass = pw || "";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pass)).length;
  const lengthScore = pass.length >= 16 ? 3 : pass.length >= 12 ? 2 : pass.length >= 8 ? 1 : 0;
  const classScore  = Math.max(0, classes - 1);
  let score = Math.min(4, lengthScore + classScore);
  const isCommon = COMMON_WEAK.test(pass);
  if (pass.length < 8 || isCommon) score = 0;
  const meetsMinimum = pass.length >= PASSWORD_MIN_LENGTH && classes >= PASSWORD_MIN_CLASSES && !isCommon;
  return { score, label: SCORE_LABELS[score], classes, isCommon, meetsMinimum };
}
