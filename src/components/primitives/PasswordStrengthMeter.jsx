import { T } from "../../tokens";
import { scorePassword, PASSWORD_MIN_LENGTH, PASSWORD_MIN_CLASSES } from "../../utils/passwordPolicy";

const SCORE_COLOR = [T.danger, T.danger, T.warning, T.success, T.success];

const PasswordStrengthMeter = ({ password }) => {
  const { score, label, isCommon, meetsMinimum } = scorePassword(password);
  const color = SCORE_COLOR[score];
  const empty = !password;
  const filledBars = empty ? 0 : Math.max(1, score); // "Very Weak" still lights 1 bar, not 0

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 5 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2,
            background: i < filledBars ? color : T.border,
            transition: "background .15s" }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
          color: empty ? T.textMuted : color }}>
          {empty ? "Enter a password" : label}
        </span>
        {!empty && !meetsMinimum && (
          <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>
            {isCommon ? "Too common" : password.length < PASSWORD_MIN_LENGTH
              ? `Min ${PASSWORD_MIN_LENGTH} characters`
              : `Use ${PASSWORD_MIN_CLASSES}+ of: lower/upper/digit/symbol`}
          </span>
        )}
      </div>
    </div>
  );
};

export default PasswordStrengthMeter;
