import { T } from "../../tokens";

// On a Trade Horizon page (T.hz) the pill takes HZ's pill text colours and shape. Its text keeps the
// caller's case: badge text is data that tests look up, so no text-transform.
const Badge = ({ children, variant = "default", size }) => {
  const hz = T.hz;
  const v = {
    default:  { bg: T.neutralBg,          c: T.textMuted   },
    success:  { bg: T.successBg,          c: T.successText },
    warning:  { bg: T.warningBg,          c: T.warning     },
    danger:   { bg: T.dangerBg,           c: T.danger      },
    info:     { bg: T.infoBg,             c: T.infoText    },
    // On Trade Horizon the accent is cyan, so "amber" takes the amber-family warning hue instead.
    amber:    hz ? { bg: T.warningBg, c: T.warning } : { bg: T.accentBg, c: T.accent },
    purple:   { bg: T.purpleBg,           c: T.purpleText  },
    manual:   { bg: "#f97316",            c: "#fff"        },
    central:  { bg: "rgb(77,179,232)",    c: "#fff"        },
  }[variant] || { bg: T.neutralBg, c: T.textMuted };
  return (
    <span style={{ background: v.bg, color: v.c, fontFamily: T.mono, fontSize: size ?? (hz ? 10 : 10.5), fontWeight: hz ? 700 : 600,
      padding: hz ? "3px 8px" : "2px 9px", borderRadius: hz ? 5 : 4, letterSpacing: ".06em", whiteSpace: "nowrap", width: "fit-content", alignSelf: "center", display: "inline-block" }}>
      {children}
    </span>
  );
};

export default Badge;