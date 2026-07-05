import { createContext, useContext } from "react";

export const AuthContext = createContext({
  user:             null,
  activeRole:       "viewer",
  activeRoles:      ["viewer"],
  canEdit:          false,
  canManageConfigs: false,
  isAdmin:          false,
  isViewer:         true,
  isOccBk:          false,
});

export const useAuth = () => useContext(AuthContext);
