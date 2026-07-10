import { createContext, useContext } from "react";

export const AuthContext = createContext({
  user:             null,
  activeRole:       "viewer",
  activeRoles:      ["viewer"],
  canEdit:          false,
  canEditShipments: false,
  canManageConfigs: false,
  isAdmin:          false,
  isViewer:         true,
  isOccBk:          false,
  isTradeManager:   false,
  activeOffice:     null,
  userOffices:      [],
  allOffices:       false,
  setActiveOffice:  () => {},
});

export const useAuth = () => useContext(AuthContext);
