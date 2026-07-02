import { createContext, useContext } from "react";

export const AuthContext = createContext({
  user:        null,
  activeRole:  "viewer",
  canEdit:     false,
  isAdmin:     false,
  isViewer:    true,
});

export const useAuth = () => useContext(AuthContext);
