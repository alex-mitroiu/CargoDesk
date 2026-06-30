import { T } from "../../tokens";

const Badge = ({ children, variant = "default", size }) => {
  const v = {
    default:  { bg: T.surface,            c: T.textMuted },
    success:  { bg: T.successBg,          c: T.success   },
    warning:  { bg: T.warningBg,          c: T.warning   },
    danger:   { bg: T.dangerBg,           c: T.danger    },
    info:     { bg: T.infoBg,             c: T.info      },
    amber:    { bg: T.accentBg,           c: T.accent    },
    purple:   { bg: T.purpleBg,           c: T.purple    },
    manual:   { bg: "#f97316",            c: "#fff"      },
    central:  { bg: "rgb(77,179,232)",    c: "#fff"      },
  }[variant] || { bg: T.surface, c: T.textMuted };
  return (
    <span style={{ background: v.bg, color: v.c, fontFamily: T.mono, fontSize: size ?? 10.5, fontWeight: 600,
      padding: "2px 9px", borderRadius: 4, letterSpacing: ".06em", whiteSpace: "nowrap", width: "fit-content", alignSelf: "center", display: "inline-block" }}>
      {children}
    </span>
  );
};

export default Badge;